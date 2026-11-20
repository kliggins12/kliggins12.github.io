# Batchmate Cloudflare backend

This is the first infrastructure stage for moving Batchmate and Slotterhouse off the Python/GitHub Actions publishing chain.

## Architecture

- Cloudflare Worker: scheduled source collection, parsing, D1 indexing, Turso session synchronization, and read API.
- D1: ingestion runs, source-file metadata, and canonical indexed drawings for all 17 sources.
- R2: immutable-by-version-key source CSV archive (current object key per source is updated only after parsing and required database writes succeed).
- Turso: canonical chronological history for the 12 Pick 3, Daily 4, and All or Nothing session streams.
- Pages: static Batchmate and NumberLab frontends.

The collector validates all 17 responses as non-empty CSV-like content, hashes each file, skips unchanged sources, and archives changed sources in R2. A changed file is parsed and upserted into D1 before its current-source metadata pointer is advanced. For Pick 3, Daily 4, and All or Nothing, the same parsed rows are also upserted into Turso's 12 session streams. If parsing or the Turso write fails, the current-source pointer is not advanced, so the next scheduled collection retries the file. The previous versioned R2 object remains available.

## Important migration boundary

This first stage does **not** yet replace the existing Python analysis algorithms or generate the existing `batchmate_data.json` and `tight_tickets.json` contracts. Those need to be ported and regression-tested before the frontend switches to the new API. The existing Pages app remains unchanged during this stage.

## Cloudflare setup

1. Create a D1 database named `batchmate`.
2. Create an R2 bucket named `batchmate-source-archive`.
3. Replace the D1 `database_id` placeholder in `wrangler.toml`.
4. From this directory run `npm install`.
5. Apply the schema: `npx wrangler d1 migrations apply batchmate --remote`.
6. Set the manual ingestion token: `npx wrangler secret put API_TOKEN`.
7. Deploy: `npm run deploy`.

The Worker cron runs every 30 minutes (UTC). You can also manually trigger ingestion with:

```sh
curl -X POST "https://YOUR-WORKER.workers.dev/api/admin/ingest" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

## API

- `GET /health`
- `GET /api/status`
- `GET /api/turso/health`
- `GET /api/session-draws/summary`
- `GET /api/session-draws?game=...&session=...`
- `GET /api/sources/:filename` (one of the 17 allowlisted CSV names)
- `POST /api/admin/reindex?file=...` (Bearer token required; reindexes D1 and mirrors sessioned games into Turso)
- `POST /api/admin/ingest` (Bearer token required; changed files are parsed and synchronized before metadata advances)

## Next migration milestones

1. Inspect and fixture-test each of the 17 CSV schemas.
2. Port date/number parsing into TypeScript with game/session provenance.
3. Build idempotent draw records in D1 while retaining raw CSVs in R2.
4. Port Batchmate's analysis engine and compare output against known Python outputs.
5. Add Slotterhouse journal, exact-position shapes, transitions, and assumptions on the shared draw store.
6. Switch frontend reads to the Worker API only after parity tests pass.
7. Move static hosting to Cloudflare Pages and verify AdSense and all routes before changing DNS or the public URL.
