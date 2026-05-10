from celery import Celery

from app.config import settings

celery = Celery("cineplex_watcher", broker=settings.redis_url, backend=settings.redis_url)

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

# Autodiscover tasks in the app.tasks package so the worker registers them
# when it starts.  The beat_schedule above references the task by name string
# to avoid a circular import (poll_seats.py imports celery_app.py).
celery.autodiscover_tasks(["app.tasks"])
