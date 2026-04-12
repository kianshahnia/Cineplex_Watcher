"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-04-12

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- users ---
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("phone", sa.String(20), nullable=True),
        sa.Column("push_subscription", postgresql.JSONB, nullable=True),
        sa.Column("notify_via", sa.String(50), nullable=False, server_default="email"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # --- showtimes ---
    op.create_table(
        "showtimes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("theatre_id", sa.Integer, nullable=False),
        sa.Column("showtime_id", sa.Integer, nullable=False),
        sa.Column("movie_name", sa.String(255), nullable=True),
        sa.Column("theater_name", sa.String(255), nullable=True),
        sa.Column("showtime_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("poll_interval_sec", sa.Integer, nullable=False, server_default=sa.text("90")),
        sa.Column("last_polled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seat_layout_json", postgresql.JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("theatre_id", "showtime_id", name="uq_theatre_showtime"),
    )

    # --- watches ---
    op.create_table(
        "watches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("showtime_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("showtimes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("notify_any_seat", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("user_id", "showtime_id", name="uq_user_showtime"),
    )

    # --- watched_seats ---
    op.create_table(
        "watched_seats",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("watch_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("watches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("seat_key", sa.String(20), nullable=False),
        sa.Column("seat_label", sa.String(20), nullable=False),
        sa.Column("last_known_status", sa.String(20), nullable=False, server_default="Occupied"),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("watch_id", "seat_key", name="uq_watch_seat"),
    )

    # --- seat_events ---
    op.create_table(
        "seat_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("watched_seat_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("watched_seats.id", ondelete="CASCADE"), nullable=False),
        sa.Column("old_status", sa.String(20), nullable=False),
        sa.Column("new_status", sa.String(20), nullable=False),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # --- magic_links ---
    op.create_table(
        "magic_links",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("token", sa.String(64), unique=True, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # --- indexes ---
    op.create_index("idx_watches_active", "watches", ["showtime_id"], postgresql_where=sa.text("status = 'active'"))
    op.create_index("idx_showtimes_active", "showtimes", ["is_active"], postgresql_where=sa.text("is_active = true"))
    op.create_index("idx_watched_seats_watch", "watched_seats", ["watch_id"])
    op.create_index("idx_seat_events_seat", "seat_events", ["watched_seat_id"])
    op.create_index("idx_magic_links_token", "magic_links", ["token"], postgresql_where=sa.text("used = false"))


def downgrade() -> None:
    op.drop_index("idx_magic_links_token", table_name="magic_links")
    op.drop_index("idx_seat_events_seat", table_name="seat_events")
    op.drop_index("idx_watched_seats_watch", table_name="watched_seats")
    op.drop_index("idx_showtimes_active", table_name="showtimes")
    op.drop_index("idx_watches_active", table_name="watches")
    op.drop_table("magic_links")
    op.drop_table("seat_events")
    op.drop_table("watched_seats")
    op.drop_table("watches")
    op.drop_table("showtimes")
    op.drop_table("users")
