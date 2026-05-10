from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import auth, showtimes, watches, ws
from app.services.redis_client import create_async_redis

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Create one shared async Redis client for the lifetime of the process.
    # The WebSocket router (Phase 3 Step 2) accesses it via app.state.redis.
    app.state.redis = create_async_redis()
    await log.ainfo("starting up", database=settings.database_url.split("@")[-1])
    yield
    await app.state.redis.aclose()
    await log.ainfo("shutting down")


app = FastAPI(
    title="Cineplex Seat Watcher",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow the Next.js frontend to send cookies cross-origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Routers ---
app.include_router(auth.router)
app.include_router(watches.router)
app.include_router(showtimes.router)
app.include_router(ws.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
