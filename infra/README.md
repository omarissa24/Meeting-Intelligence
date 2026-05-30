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

## Future

- `terraform/` — AWS ECS/Fargate + ALB + RDS + ElastiCache.
- Celery worker + Flower will be added here in Phase 3.
- Observability stack (OpenTelemetry collector, Prometheus, Grafana) added per `docs/tech-stack.md`.
