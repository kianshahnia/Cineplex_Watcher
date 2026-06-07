"""Auth router — magic link login, verification, session management."""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.schemas.auth import ErrorResponse, LoginRequest, MeResponse, MessageResponse, UserResponse
from app.services.auth import (
    create_jwt,
    create_magic_link,
    get_current_user,
    get_or_create_user,
    verify_magic_link,
)
from app.services.rate_limit import (
    EmailLoginRateLimited,
    enforce_email_login_limit,
    ip_key,
    limiter,
)

log = structlog.get_logger()

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post(
    "/login",
    response_model=MessageResponse,
    responses={400: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
)
# Per-IP cap — the *first* axis of defence. A single source IP can't request
# more than 5 magic links per minute regardless of which email they target.
# Strict because every successful call sends a real email (cost + spam vector)
# and writes a magic_links row (DB fill).
@limiter.limit("5/minute", key_func=ip_key)
async def login(
    request: Request,
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Request a magic link.

    Generates a crypto-random token, persists it, and (in production) sends an
    email containing a verification link.  For now the link is returned in the
    response so you can test locally without an email provider configured.

    Rate limited on two axes:

    - **Per source IP**: ``5/minute`` (handled by the slowapi decorator above).
    - **Per target email**: ``3 / 10 minutes`` (handled below via
      :func:`enforce_email_login_limit`).  Defends against distributed
      bombing of a single victim's inbox from a botnet — per-IP limits alone
      don't catch this.
    """
    # Per-email throttle runs INSIDE the handler because the email is in the
    # request body — slowapi's key functions only see the raw Request and
    # would have to consume the body to read it.  Doing the check here keeps
    # body-parsing centralised in FastAPI/Pydantic.
    try:
        await enforce_email_login_limit(body.email, request.app.state.redis)
    except EmailLoginRateLimited as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Too many magic-link requests for this email. "
                f"Please wait {exc.retry_after} second(s) and try again."
            ),
            headers={"Retry-After": str(exc.retry_after)},
        )

    magic_link = await create_magic_link(body.email, db)

    verification_url = f"{settings.magic_link_base_url}?token={magic_link.token}"

    # TODO: Phase 3 — send this URL via Resend email.  For local dev we log it
    # so you can click through manually.
    await log.ainfo("magic_link_url", url=verification_url)

    # In production, you would NOT return the token in the response body.
    # This is here only to make local development possible without Resend configured.
    if not settings.resend_api_key:
        return MessageResponse(
            data={
                "message": "Magic link created (dev mode — no email sent).",
                "verification_url": verification_url,
            }
        )

    # When Resend is configured, send the email and return a generic message
    # so the token is never exposed in the API response.
    try:
        import resend

        resend.api_key = settings.resend_api_key
        resend.Emails.send(
            {
                "from": settings.from_email,
                "to": [body.email],
                "subject": "Your Cineplex Watcher login link",
                "html": (
                    f"<p>Click below to log in. This link expires in "
                    f"{settings.magic_link_expire_minutes} minutes.</p>"
                    f'<p><a href="{verification_url}">Log in to Cineplex Watcher</a></p>'
                ),
            }
        )
    except Exception:
        await log.aexception("resend_send_failed", email=body.email)
        return MessageResponse(data={"message": "Magic link created (email send failed — check logs)."})

    return MessageResponse(data={"message": "Check your email for a login link."})


@router.get(
    "/verify",
    response_model=MessageResponse,
    responses={400: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
)
# Per-IP cap on verification — a 64-char URL-safe token (~384 bits) is
# computationally infeasible to brute force, so this isn't a real anti-guess
# defence; it's an anti-enumeration / log-noise defence.  Each verify call
# touches the DB twice (select + update) and we don't want a stuck loop in a
# misbehaving client hammering it.
@limiter.limit("10/minute", key_func=ip_key)
async def verify(
    request: Request,
    response: Response,
    token: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Verify a magic link token and issue a session cookie.

    The frontend redirects the user here after they click the email link.
    On success, an httpOnly cookie named ``session_token`` is set containing
    a signed JWT, and the user is created if they don't already exist.
    """
    magic_link = await verify_magic_link(token, db)
    user = await get_or_create_user(magic_link.email, db)
    jwt_token = create_jwt(user.id, user.email)

    # Set an httpOnly, secure (in prod) cookie so the frontend never touches the JWT
    response.set_cookie(
        key="session_token",
        value=jwt_token,
        httponly=True,
        secure=False,  # TODO: set True in production behind HTTPS
        samesite="lax",
        max_age=settings.jwt_expire_days * 86400,
        path="/",
    )

    await log.ainfo("user_logged_in", user_id=str(user.id), email=user.email)

    return MessageResponse(data={"message": "Logged in successfully."})


@router.get(
    "/me",
    response_model=MeResponse,
    responses={401: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
)
# Generous — /auth/me is called by the frontend on most navigations and at
# startup.  60/min gives normal usage a comfortable margin; a runaway client
# polling /me every second will still get caught.
@limiter.limit("60/minute")
async def me(request: Request, user: User = Depends(get_current_user)) -> MeResponse:
    """Return the currently authenticated user's profile."""
    return MeResponse(data=UserResponse.model_validate(user))


@router.post(
    "/logout",
    response_model=MessageResponse,
    responses={429: {"model": ErrorResponse}},
)
# Per-IP — logout is unauthenticated in practice (cookie may already be
# invalid).  Loose because there's no real abuse vector, just hygiene.
@limiter.limit("30/minute", key_func=ip_key)
async def logout(request: Request, response: Response) -> MessageResponse:
    """Clear the session cookie to log the user out."""
    response.delete_cookie(key="session_token", path="/")
    return MessageResponse(data={"message": "Logged out."})
