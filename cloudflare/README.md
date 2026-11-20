# Batchmate backend and data infrastructure

## Target responsibilities

- **Turso:** authoritative database for all drawing history, source metadata, ingestion runs, NumberLab analysis, Markov artifacts, and board replay data.
- **Cloudflare Workers:** API runtime, source collection, request validation, caching, security, and service-mode routing.
- **Cloudflare R2:** immutable versioned CSV archives and compressed database/export snapshots. R2 is file storage, not a second database.
- **Cloudflare D1:** optional read-only standby only after it has been fully synchronized and independently verified. It is not the normal write target.
- **GitHub:** source control, tests, schema migrations, build/deployment workflows, and release history. It is not the application's live database.
- **Website hosting:** currently GitHub Pages. The move to Cloudflare Pages/Workers-hosted static assets remains a later hosting task and must not change the public route until verified.

## Current production boundary

The existing Worker still uses D1 for source-file metadata, ingestion runs, and indexed drawing history. It mirrors only the 12 Pick 3, Daily 4, and All or Nothing session feeds to the older Turso `session_draws` table. Batchmate's homepage still uses generated `batchmate_data.json` and `tight_tickets.json` outputs. NumberLab's past-draw history view currently reads the older 12-stream Turso API.

Production ingestion remains paused and the Worker has no Cron trigger. Do not unpause ingestion, enable Cron, change the live route, deploy a new database adapter, or retire D1 until the complete migration and parity tests pass.

## Turso schema and all-game history migration

The versioned schema files are:

- `turso/0001_session_history.sql`: the original 12 session streams and board replay tables.
- `turso/0002_primary_history.sql`: unified `lottery_draws` table for all 17 source files, operational metadata tables, and migration verification ledger.

The new `lottery_draws` table uses `(source_filename, draw_date)` as its key. It preserves game, session, number order, source hash, and import timestamp. The existing `session_draws` table is retained during the compatibility period; it is not dropped by the migration.

Run the schema initializer manually from GitHub Actions **Initialize Batchmate Turso Database** only after confirming the intended Turso database and credentials. The initializer applies both schema files idempotently and verifies the required tables. It does not copy drawing rows.

The all-game migration is a separate manually dispatched workflow: **Turso primary full-history migration**.

- `report` is read-only. It reads the 17 D1-backed feeds through the existing Worker API, reads the matching Turso rows, and compares row counts plus SHA-256 fingerprints.
- `import` requires the exact confirmation phrase `IMPORT-ALL-17-SOURCES`. The script then performs idempotent upserts in batches of 100 and verifies every source after writing.
- The script refuses a missing source, malformed row, duplicate date, wrong source/game/session, non-ISO date, invalid number payload, hash mismatch, or pagination that does not advance.
- A report/import run records only aggregate counts, fingerprints, and source/date coverage in its output. It does not print lottery number payloads or credentials.
- Import is not run automatically by a push or deployment.

The first report is expected to reveal how many rows are present in the unified Turso table before any import. A read-only report is the correct next operational check after applying the schema.

## Database migration sequence

1. Confirm the Turso database URL, plan, usage, and overage setting.
2. Apply the additive schema using the manual schema workflow.
3. Run the all-game migration in `report` mode and retain the output.
4. Review source counts and date ranges against all 17 existing D1 sources.
5. Obtain explicit approval before selecting `import` mode.
6. Run the idempotent import and require exact per-source fingerprint verification.
7. Migrate source-file metadata, complete ingestion-run history, model artifacts, analysis notes, Markov outputs, and board replay data; verify keys and hashes.
8. Add a Turso-first repository/data-access layer to the Worker. Keep D1 only behind a read-only, verified standby adapter.
9. Migrate the frontend data contracts. Batchmate's existing generated outputs must be reproduced and compared against the current Python outputs before switching the homepage to the API.
10. Implement cache, quota alerting, primary/backup/maintenance service modes, and failover banner.
11. Test the D1 standby replication and outage behavior without activating production failover.
12. Move website hosting only after the pages, routes, assets, ads, and custom-domain behavior are validated.

## Existing API routes

- `GET /health`
- `GET /api/status`
- `GET /api/migration/source-files` (Bearer token required; read-only migration export)
- `GET /api/migration/ingestion-runs?limit=...&before=...` (Bearer token required; read-only migration export)
- `GET /api/turso/health`
- `GET /api/session-draws/summary`
- `GET /api/session-draws?game=...&session=...`
- `GET /api/sources/:filename`
- `GET /api/draws/latest`
- `GET /api/draws?game=...&session=...`
- `POST /api/admin/reindex?file=...` (Bearer token required)
- `POST /api/admin/ingest` (Bearer token required)

The existing `/api/draws` route is the read-only migration source for the 17-feed copy. It still reads D1 at this stage and is not the final public history API.

## Deployment and operations

- Worker configuration: `wrangler.toml`
- Worker deployment workflow: `.github/workflows/deploy-worker.yml`
- Schema initialization workflow: `.github/workflows/migrate-turso.yml`
- Full-history migration workflow: `.github/workflows/turso-primary-full-history.yml`
- Production ingestion remains paused via `INGEST_PAUSED = "true"` and an empty Cron list.
