"""add user-provided name to watches

Revision ID: 002
Revises: 001
Create Date: 2026-06-03

Adds a per-watch ``name`` column so users can label each showtime they track.
The label lives on ``watches`` (not ``showtimes``) because a single showtime
row is shared across every user watching it — the name is personal to one
user's watch. Nullable: existing watches and watches created without a name
fall back to the movie name (always NULL today) / a generic placeholder in the
UI.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("watches", sa.Column("name", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("watches", "name")
