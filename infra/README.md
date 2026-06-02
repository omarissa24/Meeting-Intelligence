# Infra

Local-dev composition. Future production infra-as-code (Terraform for AWS ECS/Fargate + RDS + ElastiCache, per `docs/tech-stack.md`) will live under `terraform/`.

## docker-compose

```bash
# All services (Postgres + Redis + backend container)
docker compose -f infra/docker-compose.yml up

# Just the data plane (recommended for backend-on-host dev)
docker compose -f infra/docker-compose.yml up -d postgres redis

# Tear down (keeps volumes)
docker compose -f infra/docker-compose.yml down

# Tear down + wipe data
docker compose -f infra/docker-compose.yml down -v
```

## Verify pgvector

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U postgres -d meeting_intelligence \
       -c "CREATE EXTENSION IF NOT EXISTS vector; \
           SELECT extversion FROM pg_extension WHERE extname='vector';"
```

A version number (e.g. `0.8.0`) confirms the `pgvector/pgvector:pg16` image is wired up correctly.

## Application role (`app_user`)

The backend **must** connect as the non-privileged `app_user` role, not as `postgres`. RLS policies on `users`, `meetings`, and `transcript_segments` are how cross-user isolation is enforced — and Postgres unconditionally bypasses every RLS policy for any role with `rolsuper=true` or `rolbypassrls=true`. `FORCE ROW LEVEL SECURITY` does not save you: it only forces RLS to apply to the table *owner*; superuser sessions ignore RLS entirely.

To make a wrong setup loud rather than silent, the FastAPI lifespan calls `assert_not_bypassing_rls` at startup and refuses to come up if the connection role would bypass policies. The smoke run that prompted this guard read another user's full transcript in 200 OK before this was wired in — the policies were correct, the connection role was wrong.

### How `app_user` is provisioned

Two paths, both idempotent:

1. **Compose first-init.** `init-app-user.sh` + `init-app-user.sql` are mounted under `/docker-entrypoint-initdb.d/`. On the first `docker compose up postgres` against an empty volume, Postgres runs the wrapper, which `CREATE`s `app_user` with `LOGIN` and the password from `APP_USER_PASSWORD` (default `app_dev_password`).
2. **Migration `0001_phase2_foundation`.** Creates `app_user` `NOLOGIN` if it doesn't already exist, then grants the table-level privileges (`SELECT, INSERT, UPDATE, DELETE` on `users`, `meetings`, `transcript_segments`). This path covers fresh DBs that don't go through compose — pytest-postgresql ephemeral DBs in CI, hand-rolled dev DBs, etc.

For local dev, the two layer cleanly: compose seeds the role with LOGIN; alembic adds the privileges; the host `uvicorn --reload` connects via the URL in `backend/.env.example`, which points at `app_user`.

### Existing volumes

The compose init scripts run **only** on first DB init. If you already have a `postgres-data` volume from before this change, either:

```bash
# Option A — wipe and re-seed (loses local DB data):
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d postgres

# Option B — provision the role manually (keeps data):
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U postgres -d meeting_intelligence \
       -c "ALTER ROLE app_user LOGIN PASSWORD 'app_dev_password'; \
           GRANT CONNECT ON DATABASE meeting_intelligence TO app_user; \
           GRANT USAGE ON SCHEMA public TO app_user;"
```

### Customising the password

Set `APP_USER_PASSWORD` in `infra/.env` (gitignored) before `docker compose up`, and mirror the same value in `backend/.env`'s `DATABASE_URL`. The default `app_dev_password` is intentionally weak — it's a dev convenience, not a security boundary; production deploys provision `app_user` out-of-band with a secret manager.

### Tests

`backend/tests/conftest.py` provisions `app_user` with `LOGIN` per test session and revokes on teardown — independently of this dev-time seed. Test runs that share a Postgres instance with a running backend will not collide as long as they use different databases (the conftest carves out an ephemeral one per session). The `test_rls_bypass_check.py` suite asserts the lifespan guard fires for `postgres` and passes for `app_user`.

## Future

- `terraform/` — AWS ECS/Fargate + ALB + RDS + ElastiCache.
- Celery worker + Flower will be added here in Phase 3.
- Observability stack (OpenTelemetry collector, Prometheus, Grafana) added per `docs/tech-stack.md`.
