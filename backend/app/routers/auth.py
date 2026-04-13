"""Auth router — magic link login, verification, session management."""

import structlog
from fastapi import APIRouter, Depends, Query, Response
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

log = structlog.get_logger()

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post(
    "/login",
    response_model=MessageResponse,
    responses={400: {"model": ErrorResponse}},
)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)) -> MessageResponse:
    """Request a magic link.

    Generates a crypto-random token, persists it, and (in production) sends an
    email containing a verification link.  For now the link is returned in the
    response so you can test locally without an email provider configured.
    """
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
    responses={400: {"model": ErrorResponse}},
)
async def verify(
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
    responses={401: {"model": ErrorResponse}},
)
async def me(user: User = Depends(get_current_user)) -> MeResponse:
    """Return the currently authenticated user's profile."""
    return MeResponse(data=UserResponse.model_validate(user))


@router.post(
    "/logout",
    response_model=MessageResponse,
)
async def logout(response: Response) -> MessageResponse:
    """Clear the session cookie to log the user out."""
    response.delete_cookie(key="session_token", path="/")
    return MessageResponse(data={"message": "Logged out."})
