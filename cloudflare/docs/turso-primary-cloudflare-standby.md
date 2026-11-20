# Turso primary database / Cloudflare standby architecture

**Status:** Approved target architecture; implementation in progress; production cutover not authorized  
**Prepared:** 2026-11-20  
**Scope:** Batchmate, NumberLab, drawing history, ingestion metadata, analysis notes, and board/Markov data

## 1. Architecture decision

- **Turso is the authoritative primary database** for all application data.
- **Cloudflare Workers remain the API and service runtime.** Cloudflare is not removed from the request path.
- **Cloudflare D1 is the read-only standby replica** used only when the Turso primary cannot serve requests.
- Cloudflare R2 may continue to hold immutable raw-source archives; it is object storage, not a competing source of truth.
- Existing Main D1 data and all existing Markov/model artifacts must be preserved during migration.
- No automatic failover, failback, ingestion schedule, or production cutover is enabled by this document.

## 2. Important current-state distinction

The current Worker is not yet Turso-primary. The current code uses D1 for source-file metadata, ingestion runs, and the indexed draw history. It also mirrors only the 12 Pick 3, Daily 4, and All or Nothing session streams into Turso. The other game histories and D1 operational metadata are not yet represented by the current Turso session-history schema.

The implementation branch now changes the Batchmate homepage to prefer the integrity-checked `/api/primary/analysis` endpoint for `batchmate_data.json` and `tight_tickets.json`, with fallback to the existing public generated JSON files. It prefers the Turso `/api/primary/draws/latest` endpoint and falls back to the existing Worker/D1 endpoint. The two analysis snapshots are stored as versioned records in `analysis_artifacts`; a separate manually confirmed workflow validates and imports them. That workflow has not been run, so the JSON fallback remains necessary until the snapshots are present in Turso.

The NumberLab client also has a compatibility-aware reader: it selects the all-game Turso API only when all 17 expected feeds are present and non-empty, otherwise it uses the older 12-stream session history and labels it as limited. It renders a drawing journal, consecutive-draw comparisons, observed frequency summaries, and the recent Pick 3 sequence. These are descriptive views, not a Markov forecasting model. Both frontend changes are on the implementation branch and are not deployed. The Worker itself is still D1-based for ingestion and legacy draw routes; these added endpoints are read-only and do not by themselves make the whole application Turso-primary.

The temporary preview run is separate. It loaded 100 recent draws in each of those 12 streams into temp_preview_* tables. It did not populate the canonical session_draws table and is not a full-history migration.

The existing Cloudflare Main D1 is the current complete source to preserve during the initial migration. The separate batchmate-backup D1 was previously only partially seeded (60,000 of 84,589 drawings and no source-file metadata) and is not eligible for failover.

## 3. Turso primary data scope

Turso must hold the complete operational dataset required by Batchmate and NumberLab, not only the 12 sessioned streams.

### Canonical drawing and ingestion data

- All 17 current CSV sources: four sessions each for All or Nothing, Pick 3, and Daily 4, plus Cash Five, Texas Two Step, Lotto Texas, Powerball, and Mega Millions.
- Normalized drawing rows with game, session, date, number payload, source filename, source hash, and import timestamp.
- Source-file metadata and SHA-256 hashes.
- Ingestion-run history, status, counts, timestamps, and errors.
- A source-to-draw uniqueness rule that prevents duplicate imports while permitting a corrected drawing to be reconciled safely.

### Analysis and model data

- Any existing Markov models, model versions, training cutoffs, and saved transition/frequency artifacts that are found in the full external data inventory. No such model/artifact files were found in the scanned Batchmate and website repository trees; this does not rule out external Turso or other storage.
- Compact analysis notes and their source-window provenance.
- Pick 3 and Daily 4 session-specific analysis outputs.
- All or Nothing analysis outputs and its complement/pair calculations.
- Board replay runs, events, checkpoints, assumptions, and evaluations.
- Any other persistent NumberLab state discovered during the pre-cutover inventory.

Do not replace an existing model with a newly computed model merely because the database is changing. Preserve the original model payload, version, parameters, and training cutoff. Rebuild only through a separately tested migration.

## 4. Cloudflare standby contents and replication

Cloudflare Main D1 becomes the standby copy after Turso has been populated and verified. The existing separate Backup D1 remains a secondary recovery copy until it is independently repaired and verified.

Replication direction after cutover is one-way:

**Turso primary → Cloudflare D1 standby**

Normal user reads and writes go to Turso. D1 is not dual-written on every application request. A controlled replication job copies only changed rows, source metadata, ingestion metadata, and model/replay records that are required for read-only service.

The replication process must:

1. Use a durable cursor or change sequence so it can resume without skipping gaps.
2. Be idempotent; retrying a batch must not duplicate records.
3. Reserve and enforce a daily write budget before sending each D1 batch.
4. Check actual D1 usage as a secondary signal, not as its only quota control.
5. Verify row counts, key coverage, per-source date ranges, source hashes, model versions, and replay metadata.
6. Publish a last-verified replication timestamp and replication status.
7. Mark the standby ineligible whenever replication is incomplete, stale beyond the configured limit, or verification fails.

The D1 standby is a last-verified snapshot, not an active independent writer. Do not silently write application changes to D1 while Turso is unavailable. Default degraded mode is read-only and pauses ingestion and saved changes. A separate write-promotion/reconciliation design would be required before allowing writes during a primary outage.

## 5. Failover modes

The API must expose an explicit service mode. Do not infer a database outage from every exception.

### PRIMARY

- Turso is healthy and within configured internal usage thresholds.
- Reads and writes are served by Turso.
- D1 replication runs separately and is not on the user request path.

### BACKUP_READ_ONLY

Enter only when a recognized Turso quota-exhaustion or primary availability condition is confirmed and the D1 standby passes its own health and freshness checks.

- Read-only requests may be served from the last verified D1 snapshot.
- All ingestion, reindexing, model writes, board mutations, and other database writes are paused.
- The API response identifies the data as a backup snapshot and includes its last-verified timestamp.
- The frontend displays a persistent degraded-mode banner.

Suggested user-facing message:

**“The primary database is temporarily unavailable or has reached its usage limit. Batchmate is showing the latest verified Cloudflare backup, updated [timestamp]. New drawings and saved changes are paused while the primary service is restored. Live data will return when the primary database is available again.”**

Do not promise a specific restoration time. The recovery time depends on the provider's quota period, account plan, and service availability.

### MAINTENANCE

Use when Turso is unavailable and the D1 standby is missing, stale, over quota, or fails verification.

- Do not serve an unverified or inconsistent dataset as current.
- Show a maintenance message and the last known successful data timestamp.
- Do not attempt writes to either database.

## 6. Failback to Turso

Do not switch back on the basis of one successful ping.

Before returning to PRIMARY:

1. Confirm Turso connectivity and successful read/write health checks using a controlled test record or dedicated health table.
2. Confirm the Turso quota/availability condition has cleared.
3. Reconcile any allowed operational changes since the last primary checkpoint. Under the default read-only backup mode there should be no user data writes to reconcile.
4. Compare canonical counts, source hashes, date ranges, model versions, and replication cursors.
5. Require repeated successful checks over a short stability window.
6. Switch the service mode back to PRIMARY and record the transition.

## 7. Quota and cost controls

As checked on 2026-11-20, Turso's published Free plan lists 5 GB storage, 500 million monthly rows read, 10 million monthly rows written, and 3 GB monthly sync allowance. Turso's pricing page also says extra usage is billed automatically when overages are enabled. Confirm the actual account plan, renewal period, and overage setting in the Turso dashboard before enabling production use.

Cloudflare's published Workers Free D1 allowance is 5 million rows read per day and 100,000 rows written per day. D1 Free queries are rejected after the daily read or write limit is reached until the UTC reset. Therefore, D1 must not be treated as unlimited capacity simply because it is the standby.

Required controls:

- Track application-level rows read/written and provider usage where available.
- Set internal alerts at 70%, 85%, and 95% of the applicable plan allowance.
- Keep a reserved safety margin; stop optional analysis and ingestion before reaching a hard provider limit.
- Do not enable Turso overages or upgrade a plan without an explicit account-owner decision.
- Cache frequently requested read-only results at the Cloudflare edge where appropriate to protect both databases.
- Keep health checks small and avoid frequent full-table scans.

## 8. Migration sequence

1. Inventory all existing D1 tables, Markov/model artifacts, Turso databases/tables, current Turso usage, and all application routes that read or write data.
2. Design and apply the complete additive Turso schema. The implementation branch now adds `lottery_draws` for all 17 feeds, operational metadata tables, and an import-verification ledger. Existing tables are retained.
3. Run the new read-only full-history report. It compares all 17 D1-backed source feeds with unified Turso records using row counts and SHA-256 fingerprints. The separate import mode requires an exact confirmation phrase and uses idempotent batches of 100.
4. After the drawing import, verify exact key coverage, row payload hashes, source metadata, complete ingestion metadata, and model identity. Drawing fingerprint verification is implemented; metadata/model transfer is still outstanding.
5. Refactor the Worker data-access layer so Turso is the only normal application database. This implementation has not yet changed the production Worker read/write paths.
6. Complete the Batchmate generated-combination API contract and shadow parity checks. NumberLab's compatibility-aware reader is implemented, but the full 17-feed path remains gated on successful migration and verification. Do not point the frontend directly at database credentials.
7. Shadow-test every frontend data view against the existing JSON output and current D1 results.
8. Implement and test the service-mode state machine, user-facing banner, cache behavior, quota detection, and read-only restrictions.
9. Establish Turso-to-D1 standby replication and prove the D1 mirror is eligible before any production failover test.
10. Run read-only shadow comparisons between old D1 results and Turso results for every API route and game.
11. Obtain explicit approval before changing production routing, enabling failover, unpausing ingestion, enabling Cron, or retiring any existing data store.

## 9. Release gates

Production cutover is blocked until all of the following are true:

- Every game and session is represented in Turso.
- Every existing model and required NumberLab artifact is preserved and verified.
- All application read/write paths use the Turso adapter in shadow tests.
- Cloudflare D1 standby is complete, current, and verified.
- Backup-mode requests are read-only and clearly marked as backup data.
- Quota-exhaustion handling has been tested without consuming production quotas.
- Failback and reconciliation have been tested.
- A recovery/rollback procedure is documented.
- The account owner explicitly authorizes production cutover and failover activation.

## 10. Current operational status

- Temporary Turso preview: completed for 1,200 sample drawing rows across 12 streams.
- Canonical Turso full-history migration: not performed.
- Batchmate analysis snapshots: versioned schema and guarded import workflow added; import not performed.
- NumberLab history UI and Batchmate Turso-first fallback code: added on implementation branch; not deployed.
- Main D1: preserved as the current complete source during migration.
- Separate Backup D1: incomplete; not eligible for failover.
- Production ingestion: paused.
- Cloudflare Cron: not enabled.
- Automatic failover/failback: not enabled.
- Production routing: unchanged.


## 11. Implementation branch status (2026-11-20)

The branch `implementation/turso-full-history` adds an additive all-game Turso schema, a guarded 17-feed plus operational metadata migration, versioned Batchmate analysis snapshot storage/import, read-only all-game Worker routes, and compatibility-aware Batchmate/NumberLab frontends. The drawing import and analysis artifact import have not been run against live Turso. The production Worker, frontend deployment, ingestion schedule, D1 replication, and hosting route remain unchanged.
