from celery import Celery

from app.config import settings
from app.logging_config import configure_logging

# Configure structlog before any task code runs so Celery worker logs are
# structured the same way as FastAPI server logs.
configure_logging()

celery = Celery(
    "cineplex_watcher",
    broker=settings.redis_url,
    backend=settings.redis_url,
    # Point at the module that actually defines the task. ``app.tasks`` is just
    # an (empty) package __init__, so including it registered nothing — the
    # worker booted with an empty task list and rejected every beat message with
    # "Received unregistered task of type 'tasks.poll_seats'".
    include=["app.tasks.poll_seats"],
)

celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        # Fire every 30 s — the minimum poll interval.  The task itself skips
        # showtimes whose poll_interval_sec hasn't elapsed yet.
        "poll-seats-every-30s": {
            "task": "tasks.poll_seats",
            "schedule": 30.0,
        },
    },
)

# The beat_schedule above references the task by its name string
# ("tasks.poll_seats") rather than importing it, which avoids the circular
# import (poll_seats.py imports `celery` from this module). Registration of the
# task object itself is handled by the ``include=`` argument above, imported
# when the worker finalizes the app on startup.
