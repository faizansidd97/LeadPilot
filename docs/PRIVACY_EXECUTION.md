# Anonymization and restore replay

13 November setup addition: a deployable private Cloudflare R2 adapter and disabled-by-default one-minute scheduler are now prepared. Follow [PRIVACY_CLOUD_SETUP.md](PRIVACY_CLOUD_SETUP.md) for migration preflight, storage lock/retention, secrets and deployment. The original implementation evidence below is historical; hosted resources, migration and execution have not been activated by this addition.

Implemented locally on 12 November 2026, completing migration 024 started on 19 October. The user approved identifying-content removal, 30-day non-identifying history, then expiry to a minimal completion record. No live anonymization, hosted migration, worker tick, credential change or deployment was performed.

## User and worker flow

1. An owner records a privacy request and a manager records external identity verification. Resolve intersecting holds first. Intake/review alone does not remove content.
2. Open the case's **Anonymization** section and refresh status. When configured, an owner with recent MFA explicitly confirms preparation against current case, subject and policy versions. Unknown save results recover only the original payload/key; acknowledged saves recover with reads only.
3. Preparation freezes subjects and rejects active/uncertain AI, relevant running outbox work, holds and unattributed import content. Selected leads and their children disappear from authenticated RLS reads. Existing business RPC/replay paths pause for the agency until cleanup completes. Authorized managers retain privacy-list/status access.
4. A worker claims one 60-second lease and signs a minimal scope manifest. It creates the independent object with If-None-Match: * and reads it back. Exact original signed text must verify before cleanup. An existing old-key object is accepted only when its key is retained. Storage failure leaves customer content intact and permits lease recovery.
5. Each apply removes at most 25 subjects in one transaction, rechecking lease, exact manifest digest, case version/state, holds and processing. Failure rolls back content, history and progress together. Later ticks skip completed subjects. Closing an agency can include already-scrubbed leads.
6. Completion retains aggregate counts for 30 days. Reads hide expired summaries even before the expiry tick; the expiry RPC removes summaries in batches of 25 jobs. Minimal private completion and anti-revival evidence remains.

The pending operation cannot be undone or withdrawn through ordinary case review. Agency business actions may temporarily return PRIVACY_FROZEN. Closure revokes only that agency's memberships/invitations/integrations and processing access; shared Auth users and their independent memberships survive. User code never receives a service key.

## Data treatment

| Stored copy | Treatment |
| --- | --- |
| Selected leads | Hidden constant shells; no real name/email/phone, assignee, budget/requirements, notes/facts, source reference, outcome or current analysis. The fixed example.invalid address satisfies the old contact constraint; archive/do-not-contact and write barriers stay enforced. |
| Messages/revisions, tasks, drafts/feedback, AI analyses/jobs/private contexts/provider attempts/copy receipts | Removed together after active/uncertain processing is resolved. No external message/provider call is made. |
| Notices/outbox | Relevant queued notices cancelled at preparation; linked notices/payloads removed during cleanup. Delayed subject writes are fenced. Closure clears the scoped outbox. |
| Imports | Linked payloads/errors cleared and made non-retryable; the affected import's identifying reason cleared. Lead scope refuses unattributed payload/error rows rather than erasing unrelated rows. Closure clears all scoped import content. |
| API retries | Receipts referencing selected lead/message/task/job/draft/case/import UUIDs are replaced by a fixed redacted response. Keys/hashes remain to prevent duplicate creation. Unrelated receipts survive. |
| Website provenance | Raw external event ID removed; a one-way hash barrier prevents an exact old website event replay from recreating the customer. |
| Audit/privacy notes | Linked activity rows and identifying case/review/reference text removed. Closure clears all scoped activity/case text. Private minimal completion replaces the execution trail. |
| Agency identity/access | Fixed agency/integration labels, cleared member display labels, inactive memberships, disabled integrations/AI/processing, redacted revoked invitations. Shared Auth accounts are preserved. |
| Anonymous history | Aggregate lead/message/task counts only; hidden/removed after 30 days. |
| Completion/restore evidence | Protected job/case/subject UUIDs, authorization references, versions/timing, manifest digests and replay keys/hashes remain. These technical tombstones are not publicly anonymous customer history and require separate operator retention review. |

Arbitrary unrelated free text cannot be reliably attributed by a UUID graph. Review duplicates, unattributed notes/imports and external provider/log/export/customer-channel copies before preparation. The implementation does not certify legal anonymization or erase an external service's copies. Fresh inquiries with a new identity/event are not matched using erased contact details.

## Install and configure

Existing schema: review and apply only **20261019122219_privacy_anonymization.sql** (024). Fresh schema: use the generated atomic **001–024 setup.sql** bundle. Never rerun the setup bundle on initialized tables. `node backend/scripts/setup-supabase.mjs --sql-only` rebuilds SQL without reading/writing local environment configuration.

Execution defaults to disabled in both private DB policy and application configuration. No new credentials were generated or populated. Server-only names are in frontend/.env.example:

- PRIVACY_EXECUTION_ENABLED=true
- PRIVACY_MANIFEST_STORE_URL: approved private HTTPS object adapter base path
- PRIVACY_MANIFEST_STORE_TOKEN: scoped server credential, at least 32 characters
- PRIVACY_MANIFEST_ACTIVE_KEY: immutable key ID
- PRIVACY_MANIFEST_KEYS: JSON key ring; IDs map to 32-byte lowercase hex HMAC keys. Retain old keys for manifests/backups.

The adapter must support GET and immutable conditional PUT to `<base>/<job UUID>.json`, returning 404 for missing and 412 for an existing object. The application verifies signed read-back, rejects redirects, bounds bodies and times out requests. Operators must establish private access, write-once retention, approved region and recovery independent of the CRM database/backup lifecycle. An ordinary mutable bucket or incomplete object listing does not establish a complete ledger. No external adapter was provisioned here.

After staging review, a database operator can enable private.privacy_policy and increment its version through reviewed SQL. There is no user-facing policy bypass. Correct configuration and recover existing jobs; do not delete pending jobs/barriers. Stop application/worker enablement for an operational pause.

**POST /api/internal/privacy** requires the existing CRON_SECRET bearer authorization and processes one claimed batch plus expiry. No scheduler is installed by this change. Explicit operator tick: `node --experimental-strip-types backend/scripts/privacy-operator.mjs --run-worker --connect`. No remote work happens without --connect. Logs/output contain only status/counts. Never invoke it from a build step.

## Restore before reopening

Restore offline with user ingress, direct Data API access and other workers disabled **before** loading the backup. An old backup can predate privacy intents, migration 024 and the gate itself; a flag inside that backup cannot prove safety. Apply missing migrations offline first.

Get a complete export from the independent immutable ledger and its separately verified digest. The operator must establish inclusion of every prepared operation through the recovery point; completeness is not inferred from the restored DB or a fresh object listing. Export shape: `{ "format_version": 1, "manifests": [ <signed objects> ] }`. Protect the export and all retained HMAC keys: manifests contain opaque scope IDs even though they contain no customer text.

Replay: `node --experimental-strip-types backend/scripts/privacy-operator.mjs --restore --connect --bundle <protected export path> --sha256 <independent digest>`.

Every signature/scope and the exact bundle digest are validated before writes. Replay then blocks database identity/RLS, applies all manifests and **leaves the gate blocked by default**. A partial failure cannot open it. It handles intents absent from an older backup, scrubs restored copies for terminal jobs, recreates barriers, preserves foreign tenants and never recreates anonymous summaries that may have expired.

After checking replay and external copy/provider reconciliation, rerun the same checkpoint with **--finish** to release the DB gate. Applied receipts must match the exact checkpoint count. Reopen external ingress/other workers only after separate operator approval. Restored provider state is scrubbed without contacting providers; external charge/dispute evidence must be independently retained and reconciled. This is not purchased-tier RPO/RTO acceptance.

## Evidence and limits

New tests cover actual isolated SQL permissions/MFA/holds, late writes and exact intake replay, scoped public/private cleanup, unrelated receipts/tenants, cleanup/migration rollback, 26-subject leases, closure/shared Auth, expiry, and actual older database dump/load with independent replay. Injected transports cover signatures/old keys, conditional-write/readback races and unavailable/oversized manifests. Client tests cover original-operation recovery, MFA, closed scope and malformed/cross-case progress.

The final complete run at 12 November 00:52 Asia/Karachi passes **836/836 tests**, both package types, 100 analysis/56 draft constructed contracts, saved inventory and production build. LOCAL_CHECKS.json binds 330 source files. Real independent storage durability/complete export procedure, signed hosted MFA, concurrent DB sessions, very large per-lead child sets, mounted browser/accessibility and deployed scheduling/external copies remain staging gates. The feature is not enabled or deployed and A22 release acceptance remains pending.

The focused set adds 24 tests. Initial test fixtures omitted a required draft state and then used a non-schema state; those fixtures were corrected. A restore receipt lookup initially used an invalid PL/pgSQL variable qualifier; the explicit block label fixes it. All focused and full checks passed after these corrections. Final UI review also kept preparation recovery outside the parent disabled fieldset, retained the parent action guard while an original request needs recovery, and added a synchronous parent/MFA guard before child dispatch. No live evidence is inferred from these helper/type/build checks.
