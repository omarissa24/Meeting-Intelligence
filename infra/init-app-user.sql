-- Compose-time provisioning of the application role.
--
-- Postgres bypasses every RLS policy for any role with rolsuper=true or
-- rolbypassrls=true (FORCE ROW LEVEL SECURITY does NOT change this for
-- the *table owner's* superuser status — it forces RLS for the owner
-- relative to its own tables, but a superuser session ignores RLS
-- entirely). The backend must therefore connect as a non-privileged
-- role; `app_user` is that role.
--
-- The 0001 migration also handles `CREATE ROLE app_user NOLOGIN` so
-- pytest-postgresql / fresh DBs without the compose hook still get the
-- role. The compose path layers on top: it grants LOGIN with a known
-- password so `docker compose up postgres` + `uvicorn --reload` Just
-- Works in isolation mode out of the box.
--
-- Note for tests: backend/tests/conftest.py re-provisions LOGIN per
-- session against an ephemeral DB and revokes on teardown — those
-- runs are independent of this dev-time seed.

-- `current_setting(..., false)` raises if the GUC is unset rather than
-- returning empty string — protects against running this file outside
-- the wrapper's transaction (e.g. if someone drops it under
-- /docker-entrypoint-initdb.d/ by mistake).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        EXECUTE format(
            'CREATE ROLE app_user LOGIN PASSWORD %L',
            current_setting('app.app_user_password', false)
        );
    ELSE
        EXECUTE format(
            'ALTER ROLE app_user LOGIN PASSWORD %L',
            current_setting('app.app_user_password', false)
        );
    END IF;
END
$$;

GRANT CONNECT ON DATABASE meeting_intelligence TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
