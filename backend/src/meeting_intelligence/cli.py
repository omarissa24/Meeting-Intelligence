"""Admin CLI (`mi`).

Lightweight Typer wrapper for ops commands that don't fit the HTTP
API. Today: dispatching the embedding backfill task. Future commands
should follow the same shape — one Typer command, one Celery dispatch
or one read-only DB introspection — and stay out of feature-route
territory.

Run via the entry point installed by `pyproject.toml`:

    uv run mi backfill-embeddings --user-id <uuid>
    uv run mi backfill-embeddings   # all users
"""

from __future__ import annotations

import typer

app = typer.Typer(help="Meeting Intelligence admin CLI", no_args_is_help=True)


@app.callback()
def _root() -> None:
    """Force Typer to keep subcommand structure even with one command.

    Without a callback Typer flattens `mi backfill-embeddings` to bare
    `mi` once there's only one subcommand. The callback preserves the
    `mi <command>` shape so future commands compose naturally.
    """


@app.command("backfill-embeddings")
def backfill_embeddings_cmd(
    user_id: str | None = typer.Option(
        None,
        "--user-id",
        "-u",
        help="Limit to one user. Omit to dispatch across every meeting.",
    ),
) -> None:
    """Dispatch the embedding backfill task on the configured Celery broker.

    Uses `.delay()` so the operator's terminal returns immediately;
    progress shows up in the worker logs. The task itself iterates
    meetings (newest first) and dispatches per-meeting embed tasks.
    """
    # Lazy import: importing the worker tasks at module load forces
    # the Celery app to construct, which would error in environments
    # that haven't configured a broker (e.g. shell autocompletion).
    from meeting_intelligence.worker.tasks.embed import backfill_embeddings

    async_result = backfill_embeddings.delay(user_id=user_id)
    typer.echo(
        f"dispatched backfill_embeddings task_id={async_result.id} user_id={user_id}"
    )


def main() -> None:  # pragma: no cover — entry point shim for `python -m`
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
