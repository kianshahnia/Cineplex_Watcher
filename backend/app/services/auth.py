"""Authentication service — magic link generation, verification, and JWT session management."""

import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
import structlog
from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.magic_link import MagicLink
from app.models.user import User

log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Magic link creation
# ---------------------------------------------------------------------------


async def create_magic_link(email: str, db: AsyncSession) -> MagicLink:
    """Generate a crypto-random magic link token and persist it.

    Returns the MagicLink row so the caller can build the email.
    """
    token = secrets.token_urlsafe(48)  # 64-char URL-safe string
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.magic_link_expire_minutes)

    magic_link = MagicLink(
        email=email.lower().strip(),
        token=token,
        expires_at=expires_at,
    )
    db.add(magic_link)
    await db.commit()
    await db.refresh(magic_link)

    await log.ainfo("magic_link_created", email=email)
    return magic_link


# ---------------------------------------------------------------------------
# Magic link verification
# ---------------------------------------------------------------------------


async def verify_magic_link(token: str, db: AsyncSession) -> MagicLink:
    """Validate a magic link token. Returns the MagicLink if valid.

    Raises HTTPException if the token is invalid, expired, or already used.
    """
    stmt = select(MagicLink).where(MagicLink.token == token, MagicLink.used == False)  # noqa: E712
    result = await db.execute(stmt)
    magic_link = result.scalar_one_or_none()

    if magic_link is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or already-used magic link.",
        )

    if magic_link.expires_at < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Magic link has expired. Please request a new one.",
        )

    # Mark as used so it can't be replayed
    magic_link.used = True
    await db.commit()

    await log.ainfo("magic_link_verified", email=magic_link.email)
    return magic_link


# ---------------------------------------------------------------------------
# User get-or-create
# ---------------------------------------------------------------------------


async def get_or_create_user(email: str, db: AsyncSession) -> User:
    """Return the existing user for this email, or create a new one."""
    normalized = email.lower().strip()
    stmt = select(User).where(User.email == normalized)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user is not None:
        return user

    user = User(email=normalized)
    db.add(user)
    await db.commit()
    await db.refresh(user)

    await log.ainfo("user_created", user_id=str(user.id), email=normalized)
    return user


# ---------------------------------------------------------------------------
# JWT encode / decode
# ---------------------------------------------------------------------------


def create_jwt(user_id: uuid.UUID, email: str) -> str:
    """Create a signed JWT containing the user's identity."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "email": email,
        "iat": now,
        "exp": now + timedelta(days=settings.jwt_expire_days),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_jwt(token: str) -> dict:
    """Decode and validate a JWT. Raises HTTPException on failure."""
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired. Please log in again.",
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session token.",
        )


# ---------------------------------------------------------------------------
# FastAPI dependency — extract current user from the session cookie
# ---------------------------------------------------------------------------


async def get_current_user(
    session_token: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """FastAPI dependency that reads the JWT from an httpOnly cookie
    and returns the authenticated User.

    Usage in a router:
        @router.get("/protected")
        async def protected(user: User = Depends(get_current_user)):
            ...
    """
    if session_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated.",
        )

    payload = decode_jwt(session_token)

    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session token.",
        )

    stmt = select(User).where(User.id == uuid.UUID(user_id))
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )

    return user
