from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.logging_config import configure_logging, log_requests
from app.routers import auth, movies, showtimes, watches, ws
from app.services.rate_limit import limiter, rate_limit_exceeded_handler
from app.services.redis_client import create_async_redis

# Configure structlog + stdlib logging before any log event fires.
configure_logging()

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Create one shared async Redis client for the lifetime of the process.
    # The WebSocket router (Phase 3 Step 2) accesses it via app.state.redis.
    app.state.redis = create_async_redis()
    await log.ainfo("starting up", database=settings.database_url.split("@")[-1])
    yield
    await app.state.redis.aclose()
    await log.ainfo("shutting down")


app = FastAPI(
    title="Cineplex Seat Watcher",
    version="0.1.0",
    lifespan=lifespan,
)

# --- Rate limiting (Phase 5 Step 2) ---
# slowapi expects the limiter on ``app.state.limiter`` so the ``@limiter.limit``
# decorators can find it at request time.  The custom exception handler maps
# slowapi's ``RateLimitExceeded`` into our standard ``{data, error}`` envelope.
# NOTE: we deliberately do NOT mount SlowAPIMiddleware — combining the
# middleware with per-route decorators double-wraps each request and triggers
# an ``AttributeError: 'State' object has no attribute 'view_rate_limit'`` on
# the response-headers injection path.  The decorators alone are enough.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)


@app.middleware("http")
async def _ensure_rate_limit_state(request, call_next):
    """Defensive: guarantee ``request.state.view_rate_limit`` exists.

    slowapi's per-route decorator reads ``request.state.view_rate_limit``
    after the endpoint runs (to inject ``X-RateLimit-*`` headers).  That
    attribute is normally set by the limit-check pass, but when the storage
    backend (Redis) is unreachable AND ``swallow_errors=True`` is configured,
    the check is silently skipped and the attribute is never assigned —
    which then surfaces as a 500 ``AttributeError`` on the success path.

    Pre-seeding the attribute to ``None`` makes the read total: present, but
    no headers to inject.  Costs one attribute assignment per request.
    """
    request.state.view_rate_limit = None
    return await call_next(request)

# CORS — allow the Next.js frontend to send cookies cross-origin.
# Origins come from the CORS_ORIGINS env var (comma-separated) so production
# domains don't require a code change.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request logging — added last so it becomes the outermost middleware layer.
# Each call to add_middleware() inserts at position 0 of the stack, so the
# last call here runs first on every incoming request.  This ensures that
# request_id + duration capture all processing, including CORS and rate-limit
# checks.  WebSocket upgrade requests (scope["type"] == "websocket") bypass
# BaseHTTPMiddleware entirely and are not logged here.
app.add_middleware(BaseHTTPMiddleware, dispatch=log_requests)

# --- Routers ---
app.include_router(auth.router)
app.include_router(watches.router)
app.include_router(showtimes.router)
app.include_router(movies.router)
app.include_router(ws.router)


@app.get("/health")
async def health() -> dict[str, str]:
    # Intentionally NOT rate-limited — used by Docker / orchestrators for
    # liveness probes that fire on a tight interval.
    return {"status": "ok"}
