"""add an adjacent-seat notification threshold to watches

Revision ID: 006
Revises: 005
Create Date: 2026-07-29

Adds ``watches.min_adjacent_seats`` — "only alert me when this many of my seats
are free side by side". A group of four doesn't want to hear that two seats
opened; they want to hear when four opened *together*.

Like ``watches.name`` (002) and ``watches.showtime_at`` (003) it lives on
``watches``, not ``showtimes``: a showtime row is shared across every user
watching it, and how big a block *you* need is personal to your watch.

**NULL means off**, and off is the pre-existing behaviour: alert per seat, the
moment any watched seat flips ``Occupied -> Available``. Only values >= 2 engage
the block rule, so every existing row keeps working untouched and no backfill is
needed. The schema layer normalises 1 (and anything below) to NULL rather than
storing it, because "a block of one seat" is not a threshold — it is the absence
of one, and two spellings of the same state would be a trap for every read site.

No upper bound in the database. The request schema caps it (see
``MAX_ADJACENT_SEATS``), which is where a UI-facing limit belongs; a CHECK
constraint here would need a migration to retune.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "watches",
        sa.Column("min_adjacent_seats", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("watches", "min_adjacent_seats")
