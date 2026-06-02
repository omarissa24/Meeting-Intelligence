#!/bin/sh
# Compose first-init wrapper for init-app-user.sql.
#
# Postgres's official image runs every executable in
# /docker-entrypoint-initdb.d/ exactly once when the data directory is
# initialised. We use a wrapper (rather than letting Postgres run the
# .sql directly) so we can pass APP_USER_PASSWORD into psql as a `-v`
# variable — embedding the password as a literal in the .sql file
# would mean either checking it in or templating at compose-up time.
# The .sql lives at /init-scripts/, NOT under /docker-entrypoint-initdb.d/,
# so Postgres doesn't also run it directly (where the GUC the .sql reads
# wouldn't be set, and the run would fail).
#
# The transaction is explicit (BEGIN/COMMIT). `SET LOCAL` only takes
# effect inside a transaction; psql's default autocommit would silently
# drop it and leave the GUC unset, which `current_setting(..., false)`
# now catches loudly rather than treating as "empty string".
#
# Idempotency: the .sql guards CREATE ROLE on `IF NOT EXISTS` and falls
# through to ALTER ROLE LOGIN PASSWORD on the existing case. Re-init via
# `compose down -v` picks up a new password if APP_USER_PASSWORD changes.

set -e

psql -v ON_ERROR_STOP=1 \
     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -v app_user_password="${APP_USER_PASSWORD:-app_dev_password}" <<'SQL'
BEGIN;
SET LOCAL app.app_user_password = :'app_user_password';
\i /init-scripts/init-app-user.sql
COMMIT;
SQL
