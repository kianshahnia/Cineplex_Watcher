"""Structlog configuration and HTTP request-logging middleware.

Call :func:`configure_logging` once at process startup — in ``main.py`` for
the uvicorn server and in ``tasks/celery_app.py`` for Celery workers.  After
that every ``structlog.get_logger()`` call in the codebase shares the same
processor chain.

The :func:`log_requests` middleware binds a ``request_id``, ``method``, and
``path`` to structlog's context-var store at the start of every HTTP request.
Because structlog's context vars propagate through ``await`` chains, any log
call made deeper in the stack — in routers, services, or tasks that happen to
be awaited synchronously — will automatically include those fields.  This
makes cross-cutting a single request across many log lines trivial.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

import structlog
from starlette.requests import Request
from starlette.responses import Response

from app.config import settings

_configured = False


def configure_logging() -> None:
    """Wire up structlog and the stdlib root logger.

    Idempotent — safe to call multiple times (only the first call has any
    effect).  Subsequent calls are no-ops so that test suites or modules that
    call this defensively don't reset configuration set up by their harness.
    """
    global _configured
    if _configured:
        return
    _configured = True

    # Processors shared between structlog's own pipeline and the
    # ProcessorFormatter that handles stdlib log records forwarded by uvicorn,
    # SQLAlchemy, celery, etc.
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,  # inject per-request fields
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.ExceptionRenderer(),
    ]

    renderer: structlog.types.Processor
    if settings.log_json:
        # Production: one JSON object per line — easy for log aggregators.
        renderer = structlog.processors.JSONRenderer()
    else:
        # Development: coloured, human-readable console output.
        renderer = structlog.dev.ConsoleRenderer(colors=True)

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        # Cache the resolved processor chain on first use; restart the process
        # (or call structlog.reset_defaults()) if you need dynamic reconfiguration.
        cache_logger_on_first_use=True,
    )

    # ProcessorFormatter bridges stdlib logging (uvicorn, sqlalchemy, celery)
    # through the same structlog pipeline so all log output looks identical.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(settings.log_level.upper())

    # Our structured middleware replaces uvicorn's built-in access log to
    # avoid duplicate (and unstructured) per-request lines in the output.
    logging.getLogger("uvicorn.access").propagate = False
    logging.getLogger("uvicorn.access").handlers = []

    # SQLAlchemy can be extremely chatty at DEBUG; unless the operator
    # explicitly asked for DEBUG output, keep the engine at WARNING.
    if settings.log_level.upper() != "DEBUG":
        logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)


_req_log = structlog.get_logger("http")


async def log_requests(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """Structured per-request log line with timing and status.

    Binds ``request_id``, ``method``, and ``path`` into structlog's context-var
    store before the request is dispatched so every downstream log call
    automatically inherits them.  Logs a final ``http.response`` event (or
    ``http.request_failed`` for unhandled exceptions) with the HTTP status code
    and elapsed time in milliseconds.  Attaches ``X-Request-Id`` to the
    response so callers can correlate their own logs with server-side entries.
    """
    request_id = uuid.uuid4().hex[:12]

    # Reset any context left over from a previous request on this coroutine
    # (shouldn't happen with per-request tasks, but defensive is cheap).
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        request_id=request_id,
        method=request.method,
        path=request.url.path,
    )

    start = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        structlog.contextvars.bind_contextvars(status_code=500, duration_ms=duration_ms)
        await _req_log.aexception("http.request_failed")
        raise

    duration_ms = round((time.perf_counter() - start) * 1000, 1)
    structlog.contextvars.bind_contextvars(
        status_code=response.status_code,
        duration_ms=duration_ms,
    )

    if response.status_code >= 500:
        await _req_log.aerror("http.response")
    elif response.status_code >= 400:
        await _req_log.awarning("http.response")
    else:
        await _req_log.ainfo("http.response")

    response.headers["X-Request-Id"] = request_id
    return response
