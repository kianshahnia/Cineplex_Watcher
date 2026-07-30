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
2. Retire showtimes whose start time has passed (no upstream request), and skip
   showtimes that were polled recently (within their interval).
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
8. Enqueue a separate ``tasks.send_notifications`` Celery task with the batch,
   then return. That task (not the poll cycle) does the blocking email/SMS/push
   delivery and, in its own transaction, marks ``notified_at`` / creates
   ``watched_seats`` rows for ``notify_any_seat`` watches / retires fully-delivered
   watches to ``expired``. Keeping delivery off the poll path stops one popular
   showtime's alert fan-out from stalling every other showtime's poll.
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
from app.models.notification import Notification
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
from app.services import seat_groups
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
    """Return the recommended poll interval in seconds, or -1 to stop polling.

    Takes the **aware UTC** ``showtimes.showtime_at``, which is now populated
    automatically from Cineplex's ``showStartDateTimeUtc`` (see
    ``services/showtime_metadata.py``).  It stays NULL only for showtimes whose
    metadata could not be resolved, which fall back to a flat 90 s.

    Tiers::

        None     ->  90    metadata unresolved — the old flat default
        <= 0h    ->  -1    started — caller retires the showtime, see below
        <= 2h    ->  30    carts are abandoned most often close to showtime
        <= 6h    ->  60
        <= 24h   ->  90
        else     -> 300    far future — nothing changes today

    The 300 s far-future tier is what *pays* for the 30 s near-showtime tier.
    Most watched showtimes are days out (people plan ahead), so moving that
    majority from 90 s to 300 s more than offsets the showtimes inside two hours
    now polling three times as often: net upstream volume drops by roughly a
    third.  That matters because the Cineplex per-IP request budget, not CPU, is
    this system's existential constraint (docs/scaling.md Finding 2).

    **-1 is now actionable, not advisory.**  Before Cineplex's own start time was
    available this function could only ever guess, so callers clamped -1 up to
    the 30 s floor and waited for the API's ``isPostShowtime`` flag to confirm —
    which made a screening that had *already started* poll three times more often
    than one that hadn't.  With an authoritative start time, -1 means "this
    screening has begun" and the caller retires the showtime outright.
    ``isPostShowtime`` remains the backstop for showtimes whose metadata never
    resolved (``showtime_at IS NULL``), where this function still returns 90 and
    can never return -1.
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
    elif hours_until <= 24:
        return 90
    else:
        return 300


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
# Adjacent-seat threshold ("only alert me when N seats open together")
# ---------------------------------------------------------------------------


def _wants_groups(watch: Watch) -> bool:
    """Has this watch asked for block alerts at all?

    Legacy ``notify_any_seat`` watches are excluded whatever their threshold says:
    they track no fixed seat set, so there is nothing for a block to be made of —
    every seat in the room would qualify, which is what the flag already means.
    (Nothing can set that flag any more; watches predating its retirement still
    carry it.)
    """
    return (
        watch.min_adjacent_seats is not None
        and watch.min_adjacent_seats >= 2
        and not watch.notify_any_seat
    )


def _group_threshold(watch: Watch, benches: list[list[str]]) -> int | None:
    """The block size to enforce for this watch, or None to alert per seat.

    None also covers the one case where the threshold is set but unenforceable —
    an uncached seat layout, so nothing is known about which seats touch. The
    caller falls back to per-seat alerts and logs it; see the note at that call
    site for why falling back beats going quiet.
    """
    if not _wants_groups(watch) or not benches:
        return None
    return watch.min_adjacent_seats


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
    # It is also None for a *bridge* seat in an adjacent-seat block alert — a free
    # seat the user never picked that completes a block between two they did. Those
    # get no row: they are named in the message so the block can be booked, but
    # they are not seats the user chose to watch. The two cases are told apart by
    # the job's ``min_adjacent_seats``, not by this field.
    watched_seat_id: uuid.UUID | None

    def to_dict(self) -> dict:
        """JSON-safe form for the Celery ``send_notifications`` task payload."""
        return {
            "seat_key": self.seat_key,
            "seat_label": self.seat_label,
            "watched_seat_id": (
                str(self.watched_seat_id) if self.watched_seat_id else None
            ),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "_CandidateSeat":
        wsid = d["watched_seat_id"]
        return cls(
            seat_key=d["seat_key"],
            seat_label=d["seat_label"],
            watched_seat_id=uuid.UUID(wsid) if wsid else None,
        )


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
    # Display-only wall clock, fed to strftime by the renderers. Sourced from
    # watches.showtime_at (naive by column definition) or showtimes.showtime_local
    # (naive by design) — never from the aware-UTC showtimes.showtime_at. The
    # field name is kept for wire compatibility: it is a key in the Celery task
    # payload, so renaming it would break jobs already queued at deploy time.
    showtime_at: datetime | None
    theatre_id: int
    showtime_id: int
    candidate_seats: list[_CandidateSeat]
    # The watch's adjacent-seat threshold, or None for an ordinary per-seat alert.
    # Set means this batch is a *block* alert, which changes three things
    # downstream: the copy leads with "N seats together", untracked candidates are
    # bridges and get no watched_seats row, and the watch is not retired on
    # delivery (a block that breaks and re-forms is worth alerting again).
    min_adjacent_seats: int | None = None
    # One entry per qualifying block, each an ordered list of seat labels.  Carries
    # the grouping the flat ``candidate_seats`` list loses, so the renderers can
    # say "4 together: G4-G7" instead of just naming four seats.  None on per-seat
    # alerts, where there is no grouping to report.
    seat_blocks: list[list[str]] | None = None

    def to_dict(self) -> dict:
        """JSON-safe form for the Celery ``send_notifications`` task payload.

        Celery is configured with the JSON serializer (see celery_app.py), so a
        job crossing the task boundary must contain only JSON primitives. UUIDs
        become strings and the datetime becomes an ISO-8601 string;
        ``user_push_subscription`` is already a plain dict from the JSONB column.
        """
        return {
            "watch_id": str(self.watch_id),
            "user_email": self.user_email,
            "user_phone": self.user_phone,
            "user_push_subscription": self.user_push_subscription,
            "user_notify_via": self.user_notify_via,
            "watch_name": self.watch_name,
            "movie_name": self.movie_name,
            "theater_name": self.theater_name,
            "showtime_at": self.showtime_at.isoformat() if self.showtime_at else None,
            "theatre_id": self.theatre_id,
            "showtime_id": self.showtime_id,
            "candidate_seats": [c.to_dict() for c in self.candidate_seats],
            "min_adjacent_seats": self.min_adjacent_seats,
            "seat_blocks": self.seat_blocks,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "_NotifyJob":
        sa = d["showtime_at"]
        return cls(
            watch_id=uuid.UUID(d["watch_id"]),
            user_email=d["user_email"],
            user_phone=d["user_phone"],
            user_push_subscription=d["user_push_subscription"],
            user_notify_via=d["user_notify_via"],
            watch_name=d["watch_name"],
            movie_name=d["movie_name"],
            theater_name=d["theater_name"],
            showtime_at=datetime.fromisoformat(sa) if sa else None,
            theatre_id=d["theatre_id"],
            showtime_id=d["showtime_id"],
            candidate_seats=[_CandidateSeat.from_dict(c) for c in d["candidate_seats"]],
            # `.get`, not `[...]`: a job enqueued by the previous release is still
            # sitting in the broker at deploy time and carries neither key. Reading
            # them defensively is what lets the worker be restarted without
            # draining the queue first.
            min_adjacent_seats=d.get("min_adjacent_seats"),
            seat_blocks=d.get("seat_blocks"),
        )


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


async def _stop_showtime(db: AsyncSession, db_showtime: Showtime, *, reason: str) -> None:
    """Deactivate a showtime and expire every watch still active on it.

    The terminal state for a screening, reached two ways: the Cineplex API's
    ``isPostShowtime`` flag (``reason="post_showtime"``) or the screening's own
    start time having passed (``reason="start_time_passed"``).  Both mean the
    same thing to a user — the show is no longer watchable — so both land on the
    same ``is_active = False`` + ``status = 'expired'`` result.

    Does **not** commit or touch Redis; the caller owns the transaction boundary
    and the snapshot cleanup, because the two call sites reach here from
    different places in their own transactions.
    """
    await log.ainfo("showtime_ended", showtime_uuid=str(db_showtime.id), reason=reason)
    db_showtime.is_active = False
    watches_result = await db.execute(
        select(Watch).where(
            Watch.showtime_id == db_showtime.id,
            Watch.status == "active",
        )
    )
    for watch in watches_result.scalars():
        watch.status = "expired"


async def _retire_passed_showtimes(r, showtimes: list[Showtime]) -> None:
    """Retire showtimes whose start time has passed, without polling them.

    Deliberately runs *before* the fetch loop so a passed screening costs zero
    upstream requests: the showtime is already over, so whatever Cineplex would
    report about its seats is worthless.  Previously these kept polling — at the
    30 s floor, the most aggressive interval in the system — until the API
    happened to set ``isPostShowtime``.
    """
    async with _session_factory() as db:
        for showtime in showtimes:
            result = await db.execute(select(Showtime).where(Showtime.id == showtime.id))
            db_showtime = result.scalar_one_or_none()
            if db_showtime is None:
                continue  # Deleted between the cycle's load and now.
            await _stop_showtime(db, db_showtime, reason="start_time_passed")
        await db.commit()

    # Snapshots are only useful for diffing the next poll, and there won't be
    # one. (They would expire on their own 6 h TTL regardless — this just
    # reclaims the memory immediately, same as the isPostShowtime path.)
    for showtime in showtimes:
        await r.delete(make_snapshot_key(str(showtime.id)))


async def _run_poll_cycle(r) -> None:
    """Run one full poll cycle across active, *watched* showtimes (lock held).

    A showtime is only polled if it has at least one **active** watch. A
    showtime whose watches were all cancelled, removed, or expired (including the
    fully-delivered ones retired in :func:`_send_notifications`) still has
    ``is_active = True`` but nobody is waiting on it, so
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

    # Partition the loaded showtimes into three groups:
    #
    #   passed — Cineplex's own start time says the screening has begun. Retired
    #            below without ever being fetched.
    #   due    — their per-showtime poll_interval_sec has elapsed.
    #   (rest) — not due yet, skipped silently.
    #
    # The interval gate itself is unchanged; what's new is the passed check in
    # front of it. get_poll_interval only returns -1 for a showtime with resolved
    # metadata, so showtimes whose showtime_at is still NULL can never land here
    # and keep relying on isPostShowtime as before.
    now = datetime.now(timezone.utc)
    passed: list[Showtime] = []
    due: list[Showtime] = []
    for showtime in showtimes:
        if get_poll_interval(showtime.showtime_at) < 0:
            passed.append(showtime)
            continue
        if showtime.last_polled_at is not None:
            elapsed = (now - showtime.last_polled_at).total_seconds()
            if elapsed < showtime.poll_interval_sec:
                continue  # Not due yet — skip silently
        due.append(showtime)

    if passed:
        await _retire_passed_showtimes(r, passed)

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
        retired=len(passed),
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
    # Watches that asked for block alerts but couldn't get them because this
    # showtime's seat layout was never cached. Collected so the (should-be-
    # impossible) condition is logged once per showtime rather than once per watch.
    layout_gaps: set[uuid.UUID] = set()

    # --- 4. Persist changes to the DB and publish pub/sub events ---
    async with _session_factory() as db:
        # Reload the showtime inside this session for writes.
        st_result = await db.execute(select(Showtime).where(Showtime.id == showtime.id))
        db_showtime = st_result.scalar_one()

        # Computed once and reused for both the stop decision and the interval
        # assignment below, so the showtime can't cross its start boundary
        # between two calls and slip past the stop check into a clamped interval.
        new_interval = get_poll_interval(db_showtime.showtime_at)

        stop_reason: str | None = None
        if is_post_showtime:
            stop_reason = "post_showtime"
        elif new_interval < 0:
            # Start time crossed between this cycle's partition step and now — a
            # sub-cycle race, handled here so it still retires immediately rather
            # than waiting a full cycle.
            stop_reason = "start_time_passed"

        if stop_reason is not None:
            # Showtime is over — stop polling and expire all active watches.
            await _stop_showtime(db, db_showtime, reason=stop_reason)
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

            # Physical adjacency, for watches carrying an "N seats together"
            # threshold. Empty when the layout was never cached — see the
            # fallback note where it's consumed below.
            benches = seat_groups.build_benches(db_showtime.seat_layout_json)

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
                seat_blocks: list[list[str]] | None = None

                group_size = _group_threshold(watch, benches)
                if group_size is None and _wants_groups(watch) and not benches:
                    # Should be unreachable: the seat-map endpoint caches the layout
                    # the first time anyone opens the page, and fan-out copies it
                    # onto every sibling it creates. If it does happen we fall back
                    # to per-seat alerts rather than going silent — an alert that
                    # ignores the user's threshold is a nuisance, one that never
                    # arrives loses them the seats.
                    layout_gaps.add(watch.id)

                if group_size is not None:
                    # --- block path ---------------------------------------------
                    # Deliberately reads the *whole* current availability map, not
                    # just this poll's changes: a block completed by a seat that
                    # opened four polls ago is exactly the case the per-seat path
                    # cannot express. Dedup is the prev-vs-new crossing inside
                    # find_new_blocks, so `notified_at` is not consulted here —
                    # that is what lets a block that broke and re-formed alert
                    # again, which is the point of the feature.
                    blocks = seat_groups.find_new_blocks(
                        benches,
                        set(tracked),
                        prev_statuses,
                        new_statuses,
                        group_size,
                    )
                    for block in blocks:
                        for seat_key in block:
                            ws_row = tracked.get(seat_key)
                            candidates.append(
                                _CandidateSeat(
                                    seat_key=seat_key,
                                    seat_label=label_map.get(seat_key, seat_key),
                                    # None => a bridge seat, named in the message
                                    # but never given a watched_seats row.
                                    watched_seat_id=ws_row.id if ws_row else None,
                                )
                            )
                    seat_blocks = [
                        [label_map.get(seat_key, seat_key) for seat_key in block]
                        for block in blocks
                    ] or None
                else:
                    # --- per-seat path (unchanged) ------------------------------
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
                            # The user's per-watch date wins over the shared
                            # showtime metadata, mirroring how watch_name
                            # overrides movie_name above.
                            #
                            # NOTE the fallback is `showtime_local`, NOT
                            # `showtime_at`. Both are the same screening, but
                            # `showtime_at` is an aware UTC instant (it exists
                            # to be compared against now() by
                            # get_poll_interval) while this value is destined
                            # for strftime in the alert copy. Rendering the UTC
                            # column would email an 11:00 AM Vancouver
                            # screening as "6:00 PM" — the naive theatre-local
                            # column is the one users should read. Same reason
                            # watches.showtime_at is itself naive.
                            showtime_at=watch.showtime_at or db_showtime.showtime_local,
                            theatre_id=db_showtime.theatre_id,
                            showtime_id=db_showtime.showtime_id,
                            candidate_seats=candidates,
                            min_adjacent_seats=group_size,
                            seat_blocks=seat_blocks,
                        )
                    )

        # Update adaptive poll interval and timestamp. new_interval was computed
        # at the top of this transaction and is guaranteed positive here — a
        # passed showtime returned above instead of being clamped to the 30 s
        # floor (which used to make passed showtimes the *most* aggressively
        # polled rows in the table).
        db_showtime.poll_interval_sec = new_interval
        db_showtime.last_polled_at = datetime.now(timezone.utc)
        await db.commit()

    if layout_gaps:
        await log.awarning(
            "seat_group_layout_missing",
            showtime_uuid=str(showtime.id),
            theatre_id=showtime.theatre_id,
            showtime_id=showtime.showtime_id,
            watches=len(layout_gaps),
        )

    # --- 5. Persist the new snapshot after a successful DB commit ---
    await r.setex(snapshot_key, SNAPSHOT_TTL_SEC, json.dumps(new_statuses))

    # --- 6. Hand notifications off to a separate Celery task ---
    # Delivery used to be awaited inline here, which meant one showtime releasing
    # a large seat block (many watchers × email+SMS+push, each a blocking vendor
    # call) stalled the poll of every remaining showtime while holding this
    # coroutine's semaphore slot. Now we enqueue the batch and return
    # immediately: the poll cycle stays fast and bounded, and the separate task
    # gets Celery retries for free. The snapshot was already advanced above, so a
    # delayed send never causes re-detection of the same transition on the next
    # cycle (the diff is snapshot-based, not notified_at-based).
    #
    # celery.send_task publishes to the broker by task-name string, avoiding a
    # forward reference to the task object; the call is quick but does broker
    # I/O, so run it off the event loop via to_thread.
    if notify_jobs:
        payload = [job.to_dict() for job in notify_jobs]
        await asyncio.to_thread(
            celery.send_task, "tasks.send_notifications", args=[payload]
        )

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

    Every channel attempt (success *or* failure) is also recorded as a
    ``notifications`` audit-log row in the same persist transaction — the
    source of truth for real message-send volume (``notified_at`` counts
    seats, not messages).
    """
    sent_jobs: list[_NotifyJob] = []
    # (job, channel, ok) per attempted send — becomes one Notification row each.
    attempts: list[tuple[_NotifyJob, str, bool]] = []

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
                seat_blocks=job.seat_blocks,
            )
            attempts.append((job, "email", email_ok))
            any_channel_ok = any_channel_ok or email_ok

        if user_wants_sms(job.user_notify_via) and job.user_phone:
            sms_ok = await asyncio.to_thread(
                send_seat_available_sms,
                to_phone=job.user_phone,
                movie_name=display_name,
                seat_labels=seat_labels,
                theatre_id=job.theatre_id,
                showtime_id=job.showtime_id,
                seat_blocks=job.seat_blocks,
            )
            attempts.append((job, "sms", sms_ok))
            any_channel_ok = any_channel_ok or sms_ok

        if user_wants_push(job.user_notify_via) and job.user_push_subscription:
            push_ok = await asyncio.to_thread(
                send_seat_available_push,
                subscription_info=job.user_push_subscription,
                movie_name=display_name,
                seat_labels=seat_labels,
                theatre_id=job.theatre_id,
                showtime_id=job.showtime_id,
                seat_blocks=job.seat_blocks,
            )
            attempts.append((job, "push", push_ok))
            any_channel_ok = any_channel_ok or push_ok

        if any_channel_ok:
            sent_jobs.append(job)

    # Nothing was even attempted (every job filtered out by channel opt-ins) —
    # no dedup state to write and no audit rows to log.
    if not sent_jobs and not attempts:
        return

    # Persist notified_at in a fresh session so a transient DB error here
    # cannot roll back the seat events / pub/sub state already committed.
    now = datetime.now(timezone.utc)
    async with _session_factory() as db:
        # ---- Audit-log every channel attempt (success AND failure) ----
        # One row per message per channel. This is what makes true send volume
        # countable (/admin/stats "notifications") and comparable against the
        # Resend dashboard. On an at-least-once task retry the re-sent attempts
        # get logged again — which is accurate, since they really were re-sent.
        for job, channel, ok in attempts:
            db.add(
                Notification(
                    watch_id=job.watch_id,
                    user_email=job.user_email,
                    channel=channel,
                    success=ok,
                    seat_count=len(job.candidate_seats),
                    theatre_id=job.theatre_id,
                    showtime_id=job.showtime_id,
                )
            )

        for job in sent_jobs:
            for cand in job.candidate_seats:
                if cand.watched_seat_id is not None:
                    # Existing tracked seat — just stamp notified_at.
                    ws = await db.get(WatchedSeat, cand.watched_seat_id)
                    if ws is not None and ws.notified_at is None:
                        ws.notified_at = now
                elif job.min_adjacent_seats is None:
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
                # else: a bridge seat inside a block alert — a free seat the user
                # never picked that completes a block between two they did. It is
                # named in the message so they can book the whole block, but adding
                # a row would silently enrol them in watching a seat they didn't
                # choose (and would show up as a seat chip on their dashboard).
                # Block alerts don't need the row for dedup anyway: theirs is the
                # snapshot crossing in find_new_blocks, not notified_at.

        # ---- Retire fully-delivered watches ----
        # A specific-seat watch whose every tracked seat has now been notified has
        # nothing left to deliver. Dropping it out of 'active' is what lets the
        # zero-watch skip in _run_poll_cycle stop polling a showtime once *all* of
        # its watches are done (or removed) — cutting upstream volume, which is
        # the existential constraint (docs/scaling.md Finding 2).
        #
        # It is marked 'expired', not 'fulfilled'. The 'fulfilled' status was
        # retired from the product on 2026-07-29 (docs/bugs.md #14/#15): the
        # dashboard now has exactly two tabs, Active and Expired, and no card
        # carries a status pill, so a third value had nowhere to surface and read
        # as a distinction without a difference. The *value* survives in the
        # column and in every read path for rows written before that date —
        # retire the write, keep the read, run no destructive migration. Same call
        # bugs.md #8 made about 'cancelled'.
        #
        # notify_any_seat watches are EXCLUDED: they have no fixed target set, so
        # any future seat release is still worth an alert — they're never "done".
        # The SELECT below autoflushes the notified_at writes above, and the
        # session's identity map means the just-stamped rows report their new
        # notified_at here.
        #
        # Watches with an adjacent-seat threshold are excluded for the same reason
        # in a different shape. Their target is "a block of N", which can be
        # satisfied more than once: whoever books the block we just alerted about
        # was competing with this user for it, and the next block — or the same one
        # re-forming — is worth another alert. Retiring on first delivery would
        # make the feature strictly worse than the per-seat alerts it replaces.
        # Cost is that these watches keep polling until the screening starts.
        for watch_id in {job.watch_id for job in sent_jobs}:
            watch = await db.get(Watch, watch_id)
            if watch is None or watch.status != "active" or watch.notify_any_seat:
                continue
            if watch.min_adjacent_seats is not None:
                continue
            seats_result = await db.execute(
                select(WatchedSeat).where(WatchedSeat.watch_id == watch_id)
            )
            tracked_seats = list(seats_result.scalars().all())
            if tracked_seats and all(s.notified_at is not None for s in tracked_seats):
                watch.status = "expired"
                await log.ainfo("watch_delivered", watch_uuid=str(watch_id))

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


async def _run_send_notifications(jobs_payload: list[dict]) -> None:
    """Rehydrate a JSON job batch and run the shared send/persist logic."""
    jobs = [_NotifyJob.from_dict(d) for d in jobs_payload]
    await _send_notifications(jobs)


@celery.task(name="tasks.send_notifications", bind=True, max_retries=3)
def send_notifications(self, jobs_payload: list[dict]) -> None:
    """Deliver a batch of seat-available alerts, off the poll cycle's critical path.

    Enqueued by :func:`_poll_showtime` once a poll has committed. It rebuilds the
    ``_NotifyJob`` batch from its JSON payload and runs the same async
    send-and-persist logic that used to run inline (:func:`_send_notifications`):
    dispatch every opted-in channel per user, then in a fresh transaction stamp
    ``notified_at`` / create ``notify_any_seat`` rows / retire fully-delivered
    watches to ``expired``.

    Splitting this out of the poll task is the whole point: a popular showtime
    releasing a big seat block (many watchers × email+SMS+push, each a blocking
    vendor call) no longer stalls the polling of every other showtime.

    Delivery is **at-least-once**. A retry after a partial failure re-sends the
    whole batch (the send loop doesn't consult ``notified_at`` — only the persist
    step does, idempotently), so a rare transient vendor/DB error can produce a
    duplicate message. Steady-state duplicates are still prevented by the
    snapshot-based diff (a transition is detected once) plus the per-seat
    ``notified_at`` guard; only actual send/DB exceptions trigger a retry
    (invalid push subs are swallowed inside the transport and don't).
    """
    try:
        asyncio.run(_run_send_notifications(jobs_payload))
    except Exception as exc:
        log.error("send_notifications_task_failed", error=str(exc))
        raise self.retry(exc=exc, countdown=30)
