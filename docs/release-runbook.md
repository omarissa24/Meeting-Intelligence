# Release runbook

How a desktop release goes from a commit on `main` to an auto-updating
installed app, and every secret/credential the pipeline needs.

## TL;DR — cutting a release

```bash
scripts/release-desktop.sh 1.2.0      # writes version, commits, tags v1.2.0
git push origin main v1.2.0           # CI builds signed bundles into a DRAFT release
# …wait for desktop-release.yml to finish on both runners…
# then: GitHub → Releases → publish the draft.   ← the go-live switch
```

Publishing the draft is deliberate and load-bearing:

- the marketing site (`apps/web`) lists download links from the latest **published** release;
- the backend `GET /updates/...` endpoint serves the updater manifest from the latest **published** release.

An unpublished draft ships nothing and updates no one.

## How auto-update works (US-24 / FR-4.06 / FR-4.07)

1. `desktop-release.yml` builds on `v*` tags via tauri-action with
   `createUpdaterArtifacts: true` → every bundle gets a minisign `.sig`
   from `TAURI_SIGNING_PRIVATE_KEY`, and `includeUpdaterJson: true`
   uploads a `latest.json` manifest to the release.
2. The backend (`GET /updates/{target}/{arch}/{current_version}`,
   `UPDATES_PROVIDER=github`) reads that `latest.json` from the latest
   published release (5-min cache, stale-on-error) and answers the
   Tauri updater protocol: 200 + artifact URL/signature when strictly
   newer, 204 otherwise. The strict-semver check on both server and
   plugin is the downgrade protection.
3. The installed app checks on launch + every 24 h
   (`use-update-checker.ts`), downloads in the background, and shows the
   "Restart to update" banner — suppressed while a recording session is
   in flight.

The updater endpoint base URL is committed in
`apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.endpoints`.
**Before the first real release**, replace the placeholder host with the
deployed backend hostname, and replace `pubkey` with the real public key
(below).

### Local simulated-update E2E

```bash
# 1. serve a fake manifest claiming a huge version:
cat > /tmp/latest.json <<'EOF'
{"version":"99.0.0","pub_date":"2026-06-10T00:00:00Z","notes":"test",
 "platforms":{"darwin-aarch64":{"url":"https://example.com/x.tar.gz","signature":"sig"}}}
EOF
UPDATES_FAKE_MANIFEST_PATH=/tmp/latest.json uv run uvicorn meeting_intelligence.main:app
# 2. point a dev build's updater endpoint at http://localhost:8000 and launch.
#    The banner appears; downgrades (version <= current) return 204 instead:
curl -i localhost:8000/updates/darwin/aarch64/0.0.1    # 200
curl -i localhost:8000/updates/darwin/aarch64/99.0.0   # 204
```

## Secrets inventory (GitHub → repo → Settings → Secrets and variables)

### Tauri updater signing (required for every release)

Generate once, guard forever — **losing the private key strands every
installed app off the update path** (they'll reject manifests signed by
a new key):

```bash
pnpm --filter @meeting-intelligence/desktop tauri signer generate -- -w ~/.tauri/marens.key
```

- Public key → paste into `tauri.conf.json` `plugins.updater.pubkey` (committed).
- `TAURI_SIGNING_PRIVATE_KEY` ← contents of `~/.tauri/marens.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ← the password chosen at generate time.

The CI guard fails any tag build where the private key secret is missing.

### macOS signing + notarization (Developer ID)

With these set, the Tauri bundler signs **and notarizes** automatically —
no extra workflow steps. First notarization commonly fails on a wrong
app-specific password or Team ID; budget one debug cycle.

| Secret                       | Value                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of the "Developer ID Application" cert exported from Keychain as `.p12`: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password                                                                                     |
| `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Your Name (TEAMID)`                                                            |
| `APPLE_ID`                   | the Apple Developer account email                                                                              |
| `APPLE_PASSWORD`             | an **app-specific password** from appleid.apple.com (not the account password)                                 |
| `APPLE_TEAM_ID`              | 10-char team ID from developer.apple.com → Membership                                                          |

### Windows Authenticode (staged — not yet purchased)

Windows builds currently ship **unsigned**: SmartScreen warns on install,
but the Tauri-updater `.sig` is independent of Authenticode, so unsigned
Windows builds still auto-update correctly. When a cert exists, set the
two secrets — no code or workflow change needed:

- `WINDOWS_CERTIFICATE` ← base64 of the `.pfx`
- `WINDOWS_CERTIFICATE_PASSWORD`

Note: macOS bundles are aarch64-only for now (the screencapturekit →
apple-metal dependency pins the runner to macos-26 and makes
cross-compiling a universal binary risky). Intel Macs are unsupported.

## Backend production deploy (Fly.io)

Config is `backend/fly.toml`; `backend-deploy.yml` deploys on pushes to
`main` once enabled. One-time setup:

```bash
fly apps create meeting-intelligence-api
fly postgres create …                      # or any managed Postgres 16 + pgvector
fly redis create …                         # Upstash Redis via Fly
fly secrets set -a meeting-intelligence-api \
  DATABASE_URL=… REDIS_URL=… \
  DEEPGRAM_API_KEY=… ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
  WORKOS_API_KEY=… WORKOS_CLIENT_ID=… WORKOS_REDIRECT_URI=… \
  S3_BUCKET=… S3_ENDPOINT_URL=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_REGION=…
# optional, only if GitHub rate limits ever bite the /updates cache:
# fly secrets set UPDATES_GITHUB_TOKEN=<fine-grained read-only PAT>
```

Then in GitHub: repo secret `FLY_API_TOKEN` (`fly tokens create deploy`)
and repo **variable** `FLY_DEPLOY_ENABLED=true`. Also set
`UPDATES_GITHUB_REPO` in `fly.toml` to this repo's `owner/name`, add the
production redirect URI in the WorkOS dashboard, and put the Fly
hostname into `tauri.conf.json`'s updater endpoint.

TLS / encryption notes (US-13, FR-2.13):

- `force_https = true` in `fly.toml` → Fly's edge terminates TLS and
  redirects plain HTTP; verify post-deploy with
  `curl -sI http://<host>/health` (expect 301/308) and
  `openssl s_client -connect <host>:443 -tls1_3`.
- S3 uploads set `ServerSideEncryption=AES256` in code; Postgres
  encryption at rest is the managed provider's job (Fly Postgres volumes
  and RDS are encrypted by default — confirm on the chosen plan).
- `auto_stop_machines = "off"` is required: live transcript WebSockets
  must not be reaped mid-meeting.

## Celery operations

- The Fly `worker` process group runs the Celery worker — the API alone
  never archives audio / summarises / embeds.
- Local monitoring: `docker compose -f infra/docker-compose.yml up flower`
  → http://localhost:5555 (basic auth `FLOWER_BASIC_AUTH`, default
  `admin:admin`). Flower is deliberately not deployed to Fly by default;
  if ops needs it, add a `flower` process group behind basic auth.
- Tasks retry 3× then dead-letter durably into the `dead_letter_tasks`
  table (task name/id, args, error, timestamp) for inspection/replay.
