"""phase4 step 1: pgvector + transcript embeddings + tag GIN index

Revision ID: 0006_phase4_search
Revises: 0005_phase3_summaries
Create Date: 2026-06-04 00:00:00.000000

Phase 4 enables semantic search over `transcript_segments` (US-22 /
FR-4.01..05, FR-4.15). Three changes:

1. `CREATE EXTENSION vector` — the compose Postgres image is
   `pgvector/pgvector:pg16` so the extension is installed but the
   migration still has to enable it. Keeping it in this migration
   means a fresh DB built from scratch is search-ready.

2. Add a nullable `embedding vector(1536)` column to
   `transcript_segments`. Nullable because population is async — the
   `embed_meeting_segments` Celery task tail-chains off
   `summarise_meeting`, and existing rows are populated by the
   `backfill_embeddings` admin command.

3. HNSW index over the embedding column with `vector_cosine_ops`.
   Partial on `WHERE embedding IS NOT NULL` so the index doesn't
   carry placeholder rows during the backfill window.

4. GIN index on `meetings.tags` so the `tags && ARRAY[...]` overlap
   filter in `GET /meetings` and `POST /search` is index-served at
   scale.

Down: drop indexes + column. The extension stays installed —
removing it from a working DB risks tripping later phases that
also use vector types.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector

revision: str = "0006_phase4_search"
down_revision: str | None = "0005_phase3_summaries"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Extension. Idempotent — no-op on prod, mandatory in CI.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # 2. Embedding column. Nullable; populated asynchronously by the
    # `embed_meeting_segments` Celery task.
    op.add_column(
        "transcript_segments",
        sa.Column("embedding", Vector(1536), nullable=True),
    )

    # 3. HNSW index, cosine distance, partial on populated rows. Built
    # against an empty column on first apply — instantaneous. The
    # backfill keeps the index incrementally maintained as rows fill
    # in.
    op.execute(
        """
        CREATE INDEX ix_transcript_segments_embedding_hnsw
            ON transcript_segments
            USING hnsw (embedding vector_cosine_ops)
            WHERE embedding IS NOT NULL
        """
    )

    # 4. GIN index on the meetings.tags array. Supports both the
    # `&&` overlap operator used by the filter and the future
    # contains operator if we add tag-equals semantics later.
    op.execute(
        "CREATE INDEX ix_meetings_tags_gin ON meetings USING GIN (tags)"
    )

    # 5. App role grants. The embedding column is part of
    # transcript_segments so existing grants already cover it; no
    # new grant statements needed.


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_meetings_tags_gin")
    op.execute("DROP INDEX IF EXISTS ix_transcript_segments_embedding_hnsw")
    op.drop_column("transcript_segments", "embedding")
    # Intentionally leave the extension installed — removing it from
    # a working DB risks tripping later phases.
