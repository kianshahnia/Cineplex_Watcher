"""add notifications audit-log table

Revision ID: 004
Revises: 003
Create Date: 2026-07-17

One row per outbound seat-alert message per channel attempt (email / SMS /
push), written by the ``send_notifications`` Celery task. Closes the known
stats gap: ``watched_seats.notified_at`` counts *seats that fired*, not
*messages sent* (per-watch batching means one email can cover many seats).
Delivered-email rows here should match the Resend dashboard's send count.

``watch_id`` is ``ON DELETE SET NULL`` — the audit trail must survive hard
watch deletes (``DELETE /watches/{id}/remove``). Recipient and showtime
identifiers are denormalized onto the row for the same reason.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "watch_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("watches.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("user_email", sa.String(255), nullable=False),
        sa.Column("channel", sa.String(20), nullable=False),
        sa.Column("success", sa.Boolean, nullable=False),
        sa.Column("seat_count", sa.Integer, nullable=False),
        sa.Column("theatre_id", sa.Integer, nullable=False),
        sa.Column("showtime_id", sa.Integer, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    # The admin stats endpoint runs time-windowed counts ("sent in the last
    # 7 days") against created_at.
    op.create_index("idx_notifications_created", "notifications", ["created_at"])


def downgrade() -> None:
    op.drop_index("idx_notifications_created", table_name="notifications")
    op.drop_table("notifications")
