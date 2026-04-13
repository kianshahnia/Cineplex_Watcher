import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr


# --- Requests ---


class LoginRequest(BaseModel):
    """User submits their email to receive a magic link."""

    email: EmailStr


# --- Responses ---


class MessageResponse(BaseModel):
    """Generic success message wrapper."""

    data: dict[str, str]
    error: None = None


class UserResponse(BaseModel):
    """Public user representation returned by /auth/me."""

    id: uuid.UUID
    email: str
    phone: str | None
    notify_via: str
    created_at: datetime

    model_config = {"from_attributes": True}


class MeResponse(BaseModel):
    """Wraps user data in the standard API envelope."""

    data: UserResponse
    error: None = None


class ErrorResponse(BaseModel):
    """Standard error envelope."""

    data: None = None
    error: dict[str, str]
