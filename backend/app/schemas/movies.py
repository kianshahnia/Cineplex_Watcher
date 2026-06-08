"""Schemas for the landing-page "Now Playing" movie carousel (TMDB-backed)."""

from pydantic import BaseModel


class NowPlayingMovie(BaseModel):
    """One currently-in-theatres movie, trimmed to what the carousel renders."""

    id: int
    title: str
    poster_url: str  # absolute https URL to the poster image
    release_date: str | None  # "YYYY-MM-DD" or None
    vote_average: float
    popularity: float
    overview: str | None


class NowPlayingResponse(BaseModel):
    """Standard envelope wrapping the popularity-ranked list of movies."""

    data: list[NowPlayingMovie]
    error: None = None
