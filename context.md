# Cineplex Watcher — Session Context

> **This file is a living document.** Every Claude Code session should read it at the start and update it at the end if anything meaningful was learned, changed, or deferred. Do not let it go stale. Append, correct, and prune as the project evolves.

---

## How to use this file

- Read it at the start of every session before touching any code.
- After any session that builds something, deferres something, or discovers a gotcha, update the relevant section.
- Keep entries specific and actionable — not generic advice that applies to every project.

---

## Phase completion status

| Phase | Status | Notes |
|---|---|---|
| Phase 1 — Core backend scaffold | Complete | Models, migrations, Docker, Celery config, test scraper |
| Phase 2 — REST API + auth | Complete | Auth, watches CRUD, showtime seat map endpoint |
| Phase 3 — Real-time + notifications | Not started | Redis pub/sub, WebSocket, Resend, Twilio, Web Push |
| Phase 4 — Frontend | Not started | Next.js, seat map component, WebSocket hook |
| Phase 5 — Polish + deploy | Not started | Rate limiting, structlog, Dockerize frontend |

---

## Dev environment

- **No virtual environment.** Packages are installed into the Conda base environment at `/c/Users/tykop/miniforge3/`. Run `pip install <package>` directly — do not create or activate a venv unless the user asks.
- **Python path:** To run `python -c "from app.xxx import ..."` you must be in the `backend/` directory, or set `PYTHONPATH=backend`. The project is not installed as a package — it's a flat directory layout run by uvicorn.
- **Linting:** `ruff` is installed. Run `ruff check <files>` before committing. All files should pass with zero errors.
- **Database:** PostgreSQL runs in Docker Compose on port 5432. The schema is managed by Alembic — never modify it manually. All schema changes need a new migration in `backend/alembic/versions/`.
- **No frontend yet.** The `frontend/` directory doesn't exist yet. Only the backend has been built.

---

## What was actually built vs. the original plan

### Phase 1 — What changed
- `services/cineplex.py` was listed as a Phase 1 deliverable in CLAUDE.md but was **not built in Phase 1**. It was deferred to Phase 2 Step 3 and built there instead. The Phase 1 proof-of-concept is the standalone `test_scraper.py` script at the project root (synchronous, not async, no FastAPI).
- `tasks/poll_seats.py` was listed as Phase 1 Step 5 but **was not built**. It still needs to be created. The `celery_app.py` exists with an empty `beat_schedule = {}`, ready to receive tasks.

### Phase 2 — What was built (not in original CLAUDE.md detail)
- `services/watches.py` contains `get_or_create_showtime()`. This function is **shared** between the watches router and the showtimes router — both call it to deduplicate Showtime rows. Do not move or duplicate it.
- `schemas/watches.py` uses `Field(validation_alias="watched_seats")` on the `seats` field of `WatchResponse`. This maps the ORM relationship name (`watched_seats`) to the cleaner API key (`seats`). Requires `model_config = {"populate_by_name": True}`.

---

## Known gaps and deferred work

### Movie metadata is not populated
The `showtimes` table has `movie_name`, `theater_name`, and `showtime_at` columns but they are **always NULL** right now. The two Cineplex API endpoints we use (seats + seat-availability) don't return this metadata. We need to either:
- Find a Cineplex API endpoint that returns showtime details (movie title, theatre name, start time).
- Scrape the public Cineplex page for the showtime.
- Or accept that these fields stay NULL and remove them from the UI for now.
This is a **Phase 3/4 blocker** for displaying movie info in the frontend and for the Celery poller to know when to stop polling (it needs `showtime_at` for adaptive intervals).

### URL parsing only supports the API URL format
`services/cineplex.py:parse_cineplex_url()` only handles the API URL format:
```
https://apis.cineplex.com/.../theatre/1405/showtime/528426/...
```
It does **not** handle the public Cineplex website URL (`https://www.cineplex.com/Showtimes/...`). The public URL format needs to be reverse-engineered before the `POST /showtimes/parse-url` endpoint is useful to a real user.

### The Celery polling task does not exist yet
`backend/app/tasks/poll_seats.py` was never created. The `celery_app.py` is a stub with an empty beat schedule. The polling task is a Phase 3 prerequisite — notifications can't fire without it. When building it, it should:
- Query all active showtimes (`WHERE is_active = true`)
- For each: call `cineplex_service.fetch_seat_availability()`
- Compare against `watched_seats.last_known_status`
- Publish changes to Redis pub/sub on channel `showtime:{showtime_uuid}`
- Trigger notification sends
- Update `poll_interval_sec` using the adaptive strategy in CLAUDE.md
- Set `is_active = false` on showtimes where `isPostShowtime = true`

### Cookie security flag
`routers/auth.py` sets the session cookie with `secure=False` for local dev. This must be changed to `secure=True` in production (requires HTTPS). Add an env-driven toggle before deploy.

### Celery and SQLAlchemy async
Celery workers run synchronous tasks by default. The Celery task will need to call SQLAlchemy models, which are defined as async. Either:
- Use `asyncio.run()` inside the task to bridge sync→async, or
- Use a separate sync SQLAlchemy engine inside `tasks/` (not the async one in `database.py`).
This is a known architecture challenge — resolve it when building `poll_seats.py`.

---

## Established patterns — follow these in new code

### API response envelope
All endpoints return `{ "data": ..., "error": null }` on success and `{ "data": null, "error": {"message": "..."} }` on failure. Every router module has a matching `*Response` Pydantic schema in `schemas/`. Never return raw dicts from endpoints.

### Service layer separation
Routers do not contain business logic. The pattern is:
- `routers/` — HTTP layer: parse request, call service, return response schema
- `services/` — business logic: DB queries, external API calls, domain rules
- `schemas/` — Pydantic models for request/response validation and serialization

### Eager loading for Pydantic serialization
Any endpoint that returns a model with ORM relationships must use `selectinload()` when fetching. Async SQLAlchemy sessions do not allow lazy loading — accessing an unloaded relationship outside a coroutine will raise. The `_load_watch()` helper in `services/watches.py` is the reference pattern.

### get_or_create with race-condition guard
When inserting with a unique constraint, the pattern is: `SELECT` → if not found, `INSERT` → catch `IntegrityError` → `rollback()` → `SELECT` again. See `services/watches.py:get_or_create_showtime()`. Always `await db.rollback()` before retrying after an `IntegrityError` — the session is in an error state otherwise.

### Cineplex API base URL
```
https://apis.cineplex.com/prod/ticketing/api/v1
```
Defined as `CINEPLEX_API_BASE` in `services/cineplex.py`. Use that constant — don't hardcode the URL elsewhere.

### Soft deletes
Watches are never hard-deleted. `DELETE /watches/{id}` sets `status = 'cancelled'`. This preserves history and keeps the Celery poller logic simple (it filters on `status = 'active'`).

---

## Phase 3 — things to know before starting

- The WebSocket endpoint belongs in `routers/ws.py` and should be registered in `main.py` alongside the other routers.
- Redis pub/sub channel naming convention (not yet decided — pick one and document it here): proposed `showtime:{showtime_uuid}` where `showtime_uuid` is the UUID primary key from our `showtimes` table (not the Cineplex integer ID).
- Resend email sending is already stubbed in `routers/auth.py`. Phase 3 email notifications for seat alerts will follow the same pattern — import `resend`, set `resend.api_key`, call `resend.Emails.send()`.
- The `notify_any_seat` boolean on `Watch` and `notified_at` on `WatchedSeat` are the two fields that control notification logic. Read CLAUDE.md's "Notification deduplication" section before implementing.
- The `User.push_subscription` JSONB column stores the browser Web Push subscription object. It's null until the user opts in on the frontend.

---

## Reminders for all sessions

- Run `ruff check` on every file you create or modify before committing.
- Check this file and CLAUDE.md before starting. CLAUDE.md has the canonical architecture and data model. This file has the real-world state.
- The user is learning — include a Change Report at the end of every substantive response (format defined in CLAUDE.local.md).
- Commit messages use Conventional Commits format (`feat:`, `fix:`, `chore:`). Include `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` in every commit.
