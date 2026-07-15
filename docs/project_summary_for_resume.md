# Cinewatch (Cineplex Seat Watcher) — Project Summary

> Context document for resume-building. Written 2026-07-14. Captures the full
> stack, architecture, and engineering substance of the project.

---

## One-line description

A full-stack, real-time web application that monitors Cineplex movie-theatre
seat availability and instantly notifies users (email, SMS, browser push) the
moment a specific watched seat frees up — built to demonstrate production-grade
backend engineering: background job processing, WebSockets, adaptive polling,
event-driven pub/sub, and clean relational data modeling.

**Type:** Solo personal/portfolio project. **Status:** Feature-complete across
5 build phases; in production-deployment prep. **Domain:** `cinewatch.ca`.

---

## The problem it solves

Popular Cineplex showtimes sell out, but seats routinely free up when other
users abandon their carts (Cineplex holds a seat as "Occupied" for 5–10 minutes
while it sits in someone's cart, then releases it back to "Available"). A person
who wants a specific seat — or any seat in a sold-out show — has no way to know
the instant one opens. Cinewatch watches the showtime on their behalf and fires
a notification within seconds of a seat flipping from `Occupied` → `Available`.

The user flow: paste a Cineplex showtime URL → see an interactive seat map →
click the specific seats to watch (or "watch all occupied seats") → get an
email/SMS/push alert the moment one opens, with a direct booking link.

---

## Tech stack

| Layer | Technology | Role |
|---|---|---|
| Backend API | **FastAPI** (Python 3.12, fully async) | REST API + WebSocket server |
| Frontend | **Next.js 14** (App Router, TypeScript strict) | SSR seat map, dashboard, real-time UI |
| Database | **PostgreSQL 16** | Users, showtimes, watches, seat events |
| ORM | **SQLAlchemy 2.0** (async) | Data models + queries |
| Migrations | **Alembic** | Versioned schema changes |
| Cache / Broker / Pub-Sub | **Redis 7** | Celery broker, seat-state snapshots, WebSocket fan-out |
| Background jobs | **Celery 5** (+ Celery Beat) | Scheduled adaptive seat polling |
| Email | **Resend** | Magic-link auth + seat alerts |
| SMS | **Twilio** | Seat-alert text messages |
| Browser push | **Web Push API** (`pywebpush`, VAPID) | Push notifications from the worker |
| Auth | **Magic link (passwordless)** + JWT (httpOnly cookie) | No passwords stored |
| Logging | **structlog** | Structured JSON request logging + request-ID tracing |
| Rate limiting | **slowapi** (Redis-backed, moving-window) | Per-endpoint + per-email/IP abuse limits |
| External data | **TMDB API** (server-side proxy) | "Now Playing in Canada" poster carousel |
| Containerization | **Docker Compose** | Full stack (Postgres, Redis, API, worker, beat, frontend) |
| Deploy target | VPS + **Caddy** (auto-HTTPS reverse proxy) | Production hosting |

---

## Architecture

```
User (browser)
    │
    ▼
Next.js frontend (SSR seat map + WebSocket client)
    │  REST                     ▲ WebSocket push
    ▼                           │
FastAPI backend ──────────► Redis (pub/sub) ──► live WS connections
    │        │
    │        └──► Celery worker ──► Cineplex API (unauthenticated)
    │                   │
    ▼                   ▼
PostgreSQL       diff new vs. snapshot → publish change → send notifications
```

**Event flow:**
1. Frontend parses `theatre_id` + `showtime_id` out of a pasted Cineplex URL.
2. FastAPI fetches the seat layout + availability from Cineplex's public
   ticketing API, dedupes/stores the showtime, and returns a merged seat map.
3. User selects seats; a `watch` + `watched_seats` rows are created.
4. **Celery Beat** schedules a polling task per active showtime at an *adaptive*
   interval (90s far out → 60s → 30s within 2 hours of showtime).
5. Each poll pulls the availability endpoint **once per showtime** (shared across
   all users watching it), diffs it against a **Redis snapshot** of last-known
   state.
6. Any `Occupied → Available` transition is published to a Redis pub/sub channel
   AND triggers the notification pipeline (email/SMS/push, per user preference).
7. FastAPI's **WebSocket** endpoint subscribes to the Redis channel and pushes
   the event to connected browsers in real time — the seat flips colour and
   flashes brass instantly on the seat map.
8. Polling stops when Cineplex reports `isPostShowtime`, or when no active
   watches remain for that showtime.

---

## What makes it engineering-interesting (resume substance)

These are the non-trivial problems solved — the parts worth talking about in an
interview:

- **Event-driven, deduplicated polling.** Multiple users watching the same
  showtime share ONE poll and ONE Cineplex request (enforced by a
  `UNIQUE(theatre_id, showtime_id)` constraint + a `get_or_create` pattern with
  an `IntegrityError`-rollback race guard). The worker diffs a single API
  response against every watcher's tracked seats.

- **Sync↔async bridge in Celery.** Celery tasks are synchronous but the whole
  data layer is async SQLAlchemy. Solved with a *separate* engine using
  `NullPool` inside the task and `asyncio.run()` per execution — avoids asyncpg
  connection-pool/event-loop binding bugs that arise when each task spins up a
  fresh event loop.

- **Redis-snapshot diffing (not just DB state).** Change detection diffs against
  a `snapshot:{uuid}` Redis key rather than each seat's stored status. This lets
  the system detect openings for *any* seat (needed for "watch all / notify any
  seat"), not only individually tracked ones. A "baseline poll" guard skips
  change-detection on the first poll of a showtime so users don't get spammed
  about seats that were already open when they started watching.

- **Cart-lock awareness.** Seats bounce `Available → Occupied → Available` as
  carts are added/abandoned. The system only notifies on `Occupied → Available`
  and dedupes with a `notified_at` timestamp so a seat that flickers doesn't
  re-alert.

- **Real-time WebSockets with correct lifecycle.** Each connection runs two
  concurrent tasks (forward-from-Redis + detect-client-disconnect) raced with
  `asyncio.wait(FIRST_COMPLETED)`, so a client dropping mid-stream doesn't hang
  a task blocked on `pubsub.listen()`. Cookie-based JWT auth over the WS upgrade;
  typed close codes (4001 auth, 4003 inactive, 4029 rate-limited).

- **Multi-channel notification fan-out with OR-of-channels dedup.** Email, SMS,
  and push each have a pure *renderer* (unit-testable, no network) split from a
  *transport* (the vendor SDK, wrapped in `asyncio.to_thread` since all three
  SDKs are sync). A seat is marked "notified" once *any* channel succeeds.
  Two-transaction persistence: seat events commit first, then notifications
  send, then a second transaction stamps `notified_at` — so a vendor failure
  never rolls back already-detected events.

- **Adaptive polling cadence** tied to time-until-showtime (carts get abandoned
  most often near showtime, so poll faster then), with graceful fallback when
  the showtime timestamp is unknown.

- **Production hardening.** Redis-backed moving-window rate limiting with
  per-endpoint budgets, a separate per-email login limit to defend against
  distributed inbox-bombing, and fail-open behaviour when Redis is down.
  Structured JSON logging with per-request context binding (a log line from a
  deep service automatically carries the request ID). Passwordless magic-link
  auth with short-lived crypto tokens and 7-day JWT sessions.

- **Reverse-engineered an undocumented API.** Cineplex's ticketing endpoints are
  unauthenticated but undocumented; mapped the seat-layout and seat-availability
  endpoints, their key format (`{section}_{row}_{seat}`), and their quirks (e.g.
  aisle rows return `label: null`) by inspecting the live ticketing bundle.

---

## Data model (PostgreSQL)

Six tables, all UUID PKs:
- **users** — email, optional phone, push subscription JSONB, notification
  channel prefs.
- **showtimes** — `(theatre_id, showtime_id)` unique; cached seat-layout JSONB;
  adaptive `poll_interval_sec`; `is_active` flag. *Shared* across all users
  watching the same show.
- **watches** — a user's watch of a showtime; soft-deleted (`status`) not hard
  by default; carries a per-user `name` and per-user `showtime_at` (personal
  annotations, deliberately not on the shared showtime row).
- **watched_seats** — individual tracked seats with `last_known_status` and
  `notified_at` for dedup.
- **seat_events** — audit log of every status transition.
- **magic_links** — single-use, 15-minute crypto tokens for passwordless auth.

Partial indexes on the hot paths (active watches, active showtimes, unused
magic-link tokens).

---

## Frontend highlights

- **Next.js 14 App Router**, TypeScript strict mode (`noUncheckedIndexedAccess`),
  **pure CSS Modules — no Tailwind, no UI library.** Custom "editorial cinema"
  design system (deep navy + brushed silver + a single sparing brass accent;
  Fraunces + Geist type).
- **Server-rendered seat map** (`app/watch/[id]`): the seat grid is painted on
  the server so there's no loading flash; a client layer initializes from the
  SSR payload and takes over live updates.
- **Hand-rolled SVG seat map** with grid/aisle math, accessibility-typed seats,
  a "SCREEN" projector-cone motif, and a scroll-mask affordance.
- **Click-and-drag seat painting** (spreadsheet-style select/deselect), built on
  pointer capture + `elementFromPoint` hit-testing, with refs-only state so a
  drag never re-renders the grid mid-gesture.
- **Live seat flashing** driven by a reconnecting WebSocket hook
  (`useShowtimeEvents`) with capped exponential backoff and terminal vs.
  retryable close-code handling.
- **Watchlist dashboard** with filter tabs, in-place cancel/remove/rename, and
  status-aware card styling.
- **iOS-style "drum" wheel date/time picker** built from scratch (no library):
  native momentum scroll + JS snap, a per-row `rotateX` depth curve painted via
  `requestAnimationFrame` direct DOM writes, auto-inferred year.
- **TMDB "Now Playing" poster carousel** on the landing page, proxied through
  the backend (the TMDB token is a server-side secret, never shipped to the
  client) with Redis caching and a graceful fallback.

---

## Notable engineering decisions & their rationale

- **Passwordless magic-link auth** — no password storage/reset flow to secure;
  demonstrates JWT session handling and secure cookie config.
- **Service/router/schema separation** — routers are the thin HTTP layer;
  business logic lives in `services/`; Pydantic schemas validate every
  request/response. Consistent `{ data, error }` envelope on every endpoint.
- **Soft deletes by default** — cancelling a watch flips its status rather than
  deleting, preserving history and keeping the poller's `status = 'active'`
  filter simple. A separate hard-delete endpoint exists for permanent removal
  (with eager-loaded cascade children to avoid async `MissingGreenlet` errors).
- **Redis as three things at once** — Celery broker, seat-state snapshot store,
  and WebSocket pub/sub bus — showing comfort with a single infra piece serving
  multiple roles.
- **Dev-mode graceful degradation** — every external vendor (Resend, Twilio,
  Web Push, TMDB) no-ops with a logged "would have sent" message when its API
  key is absent, so the whole pipeline runs end-to-end on day one with zero
  third-party accounts configured.

---

## Scope / scale of the codebase

- Multi-service backend: FastAPI app + Celery worker + Celery Beat, all sharing
  models/services, run together via Docker Compose alongside Postgres and Redis.
- Migration-managed schema (Alembic, currently at revision `003`).
- Multi-stage Docker builds (backend + a 3-stage Next.js standalone image),
  production Docker Compose with a Caddy auto-HTTPS reverse proxy.
- Built solo across five planned phases (core polling → REST API + auth →
  real-time + notifications → full frontend → polish + deploy).

---

## Suggested resume bullet phrasings

- *Built a real-time full-stack seat-availability monitor (FastAPI, Next.js,
  PostgreSQL, Redis, Celery) that detects theatre seat openings and pushes
  email/SMS/browser-push alerts within seconds via WebSockets.*
- *Designed an event-driven polling pipeline with adaptive intervals and
  Redis-snapshot diffing that deduplicates work across users watching the same
  showtime — one upstream API call fans out to all watchers.*
- *Implemented async SQLAlchemy 2.0 over PostgreSQL with a sync↔async Celery
  bridge, Alembic migrations, and Redis pub/sub driving live WebSocket updates.*
- *Hardened the API for production with Redis-backed rate limiting, structured
  request-ID logging (structlog), passwordless JWT auth, and Dockerized
  multi-service deployment behind an auto-HTTPS reverse proxy.*
- *Hand-built the frontend in Next.js 14 (App Router, TypeScript strict, CSS
  Modules — no UI framework): SSR interactive SVG seat map, drag-to-select
  seat painting, a reconnecting WebSocket layer, and a from-scratch iOS-style
  wheel date picker.*
```
