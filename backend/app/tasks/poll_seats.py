"""Celery task: poll Cineplex for seat availability changes.

Scheduled by Celery beat every 30 seconds (the minimum poll interval).
Each run checks all active showtimes and skips any that aren't yet due for
a refresh based on their individual ``poll_interval_sec`` setting.

Sync / async bridge
-------------------
Celery workers run synchronously. All database and Redis I/O lives inside
``_poll_all_showtimes()``, which is called via ``asyncio.run()`` from the
sync Celery entry point ``poll_seats()``. Each Celery task execution creates
its own event loop via ``asyncio.run()``.

Because asyncpg connections are bound to the event loop that created them,
this task uses a **separate SQLAlchemy engine with NullPool** rather than the
shared FastAPI engine. NullPool creates a fresh connection per session and
closes it immediately after — no connection is ever re-used across event loop
boundaries.

Flow per poll cycle
-------------------
Steps 3–9 run per showtime with **bounded concurrency** (``POLL_CONCURRENCY``
coroutines at a time, via an ``asyncio.Semaphore`` + ``asyncio.gather``) over a
single shared keep-alive ``httpx.Client``, so a ~140-showtime cycle finishes in
~10 s instead of ~60 s sequential while never bursting more than a handful of
requests at Cineplex at once.

1. Load all active *watched* showtimes from the DB.
2. Skip showtimes that were polled recently (within their interval).
3. Fetch the current seat availability from the Cineplex API on the shared
   ``httpx.Client`` (sync, run in a thread pool via ``asyncio.to_thread``).
4. Diff against the previous availability snapshot stored in Redis.
5. For every seat that changed:
   - Record a ``SeatEvent`` row in the DB.
   - Update ``watched_seats.last_known_status`` for any watch that tracks it.
   - If the transition is ``Occupied → Available``, publish a pub/sub event.
6. Compute per-watch email-notification batches for newly-available seats
   (skipping users who haven't opted in to email and seats already notified).
7. Save the new availability snapshot to Redis and update the showtime's
   adaptive interval / ``last_polled_at``, then commit.
8. Send queued emails via ``asyncio.to_thread`` (Resend SDK is sync).
9. In a second transaction, mark ``notified_at`` for sent emails and create
   ``watched_seats`` rows for ``notify_any_seat`` watches so we don't re-send.
"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
import structlog
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload
from sqlalchemy.pool import NullPool

from app.config import settings
from app.models.seat_event import SeatEvent
from app.models.showtime import Showtime
from app.models.watch import Watch
from app.models.watched_seat import WatchedSeat
from app.services.notifications import (
    send_seat_available_email,
    send_seat_available_push,
    send_seat_available_sms,
    user_wants_email,
    user_wants_push,
    user_wants_sms,
)
from app.services.redis_client import (
    SNAPSHOT_TTL_SEC,
    acquire_poll_lock,
    create_async_redis,
    make_snapshot_key,
    publish_seat_event,
    release_poll_lock,
)
from app.tasks.celery_app import celery

log = structlog.get_logger()

CINEPLEX_API_BASE = "https://apis.cineplex.com/prod/ticketing/api/v1"

# How many showtimes to poll concurrently within a single cycle. Bounded so we
# never burst the whole showtime list at Cineplex at once (which would look like
# an attack to the Imperva WAF and blow the per-IP request budget — see
# docs/scaling.md Finding 2). At 5, a ~140-showtime cycle that ran ~60 s
# strictly-sequentially collapses to ~10 s while peaking at only 5 in-flight
# upstream requests. Raise cautiously; the ceiling is WAF tolerance, not CPU.
POLL_CONCURRENCY = 5

# One real, stable User-Agent instead of httpx's default ``python-httpx/x.y``.
# It's honest (identifies the app + a contact URL) rather than a spoofed browser
# string — Imperva filters on datacenter-IP reputation, so faking a browser UA
# does nothing (proven during the Hetzner→OVH migration), but a self-identifying
# UA is good-citizen and less obviously bot-like than the library default.
_USER_AGENT = "Cinewatch/1.0 (+https://cinewatch.ca)"

# Connection-pool limits for the per-cycle shared client. With POLL_CONCURRENCY
# fetches in flight, ≤5 sockets are ever open; keepalive_expiry (30 s) keeps them
# warm across the whole cycle so seat polls reuse connections instead of paying a
# fresh TCP+TLS handshake (~300–800 ms) every request.
_HTTP_LIMITS = httpx.Limits(
    max_connections=POLL_CONCURRENCY * 2,
    max_keepalive_connections=POLL_CONCURRENCY,
    keepalive_expiry=30.0,
)
_HTTP_TIMEOUT = 15.0

# ---------------------------------------------------------------------------
# Celery-specific SQLAlchemy engine (NullPool — no connection reuse across
# event loops).  Separate from the FastAPI engine in database.py.
# ---------------------------------------------------------------------------

_engine = create_async_engine(settings.database_url, poolclass=NullPool)
_session_factory = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)


# ---------------------------------------------------------------------------
# Adaptive poll interval (mirrors the spec in CLAUDE.md)
# ---------------------------------------------------------------------------


def get_poll_interval(showtime_at: datetime | None) -> int:
    """Return the recommended poll interval in seconds.

    Falls back to 90 s when ``showtime_at`` is NULL (metadata not yet
    populated).  Returns -1 only when ``showtime_at`` confirms the showtime
    has passed — in practice the Cineplex API's ``isPostShowtime`` flag is
    the authoritative signal to stop polling.
    """
    if showtime_at is None:
        return 90
    hours_until = (showtime_at - datetime.now(timezone.utc)).total_seconds() / 3600
    if hours_until <= 0:
        return -1
    elif hours_until <= 2:
        return 30
    elif hours_until <= 6:
        return 60
    else:
        return 90


# ---------------------------------------------------------------------------
# Cineplex HTTP fetch (synchronous — used via asyncio.to_thread)
# ---------------------------------------------------------------------------


def _fetch_availability_sync(
    client: httpx.Client, theatre_id: int, showtime_id: int
) -> dict:
    """Fetch seat availability synchronously on the shared cycle client.

    Intended to be called via ``asyncio.to_thread`` so the event loop is
    not blocked during network I/O.  ``httpx.Client`` is thread-safe, so the
    same client is reused concurrently across the cycle's poll threads —
    reusing keep-alive connections instead of a cold handshake per request.
    Raises ``httpx.HTTPStatusError`` on non-2xx responses.
    """
    url = f"{CINEPLEX_API_BASE}/theatre/{theatre_id}/showtime/{showtime_id}/seat-availability"
    resp = client.get(url)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Seat-label lookup from the cached layout JSON
# ---------------------------------------------------------------------------


def _build_label_map(seat_layout_json: dict | None) -> dict[str, str]:
    """Build a ``{seat_key: seat_label}`` mapping from the cached seat layout.

    The layout is stored in ``showtimes.seat_layout_json`` after the first
    time a user creates a watch for the showtime.  Returns an empty dict if
    the layout hasn't been cached yet — the seat_key is used as a fallback
    label in that case.
    """
    if not seat_layout_json:
        return {}
    label_map: dict[str, str] = {}
    for row in seat_layout_json.get("standardSeats", {}).get("rows", []):
        for seat in row.get("seats", []):
            label_map[seat["id"]] = seat.get("label", seat["id"])
    return label_map


# ---------------------------------------------------------------------------
# Notification job — plain dataclass so we can build a batch *during* the
# write-transaction and consume it afterwards (when ORM rows would be
# detached / refreshed).
# ---------------------------------------------------------------------------


@dataclass
class _CandidateSeat:
    """One newly-available seat earmarked for notification."""

    seat_key: str
    seat_label: str
    # If the user is tracking this seat specifically, we have its
    # WatchedSeat row id and just need to set notified_at on it.
    # If this seat surfaced via notify_any_seat, the row doesn't exist yet
    # and we'll create it (with notified_at set) after the email sends.
    watched_seat_id: uuid.UUID | None


@dataclass
class _NotifyJob:
    """Everything required to dispatch one user's seat-available alert.

    A single job may fan out to multiple channels (email + SMS + push)
    depending on the user's ``notify_via`` preference and what data they
    have on file (phone number, push subscription). Channel selection
    happens in ``_send_notifications`` so the job-building loop stays
    simple.
    """

    watch_id: uuid.UUID
    user_email: str
    user_phone: str | None
    user_push_subscription: dict | None
    user_notify_via: str | None
    # User-chosen label for this watch (watches.name). Takes precedence over
    # the showtime's movie_name when present — it's the personal name the user
    # gave the showtime at create time. movie_name is currently always NULL.
    watch_name: str | None
    movie_name: str | None
    theater_name: str | None
    showtime_at: datetime | None
    theatre_id: int
    showtime_id: int
    candidate_seats: list[_CandidateSeat]


# ---------------------------------------------------------------------------
# Main async polling orchestration
# ---------------------------------------------------------------------------


async def _poll_all_showtimes() -> None:
    """Acquire the single-flight lock, then run one poll cycle.

    Guarded by a global Redis lock (see :func:`acquire_poll_lock`) so only one
    cycle runs at a time. Celery beat fires every 30 s but a full cycle can
    take longer; without the lock two cycles would run concurrently on the
    prefork pool, duplicating upstream Cineplex requests and risking duplicate
    notifications. If a beat tick fires while a cycle is already running it logs
    ``poll_cycle_skipped_locked`` and returns immediately.
    """
    r = create_async_redis()
    try:
        token = await acquire_poll_lock(r)
        if token is None:
            await log.ainfo("poll_cycle_skipped_locked")
            return
        try:
            await _run_poll_cycle(r)
        finally:
            await release_poll_lock(r, token)
    finally:
        await r.aclose()


async def _run_poll_cycle(r) -> None:
    """Run one full poll cycle across active, *watched* showtimes (lock held).

    A showtime is only polled if it has at least one **active** watch. A
    showtime whose watches were all cancelled, removed, expired, or marked
    ``fulfilled`` still has ``is_active = True`` but nobody is waiting on it, so
    polling it is pure wasted upstream volume (Cineplex request budget is the
    existential constraint — see docs/scaling.md Finding 2). The correlated
    ``EXISTS`` sub-query below drops those from the cycle entirely; if a new
    watch is later created for such a showtime, polling resumes automatically on
    the next cycle (no row is deactivated, so nothing needs re-enabling).
    """
    async with _session_factory() as db:
        stmt = (
            select(Showtime)
            .where(Showtime.is_active.is_(True))
            .where(
                exists().where(
                    Watch.showtime_id == Showtime.id,
                    Watch.status == "active",
                )
            )
        )
        result = await db.execute(stmt)
        showtimes = list(result.scalars().all())

    # Count reflects only active showtimes that still have ≥1 active watch
    # (zero-watch showtimes are filtered out by the query above).
    await log.ainfo("poll_cycle_start", watched_showtimes=len(showtimes))
    cycle_start = time.monotonic()

    # Select the showtimes actually due for a refresh this cycle (their
    # per-showtime poll_interval_sec has elapsed). The interval gate is unchanged
    # from the old sequential loop — only the dispatch below is now concurrent.
    now = datetime.now(timezone.utc)
    due: list[Showtime] = []
    for showtime in showtimes:
        if showtime.last_polled_at is not None:
            elapsed = (now - showtime.last_polled_at).total_seconds()
            if elapsed < showtime.poll_interval_sec:
                continue  # Not due yet — skip silently
        due.append(showtime)

    # Poll due showtimes with bounded concurrency instead of strictly one at a
    # time. asyncio.Semaphore caps how many _poll_showtime coroutines fetch
    # upstream simultaneously (POLL_CONCURRENCY), and a single shared
    # httpx.Client keeps connections warm across them. This is a pure
    # performance change: each showtime is still polled exactly once, in
    # isolation (no two coroutines touch the same showtime row), so ordering
    # doesn't matter.
    sem = asyncio.Semaphore(POLL_CONCURRENCY)
    with httpx.Client(
        headers={"User-Agent": _USER_AGENT},
        timeout=_HTTP_TIMEOUT,
        limits=_HTTP_LIMITS,
    ) as client:

        async def _guarded(st: Showtime) -> None:
            async with sem:
                await _poll_showtime(r, client, st)

        # Plain gather (no return_exceptions): an unexpected error still
        # propagates out to poll_seats() and triggers its Celery retry, matching
        # the old sequential behaviour. Expected Cineplex fetch failures are
        # already caught inside _poll_showtime and never reach here.
        await asyncio.gather(*(_guarded(st) for st in due))

    await log.ainfo(
        "poll_cycle_complete",
        watched_showtimes=len(showtimes),
        polled=len(due),
        elapsed_sec=round(time.monotonic() - cycle_start, 1),
    )

    # Dead-man's-switch: signal the external monitor that a full cycle
    # completed. Reached only if the polling above didn't raise, so a poller that
    # is crash-looping stops pinging and the monitor alerts. See
    # settings.healthcheck_ping_url.
    await _ping_healthcheck()


async def _ping_healthcheck() -> None:
    """Best-effort dead-man's-switch ping after a successful poll cycle.

    GETs ``settings.healthcheck_ping_url`` (healthchecks.io or similar) so an
    external monitor knows the poller is alive; when pings stop it alerts us.
    This is the one signal ``/health`` can't give — the API stays up even if the
    Celery worker dies. Never raises: a monitoring ping must not break polling.
    Blank URL = disabled (dev-mode no-op).
    """
    url = settings.healthcheck_ping_url
    if not url:
        return
    try:
        await asyncio.to_thread(httpx.get, url, timeout=10)
    except Exception as exc:
        await log.awarning("healthcheck_ping_failed", error=str(exc))


async def _poll_showtime(r, client: httpx.Client, showtime: Showtime) -> None:
    """Poll a single showtime: fetch → diff → persist → publish → notify."""
    await log.ainfo(
        "polling_showtime",
        showtime_uuid=str(showtime.id),
        theatre_id=showtime.theatre_id,
        showtime_id=showtime.showtime_id,
    )

    # --- 1. Fetch current availability from Cineplex (non-blocking) ---
    try:
        availability: dict = await asyncio.to_thread(
            _fetch_availability_sync,
            client,
            showtime.theatre_id,
            showtime.showtime_id,
        )
    except Exception as exc:
        # Transient Cineplex API error — log and skip this cycle.
        # Per CLAUDE.md: "Don't mark the showtime as inactive."
        await log.awarning(
            "cineplex_fetch_failed",
            showtime_uuid=str(showtime.id),
            error=str(exc),
        )
        return

    new_statuses: dict[str, str] = availability.get("seatAvailabilities", {})
    is_post_showtime: bool = availability.get("isPostShowtime", False)

    # --- 2. Load previous availability snapshot from Redis ---
    snapshot_key = make_snapshot_key(str(showtime.id))
    raw_snapshot = await r.get(snapshot_key)
    # The very first poll of a showtime has no prior snapshot. We must NOT
    # treat the seats that happen to be open *right now* as fresh
    # "Occupied -> Available" transitions — otherwise a user who starts
    # watching a showtime that already has open seats is immediately emailed
    # about every one of them, even though nothing actually changed
    # (bugs.md #1). Instead, the first poll only *establishes the baseline*;
    # real change detection begins on the next cycle.
    is_baseline_poll = raw_snapshot is None
    prev_statuses: dict[str, str] = json.loads(raw_snapshot) if raw_snapshot else {}

    # --- 3. Diff: find every seat whose status changed ---
    # Skipped on the baseline poll (see above) — we have no prior state to
    # diff against, so we can't legitimately claim any seat "became" available.
    changed: list[tuple[str, str, str]] = []  # (seat_key, old_status, new_status)
    if not is_baseline_poll:
        for seat_key, new_status in new_statuses.items():
            old_status = prev_statuses.get(seat_key, "Occupied")
            if old_status != new_status:
                changed.append((seat_key, old_status, new_status))

    notify_jobs: list[_NotifyJob] = []

    # --- 4. Persist changes to the DB and publish pub/sub events ---
    async with _session_factory() as db:
        # Reload the showtime inside this session for writes.
        st_result = await db.execute(select(Showtime).where(Showtime.id == showtime.id))
        db_showtime = st_result.scalar_one()

        if is_post_showtime:
            # Showtime is over — stop polling and expire all active watches.
            await log.ainfo("showtime_ended", showtime_uuid=str(db_showtime.id))
            db_showtime.is_active = False
            watches_result = await db.execute(
                select(Watch).where(
                    Watch.showtime_id == db_showtime.id,
                    Watch.status == "active",
                )
            )
            for watch in watches_result.scalars():
                watch.status = "expired"
            await db.commit()
            await r.delete(snapshot_key)  # Clean up — no more polls needed
            return

        if changed:
            # Load every active watch for this showtime *with* its user and
            # watched_seats relationships eager-loaded. We touch both inside
            # this session — async SQLAlchemy will not lazy-load on access.
            w_stmt = (
                select(Watch)
                .where(
                    Watch.showtime_id == db_showtime.id,
                    Watch.status == "active",
                )
                .options(
                    selectinload(Watch.user),
                    selectinload(Watch.watched_seats),
                )
            )
            w_result = await db.execute(w_stmt)
            watches = list(w_result.scalars().all())

            # Build a seat_key → [WatchedSeat] map across all watches so we
            # can attach SeatEvents and update last_known_status in one pass.
            seat_to_watched: dict[str, list[WatchedSeat]] = {}
            for watch in watches:
                for ws in watch.watched_seats:
                    seat_to_watched.setdefault(ws.seat_key, []).append(ws)

            # Build label map for pub/sub + email payloads.
            label_map = _build_label_map(db_showtime.seat_layout_json)

            for seat_key, old_status, new_status in changed:
                # Update DB state for any user who is watching this seat.
                for ws in seat_to_watched.get(seat_key, []):
                    db.add(
                        SeatEvent(
                            watched_seat_id=ws.id,
                            old_status=old_status,
                            new_status=new_status,
                        )
                    )
                    ws.last_known_status = new_status

                # Publish a pub/sub event only for the direction we care about.
                # CLAUDE.md: "Don't notify on Available → Occupied — only notify
                # on Occupied → Available."
                if old_status == "Occupied" and new_status == "Available":
                    await publish_seat_event(
                        r,
                        showtime_uuid=str(db_showtime.id),
                        theatre_id=db_showtime.theatre_id,
                        showtime_id=db_showtime.showtime_id,
                        seat_key=seat_key,
                        seat_label=label_map.get(seat_key, seat_key),
                    )

            # ---- Build per-watch email notification batches ----
            # One email per watch carrying ALL of its newly-available seats.
            # Sending one message per seat would spam users who watch many.
            newly_available_keys = {
                seat_key
                for seat_key, old_status, new_status in changed
                if old_status == "Occupied" and new_status == "Available"
            }

            for watch in watches:
                user = watch.user
                if user is None:
                    continue
                # Skip users who haven't opted in to any channel we can
                # actually deliver on. SMS requires the opt-in *and* a
                # phone number; push requires the opt-in *and* a stored
                # browser subscription.
                wants_email = user_wants_email(user.notify_via)
                wants_sms = user_wants_sms(user.notify_via) and bool(user.phone)
                wants_push = user_wants_push(user.notify_via) and bool(user.push_subscription)
                if not (wants_email or wants_sms or wants_push):
                    continue

                tracked: dict[str, WatchedSeat] = {
                    ws.seat_key: ws for ws in watch.watched_seats
                }
                candidates: list[_CandidateSeat] = []

                for seat_key in newly_available_keys:
                    seat_label = label_map.get(seat_key, seat_key)
                    if seat_key in tracked:
                        ws = tracked[seat_key]
                        if ws.notified_at is None:
                            candidates.append(
                                _CandidateSeat(
                                    seat_key=seat_key,
                                    seat_label=seat_label,
                                    watched_seat_id=ws.id,
                                )
                            )
                    elif watch.notify_any_seat:
                        # No watched_seats row yet — we'll create one after
                        # a successful send so the dedup check works on the
                        # next cycle.
                        candidates.append(
                            _CandidateSeat(
                                seat_key=seat_key,
                                seat_label=seat_label,
                                watched_seat_id=None,
                            )
                        )

                if candidates:
                    notify_jobs.append(
                        _NotifyJob(
                            watch_id=watch.id,
                            user_email=user.email,
                            user_phone=user.phone,
                            user_push_subscription=user.push_subscription,
                            user_notify_via=user.notify_via,
                            watch_name=watch.name,
                            movie_name=db_showtime.movie_name,
                            theater_name=db_showtime.theater_name,
                            # The user's per-watch date wins over the (always
                            # NULL) shared showtime metadata, mirroring how
                            # watch_name overrides movie_name above.
                            showtime_at=watch.showtime_at or db_showtime.showtime_at,
                            theatre_id=db_showtime.theatre_id,
                            showtime_id=db_showtime.showtime_id,
                            candidate_seats=candidates,
                        )
                    )

        # Update adaptive poll interval and timestamp.
        new_interval = get_poll_interval(db_showtime.showtime_at)
        # If showtime_at says it's passed but isPostShowtime wasn't set yet,
        # use the minimum interval (30 s) and let the API confirm.
        db_showtime.poll_interval_sec = max(new_interval, 30)
        db_showtime.last_polled_at = datetime.now(timezone.utc)
        await db.commit()

    # --- 5. Persist the new snapshot after a successful DB commit ---
    await r.setex(snapshot_key, SNAPSHOT_TTL_SEC, json.dumps(new_statuses))

    # --- 6. Fire emails outside the write transaction ---
    if notify_jobs:
        await _send_notifications(notify_jobs)

    await log.ainfo(
        "showtime_polled",
        showtime_uuid=str(showtime.id),
        total_seats=len(new_statuses),
        changes=len(changed),
        emails_queued=len(notify_jobs),
    )


# ---------------------------------------------------------------------------
# Notification dispatch
# ---------------------------------------------------------------------------


async def _send_notifications(jobs: list[_NotifyJob]) -> None:
    """Dispatch every opted-in channel for each ``_NotifyJob`` and persist
    dedup state once at least one channel succeeds.

    Called *after* the seat-event write transaction has committed so the
    DB stays consistent even if the vendor APIs fail partway through.
    Each ``send_*`` call is wrapped in ``asyncio.to_thread`` because both
    Resend and Twilio ship synchronous SDKs.

    Notification dedup is per-seat, not per-channel — once we've notified
    a user about a seat on *any* channel, ``notified_at`` is stamped and
    we don't re-alert (matching CLAUDE.md "Notification deduplication").
    """
    sent_jobs: list[_NotifyJob] = []

    for job in jobs:
        seat_labels = [c.seat_label for c in job.candidate_seats]
        any_channel_ok = False

        # The name the user gave this watch wins over the (currently always
        # NULL) showtime movie_name. When both are NULL the renderers fall
        # back to their own "Your watched showtime" / "Cineplex" placeholders.
        display_name = job.watch_name or job.movie_name

        if user_wants_email(job.user_notify_via):
            email_ok = await asyncio.to_thread(
                send_seat_available_email,
                to_email=job.user_email,
                movie_name=display_name,
                theater_name=job.theater_name,
                showtime_at=job.showtime_at,
                seat_labels=seat_labels,
                theatre_id=job.theatre_id,
                showtime_id=job.showtime_id,
            )
            any_channel_ok = any_channel_ok or email_ok

        if user_wants_sms(job.user_notify_via) and job.user_phone:
            sms_ok = await asyncio.to_thread(
                send_seat_available_sms,
                to_phone=job.user_phone,
                movie_name=display_name,
                seat_labels=seat_labels,
                theatre_id=job.theatre_id,
                showtime_id=job.showtime_id,
            )
            any_channel_ok = any_channel_ok or sms_ok

        if user_wants_push(job.user_notify_via) and job.user_push_subscription:
            push_ok = await asyncio.to_thread(
                send_seat_available_push,
                subscription_info=job.user_push_subscription,
                movie_name=display_name,
                seat_labels=seat_labels,
                theatre_id=job.theatre_id,
                showtime_id=job.showtime_id,
            )
            any_channel_ok = any_channel_ok or push_ok

        if any_channel_ok:
            sent_jobs.append(job)

    if not sent_jobs:
        return

    # Persist notified_at in a fresh session so a transient DB error here
    # cannot roll back the seat events / pub/sub state already committed.
    now = datetime.now(timezone.utc)
    async with _session_factory() as db:
        for job in sent_jobs:
            for cand in job.candidate_seats:
                if cand.watched_seat_id is not None:
                    # Existing tracked seat — just stamp notified_at.
                    ws = await db.get(WatchedSeat, cand.watched_seat_id)
                    if ws is not None and ws.notified_at is None:
                        ws.notified_at = now
                else:
                    # notify_any_seat watch — create the row so future polls
                    # treat this seat as "already notified" for this watch.
                    db.add(
                        WatchedSeat(
                            watch_id=job.watch_id,
                            seat_key=cand.seat_key,
                            seat_label=cand.seat_label,
                            last_known_status="Available",
                            notified_at=now,
                        )
                    )

        # ---- Mark fully-delivered watches as 'fulfilled' ----
        # A specific-seat watch whose every tracked seat has now been notified
        # has nothing left to deliver. Marking it 'fulfilled' drops it from the
        # active set, so once *all* of a showtime's watches are fulfilled (or
        # removed) the zero-watch skip in _run_poll_cycle stops polling that
        # showtime — cutting upstream volume (docs/scaling.md Finding 2). It also
        # fixes the /admin/stats fulfilled count, which is otherwise always 0.
        #
        # notify_any_seat watches are EXCLUDED: they have no fixed target set, so
        # any future seat release is still worth an alert — they're never "done".
        # The SELECT below autoflushes the notified_at writes above, and the
        # session's identity map means the just-stamped rows report their new
        # notified_at here.
        for watch_id in {job.watch_id for job in sent_jobs}:
            watch = await db.get(Watch, watch_id)
            if watch is None or watch.status != "active" or watch.notify_any_seat:
                continue
            seats_result = await db.execute(
                select(WatchedSeat).where(WatchedSeat.watch_id == watch_id)
            )
            tracked_seats = list(seats_result.scalars().all())
            if tracked_seats and all(s.notified_at is not None for s in tracked_seats):
                watch.status = "fulfilled"
                await log.ainfo("watch_fulfilled", watch_uuid=str(watch_id))

        await db.commit()


# ---------------------------------------------------------------------------
# Celery task entry point
# ---------------------------------------------------------------------------


@celery.task(name="tasks.poll_seats", bind=True, max_retries=3)
def poll_seats(self) -> None:
    """Check all active showtimes and poll those due for a refresh.

    Called by Celery beat every 30 seconds.  The task skips showtimes
    whose ``poll_interval_sec`` has not elapsed since ``last_polled_at``,
    so beat can fire frequently without hammering Cineplex.
    """
    try:
        asyncio.run(_poll_all_showtimes())
    except Exception as exc:
        log.error("poll_seats_task_failed", error=str(exc))
        raise self.retry(exc=exc, countdown=60)
