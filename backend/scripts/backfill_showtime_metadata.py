"""Backfill movie/theatre/start-time metadata for showtimes created before the feature.

``showtimes.movie_name`` / ``theater_name`` / ``showtime_at`` were NULL for every
row from the first migration until the auto-resolution feature landed.  New rows
now resolve themselves the first time anyone views the seat map (see
``routers/showtimes.py``), but existing rows only would if someone happened to
open them again.  This walks them once.

Run it from inside the backend container::

    docker compose -f docker-compose.prod.yml exec backend \\
        sh -c 'cd /app && PYTHONPATH=/app python scripts/backfill_showtime_metadata.py'

(``-e PYTHONPATH=/app`` on ``docker compose exec`` does **not** propagate in this
environment — set it inside the shell, same as the alembic invocation.)

Options::

    --dry-run       list the rows that would be resolved, make no requests
    --limit N       stop after N rows (default: all)
    --delay SEC     seconds between rows (default: 1.0)

**Running on the host instead of in the container needs care.**  ``app/config.py``
declares ``env_file=".env"``, which resolves against the *current working
directory* — so running this from ``backend/`` finds no ``.env`` (the real one is
at the repo root), every setting silently falls back to its default, and
``cineplex_api_key`` ends up blank.  The script would then report every row as
unresolved for no visible reason.  Inside the container the values arrive as real
environment variables via compose's ``env_file:``, so this trap doesn't apply.

Safe to re-run: rows that resolved are skipped by ``should_resolve``, and rows
that failed are skipped by their Redis cooldown until it expires.
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Allow `python scripts/backfill_showtime_metadata.py` to work without the caller
# remembering PYTHONPATH: sys.path[0] is the scripts/ dir, so `app` is one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import structlog  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.config import settings  # noqa: E402
from app.logging_config import configure_logging  # noqa: E402
from app.models.showtime import Showtime  # noqa: E402
from app.services.redis_client import create_async_redis  # noqa: E402
from app.services.showtime_metadata import ensure_showtime_metadata  # noqa: E402

log = structlog.get_logger()

# One request per second by default.  The whole point of this script is that it
# fires the requests the app would otherwise have spread across weeks of page
# views, all at once, from the one IP Cineplex's WAF sees us on — so it is
# deliberately slower than it needs to be.
DEFAULT_DELAY_SEC = 1.0


async def backfill(*, limit: int | None, delay: float, dry_run: bool) -> None:
    """Resolve metadata for every showtime row that still lacks a movie name."""
    # A dedicated engine with NullPool, matching tasks/poll_seats.py: this is a
    # standalone process with its own event loop, so it must not share the
    # FastAPI engine's connection pool.
    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    redis = create_async_redis()

    resolved = failed = 0

    try:
        async with session_factory() as db:
            # Newest first: an old showtime has almost certainly aged out of
            # Cineplex's system and will 404, so front-loading recent rows gets
            # the useful results before the long tail of dead ones.
            stmt = (
                select(Showtime)
                .where(Showtime.movie_name.is_(None))
                .order_by(Showtime.created_at.desc())
            )
            if limit:
                stmt = stmt.limit(limit)
            rows = list((await db.execute(stmt)).scalars().all())

            await log.ainfo("backfill_start", pending=len(rows), dry_run=dry_run)

            for index, showtime in enumerate(rows):
                if dry_run:
                    await log.ainfo(
                        "backfill_would_resolve",
                        theatre_id=showtime.theatre_id,
                        showtime_id=showtime.showtime_id,
                        previously_attempted=showtime.metadata_fetched_at is not None,
                    )
                    continue

                if index:
                    # Throttle *between* rows rather than after the last one.
                    # Applied unconditionally — including to rows skipped by a
                    # cooldown, which cost no upstream request — because keeping
                    # the pacing dead simple is worth more here than shaving a
                    # couple of minutes off a one-off script.
                    await asyncio.sleep(delay)

                if await ensure_showtime_metadata(showtime, redis, db):
                    resolved += 1
                    await log.ainfo(
                        "backfill_resolved",
                        theatre_id=showtime.theatre_id,
                        showtime_id=showtime.showtime_id,
                        movie_name=showtime.movie_name,
                        showtime_local=(
                            showtime.showtime_local.isoformat()
                            if showtime.showtime_local
                            else None
                        ),
                    )
                else:
                    # Already logged in detail by the service (404, cooldown,
                    # transport error, …) — just keep the tally here.
                    failed += 1

            await log.ainfo(
                "backfill_complete",
                total=len(rows),
                resolved=resolved,
                unresolved=failed,
                dry_run=dry_run,
            )
    finally:
        await redis.aclose()
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="list the rows that would be resolved without making any requests",
    )
    parser.add_argument("--limit", type=int, default=0, help="stop after N rows (0 = all)")
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY_SEC,
        help=f"seconds between rows (default: {DEFAULT_DELAY_SEC})",
    )
    args = parser.parse_args()

    configure_logging()
    asyncio.run(
        backfill(limit=args.limit or None, delay=args.delay, dry_run=args.dry_run)
    )


if __name__ == "__main__":
    main()
