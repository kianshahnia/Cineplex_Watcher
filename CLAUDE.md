# Cineplex Seat Watcher

## Project overview

A full-stack web application that monitors Cineplex movie theater seat availability in real time. Users paste a Cineplex showtime URL, see an interactive seat map, select specific seats (or all seats) to track, and receive instant notifications (email, SMS, browser push) when a watched seat becomes available.

This is a personal/portfolio project. The goal is to demonstrate production-grade full-stack engineering: background job processing, real-time WebSockets, adaptive polling, event-driven architecture, and clean relational data modeling.

---

## Tech stack

| Layer            | Technology                               | Purpose                                                |
| ---------------- | ---------------------------------------- | ------------------------------------------------------ |
| Backend API      | **FastAPI** (Python 3.12+)               | REST API + WebSocket server, async-native              |
| Frontend         | **Next.js 14+** (TypeScript, App Router) | SSR, seat map UI, real-time updates                    |
| Database         | **PostgreSQL 16**                        | Persistent storage for users, watches, seat events     |
| ORM              | **SQLAlchemy 2.0** (async)               | Database models and queries                            |
| Migrations       | **Alembic**                              | Schema migrations                                      |
| Cache / Broker   | **Redis 7**                              | Celery task broker, seat data cache, WebSocket pub/sub |
| Background jobs  | **Celery 5**                             | Scheduled seat availability polling                    |
| Email            | **Resend** (or SendGrid)                 | Magic link auth + seat availability alerts             |
| SMS              | **Twilio**                               | SMS seat availability alerts                           |
| Push             | **Web Push API** (pywebpush)             | Browser push notifications                             |
| Containerization | **Docker Compose**                       | Full local dev environment in one command              |

---

## Architecture

```
User (browser)
    │
    ▼
Next.js frontend (SSR + seat map UI + WebSocket client)
    │                          ▲
    │ REST API                 │ WebSocket push
    ▼                          │
FastAPI backend ──────────► Redis (pub/sub) ──► WS connections
    │         │
    │         └──► Celery worker ──► Cineplex API
    │                    │
    ▼                    ▼
PostgreSQL          (compares new vs stored status,
                     publishes changes to Redis,
                     triggers notifications)
```

### Flow

1. User pastes a Cineplex showtime URL into the frontend.
2. Frontend extracts `theatre_id` and `showtime_id` from the URL, calls FastAPI to create a watch.
3. FastAPI fetches seat layout + availability from Cineplex, stores the showtime if new, returns seat map data.
4. User clicks seats to watch (or selects "watch all"), frontend sends selected seat keys to FastAPI.
5. Celery beat schedules a polling task per active showtime at adaptive intervals.
6. On each poll, Celery worker GETs the seat-availability endpoint, compares against `last_known_status` in the DB.
7. If any watched seat changes from `Occupied` → `Available`, worker publishes event to Redis and triggers notifications.
8. Redis pub/sub pushes the event to FastAPI's WebSocket handler, which forwards it to connected clients in real time.
9. Polling stops when `isPostShowtime` is `true` or all watches for that showtime are fulfilled/cancelled.

---

## Cineplex API (unauthenticated — no cookies or auth required)

### Seat availability endpoint

```
GET https://apis.cineplex.com/prod/ticketing/api/v1/theatre/{theatre_id}/showtime/{showtime_id}/seat-availability
```

**Response shape:**

```json
{
  "seatAvailabilities": {
    "1_7_4": "Available",
    "1_7_5": "Occupied",
    "1_8_10": "Available"
  },
  "isSoldOut": false,
  "isPostShowtime": false
}
```

- Keys follow the pattern `{section}_{row}_{seat}` (e.g., `1_7_4` = section 1, row 7, seat 4).
- Values are either `"Available"` or `"Occupied"`.
- `isSoldOut`: all seats occupied.
- `isPostShowtime`: showtime has passed — stop polling.

### Seat layout endpoint

```
GET https://apis.cineplex.com/prod/ticketing/api/v1/theatre/{theatre_id}/showtime/{showtime_id}/seats
```

_(Confirm exact URL — it's a sibling endpoint on the same base path.)_

**Response shape (abbreviated):**

```json
{
  "totalRows": 15,
  "totalColumns": 28,
  "maxSeatSelectionAllowed": 18,
  "standardSeats": {
    "areaWidth": 28,
    "columnCount": 28,
    "rowCount": 15,
    "rows": [
      {
        "number": 1,
        "physicalNumber": 14,
        "label": "AA",
        "seats": [
          {
            "id": "1_14_23",
            "column": 5,
            "columnPhysicalNumber": 23,
            "label": "AA1",
            "type": "Standard"
          }
        ]
      }
    ]
  }
}
```

- `rows[].label` is the human-readable row letter(s) (e.g., "AA", "A", "B"...).
- `rows[].seats[].id` matches the keys in `seatAvailabilities`.
- `rows[].seats[].label` is the human-readable seat label (e.g., "AA1", "B12").
- `rows[].seats[].column` is the grid column position for visual layout (determines gaps/aisles).
- `rows[].seats[].type` can be "Standard", "Wheelchair", "Companion", etc.
- Empty `seats: []` rows represent physical gaps (aisles between sections).

### URL parsing

Extract `theatre_id` and `showtime_id` from user-pasted URLs. Expected input formats:

```
https://www.cineplex.com/Showtimes/...  (the user-facing page)
https://apis.cineplex.com/prod/ticketing/api/v1/theatre/1405/showtime/528426/seat-availability
```

The frontend needs to handle both: if the user pastes the public Cineplex URL, parse out the IDs. If they paste the API URL directly, extract from the path. Store a regex or URL parser utility for this.

---

## Database schema (PostgreSQL)

### Tables

**users**

- `id` UUID PK DEFAULT gen_random_uuid()
- `email` VARCHAR(255) UNIQUE NOT NULL
- `phone` VARCHAR(20) NULLABLE — for SMS notifications
- `push_subscription` JSONB NULLABLE — Web Push subscription object
- `notify_via` VARCHAR(50) DEFAULT 'email' — comma-separated: 'email', 'sms', 'push'
- `created_at` TIMESTAMPTZ DEFAULT now()

**showtimes**

- `id` UUID PK DEFAULT gen_random_uuid()
- `theatre_id` INT NOT NULL — from Cineplex URL
- `showtime_id` INT NOT NULL — from Cineplex URL
- `movie_name` VARCHAR(255)
- `theater_name` VARCHAR(255)
- `showtime_at` TIMESTAMPTZ — when the movie starts
- `is_active` BOOLEAN DEFAULT true — set false when `isPostShowtime` or manually stopped
- `poll_interval_sec` INT DEFAULT 90 — adaptive: 90 → 60 → 30
- `last_polled_at` TIMESTAMPTZ NULLABLE
- `seat_layout_json` JSONB — cached layout response for rendering seat map
- `created_at` TIMESTAMPTZ DEFAULT now()
- UNIQUE(theatre_id, showtime_id)

**watches**

- `id` UUID PK DEFAULT gen_random_uuid()
- `user_id` UUID FK → users.id ON DELETE CASCADE
- `showtime_id` UUID FK → showtimes.id ON DELETE CASCADE
- `status` VARCHAR(20) DEFAULT 'active' — 'active', 'fulfilled', 'cancelled', 'expired'
- `notify_any_seat` BOOLEAN DEFAULT false — true = user wants alerts for ANY seat
- `created_at` TIMESTAMPTZ DEFAULT now()
- UNIQUE(user_id, showtime_id)

**watched_seats**

- `id` UUID PK DEFAULT gen_random_uuid()
- `watch_id` UUID FK → watches.id ON DELETE CASCADE
- `seat_key` VARCHAR(20) NOT NULL — e.g., '1_7_4'
- `seat_label` VARCHAR(20) NOT NULL — e.g., 'G4'
- `last_known_status` VARCHAR(20) DEFAULT 'Occupied'
- `notified_at` TIMESTAMPTZ NULLABLE — null until notification sent
- UNIQUE(watch_id, seat_key)

**seat_events**

- `id` UUID PK DEFAULT gen_random_uuid()
- `watched_seat_id` UUID FK → watched_seats.id ON DELETE CASCADE
- `old_status` VARCHAR(20) NOT NULL
- `new_status` VARCHAR(20) NOT NULL
- `detected_at` TIMESTAMPTZ DEFAULT now()

**magic_links**

- `id` UUID PK DEFAULT gen_random_uuid()
- `email` VARCHAR(255) NOT NULL
- `token` VARCHAR(64) UNIQUE NOT NULL — crypto-random
- `expires_at` TIMESTAMPTZ NOT NULL — 15 minutes from creation
- `used` BOOLEAN DEFAULT false
- `created_at` TIMESTAMPTZ DEFAULT now()

### Key indexes

```sql
CREATE INDEX idx_watches_active ON watches(showtime_id) WHERE status = 'active';
CREATE INDEX idx_showtimes_active ON showtimes(is_active) WHERE is_active = true;
CREATE INDEX idx_watched_seats_watch ON watched_seats(watch_id);
CREATE INDEX idx_seat_events_seat ON seat_events(watched_seat_id);
CREATE INDEX idx_magic_links_token ON magic_links(token) WHERE used = false;
```

### Deduplication logic

Multiple users can watch the same showtime. The `showtimes` table has a UNIQUE constraint on `(theatre_id, showtime_id)`. When a new user creates a watch for a showtime that already exists, reuse the existing showtimes row. The Celery worker queries distinct active showtimes, polls each ONCE, then checks all watches + watched_seats for that showtime against the single API response.

---

## Adaptive polling strategy

```python
def get_poll_interval(showtime_at: datetime) -> int:
    hours_until = (showtime_at - datetime.now(timezone.utc)).total_seconds() / 3600
    if hours_until <= 0:
        return -1  # stop polling
    elif hours_until <= 2:
        return 30  # high frequency — carts abandoned most often near showtime
    elif hours_until <= 6:
        return 60
    else:
        return 90
```

Update `showtimes.poll_interval_sec` after each poll. If `isPostShowtime` is true in the API response, set `is_active = false` and mark all watches as 'expired'.

---

## Authentication — magic link (passwordless)

1. User enters email on the frontend.
2. Backend generates a crypto-random token, stores it in `magic_links` with 15-min expiry.
3. Backend sends email via Resend containing a link: `https://yourapp.com/auth/verify?token=abc123`.
4. User clicks the link. Backend validates token, creates or fetches the user, issues a JWT session token (httpOnly cookie).
5. JWT contains `user_id` and `email`. Expires in 7 days. Refresh on each request.

---

## Notifications

### Email (Resend)

- Used for both magic link auth and seat alerts.
- Seat alert email contains: movie name, theater, showtime, which seat(s) became available, and a direct link to the Cineplex booking page.

### SMS (Twilio)

- Only if user has provided phone number and opted in.
- Short message: "{movie} — Seat {label} is now available! Book now: {url}"

### Browser push (Web Push API)

- User opts in via browser prompt.
- Store the push subscription JSON in `users.push_subscription`.
- Use `pywebpush` to send push notifications from the Celery worker.

### Notification deduplication

- Set `watched_seats.notified_at` after sending the first notification.
- Do NOT re-notify for the same seat becoming available again unless the user explicitly re-enables it.
- If `notify_any_seat` is true on the watch, notify for every seat that flips to Available (but still only once per seat).

---

## Project structure

```
cineplex-watcher/
├── CLAUDE.md                    # This file
├── docker-compose.yml           # PostgreSQL, Redis, FastAPI, Celery, Next.js
├── backend/
│   ├── pyproject.toml           # Python dependencies (use Poetry or pip)
│   ├── alembic/                 # Database migrations
│   │   └── versions/
│   ├── app/
│   │   ├── main.py              # FastAPI app entry point
│   │   ├── config.py            # Settings via pydantic-settings (env vars)
│   │   ├── database.py          # Async SQLAlchemy engine + session
│   │   ├── models/              # SQLAlchemy ORM models
│   │   │   ├── user.py
│   │   │   ├── showtime.py
│   │   │   ├── watch.py
│   │   │   ├── watched_seat.py
│   │   │   ├── seat_event.py
│   │   │   └── magic_link.py
│   │   ├── schemas/             # Pydantic request/response schemas
│   │   ├── routers/             # FastAPI route modules
│   │   │   ├── auth.py          # Magic link login/verify
│   │   │   ├── watches.py       # CRUD for watches + watched seats
│   │   │   ├── showtimes.py     # Showtime lookup + seat map data
│   │   │   └── ws.py            # WebSocket endpoint
│   │   ├── services/            # Business logic
│   │   │   ├── cineplex.py      # HTTP client for Cineplex API
│   │   │   ├── notifications.py # Email, SMS, push sending
│   │   │   └── auth.py          # Magic link + JWT logic
│   │   └── tasks/               # Celery task definitions
│   │       ├── celery_app.py    # Celery config
│   │       └── poll_seats.py    # The main polling task
│   └── Dockerfile
├── frontend/
│   ├── package.json
│   ├── next.config.js
│   ├── app/                     # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx             # Landing page — paste URL, enter email
│   │   ├── auth/
│   │   │   └── verify/page.tsx  # Magic link callback
│   │   ├── dashboard/
│   │   │   └── page.tsx         # Active watches overview
│   │   └── watch/
│   │       └── [id]/page.tsx    # Seat map view for a specific showtime
│   ├── components/
│   │   ├── SeatMap.tsx          # Interactive seat grid — the core UI
│   │   ├── SeatCell.tsx         # Individual seat (available/occupied/watched)
│   │   └── WatchCard.tsx        # Summary card for an active watch
│   ├── hooks/
│   │   └── useWebSocket.ts     # WebSocket connection + reconnection
│   ├── lib/
│   │   └── api.ts              # Fetch wrapper for backend API
│   └── Dockerfile
└── README.md
```

---

## Coding conventions

- **Python**: Use type hints everywhere. Async functions for all I/O. Format with `ruff`. Use `pydantic` for all data validation.
- **TypeScript**: Strict mode. No `any` types. Use `interface` over `type` where possible.
- **API responses**: Always return consistent JSON: `{ "data": ..., "error": null }` or `{ "data": null, "error": { "message": "..." } }`.
- **Environment variables**: All secrets and config via `.env` file loaded by `pydantic-settings`. Never hardcode API keys, database URLs, or secrets.
- **Git**: Conventional commits (`feat:`, `fix:`, `chore:`). Feature branches off `main`.
- **Error handling**: Never silently swallow exceptions. Log errors with structlog. Return meaningful HTTP error codes.
- **Database**: Always use migrations (Alembic) for schema changes. Never modify the DB manually.

---

## Environment variables (.env)

```env
# Database
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/cineplex_watcher

# Redis
REDIS_URL=redis://localhost:6379/0

# Auth
JWT_SECRET=<generate-a-random-64-char-string>
MAGIC_LINK_BASE_URL=http://localhost:3000/auth/verify

# Email (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxx
FROM_EMAIL=alerts@yourdomain.com

# SMS (Twilio)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxx
TWILIO_FROM_NUMBER=+1xxxxxxxxxx

# Web Push (VAPID keys)
VAPID_PRIVATE_KEY=<generate>
VAPID_PUBLIC_KEY=<generate>
VAPID_CLAIM_EMAIL=mailto:you@example.com
```

---

## Build order (phases)

### Phase 1: Core backend + polling proof of concept

1. Set up Docker Compose (PostgreSQL + Redis).
2. Create FastAPI app skeleton with config.
3. Define SQLAlchemy models and run Alembic migrations.
4. Build `services/cineplex.py` — async HTTP client that fetches seat availability + layout.
5. Build Celery task `poll_seats.py` — polls one showtime, compares statuses, logs changes.
6. Test with a hardcoded showtime URL. Verify status changes are detected and logged.

### Phase 2: API + auth

1. Build magic link auth flow (send email, verify token, issue JWT).
2. Build watch CRUD endpoints (create watch, add seats, list active watches, cancel).
3. Build showtime endpoint (fetches + caches seat layout, returns merged layout + availability).

### Phase 3: Real-time + notifications

1. Add Redis pub/sub for seat change events.
2. Build WebSocket endpoint that subscribes to Redis channels per showtime.
3. Integrate Resend for email alerts.
4. Integrate Twilio for SMS alerts.
5. Integrate Web Push for browser notifications.

### Phase 4: Frontend

1. Landing page — URL input + email login.
2. Seat map component — render the grid from layout JSON, overlay availability colors.
3. Seat selection — click to toggle watch, bulk "watch all" button.
4. Dashboard — list active watches with live status indicators.
5. WebSocket hook — connect on mount, handle incoming seat change events, update UI.

### Phase 5: Polish + deploy

1. Dockerize frontend.
2. Add rate limiting to API endpoints.
3. Add request logging with structlog.
4. Write README with setup instructions.
5. Deploy (Railway, Fly.io, or similar).

---

## Key edge cases to handle

- **Cart locks**: Seats temporarily show as `Occupied` when someone adds them to cart (5-10 min). They may flip back to `Available` if the cart is abandoned. Don't notify on `Available` → `Occupied` — only notify on `Occupied` → `Available`.
- **Showtime expiry**: Stop polling when `isPostShowtime` is true. Mark all watches as 'expired'.
- **Sold out → not sold out**: If `isSoldOut` flips from true to false, that means seats opened up. Trigger a poll immediately.
- **Rate limiting**: Add minimum 30s between requests to the same showtime even if multiple users create watches simultaneously.
- **Stale sessions**: If no watches exist for a showtime, stop polling it. Clean up with a periodic Celery task.
- **Cineplex API downtime**: If a poll returns a non-200 status, log the error and retry on the next interval. Don't mark the showtime as inactive.
- **Duplicate notifications**: Use `notified_at` on `watched_seats` to prevent re-notifying for the same seat.


