# Cineplex Seat Watcher

Ever been eyeing seats for a movie and they're all taken, only for a bunch to open up later when people abandon their carts? This app watches Cineplex showtimes for you and sends you a notification the moment a seat becomes available.

You paste a Cineplex showtime URL, pick the seats you want (or just watch all of them), and the app polls the Cineplex API in the background. When a seat flips from occupied to available, you get an alert via email, SMS, or browser push notification — and the seat lights up live on the map if you have it open.

## How it works

1. You paste a Cineplex showtime URL and log in with your email (passwordless magic link).
2. The app fetches the seat layout and current availability from Cineplex's API.
3. You see an interactive seat map and select which seats to watch (click, drag to paint, or "watch all occupied seats"). You can name a watch and attach the screening date/time.
4. A background worker polls the Cineplex API on an adaptive schedule (more frequently as showtime approaches), comparing each poll against the previous snapshot.
5. When a watched seat flips from occupied to available, the app notifies you instantly and pushes a real-time update to your browser over a WebSocket.

## Tech stack

- **Backend:** FastAPI, SQLAlchemy 2.0 (async), Celery, Redis
- **Frontend:** Next.js 14 with TypeScript (App Router), pure CSS Modules
- **Database:** PostgreSQL 16
- **Real-time:** Redis pub/sub + WebSockets
- **Notifications:** Resend (email), Twilio (SMS), Web Push API
- **Ops:** Docker Compose, slowapi rate limiting, structlog request logging

## Getting started

### Prerequisites

- Docker and Docker Compose
- Node.js 18+ (only if you want to run the frontend outside Docker for dev)

### Running locally

1. Clone the repo and copy the example env file:

```bash
cp .env.example .env
```

2. Fill in your API keys in `.env` (Resend, Twilio, VAPID keys). The database and Redis URLs work out of the box with Docker Compose. The notification integrations are optional — when a key is missing the app logs the message it *would* have sent instead of failing, so you can run the full pipeline without configuring anything.

3. Start everything:

```bash
docker compose up --build
```

This brings up PostgreSQL, Redis, the FastAPI backend, the Celery worker and beat scheduler, and the Next.js frontend:

- Frontend: `http://localhost:3000`
- API: `http://localhost:8000`

4. Run database migrations:

```bash
docker compose exec backend alembic upgrade head
```

### Frontend development

The frontend is containerized for the full-stack run above, but it builds a static artifact so there's no live reload inside Docker. For frontend iteration, run it directly on the host (the backend still needs to be up on port 8000 for cookies/CORS):

```bash
cd frontend
npm install
npm run dev
```

### Optional configuration

A few behaviours are env-driven with sensible defaults:

- `RATE_LIMIT_ENABLED` (default `true`) — turn off to disable all rate limits, e.g. for load tests.
- `LOG_JSON` (default `false`) — emit machine-parseable JSON logs instead of coloured console output. Docker Compose sets this to `true` for the backend services.
- `LOG_LEVEL` (default `INFO`) — set `DEBUG` to restore SQL echo.

## Project status

**Phase 1 — Complete.** Backend foundation: SQLAlchemy models, Alembic migrations, Docker Compose setup, Celery config, and a proof-of-concept Cineplex API scraper.

**Phase 2 — Complete.** Full REST API:
- Passwordless magic link auth (JWT session cookie, `/auth/login`, `/auth/verify`, `/auth/me`, `/auth/logout`)
- Watch CRUD (`POST /watches`, `POST /watches/{id}/seats`, `GET /watches`, `PATCH /watches/{id}`, `DELETE /watches/{id}`, `DELETE /watches/{id}/remove`)
- Showtime seat map endpoint — fetches layout from Cineplex, caches it, merges with live availability (`GET /showtimes/{theatre_id}/{showtime_id}`)
- URL parser utility (`POST /showtimes/parse-url`)

**Phase 3 — Complete.** Real-time and notifications: Redis pub/sub, a WebSocket endpoint that streams seat-availability events per showtime, and email (Resend), SMS (Twilio), and browser push (Web Push) alerts wired into the polling pipeline with per-seat deduplication.

**Phase 4 — Complete.** Next.js frontend: landing page with URL input and magic-link login, an interactive seat map (click and drag-to-paint selection), watch creation that survives the sign-in roundtrip, a watchlist dashboard, and live seat updates over WebSocket. Watches can be named and given a screening date/time via a custom drum-wheel picker.

**Phase 5 — In progress.** Polish and deploy: frontend Dockerization, API rate limiting, and structured request logging are done. Deployment is the remaining step.

## License

This is a personal project. No license yet.
