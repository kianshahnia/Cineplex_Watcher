"""Notification service — outbound seat-availability alerts.

Supports email (Resend), SMS (Twilio), and browser Web Push (pywebpush).

All three vendor SDKs are synchronous, so async callers (the Celery polling
task, FastAPI request handlers) should invoke the ``send_*`` functions via
``asyncio.to_thread`` to keep the event loop unblocked during network I/O.

Design notes
------------
- Each channel has a pure renderer (``build_seat_available_email`` /
  ``build_seat_available_sms`` / ``build_seat_available_push``) and a
  separate transport. The split keeps message content unit-testable
  without a network or API key.
- When the relevant API key / VAPID keys aren't configured, the ``send_*``
  function logs the message it *would* have sent and returns ``False``.
  That keeps the full pipeline exercised end-to-end during local
  development without forcing every contributor to wire up vendors on day
  one.
- Movie / theater / showtime metadata is currently always NULL on the
  ``showtimes`` row (see docs/context.md). Every field is rendered through
  a NULL-safe fallback so messages still look reasonable in the meantime.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from html import escape

import structlog

from app.config import settings

log = structlog.get_logger()


# Public Cineplex ticketing URL — what users actually click in the email.
# Same shape we already accept in services/cineplex.py:parse_cineplex_url().
CINEPLEX_BOOKING_URL = (
    "https://www.cineplex.com/ticketing/preview"
    "?theatreId={theatre_id}&showtimeId={showtime_id}"
)


@dataclass(frozen=True)
class RenderedEmail:
    """A fully-rendered email ready to hand to a transport (Resend/SMTP/etc.)."""

    subject: str
    text_body: str
    html_body: str


# ---------------------------------------------------------------------------
# Pure rendering — no I/O, easy to unit-test.
# ---------------------------------------------------------------------------


def _format_showtime(showtime_at: datetime | None) -> str:
    """Human-readable showtime string with a NULL-safe fallback.

    ``showtimes.showtime_at`` is currently NULL for every row because the
    Cineplex endpoints we use don't expose movie metadata (see
    docs/context.md). Once we discover a metadata source this will start
    rendering nicely without further changes here.
    """
    if showtime_at is None:
        return "Showtime"
    return showtime_at.strftime("%A, %b %d at %I:%M %p")


def build_seat_available_email(
    *,
    movie_name: str | None,
    theater_name: str | None,
    showtime_at: datetime | None,
    seat_labels: list[str],
    theatre_id: int,
    showtime_id: int,
) -> RenderedEmail:
    """Render the subject, plaintext body, and HTML body for a seat alert.

    ``seat_labels`` may contain one or more labels — the copy adapts
    automatically for singular vs. plural.
    """
    if not seat_labels:
        raise ValueError("seat_labels must contain at least one entry")

    movie = movie_name or "Your watched showtime"
    theater = theater_name or ""
    when = _format_showtime(showtime_at)
    book_url = CINEPLEX_BOOKING_URL.format(theatre_id=theatre_id, showtime_id=showtime_id)
    seats_str = ", ".join(seat_labels)
    plural = "seats are" if len(seat_labels) > 1 else "seat is"

    subject = f"{movie} — {seats_str} now available"

    text_lines = [
        f"Good news — the following {plural} now available for {movie}:",
        "",
        f"  {seats_str}",
        "",
    ]
    if theater:
        text_lines.append(theater)
    text_lines.extend([when, "", f"Book now: {book_url}", ""])
    text_body = "\n".join(text_lines)

    seat_chips = "".join(
        f'<span style="display:inline-block;padding:6px 12px;margin:4px 4px 4px 0;'
        f'background:#0e7c3a;color:#ffffff;border-radius:4px;font-weight:600;'
        f'font-family:Menlo,Consolas,monospace;">{escape(label)}</span>'
        for label in seat_labels
    )
    theater_html = (
        f'<p style="margin:0 0 4px 0;color:#555555;">{escape(theater)}</p>' if theater else ""
    )
    html_body = f"""<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f7f9;margin:0;padding:24px;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:24px;">
      <h2 style="margin:0 0 8px 0;color:#111111;font-size:20px;">{escape(movie)}</h2>
      {theater_html}
      <p style="margin:0 0 16px 0;color:#555555;">{escape(when)}</p>
      <p style="margin:0 0 8px 0;color:#111111;font-size:16px;">
        The following {plural} now available:
      </p>
      <p style="margin:0 0 20px 0;">{seat_chips}</p>
      <p style="margin:0;">
        <a href="{escape(book_url)}" style="display:inline-block;padding:12px 20px;background:#d62828;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:600;">
          Book on Cineplex
        </a>
      </p>
      <p style="margin:24px 0 0 0;color:#888888;font-size:12px;">
        You're receiving this because you set up a seat watch on Cineplex Watcher.
      </p>
    </td></tr>
  </table>
</body>
</html>
"""
    return RenderedEmail(subject=subject, text_body=text_body, html_body=html_body)


# ---------------------------------------------------------------------------
# Transport — Resend (synchronous). Wrap calls in asyncio.to_thread.
# ---------------------------------------------------------------------------


def send_seat_available_email(
    *,
    to_email: str,
    movie_name: str | None,
    theater_name: str | None,
    showtime_at: datetime | None,
    seat_labels: list[str],
    theatre_id: int,
    showtime_id: int,
) -> bool:
    """Send a seat-available email via Resend.

    Returns ``True`` on a successful API call, ``False`` if the send was
    skipped (no API key configured) or failed (logged for diagnosis).

    Synchronous on purpose — the Resend SDK is sync. Async callers should
    wrap this in ``asyncio.to_thread``.
    """
    if not seat_labels:
        return False

    email = build_seat_available_email(
        movie_name=movie_name,
        theater_name=theater_name,
        showtime_at=showtime_at,
        seat_labels=seat_labels,
        theatre_id=theatre_id,
        showtime_id=showtime_id,
    )

    if not settings.resend_api_key:
        # Dev mode: surface the email in logs so the alert pipeline is
        # observable end-to-end without a real Resend key.
        log.info(
            "seat_email_skipped_no_api_key",
            to=to_email,
            subject=email.subject,
            seats=seat_labels,
        )
        return False

    try:
        import resend

        resend.api_key = settings.resend_api_key
        resend.Emails.send(
            {
                "from": settings.from_email,
                "to": [to_email],
                "subject": email.subject,
                "html": email.html_body,
                "text": email.text_body,
            }
        )
    except Exception:
        log.exception("seat_email_send_failed", to=to_email, subject=email.subject)
        return False

    log.info("seat_email_sent", to=to_email, seats=seat_labels)
    return True


# ---------------------------------------------------------------------------
# SMS rendering — pure, no I/O.
# ---------------------------------------------------------------------------


# Twilio bills per 160-character segment (GSM-7) so we keep the body tight.
# Multiple seats are listed inline; if there are too many we elide.
_SMS_MAX_SEATS_INLINE = 6


def build_seat_available_sms(
    *,
    movie_name: str | None,
    seat_labels: list[str],
    theatre_id: int,
    showtime_id: int,
) -> str:
    """Render the SMS body for a seat alert.

    Kept short on purpose — most carriers split anything over 160 chars
    into multiple billable segments. Theater name and full showtime are
    omitted so the message stays in one segment when possible.
    """
    if not seat_labels:
        raise ValueError("seat_labels must contain at least one entry")

    movie = movie_name or "Cineplex"
    book_url = CINEPLEX_BOOKING_URL.format(theatre_id=theatre_id, showtime_id=showtime_id)

    if len(seat_labels) == 1:
        seats_phrase = f"Seat {seat_labels[0]} is now available"
    elif len(seat_labels) <= _SMS_MAX_SEATS_INLINE:
        seats_phrase = f"Seats {', '.join(seat_labels)} are now available"
    else:
        head = ", ".join(seat_labels[:_SMS_MAX_SEATS_INLINE])
        extra = len(seat_labels) - _SMS_MAX_SEATS_INLINE
        seats_phrase = f"{len(seat_labels)} seats now available ({head}, +{extra} more)"

    return f"{movie} - {seats_phrase}. Book: {book_url}"


# ---------------------------------------------------------------------------
# SMS transport — Twilio (synchronous). Wrap calls in asyncio.to_thread.
# ---------------------------------------------------------------------------


def send_seat_available_sms(
    *,
    to_phone: str,
    movie_name: str | None,
    seat_labels: list[str],
    theatre_id: int,
    showtime_id: int,
) -> bool:
    """Send a seat-available SMS via Twilio.

    Returns ``True`` on a successful API call, ``False`` if the send was
    skipped (Twilio not configured / phone number empty) or failed.

    ``to_phone`` must already be in E.164 format (``+15551234567``). We
    don't normalise here — the user is responsible for storing it
    correctly when they opt in.
    """
    if not seat_labels:
        return False
    if not to_phone:
        return False

    body = build_seat_available_sms(
        movie_name=movie_name,
        seat_labels=seat_labels,
        theatre_id=theatre_id,
        showtime_id=showtime_id,
    )

    if not (
        settings.twilio_account_sid
        and settings.twilio_auth_token
        and settings.twilio_from_number
    ):
        # Dev mode — log so the alert pipeline is observable end-to-end
        # without a real Twilio account.
        log.info("seat_sms_skipped_no_twilio_config", to=to_phone, body=body)
        return False

    try:
        from twilio.rest import Client

        client = Client(settings.twilio_account_sid, settings.twilio_auth_token)
        client.messages.create(
            body=body,
            from_=settings.twilio_from_number,
            to=to_phone,
        )
    except Exception:
        log.exception("seat_sms_send_failed", to=to_phone)
        return False

    log.info("seat_sms_sent", to=to_phone, seats=seat_labels)
    return True


# ---------------------------------------------------------------------------
# Web Push rendering — pure, no I/O.
# ---------------------------------------------------------------------------


# Browser Push payloads are capped at ~4 KB by the spec.  We send a small
# JSON object the frontend service worker decodes; UX (icon, click handler,
# accessibility) is the service worker's responsibility, not the backend's.
def build_seat_available_push(
    *,
    movie_name: str | None,
    seat_labels: list[str],
    theatre_id: int,
    showtime_id: int,
) -> dict:
    """Render the Web Push payload as a JSON-serialisable dict.

    Shape consumed by the frontend service worker::

        {
            "title": str,
            "body":  str,
            "url":   str,             # where to open on click
            "seats": list[str],       # for richer UI if the SW wants it
            "tag":   str,             # collapses repeats per showtime
        }
    """
    if not seat_labels:
        raise ValueError("seat_labels must contain at least one entry")

    movie = movie_name or "Cineplex Watcher"
    book_url = CINEPLEX_BOOKING_URL.format(theatre_id=theatre_id, showtime_id=showtime_id)

    if len(seat_labels) == 1:
        body = f"Seat {seat_labels[0]} is now available — tap to book."
    else:
        body = f"{len(seat_labels)} seats now available — tap to book."

    return {
        "title": movie,
        "body": body,
        "url": book_url,
        "seats": seat_labels,
        # Same `tag` collapses notifications about the same showtime so the
        # user doesn't accumulate a stack — the latest replaces older ones.
        "tag": f"cineplex-watcher-{theatre_id}-{showtime_id}",
    }


# ---------------------------------------------------------------------------
# Web Push transport — pywebpush (synchronous). Wrap calls in asyncio.to_thread.
# ---------------------------------------------------------------------------


def send_seat_available_push(
    *,
    subscription_info: dict | None,
    movie_name: str | None,
    seat_labels: list[str],
    theatre_id: int,
    showtime_id: int,
) -> bool:
    """Send a Web Push notification via pywebpush.

    Returns ``True`` on a successful push, ``False`` if the send was
    skipped (no subscription / VAPID not configured) or failed.

    ``subscription_info`` is the raw ``PushSubscription`` JSON the browser
    handed to the frontend, stored in ``users.push_subscription``.

    HTTP 404 / 410 from the push service means the subscription has been
    revoked or expired — we log it as ``seat_push_subscription_invalid``
    so a future cleanup task can null out the column. We don't clear it
    here because this function is intentionally side-effect-free relative
    to the DB.
    """
    if not seat_labels:
        return False
    if not subscription_info:
        return False

    payload = build_seat_available_push(
        movie_name=movie_name,
        seat_labels=seat_labels,
        theatre_id=theatre_id,
        showtime_id=showtime_id,
    )

    if not (settings.vapid_private_key and settings.vapid_claim_email):
        # Dev mode — log so the alert pipeline is observable end-to-end
        # without generating VAPID keys.
        log.info("seat_push_skipped_no_vapid_config", payload=payload)
        return False

    try:
        from pywebpush import WebPushException, webpush

        webpush(
            subscription_info=subscription_info,
            data=json.dumps(payload),
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_claim_email},
        )
    except WebPushException as exc:
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        if status_code in (404, 410):
            # Subscription expired or unsubscribed — surface clearly so a
            # cleanup job can null the column on the next pass.
            log.warning(
                "seat_push_subscription_invalid",
                status_code=status_code,
                endpoint=subscription_info.get("endpoint"),
            )
        else:
            log.exception("seat_push_send_failed", status_code=status_code)
        return False
    except Exception:
        log.exception("seat_push_send_failed")
        return False

    log.info("seat_push_sent", seats=seat_labels)
    return True


# ---------------------------------------------------------------------------
# notify_via parsing
# ---------------------------------------------------------------------------


def _channels(notify_via: str | None) -> set[str]:
    """Parse the comma-separated ``users.notify_via`` column.

    Case-insensitive, whitespace-tolerant. Returns an empty set if the
    column is NULL / empty.
    """
    if not notify_via:
        return set()
    return {channel.strip().lower() for channel in notify_via.split(",") if channel.strip()}


def user_wants_email(notify_via: str | None) -> bool:
    """Return True if the user has opted in to email notifications.

    ``users.notify_via`` is a comma-separated list of channels
    (``'email'``, ``'sms'``, ``'push'``). The default at signup is
    ``'email'``.
    """
    return "email" in _channels(notify_via)


def user_wants_sms(notify_via: str | None) -> bool:
    """Return True if the user has opted in to SMS notifications.

    Caller is still responsible for checking that ``users.phone`` is
    populated — opting in without a phone number is a no-op.
    """
    return "sms" in _channels(notify_via)


def user_wants_push(notify_via: str | None) -> bool:
    """Return True if the user has opted in to browser push notifications.

    Caller is still responsible for checking that
    ``users.push_subscription`` is non-NULL — opting in without
    subscribing in the browser is a no-op.
    """
    return "push" in _channels(notify_via)
