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

The new `lottery_draws` table uses `(source_filename, draw_date)` as its key. It preserves game, session, number order, source hash, and import timestamp. The existing `session_draws` table is retained during the compatibility period; it is not dropped by the migration. The same additive schema adds `analysis_artifacts`, a versioned store for the existing Batchmate analysis JSON snapshots.

Run the schema initializer manually from GitHub Actions **Initialize Batchmate Turso Database** only after confirming the intended Turso database and credentials. The initializer applies both schema files idempotently and verifies the required tables. It does not copy drawing rows.

The all-game migration is a separate manually dispatched workflow: **Turso primary full-history migration**.

- `report` is read-only. It reads the 17 D1-backed feeds through the existing Worker API, reads the matching Turso rows, and compares row counts plus SHA-256 fingerprints.
- `import` requires the exact confirmation phrase `IMPORT-ALL-17-SOURCES`. The script then performs idempotent upserts in batches of 100 and verifies every source after writing.
- The script refuses a missing source, malformed row, duplicate date, wrong source/game/session, non-ISO date, invalid number payload, hash mismatch, or pagination that does not advance.
- A report/import run records only aggregate counts, fingerprints, and source/date coverage in its output. It does not print lottery number payloads or credentials.
- Import is not run automatically by a push or deployment.

The first report is expected to reveal how many rows are present in the unified Turso table before any import. A read-only report is the correct next operational check after applying the schema.

The separate manually dispatched workflow **Turso Batchmate analysis artifact migration** validates and compares the two published analysis snapshots. Its `import` mode requires the exact confirmation phrase `IMPORT-ANALYSIS-ARTIFACTS`, retains prior versions, and verifies the imported payload hashes. This is not the drawing-history import and must be run only after the Turso schema has been applied.

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
- `GET /api/primary/draws/summary` (all 17 Turso feeds)
- `GET /api/primary/draws/latest` (latest draw per source)
- `GET /api/primary/analysis` (latest verified Batchmate analysis snapshots)
- `POST /api/primary/admin/ingest` (Bearer token required; refuses until full-history migration verification passes)
- `POST /api/primary/admin/reindex?file=...` (Bearer token required; Turso-only reindex of one archived source)
- `GET /api/primary/draws?game=...&session=...&limit=...` (all-game history with date/source cursor)
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
- Analysis artifact migration workflow: `.github/workflows/turso-analysis-artifacts.yml`
- Turso is configured as the future ingestion target via `DATA_MODE = "turso-primary"`; production ingestion remains paused via `INGEST_PAUSED = "true"` and an empty Cron list.
- The new Turso-first collector is a code path only; it has not been run against live data.


## Website integration status

The implementation branch changes the Batchmate homepage to try Turso analysis snapshots first, then fall back to the public generated JSON snapshots. It prefers Turso's latest-drawing endpoint and retains the existing Worker/D1 route as fallback. The NumberLab page uses the all-game history endpoints only when all 17 expected feeds are present and non-empty; otherwise it clearly labels the 12-stream session-history fallback. Its current journal/comparison/frequency screens describe observed history and do not claim to predict future results.

The analysis snapshot import has not been run. Until the additive Turso schema and artifact migration are run and verified, Batchmate continues to use the published JSON fallback. These site changes are not deployed to the production branch.

No existing Markov/model artifact files were found in the scanned Batchmate and website GitHub repository trees. This does not prove there are no such artifacts in another store; inspect the existing Turso database and any external storage before treating the model inventory as complete.
