from sqlalchemy import String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    push_subscription: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    notify_via: Mapped[str] = mapped_column(String(50), default="email", nullable=False)

    watches: Mapped[list["Watch"]] = relationship(back_populates="user", cascade="all, delete-orphan")  # noqa: F821
