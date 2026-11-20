# Turso primary database / Cloudflare standby architecture

**Status:** Approved target architecture; implementation and cutover are not yet authorized  
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

The public Batchmate page currently reads the static batchmate_data.json and tight_tickets.json files; it is not yet consuming the Worker/Turso API as its live data source. The Worker also exposes D1 and Turso endpoints, but that does not by itself make the website Turso-primary. The frontend data contract and API integration must be migrated and parity-tested before cutover.\n\nThe temporary preview run is separate. It loaded 100 recent draws in each of those 12 streams into temp_preview_* tables. It did not populate the canonical session_draws table and is not a full-history migration.

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

- Existing Markov models, model versions, training cutoffs, and any saved transition/frequency artifacts.
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
2. Design and apply the complete Turso schema in a separate test database or isolated prefixed tables. Do not drop or rename current tables.
3. Copy the complete existing Main D1 dataset into Turso in bounded, resumable batches. Include all 17 sources, 84,589 known drawing records, 17 source-file metadata records, 31 ingestion runs, and all model/replay artifacts found during inventory.
4. Verify exact key coverage, row payload hashes, source metadata, ingestion metadata, and model identity. Counts alone are insufficient.
5. Refactor the Worker data-access layer so Turso is the only normal application database. Keep D1 bindings out of normal request handlers except for the explicit read-only fallback adapter and replication process.\n6. Migrate the static Batchmate/NumberLab frontend contracts to the Worker API or a generated, versioned response cache whose source is Turso; do not point the frontend directly at database credentials.\n7. Shadow-test every frontend data view against the existing JSON output and current D1 results.
6. Implement and test the service-mode state machine, user-facing banner, cache behavior, quota detection, and read-only restrictions.
7. Establish Turso-to-D1 standby replication and prove the D1 mirror is eligible before any production failover test.
8. Run read-only shadow comparisons between old D1 results and Turso results for every API route and game.
9. Obtain explicit approval before changing production routing, enabling failover, unpausing ingestion, enabling Cron, or retiring any existing data store.

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
- Main D1: preserved as the current complete source during migration.
- Separate Backup D1: incomplete; not eligible for failover.
- Production ingestion: paused.
- Cloudflare Cron: not enabled.
- Automatic failover/failback: not enabled.
- Production routing: unchanged.
