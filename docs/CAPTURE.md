# P4: capture, facts and conversation provenance

Local implementation for PRODUCT_PLAN.md P4. No hosted migration, live website connection or interactive browser acceptance is claimed. Development origin is http://localhost:4000.

## Migration and configuration

Fresh development projects apply backend/supabase/setup.sql once; it contains migrations 001–010 and refuses existing business tables. Existing projects through 007 apply only 202610060008_capture.sql, 202610060009_imports.sql and 202610060010_website_intake.sql in order. Never rerun the combined bundle against populated tables.

From backend, setup:supabase regenerates the bundle and preserves existing environment values. It generates a missing INTAKE_ENCRYPTION_KEY (32 random bytes, hex), alongside the existing invitation/cron secrets, without printing values. check:intake validates public Supabase fields, private SUPABASE_SERVICE_ROLE_KEY and encryption configuration locally. Missing hosted keys are still a configuration gate. Website intake needs the protected private client; ordinary user APIs continue to use verified cookies and RLS.

Keep INTAKE_ENCRYPTION_KEY on the application server. Existing encrypted credentials need that same key after a deploy or restore. Changing the master key without re-encrypting stored credentials disables those integrations. Integration signing-key rotation is available separately in the UI and does not replace the encryption key. Platform master-key migration and retention/deletion runbooks are release hardening work in P8.

## Confirmed facts and duplicates

Manual create and CSV confirmation accept optional confirmed_intent, budget_period (MONTH/YEAR/TOTAL/UNKNOWN), up to five trimmed/deduplicated locations, property_type, integer bedrooms 0–50, purchase_timeline, source_reference and notes. No implicit currency conversion or studio inference. Contact/budget validation is unchanged. Managers choose an active same-agency assignee or queue; agents create self-assigned leads.

The lead Facts tab explicitly saves human confirmations. PATCH /api/v1/leads/{id}/facts accepts one or more fact fields and expected_version, with a UUID Idempotency-Key. Omitted fields remain unchanged; explicit null clears nullable fields. Updates increment both version and context_version and atomically record field names, without duplicating customer text in audit. Contact and budget amounts remain in the Overview editor. Existing human facts are not overwritten by reported website requirements.

Website assertions remain in reported_facts until a user confirms needs manually. source_reference and initial WEBSITE message metadata are immutable; reported source facts remain preserved. Raw provider objects, secrets and contacts are not copied into technical logs.

Matching contacts flag review without merging or cross-agency matching. Managers can page same-tenant candidate contacts (25/page). Agents see a generic review flag and no candidate identities. Resolving a record as separate requires a documented reason, current version and retry key; audit and flag change commit together. The other record is preserved. Closing a true duplicate uses the existing explicit LOST/DUPLICATE outcome workflow and task cancellation confirmation.

## CSV workflow

Capture → CSV import provides a header template, UTF-8 file selection, column mapping, all-row validation and a 20-row paged preview. Maximum 5 MiB / 1,000 data rows. Quoted commas/newlines, escaped quotes, BOM and multilingual values are supported. Cells remain plain text; spreadsheet formulas are never executed. Future exports must separately sanitize formulas.

Supported columns mirror manual creation plus assignee_email; locations use | as a separator. Reject identity, tenant, creator, role and arbitrary assignee ID columns, including normalized naming variants. Unknown non-authority columns can be ignored. Map unique supported targets, including full_name. At least email or international phone is required. Assignee emails resolve only to active, verified same-agency memberships; invalid rows retain safe field errors, not their original content.

POST /api/v1/imports receives JSON {csv, mapping} with tenant header and UUID Idempotency-Key. The bounded JSON envelope allows escaping overhead; the decoded CSV still has the 5 MiB limit. Saved import identity binds tenant, actor, key and normalized row hash. Replay checks current manager access. This creates a PREVIEW operation, not leads.

Confirmation sets an immutable duplicate policy. Default: skip matching contacts, including earlier successful rows in the same file. To create separate matching-contact leads, check the override and supply a batch reason of 5–500 characters. Those leads still carry manager-review flags and a reasoned override event. Rows are revalidated against current assignee and contact state when processed; preview is advisory.

POST /api/v1/imports/{id}/process accepts {create_separate, reason, retry_failed}. Every call processes at most 25 pending rows in a tenant-locked transaction. Use Resume for remaining batches; reopening Capture loads the latest 25 saved imports; Load older imports pages earlier saved operations. Reads are manager-only and tenant-scoped. Each import_id+row_index has one durable disposition and at most one lead. Retrying a request or refreshing the page never inserts that row twice.

Totals always reconcile:

total = created + duplicates skipped + invalid + failed + pending.

Invalid rows do not block valid rows. Correct invalid input in a new import; default duplicate skipping reconciles already-created contacts. Retry temporary FAILED rows explicitly, at most three write attempts. Exhausted rows remain visibly failed and cannot silently restart. The UI does not auto-loop through requests or bypass shared rate limits. Keep the saved operation and resume after 429/503.

No raw CSV file is persisted on the application server or database. Valid normalized pending row payloads are stored privately for preview/resume. Successful, skipped, invalid and exhausted rows clear their payload; retryable failures retain it only for the remaining attempts. Saved preview/pending operations and minimal results need the approved P8 retention policy; no arbitrary production cleanup schedule is claimed.

## Signed website intake

Capture → Website integrations allows managers to create, rotate or revoke up to 20 agency integrations (a bounded implementation policy, not a purchased entitlement). Choose an active default assignee or manager queue at creation. Revocation is permanent; create a replacement when needed. A disabled default assignee produces a safe validation error instead of silently redirecting customer data.

Create/rotation shows the signing secret in a private receipt. Copy it to the website backend now; listing metadata never exposes the secret. Same-operation request retries can regenerate the authorized receipt. Hide it or leave Capture to remove it from UI state. Public website JavaScript must never receive the signing secret.

Secrets use AES-256-GCM with a random nonce and authenticated operation scope. Private SQL tables store encrypted material and a SHA-256 hash; user reads expose only integration metadata. Only protected service-role RPCs can load encrypted credentials and ingest. RPCs also check the actual database role internally, so an accidental wider EXECUTE grant does not authorize user calls.

Endpoint: POST /api/v1/intake/{integration_id}/leads. JSON envelope:

```json
{
  "external_event_id": "form:unique-event-123",
  "lead": {
    "full_name": "Example Buyer",
    "email": "buyer@example.com",
    "initial_message": "Looking for a two-bedroom home",
    "source_reference": "website:property-23",
    "bedrooms": 2
  },
  "occurred_at": "2026-10-05T08:00:00Z"
}
```

Send Content-Type: application/json, X-Intake-Timestamp (10-digit Unix seconds), and X-Intake-Signature (lowercase HMAC-SHA256 hex). Sign timestamp + "." + the exact UTF-8 request body, using the displayed secret as a UTF-8 string. Both past and future skew are bounded to five minutes. Never parse/re-serialize the body between signing and sending. Maximum body is 256 KiB; customer message time must be finite, timezone-aware and not in the future.

Example website-server signing only (does not make a network call):

```js
import {createHmac} from 'node:crypto';
const body = JSON.stringify(event);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', process.env.LEADPILOT_SIGNING_SECRET)
  .update(timestamp + '.').update(body, 'utf8').digest('hex');
// Send this exact body with X-Intake-Timestamp and X-Intake-Signature.
```

Integration identity resolves tenant and assignment. Reject payload tenant/actor/creator/role/assignee fields. Require an active integration, current key version and active verified issuing manager. Rotation/revocation/offboarding are coordinated with ingestion under the tenant write lock; a request verified just before a change is rechecked before inserting.

Shared durable limit: 60 authenticated intake requests per integration/minute, including replays. Denial persists in its separate RPC transaction and returns 429 + Retry-After. Signature failures do not publish events. Bound old limiter cleanup; no function-memory limiter.

Unique integration_id+external_event_id binds the SHA-256 hash of exact request bytes. Same-body replay returns the original lead ID; changed bytes return 409. Mint a fresh timestamp/signature for a transient retry while keeping the exact body/event ID. Old signing keys stop working after rotation, including event replay. 201 means created; 200 replay; 401 invalid/unavailable signing credential; 422 invalid fields; 429 wait; 503 temporary/configuration failure. No automatic customer messages or AI calls occur.

## Conversation revisions

Conversation → Edit entry is available for authorized manual entries. Supply new plain text, reason, expected message version and expected lead version. Direction, channel, occurrence/creation time, source reference, ingestion time and original author remain unchanged. Previous text, revision, editor, time and reason are stored in immutable message_revisions with tenant+lead+message foreign keys and current-parent RLS.

Revision history pages 25 previous versions. Inbound edits advance context_version; manual outbound/internal edits advance the lead/message versions. WEBSITE entries are immutable. Lost assignment or disabled membership removes current and historical child access, including request replay. Audit failure rolls back the revision, version increments and retry record together. Preview edits/history remain session-only.

## Verification and release gates

A full 96-test regression and the final 20 capture/bundle checks passed (97 distinct tests including older-operation pagination). Both package type checks and production build pass with bundled Node 24. Local meaningful tests cover CSV syntax/mapping/errors, authority columns, facts/versions/partial patches, role/tenant/current-parent denials, duplicate restrictions, message revisions/provenance, mixed-row reconciliation, at-most-once batch resume, within-file duplicates, inactive assignments, retry exhaustion, forced audit rollback, encrypted scope/signatures, exact-body handler checks, durable limit denial, integration replay/rotation/revocation and offboarding. PostgreSQL tests emulate Supabase Auth with PGlite; signature-handler tests use injected RPCs and no external network.

Hosted keys and migrations, actual website-server requests, real overlapping PostgreSQL connections, browser/mobile/keyboard journeys, approved processing/retention, platform-key restore/rotation and measured CSV/ingestion performance remain release evidence. Prior denied browser surfaces remain untouched. P5 is next: durable evidence-backed AI analysis with atomic usage reservation; manual CRM stays usable without provider keys.

## Capture and Settings client recovery

P8 adds shared in-memory retry identity through both mutation and post-save refresh, scoped abort/generation guards and a synchronous action gate. Identical retries after a lost response or refresh failure reuse the same tenant/path/method/payload key; completed workflows acknowledge it. Authorization failures/role scope changes clear protected caches and link/signing receipts. Safe API handling preserves auth/rate/field errors without raw proxy/parser failures. No schema or server permission changes are introduced. Helper tests use injected/deferred transports; React/browser workflows remain pending. See CLIENT_RECOVERY.md for recovery/session boundaries and acceptance cases.
