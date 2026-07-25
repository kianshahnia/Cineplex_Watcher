"""add resolved-metadata columns to showtimes

Revision ID: 005
Revises: 004
Create Date: 2026-07-27

Groundwork for auto-resolving a showtime's real movie title, theatre name and
screening time from Cineplex's theatrical API
(``/prod/cpx/theatrical/api/v1/theatres/{t}/showtimes/{s}``). Nothing reads or
writes these columns yet — the resolver service and its wiring land in later
sessions.

These live on ``showtimes`` (not ``watches``, unlike ``name``/``showtime_at``
from migrations 002 and 003) because they are Cineplex's own factual data about
the screening, identical for every user watching it. ``get_or_create_showtime``
already dedups that row, so one resolution serves everyone.

Three columns, and the reasoning for each:

``showtime_local`` — TIMESTAMP WITHOUT TIME ZONE (naive), the theatre-local wall
clock (upstream ``showtime.showStartDateTime``). The existing ``showtime_at``
column is TIMESTAMPTZ and will hold the aware UTC instant
(``showStartDateTimeUtc``). The API hands us both, so we store both: the instant
drives poll-interval math, the wall clock drives everything user-visible. The
alternative — one column plus a UTC→local conversion at render time — would
require knowing each theatre's timezone, and Cineplex spans BC to Newfoundland.
Deriving that from lat/long would add an IANA lookup dependency and a failure
mode purely to recompute a value we were already given. This mirrors the naive
column added in migration 003 for the same display-fidelity reason.

``metadata_fetched_at`` — TIMESTAMPTZ, stamped on every resolution *attempt*,
success or failure. It is what distinguishes "never tried" (NULL) from "tried
and failed" (non-NULL alongside a NULL ``movie_name``). Without it, a transient
upstream blip is indistinguishable from an unresolved showtime, and the resolver
would either retry forever or give up permanently.

``metadata_json`` — JSONB, the trimmed upstream response (poster URLs, runtime,
rating, genres, auditorium, experience types, warnings). Those fields arrive
free in the same response; capturing them now means a later session can build UI
on them without another migration. Stored trimmed — ``alternativeShowtimes`` (a
separate feature, and large) and ``location`` are dropped before persisting.
Follows the existing ``seat_layout_json`` JSONB column on this same table.

All nullable: every existing row predates the feature, and resolution is
best-effort by design — a metadata failure must never break the seat map.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "showtimes",
        sa.Column("showtime_local", sa.DateTime(timezone=False), nullable=True),
    )
    op.add_column(
        "showtimes",
        sa.Column("metadata_fetched_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "showtimes",
        sa.Column("metadata_json", postgresql.JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("showtimes", "metadata_json")
    op.drop_column("showtimes", "metadata_fetched_at")
    op.drop_column("showtimes", "showtime_local")
