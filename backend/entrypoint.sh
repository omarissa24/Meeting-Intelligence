#!/usr/bin/env sh
# Container entrypoint.
#
# When AUTO_MIGRATE=1 is set (compose dev only), apply schema migrations
# before starting the server. Production deployments leave AUTO_MIGRATE
# unset and run migrations as a separate, observable step in CI/CD so a
# half-deployed image can't accidentally migrate on its way to healthy.

set -e

if [ "${AUTO_MIGRATE:-0}" = "1" ]; then
    echo "[entrypoint] AUTO_MIGRATE=1 — running alembic upgrade head"
    alembic upgrade head
fi

exec "$@"
