"""add user-picked showtime date/time to watches

Revision ID: 003
Revises: 002
Create Date: 2026-06-05

Adds a per-watch ``showtime_at`` column so users can record the screening's
date and time. Like ``watches.name`` (migration 002), it lives on ``watches``
rather than ``showtimes`` because a single showtime row is shared across every
user watching it — the date a user assigns is personal to their watch.

The column is ``TIMESTAMP WITHOUT TIME ZONE`` (naive) on purpose: it stores the
theatre-local wall-clock the user picked in the frontend wheel picker, and the
notification renderer / dashboard print it back verbatim. Storing it as
TIMESTAMPTZ would normalise to UTC and shift the displayed time (a 7:30 PM pick
would render as the UTC equivalent in alert emails). Nullable: existing watches
and watches created without a date fall back to the (always-NULL today) showtime
metadata in the UI.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "watches",
        sa.Column("showtime_at", sa.DateTime(timezone=False), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("watches", "showtime_at")
