from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/cineplex_watcher"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Auth
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 7
    magic_link_base_url: str = "http://localhost:3000/auth/verify"
    magic_link_expire_minutes: int = 15
    # Set true in production (HTTPS only) — browsers silently drop Secure
    # cookies served over plain http://, so this must stay false in local dev.
    cookie_secure: bool = False

    # CORS — comma-separated list of browser origins allowed to send
    # credentialed requests. Production: "https://cinewatch.ca,https://www.cinewatch.ca".
    cors_origins: str = "http://localhost:3000"

    # Email (Resend)
    resend_api_key: str = ""
    from_email: str = "alerts@yourdomain.com"

    # SMS (Twilio)
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from_number: str = ""

    # Web Push (VAPID)
    vapid_private_key: str = ""
    vapid_public_key: str = ""
    vapid_claim_email: str = ""

    # Movies (TMDB — landing-page "Now Playing" poster carousel)
    # The v4 "Read Access Token" (a long JWT) sent as a Bearer header.  Leave
    # blank to disable the carousel: the endpoint then returns an empty list and
    # the frontend falls back to the brand motif — same dev-mode-fallback
    # convention as Resend / Twilio / Web Push.
    tmdb_api_token: str = ""
    # ISO-3166-1 region used to scope "now playing" to Canadian release windows.
    tmdb_region: str = "CA"

    # Logging (Phase 5 Step 3)
    # Set LOG_LEVEL=DEBUG to see SQL queries and verbose service output.
    log_level: str = "INFO"
    # Set LOG_JSON=true in production for structured JSON output (one object
    # per line) that log aggregators (Datadog, Loki, CloudWatch) can parse.
    # Leave false in local dev for pretty coloured console output.
    log_json: bool = False

    # Rate limiting (Phase 5 Step 2)
    # Toggle without ripping out decorators — handy for pytest runs and load tests.
    rate_limit_enabled: bool = True
    # Storage URI passed straight to `limits` (slowapi's backend). Defaults to the
    # same Redis we already use for pub/sub so per-worker counters stay in sync.
    # Set to "memory://" to fall back to per-process counters (single-worker only).
    rate_limit_storage_uri: str = ""
    # Trust X-Forwarded-For when extracting the client IP.  Leave off in local dev
    # (where the header is unset and `request.client.host` is correct).  Flip on
    # ONLY when deployed behind a proxy you control (Railway, Fly, Cloudflare).
    rate_limit_trust_forwarded_for: bool = False


settings = Settings()
