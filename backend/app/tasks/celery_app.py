from celery import Celery

from app.config import settings

celery = Celery("cineplex_watcher", broker=settings.redis_url, backend=settings.redis_url)

celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    beat_schedule={},
)
