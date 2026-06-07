"""Rate limiting for HTTP endpoints (Phase 5 Step 2).

We use **slowapi** — a FastAPI/Starlette-friendly wrapper around the
`limits` library — backed by **Redis** so per-endpoint counters stay
consistent across uvicorn workers, multiple containers, and any future
horizontal scaling.

Design goals
------------
1. **Per-endpoint limits**, not one global ceiling. The right rate for
   ``POST /auth/login`` is nothing like the right rate for ``GET /auth/me``.
2. **Authenticated users get per-user quotas**; anonymous traffic gets
   per-IP quotas. This is what :func:`user_or_ip_key` implements.
3. **The most dangerous endpoint is ``POST /auth/login``**: it sends real
   email (cost + abuse vector) and writes a row to ``magic_links``.  An
   attacker can spam a victim's inbox from rotating IPs unless we *also*
   throttle by target email.  :func:`enforce_email_login_limit` provides
   that second axis; it runs in addition to the per-IP slowapi limit.
4. **429 responses use the same ``{data, error}`` envelope** as the rest of
   the API so the frontend's :class:`ApiError` surfaces them cleanly,
   *and* they include a ``Retry-After`` header so well-behaved clients
   know exactly how long to back off.
5. **Reasoning the auth boundary into the key function** means we trust
   the JWT signature, not the user's claimed identity — a forged cookie
   simply falls back to per-IP bucketing.  No DB hit per request.
"""

from __future__ import annotations

import re

import jwt as pyjwt
import structlog
from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import settings

log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Client IP extraction
# ---------------------------------------------------------------------------


def client_ip(request: Request) -> str:
    """Return the client's IP, honouring ``X-Forwarded-For`` only when configured.

    Why this exists separately from ``slowapi.util.get_remote_address``:
    ``get_remote_address`` blindly returns ``request.client.host``, which on a
    deploy behind a proxy will be the proxy's IP — letting any single
    upstream client trivially consume the whole limit for every other user
    behind that proxy.

    We only trust ``X-Forwarded-For`` when ``rate_limit_trust_forwarded_for``
    is explicitly turned on (i.e. when an operator has confirmed there's a
    proxy in front of us scrubbing untrusted header values).
    """
    if settings.rate_limit_trust_forwarded_for:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # The header is a comma-separated list — leftmost entry is the
            # *originating* client (the proxy appends its own peer on the right).
            return forwarded.split(",")[0].strip()
    return get_remote_address(request)


# ---------------------------------------------------------------------------
# JWT-aware key function
# ---------------------------------------------------------------------------


def _decoded_user_id(request: Request) -> str | None:
    """Try to read the user UUID out of the session cookie *without* hitting the DB.

    Returns ``None`` for any failure mode (missing cookie, bad signature,
    expired token, missing ``sub`` claim). The caller falls back to per-IP
    bucketing — which is the safe default for unauthenticated traffic.
    """
    token = request.cookies.get("session_token")
    if not token:
        return None
    try:
        payload = pyjwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
        )
    except pyjwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    return str(sub) if sub else None


def user_or_ip_key(request: Request) -> str:
    """Key function: authenticated → per-user, otherwise → per-IP.

    Prefixed with ``user:`` / ``ip:`` so the two namespaces never collide
    (a malicious IP can't poison a real user's bucket by guessing a UUID).
    """
    user_id = _decoded_user_id(request)
    if user_id:
        return f"user:{user_id}"
    return f"ip:{client_ip(request)}"


def ip_key(request: Request) -> str:
    """Key function: always per-IP, regardless of auth state.

    Use this for endpoints that are intentionally unauthenticated
    (``POST /auth/login``, ``POST /showtimes/parse-url``,
    ``GET /showtimes/{...}``) — a single user shouldn't be able to hammer
    these any harder just because they happen to be signed in.
    """
    return f"ip:{client_ip(request)}"


# ---------------------------------------------------------------------------
# Limiter instance
# ---------------------------------------------------------------------------


def _storage_uri() -> str:
    """Resolve the storage URI, defaulting to the shared Redis."""
    if settings.rate_limit_storage_uri:
        return settings.rate_limit_storage_uri
    # `limits` understands the plain `redis://...` scheme that we already use
    # for pub/sub. We deliberately reuse the same instance — separate DBs are
    # unnecessary overhead and would only marginally isolate keyspaces.
    return settings.redis_url


limiter = Limiter(
    key_func=user_or_ip_key,
    storage_uri=_storage_uri(),
    # "moving-window" is more accurate than the default fixed-window strategy
    # — no burst-at-the-boundary loophole — at the cost of one extra Redis op
    # per check. Worth it for our traffic level.
    strategy="moving-window",
    # Honour the on/off switch from settings so tests / load runs can disable
    # without ripping decorators off every endpoint.
    enabled=settings.rate_limit_enabled,
    # Don't let a transient Redis blip take down the API. If we can't reach
    # storage, slowapi logs a warning and lets the request through.
    swallow_errors=True,
    # Standard X-RateLimit-* headers are disabled deliberately.  slowapi's
    # in-decorator header injection path (``_inject_headers``) reads
    # ``request.state.view_rate_limit`` which isn't reliably populated when
    # mixing per-route ``@limiter.limit`` decorators with our custom 429
    # handler — it surfaces as a 500 ``AttributeError`` after a successful
    # response, which is far worse than the missing observability header.
    # ``Retry-After`` is still set explicitly by ``rate_limit_exceeded_handler``
    # on 429 responses, which is the header that actually matters for
    # well-behaved clients.
    headers_enabled=False,
)


# ---------------------------------------------------------------------------
# 429 handler — returns the {data, error} envelope
# ---------------------------------------------------------------------------


_PERIOD_RE = re.compile(r"per\s+(\d+)\s+(second|minute|hour|day)", re.IGNORECASE)
_UNIT_SECONDS = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}


def _retry_after_seconds(detail: str) -> int:
    """Best-effort parse of "X per N <unit>" → seconds to wait.

    slowapi's :class:`RateLimitExceeded` stringifies the broken limit but
    doesn't expose the reset time directly without an extra Redis round
    trip.  For a user-facing ``Retry-After`` the window length is a fine
    upper bound — slightly pessimistic, never wrong.
    """
    match = _PERIOD_RE.search(detail or "")
    if not match:
        return 60
    n = int(match.group(1))
    unit = match.group(2).lower()
    return n * _UNIT_SECONDS[unit]


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Custom 429 response that matches our standard envelope.

    Frontends consuming ``ApiError`` will surface ``error.message`` directly,
    so the message is written as something a real user could reasonably read
    ("You're doing that too fast…") rather than the raw slowapi default
    ("5 per 1 minute").
    """
    retry_after = _retry_after_seconds(str(exc.detail))
    body = {
        "data": None,
        "error": {
            "message": (
                "You're making requests too quickly. "
                f"Please wait {retry_after} second(s) and try again."
            ),
            "retry_after_seconds": str(retry_after),
        },
    }
    response = JSONResponse(status_code=429, content=body)
    # Standard hint for well-behaved clients (browsers, mobile apps, curl
    # scripts) to throttle themselves automatically.
    response.headers["Retry-After"] = str(retry_after)
    return response


# ---------------------------------------------------------------------------
# Email-bombing guard for POST /auth/login
# ---------------------------------------------------------------------------

# Tunables for the email-side login limit. Aggressive on purpose: the
# per-(IP, email) bucket only blocks attempts to abuse one *specific* inbox,
# so a legitimate first-time visitor whose first request triggered a typo'd
# email won't be locked out of using their *correct* email immediately.
LOGIN_EMAIL_MAX_PER_WINDOW = 3
LOGIN_EMAIL_WINDOW_SECONDS = 60 * 10  # 10 minutes


class EmailLoginRateLimited(Exception):
    """Raised by :func:`enforce_email_login_limit` when the per-email cap is hit.

    Kept as a plain exception (not an ``HTTPException``) so the router can
    convert it into our standard 429 envelope — symmetric with how slowapi's
    :class:`RateLimitExceeded` is converted by :func:`rate_limit_exceeded_handler`.
    """

    def __init__(self, retry_after: int) -> None:
        super().__init__("Too many login attempts for this email.")
        self.retry_after = retry_after


async def enforce_email_login_limit(email: str, redis) -> None:
    """Throttle magic-link requests *per target email*, regardless of source IP.

    Why this exists in addition to the per-IP slowapi decorator on
    ``POST /auth/login``:

    Without a per-email cap, an attacker with a botnet (or a single host
    that rotates through residential proxies) can fan out across thousands
    of source IPs while pointing every request at one victim's inbox.
    Per-IP limits don't help — each IP is well under its own ceiling — but
    the victim gets buried in magic-link emails and our Resend bill grows.

    Implementation is the canonical Redis token-counter: ``INCR`` the key,
    ``EXPIRE`` on the first hit so the window auto-cleans, raise when the
    count exceeds the cap.  ``INCR`` + ``EXPIRE`` is two ops but the race
    is benign — the worst case is the bucket lives 1 op longer than the
    window, which only matters at the microsecond boundary.

    Email is normalised the same way :func:`services.auth.create_magic_link`
    normalises it (lower + strip), so "Foo@Bar.com" and "  foo@bar.com  "
    share a bucket.
    """
    normalized = email.lower().strip()
    key = f"ratelimit:login:email:{normalized}"
    try:
        count = await redis.incr(key)
        if count == 1:
            # First hit — start the TTL.  If the EXPIRE itself fails we
            # still throttle correctly (count keeps climbing), we just leak
            # the key with no expiry until the next refresh; tolerable.
            await redis.expire(key, LOGIN_EMAIL_WINDOW_SECONDS)
        if count > LOGIN_EMAIL_MAX_PER_WINDOW:
            ttl = await redis.ttl(key)
            # ttl == -1 means the key has no expiry (EXPIRE failed earlier);
            # fall back to the full window length so the user isn't told to
            # wait forever.
            retry_after = ttl if isinstance(ttl, int) and ttl > 0 else LOGIN_EMAIL_WINDOW_SECONDS
            await log.awarning(
                "login_email_rate_limited",
                email=normalized,
                count=count,
                retry_after=retry_after,
            )
            raise EmailLoginRateLimited(retry_after=retry_after)
    except EmailLoginRateLimited:
        raise
    except Exception as exc:
        # A Redis outage MUST NOT take down login. Log and fall through;
        # the per-IP slowapi limit still provides a safety net.
        await log.awarning("login_email_rate_limit_check_failed", error=str(exc))


# ---------------------------------------------------------------------------
# WebSocket connection-rate guard
# ---------------------------------------------------------------------------

# slowapi's decorator-based limits don't reach WebSocket handlers (they run
# off the HTTP request pipeline). We need a small manual counter so a single
# user / IP can't open thousands of WebSocket connections — each one
# subscribes to a Redis pubsub channel and holds a long-lived socket, so the
# resource cost per connection is non-trivial.
WS_CONNECT_MAX_PER_WINDOW = 30
WS_CONNECT_WINDOW_SECONDS = 60


class WsConnectRateLimited(Exception):
    """Raised when a single key exceeds the WebSocket connect-attempt cap."""

    def __init__(self, retry_after: int) -> None:
        super().__init__("Too many WebSocket connection attempts.")
        self.retry_after = retry_after


async def enforce_ws_connect_limit(*, key: str, redis) -> None:
    """Throttle WebSocket connection attempts (handshakes) per key.

    Same Redis-counter pattern as :func:`enforce_email_login_limit`.  The
    ``key`` is whatever the caller decides — typically ``user:{uuid}`` for
    an authenticated socket or ``ip:{addr}`` for an anonymous one — so the
    bucket aligns with how slowapi keys HTTP requests for the same actor.

    Counts every *handshake*, not just successful upgrades.  A flood of
    rejected connections (auth failures, invalid showtimes) is just as
    expensive as a flood of accepted ones — we want to throttle both.
    """
    redis_key = f"ratelimit:ws:connect:{key}"
    try:
        count = await redis.incr(redis_key)
        if count == 1:
            await redis.expire(redis_key, WS_CONNECT_WINDOW_SECONDS)
        if count > WS_CONNECT_MAX_PER_WINDOW:
            ttl = await redis.ttl(redis_key)
            retry_after = ttl if isinstance(ttl, int) and ttl > 0 else WS_CONNECT_WINDOW_SECONDS
            await log.awarning(
                "ws_connect_rate_limited",
                key=key,
                count=count,
                retry_after=retry_after,
            )
            raise WsConnectRateLimited(retry_after=retry_after)
    except WsConnectRateLimited:
        raise
    except Exception as exc:
        # Redis failure → fail open. Better to risk a few extra sockets than
        # to break real-time updates for every user during a Redis blip.
        await log.awarning("ws_connect_rate_limit_check_failed", error=str(exc))
