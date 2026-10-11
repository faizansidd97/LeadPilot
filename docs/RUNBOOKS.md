# P8 operational runbooks

These are implementation-based procedures for preparing a configured staging environment. No live execution, incident drill, purchased-tier guarantee, legal retention policy or deployment approval is recorded. Keep operational artifacts inside docs/frontend/backend, and development on port 4000.

## Incident triage and containment

The operator records UTC time, environment/revision and safe request IDs. Check hosting availability and protected /api/internal/health using server-held Bearer CRON_SECRET; never put the token in a URL or copy response bodies containing secrets. A 401/503 configuration error is not healthy. Confirm database reachability, due/outbox/AI lag, failed work and reconciliation. Health is global/aggregate and restricted to operations; do not expose it to the customer browser.

Contain the affected feature through existing approved settings: pause the scheduler for an unsafe worker; disable platform AI/drafts through server configuration and policy synchronization; revoke the specific website integration key or invitation where supported. These controls do not refund uncertain provider costs or cancel already accepted external transport. Preserve scoped audit/receipts, redact debug material and verify current membership before viewing tenant records. Do not “repair” access by granting client service-role permissions.

For a replayable unconfirmed save, retain the original payload/request key; changed input is a separate operation. An acknowledged save followed by failed reads recovers with reads only. CSV processing has no per-batch replay receipt and must use read-only uncertain-progress reconciliation before an explicitly requested new batch; see CSV_IMPORT_RECOVERY.md, WEBSITE_INTEGRATION_RECOVERY.md and SETTINGS_RECOVERY.md. Reload stale versions, retain user input and ask the user to review current context before resubmitting. Failed outbox work uses the existing audited recovery path documented in OPERATIONS.md. Expired leases are reclaimed by existing workers; completion tokens fence stale attempts. AI RECONCILE means an unknown charge/dispatch outcome: compare provider usage and keep its reservation until a documented resolution, rather than blindly retrying/refunding. No reconciliation executor or billing amount is inferred from aggregate tokens.

Recovery requires current authorization, no scope leak, bounded/deduplicated queue progress and validated errors. Record onset/recovery, queue age and residual errors; proposed 900-second lag alert is not a measured SLA. Actual alert routing, operator ownership, availability measurement and escalation are still deployment decisions.

## Credentials and signing-key rotation

Maintain a private inventory by environment/owner/rotation reference, with no values in docs, source, URLs or browser storage. Separate public Supabase publishable values from private service/provider/mail/cron/signing/encryption keys. Stop affected dispatchers when overlap or dedupe safety cannot be established. Stage changes through the hosting secret manager and verify negative/positive paths using approved access.

| Credential | Rotation behavior / restore requirement |
| --- | --- |
| Supabase public/private keys | Rotate through the project's supported procedure; update server/browser configuration separately, verify role/RLS and session behavior. A shape check cannot verify live authority. |
| CRON_SECRET | Coordinate scheduler/server/monitor rollout; old token must fail, new token must work. No query-string fallback. |
| Provider/mail credentials | Rotate at approved provider and hosting; verify adapter authorization and stable dedupe. Uncertain accepted requests need reconciliation before repeat dispatch. |
| INVITATION_TOKEN_SECRET + INVITATION_TOKEN_KEYS | Preserve immutable legacy and named HMAC values. Migration 016 records issuance/job key IDs and fences new writes with a global policy; old request retries/jobs retain their original key. Use the explicit plan/activate/verify CLI with reviewed version/reference/reusable request UUID; deploy the complete ring to every API/worker first. No blanket retirement is approved. See INVITATION_KEY_ROTATION.md. |
| INTAKE_ENCRYPTION_KEY | Stored signing credentials require the original key/AAD. Versioned AES ring/policy and explicit private plan/activate/rewrap/verify tooling now preserve stored signing identities; see INTAKE_KEY_ROTATION.md. Preserve the legacy value for its historical signing-root retries and old backups. Migration 017 separately versions future derivation roots; see INTAKE_SIGNING_ROOT_ROTATION.md. Live rewrap completion does not approve key retirement; blind legacy-root replacement breaks decrypt/replay. Hosted fleet/backup rotation remains pending. |
| INTAKE_SIGNING_ROOT_KEYS | Immutable named roots govern future create/rotate issuance; migration 017 records original roots for exact retries. Use the private root plan/activate/verify CLI with complete retained root/AES material and reviewed version/reference/reusable request UUID. Root activation changes no existing website signing key. Historical and backup dependencies prohibit blanket retirement. |
| Per-integration signing secret | Manager rotates/revokes via existing integration controls; update the approved website server, verify old-signature denial/new acceptance and stable event replay. Never embed it in public JavaScript. |

setup:supabase only generates missing local invitation/cron/encryption values; it does not safely rotate populated production secrets. A SQL/data backup without required encryption/signing keys is insufficient for recovery. Store key history outside database backups under approved access and retention. Emergency provider/session revocation needs a configured operator and incident-specific authorization; no live revocation occurred here.

## Migration failure and recovery

Before a hosted upgrade, record the migration sequence/hash, staged version, compatibility and purchased-tier backup/restore reference. Apply numbered missing transactions in order. Fresh setup.sql atomically applies 001–020 only when business tables do not exist; never rerun it against initialized data. Validate both positive and negative permissions in the exact target role mapping.

An uncommitted migration failure rolls back its transaction; confirm schema/helper/policy state before retrying the unchanged migration. Do not mark a partially applied schema as complete. Once committed, prefer a reviewed forward fix preserving data; no general destructive down migration is supplied. Restoring a backup may lose writes and replay external effects, so first isolate the environment, stop cron/intake/mail/provider dispatch and compare receipts/leases/usage before reopening.

Local recovery.test.ts injects a failure before migration commit and verifies rollback, then uses an actual synthetic PGlite dump/load. This is a developer drill only. Hosted restore must cover database, Auth metadata/settings, signing/encryption key dependencies, integration configuration, ledger/receipts/audit and approved out-of-band erasure records. Fence old worker completions, reconcile external transport/provider outcomes, verify current roles/assignment, and prove restored deletions are reapplied before serving traffic. **The deletion replay mechanism is unimplemented; current backups must not be reopened as proof of A22 acceptance.** Purchased-tier RPO/RTO and actual restore timing are pending.

## Privacy request handling

Verify the account/active agency/role through existing Auth and require fresh TOTP. Owner records the scope/current version/reason. An authorized manager performs identity verification outside LeadPilot and enters a bounded reference; do not paste identity documents. Use review holds while policy/authority or support evidence is unresolved. Case versions, immutable manager notes, request receipts and summary audit are transactional; state conflicts require reload/review. Owner alone withdraws, and a held case must be released first.

Review records do not erase data, lock the agency or enforce a legal hold. No production deletion/closure promise should be inferred. Resolve this table with the actual responsible policy owner before implementing irreversible work:

| Required decision | Current state |
| --- | --- |
| Applicable processing authority, geography, provider/backup regions and notices/contracts | Pending D01/D03 approval |
| Retention for leads/messages/revisions/facts/drafts/results/jobs/usage/notifications/imports/invitations/audit/rate receipts/signing issuance provenance | No approved durations or disposition rules |
| Identity authority, requester/reviewer roles, deadlines, appeals and hold release | Review foundation only; operational/legal policy pending |
| Child erasure/anonymization, external processors, ongoing jobs and ledger/audit minimization | Executor unimplemented |
| Agency closure access/exports/outstanding obligations and support access | Executor/access policy pending |
| Backup expiry, retained deletion registry, restore replay and verification before reopening | Registry/replay unimplemented; tier/retention pending |

Approved decisions should record policy version, owner, date, scope and exceptions. Then implement/test versioned purge/closure/child handling, justified minimal audit and restore replay against those rules. Never improvise retention intervals, remove audit to hide a request, use SQL to bypass MFA, or treat a local case state as execution authorization. No irreversible privacy work was performed in this slice.

## MFA/support recovery

Current UI enrolls/verifies an authenticator and uses fresh signed TOTP claims for privileged actions. It does not provide a privileged recovery bypass. Lost-factor recovery needs an approved identity/support policy and the configured Auth service's supported recovery flow; record evidence and review, then verify sessions/current membership. Support access must be least privilege, time bounded and audited under approved policy. Hosted support/MFA recovery acceptance remains pending.

P8 intake rotation procedure: deploy key-ring-capable dual readers with preserved legacy root and target material to every API/intake node, apply migration 015, and validate the replacement manager RPC signature and private worker permissions in the actual hosted API. Use the documented explicit staging-config CLI read-only plan first. With a reviewed full preflight and change reference, activate the target policy at its observed version; fresh stale-key writes fail safely. Rewrap checks agency lock/current policy/cipher hash/encryption revision, updates only encrypted storage, and keeps website signatures valid. Retain all source keys during interruptions; resume with current state instead of bypassing version checks. Separately verify stabilized live inventory, fleet reads/writes and backup recovery. CLI output is content-free and cannot prove environment identity or operator approval. No connected operation has been run here; original signing derivation and backup key retention still block blanket legacy-key retirement.

P8 invitation rotation procedure: keep legacy policy while applying migration 016 and deploying capable API/worker readers with the complete immutable ring. Run explicit read-only plan, then reviewed versioned activation with a reusable request UUID; verify actual fleet old/new requests, queue transport and backup recovery separately. API key selection and mutation fencing preserve original create/resend receipt identity across activation. Missing keys use the bounded durable retry/recovery path. Immutable private activation journals commit with policy changes; injected failure rolls both back. Old operation replay reports current policy and never reactivates an obsolete key. Format/presence preflight cannot prove historical secret values or fleet configuration. No real key change or connection occurred. See INVITATION_KEY_ROTATION.md.

P8 intake signing-root procedure: apply migration 017 under the initial legacy root policy, then deploy capable APIs with complete immutable INTAKE_SIGNING_ROOT_KEYS and AES material. The explicit root plan/activate/verify CLI checks active/target/retained root format and active AES availability; writes require reviewed version/reference/reusable request UUID. Original roots remain selected for same-operation create/rotate retries; old site credentials are unaffected by a global root switch. Actual manager signing rotate/revoke changes website key_version and requires website-side coordination. AES rewrap and signature verification use saved credentials without needing derivation roots; AES reports never evaluate root retirement. Preserve all historical/backup material. No real root/key/website change or connected operation occurred; see INTAKE_SIGNING_ROOT_ROTATION.md.

Agency Operations triage: a current verified manager can open Settings Operations for selected-agency counts/ages and fixed alerts without accessing private payloads or platform credentials. Capture the displayed snapshot time and alert categories for an approved incident record. FAILED counts retain historical exhausted jobs; expired leases still require fenced worker recovery, and AI reconciliation requires actual provider usage review. This view changes no jobs/reservations and sends no alerts outside the visible panel. No queue alert does not prove scheduler execution, delivery or availability. Provider monetary cost remains unavailable. Existing global protected health and reviewed platform recovery are the operations team's responsibility; see AGENCY_OPERATIONS.md.

## Read-only staging verification

The updated checker requires an explicit --connect-staging flag and public staging configuration; it checks email-confirmation/signup settings and anonymous denial on all 15 current public tables. Injected transport and actual anonymous SQL permission tests pass locally. It performs no migration, account creation, mutation RPC, worker dispatch or external delivery. A baseline pass cannot establish current migration revision or authenticated/UI/worker/release acceptance. Existing environment access permissions still apply; no hosted connection occurred in this slice. See STAGING_VERIFICATION.md for operator commands, safe reports and remaining acceptance gates.

## Platform health monitor continuation

Migration 019 adds expired notification/AI lease counts and alerts to the protected global health snapshot, with statement-time cutoff/lag/expiry/month selection. The API rejects extra/private or inconsistent fields through a strict contract and retains safe private/no-store failures. A read-only explicit operator command distinguishes fresh NO_ALERTS (exit 0), ATTENTION (1) and UNAVAILABLE/BLOCKED (2), with bounded transport and snapshot age/skew validation. It does not run workers, retry jobs, page anyone or prove cron/provider delivery; scheduler_verified and release_accepted stay false. Real monitoring/paging/outage/clock/rotation integration is pending. See PLATFORM_MONITORING.md for permitted staging commands and local test boundaries.

## AI provider correlation during recovery

Migration 020 atomically records a private prepared-request UUID for each analysis/draft claim; workers use it rather than an unsaved random ID and refuse untracked provider calls. Renewed leases receive new IDs; exact prepare retries retain the original receipt. The private read-only inspect:ai-attempts command accepts one job UUID and requires explicit permitted staging connection. Preserve its opaque request IDs in restricted incident evidence; reports contain no prompts, lease tokens or keys. Preparation is not proof of dispatch, dedupe or billing. Old/unprepared claims remain explicitly untracked; retain uncertain reservations until an approved maintenance process resolves provider evidence. This adds no refund/reconciliation executor. Stop dispatchers during rollout and let old leases expire before updated recovery; mixed old workers cannot establish complete tracking. See AI_ATTEMPT_TRACKING.md.

## Capture and Settings client recovery

P8 adds shared in-memory retry identity through both mutation and post-save refresh, scoped abort/generation guards and a synchronous action gate. Identical retries after a lost response or refresh failure reuse the same tenant/path/method/payload key; completed workflows acknowledge it. Authorization failures/role scope changes clear protected caches and link/signing receipts. Safe API handling preserves auth/rate/field errors without raw proxy/parser failures. No schema or server permission changes are introduced. Helper tests use injected/deferred transports; React/browser workflows remain pending. See CLIENT_RECOVERY.md for recovery/session boundaries and acceptance cases.

## Authenticated workspace recovery

ConnectedWorkspace now uses fenced session reads and synchronous action locking for bootstrap, agency selection/context refresh, account actions and sign-out. Agency selection resolves fresh membership metadata before reading leads; HTTP 401 opens sign-in while unavailable/rate/agency-denial responses show recovery with fresh agency choices. Creation retry identity is account-scoped and survives failed post-save reads. Sign-out hides mounted private records before the POST and requires explicit confirmation, retaining a retry screen on uncertainty. Thirteen local tests execute the actual session helpers with injected/deferred reads; they do not mount React or prove browser/cookie behavior. Server RLS/replay/current authority remain unchanged. See CLIENT_RECOVERY.md for session limits and required browser journeys.


## Invitation and authenticator client recovery

P8 adds effect-replay-safe mounted invitation fragment memory, current-account checks and account-scoped acceptance retries, fenced join/account-switch/sign-out transitions, and strict acknowledgement handling. MFA now fences private factor/setup data, preflights enrollment against current factors, refreshes inventory after uncertain non-idempotent setup and requires explicit unfinished-factor cleanup rather than an automatic second enrollment. Failed verification retains entered code; successful writes wait for fresh factor status. Fifteen injected/deferred helper tests provide local evidence; they do not mount React or establish hosted Auth, cross-tab logout/enrollment dedupe, browser or release acceptance. See CLIENT_RECOVERY.md for recovery boundaries and required journeys.


## Server Auth recovery and authorized baseline

The twelfth P8 slice corrects anonymous PostgREST privilege denial to accept only HTTP 401/403 plus exact SQLSTATE 42501 and records the first user-authorized real development read-only baseline (16 checks PASS). Structured Supabase Auth outage/rate/session/input errors now retain safe 503/429/401 distinctions, and verified identity gates database access. Thirteen SDK/server tests and two staging checks provide additional local evidence. No account/email/SQL mutation, worker/provider/browser action or deployment occurred. Authenticated workflows/current migrations/tenant policies, worker credentials, approved privacy, concurrency/tier restore and browser/release acceptance remain pending. See AUTH_RECOVERY.md and DEV_BASELINE.json.

## Lead directory/dashboard fails with SQLSTATE 25006

Check read RPC transaction mode and membership locking; do not remove RLS, use service-role user APIs or relax Auth requirements. The confirmed development failure involved private.active_member FOR SHARE inside a stable RPC. For a project through 020, apply the checked numbered migration 021 once, then reload directory/dashboard/team and verify signed user scope. Preserve mutation locks and replay access checks. See READ_MEMBERSHIP_RECOVERY.md; direct worker smoke evidence does not cover this user workflow.


## Reviewing privacy request impact

After migration 022 is applied, an OWNER/ADMIN opens Settings Privacy and selects the case with its latest version. Refresh the impact snapshot and inspect scope, verification-record presence, intersecting holds, open follow ups, active jobs and usage reconciliation. Resolve review holds through the existing versioned/MFA review process with an appropriate documented basis. Preserve the distinction between related records and approved deletion targets: private artifacts, provider copies, backup expiry and restored-deletion replay need their own reviewed inventory/policy. This preview does not authorize or execute deletion, cancel work or close an agency. On a version conflict, refresh cases and reselect; on an unavailable preview, retain review input and confirm deployment setup before retrying. No hosted migration or irreversible action was performed here. See PRIVACY_IMPACT.md.
