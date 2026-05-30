# @meeting-intelligence/shared-types

TypeScript types consumed by the desktop app (`apps/desktop`) for typed WS payloads, REST responses, and shared domain shapes.

## Source of truth: Pydantic, not TypeScript

The backend is Python — it does not import from this package. The canonical schema definitions live as **Pydantic models in `backend/src/meeting_intelligence/`**. This package is a hand-mirrored TypeScript reflection of those models.

This is deliberately temporary. A later phase will introduce automated codegen (likely `datamodel-code-generator` or `openapi-typescript` against the FastAPI spec) so the TS side regenerates from the Pydantic source of truth. Until that codegen lands:

- Any change to a Pydantic model must be mirrored here in the **same PR**.
- Do not invent shapes here that don't exist in `backend/`. If you need a new type, add the Pydantic model first.

## Usage

```ts
import { TranscriptLine, Speaker } from "@meeting-intelligence/shared-types";
```

Consumed via the pnpm workspace alias (`workspace:*`) — no build step.
