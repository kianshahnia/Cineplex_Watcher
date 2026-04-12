# Cineplex Seat Watcher

Ever been eyeing seats for a movie and they're all taken, only for a bunch to open up later when people abandon their carts? This app watches Cineplex showtimes for you and sends you a notification the moment a seat becomes available.

You paste a Cineplex showtime URL, pick the seats you want (or just watch all of them), and the app polls the Cineplex API in the background. When a seat flips from occupied to available, you get an alert via email, SMS, or browser push notification.

## How it works

1. You paste a Cineplex showtime URL and log in with your email (passwordless magic link).
2. The app fetches the seat layout and current availability from Cineplex's API.
3. You see an interactive seat map and select which seats to watch.
4. A background worker polls the Cineplex API on an adaptive schedule (more frequently as showtime approaches).
5. When a watched seat opens up, the app notifies you instantly and pushes a real-time update to your browser.

## Tech stack

- **Backend:** FastAPI, SQLAlchemy 2.0 (async), Celery, Redis
- **Frontend:** Next.js 14 with TypeScript (App Router)
- **Database:** PostgreSQL 16
- **Notifications:** Resend (email), Twilio (SMS), Web Push API

## Getting started

### Prerequisites

- Docker and Docker Compose
- Python 3.12+
- Node.js 18+

### Running locally

1. Clone the repo and copy the example env file:

```bash
cp .env.example .env
```

2. Fill in your API keys in `.env` (Resend, Twilio, VAPID keys). The database and Redis URLs work out of the box with Docker Compose.

3. Start everything:

```bash
docker compose up
```

This brings up PostgreSQL, Redis, the FastAPI backend, and Celery workers. The API will be available at `http://localhost:8000`.

4. Run database migrations:

```bash
docker compose exec backend alembic upgrade head
```

The frontend (Next.js) is not yet containerized. To run it separately once it's built:

```bash
cd frontend
npm install
npm run dev
```

## Project status

This is a work in progress. The backend foundation is in place (models, migrations, Docker setup, Celery config). The API endpoints, real-time WebSocket layer, notification integrations, and frontend are still being built out.

## License

This is a personal project. No license yet.
