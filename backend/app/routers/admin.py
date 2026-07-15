"""Admin router — operator-only usage metrics.

Every route here is guarded by :func:`get_current_admin`: the caller must be
authenticated (session cookie) AND have their email listed in the
``ADMIN_EMAILS`` setting. A signed-out request gets 401; a signed-in
non-admin gets 403.
"""

import structlog
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.schemas.auth import ErrorResponse
from app.schemas.stats import AdminStatsData, AdminStatsResponse
from app.services import stats as stats_service
from app.services.auth import get_current_admin
from app.services.rate_limit import limiter

log = structlog.get_logger()

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get(
    "/stats",
    response_model=AdminStatsResponse,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
    },
    summary="Usage metrics snapshot (admin only)",
)
# Per-user (the caller is always authenticated here, so the default
# user-or-IP key resolves to user:{uuid}). A dozen COUNT queries per call —
# 30/min is far more than an operator refreshing a dashboard needs while
# still blocking any scripted hammering.
@limiter.limit("30/minute")
async def get_admin_stats(
    request: Request,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminStatsResponse:
    """Return aggregate usage metrics across the whole app.

    Counts of users, logins, watches (by status), showtimes, watched seats,
    notifications fired, and seat-open events. Strictly read-only — issues
    only ``COUNT`` queries, writes nothing.
    """
    data = await stats_service.get_stats(db)
    await log.ainfo("admin_stats_viewed", admin_email=admin.email)
    return AdminStatsResponse(data=AdminStatsData.model_validate(data))
