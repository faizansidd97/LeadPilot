# Durable operations and notifications: P3

2026-10-10 update: migrations now run through 021. Authorized development checks proved one assignment notice and one due reminder through direct worker RPCs, each followed by an idle repeat. A user-requested standalone 60-second local runner is documented in LOCAL_SCHEDULER.md; it processes the durable notification queue without browser/localhost HTTP access, email or AI dispatch. Production scheduler, protected HTTP and recipient UI acceptance remain separate gates. The older P3 evidence below is historical where it refers to missing credentials or no local timer.

This is local implementation evidence, not a deployed scheduler or a production latency guarantee. Hosted Supabase, private worker credentials, approved email transport and permitted browser/real concurrency evidence remain pending. The app origin remains http://localhost:4000; root contains docs, frontend and backend.

## Upgrade and configuration

Fresh projects apply backend/supabase/setup.sql once; it combines migrations 001–013 atomically and guards existing tables. Existing projects through 006 apply 202610060007_notifications.sql once. It extends the outbox, adds notifications/rate policy, captures assignment/review versions, adds guarded worker RPCs and replaces invitation functions to enqueue durable mail. Prior business slices and current atomic offboarding remain intact.

With Node >=22.18, run backend's setup:supabase to regenerate the bundle and prepare frontend/.env.local. It preserves existing values, generates missing invitation/cron secrets and adds blank optional worker/mail fields. check:supabase checks the user configuration; check:workers additionally checks private worker credentials. These scripts do not connect remotely, reveal credential values or deploy anything.

Required for hosted worker runs:

```
APP_URL=https://your-approved-app.example
NEXT_PUBLIC_SUPABASE_URL=https://your-project.example
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<public user key>
CRON_SECRET=<private random secret, at least 32 characters>
SUPABASE_SERVICE_ROLE_KEY=<private worker key>
```

Development APP_URL stays http://localhost:4000. Never expose the last two variables through NEXT_PUBLIC. The worker client has no user cookies, session persistence or automatic token refresh. Its code calls only narrow worker RPCs; user APIs continue using verified cookie identity and RLS. Worker SQL grants require service_role and independently check the effective role even if an execute grant is widened accidentally. Protected endpoints reject missing/incorrect Bearer authorization before creating the privileged client.

Optional approved invitation mail configuration is INVITATION_MAIL_URL (HTTPS custom adapter) and INVITATION_MAIL_TOKEN. The adapter contract remains POST JSON {to,subject,text,idempotency_key}, Authorization: Bearer and Idempotency-Key, with redirects refused and ten-second timeout. It must durably deduplicate `invitation-mail:<job-id>` across retries/requeues. This is a custom adapter contract, not a claimed vendor integration. Approve transport and log handling before live use. No actual email was sent in local tests.

## Worker endpoints and scheduler

| Endpoint | Method | Behavior |
| --- | --- | --- |
| /api/internal/cron/follow-ups | GET | Seed up to 100 due task/schedule/recipient pairs, then process bounded jobs |
| /api/internal/cron/jobs | GET | Process existing notification/invitation-mail jobs |
| /api/internal/cron/status | GET | Protected global lag/failure counts; bounded old rate-window cleanup |
| /api/internal/cron/retry | POST | Explicit failed-job recovery: job_id and expected_attempts (1–3); atomic audit |

Every call needs Authorization: Bearer plus the configured CRON_SECRET. Cookie identity is not cron authority. Query parameters cannot change batch bounds or tenant authority. User-selected parent/recipient values are not accepted by these endpoints. Retry bodies are strict JSON with the normal 256 KB bound. All responses are private/no-store and safe errors include a request ID.

Provision an eligible scheduler with the proposed five-minute due cadence. Schedule jobs calls often enough to drain backlog; repeat bounded calls while work is available and stop when a call claims no jobs. A single call seeds 100 recipient pairs but processes at most 20 jobs, so seeding/draining throughput must be measured together. A job may fan out to up to 100 recipients in a transactional page. Additional pages persist their cursor, release their lease and continue later. No work relies on a request continuing after response or a process-memory timer.

The orchestrator stops claiming new jobs after 20 seconds. It claims one job at a time, avoids leasing work it has not started, and uses eight-second database request timeouts. Routes declare Node runtime/maxDuration=60; the purchased deployment platform must support the schedule/execution duration. This declaration does not provision a cron or override platform eligibility. No scheduler/deployment was created here.

## Durability, recovery and privacy

Outbox states are PENDING → RUNNING → SUCCEEDED/CANCELLED, or PENDING/FAILED after an error. Claims use FOR UPDATE SKIP LOCKED and fresh UUID fencing tokens. Leases expire after 90 seconds. Stale/expired tokens cannot finish, fail or overwrite a new claimant. Three total attempts per page/job are allowed; retry delays are 30/60/120 seconds plus 0–10 seconds of jitter. Abandoned third leases become visible FAILED jobs on the next claim. Successful fan-out pages reset their retry budget; page continuation is not a failure.

Notification publication and queue completion commit in the same database transaction. A failed insert rolls back publication and leaves the lease recoverable; it never cancels the underlying task. Business changes and their outbox capture also commit/roll back together. Private jobs contain IDs, versions and minimal metadata. They do not store customer text or raw bearer links. Public notification rows contain IDs/type/state only; customer previews are fetched from the current authorized parent.

Due scanning catches past-due eligible OPEN tasks, not merely tasks that fell due in the latest five-minute interval. Deduplication binds task, schedule_version, event type and recipient. Unassigned tasks create separate jobs/notices for each active OWNER/ADMIN; assigned tasks require current task and lead access. Expired/reassigned schedules, completed/cancelled tasks, archived/terminal leads, inactive/unverified recipients and blocked outreach are suppressed before publication. INTERNAL work remains eligible under do-not-contact. A newly active manager can receive a previously unprocessed manager-queue notice. FAILED jobs do not silently bypass their retry budget during scans.

Assignment notices capture a separate assignment_version, so A→B→A cannot revive a previous assignment notice. Manager review notices use review_version and the current duplicate flag; resolution UI arrives in P4. Invite acceptance is addressed to the inviter only. Existing legacy assignment events without a captured version are suppressed rather than guessed. Existing due tasks are caught up by scans. Existing assignments do not retroactively emit notices unless a new assignment change occurs.

Recipient-only RLS applies even to managers; owning the agency does not grant access to another recipient's notification row. Public list/read/dismiss/open functions resolve the current membership. Read/dismiss uses expected_version, actor/tenant/key/payload-bound replay and monotonic timestamps. An old notice hides sensitive previews when its context or access changes. Open reauthorizes the latest parent and returns neutral unavailable state after access loss, or opens the latest authorized lead even when the old task notice is obsolete.

P5/P6 now produce AI_READY/AI_FAILED notices transactionally. Current requester, parent and input checks suppress outdated analysis/draft results; superseded/rejected drafts do not remain current-ready. No fictional AI results are generated. Reminder notices are in-app only; no customer messages, email/push task reminders or automatic contact occur.

## Durable invitation email

Create/resend atomically enqueue INVITATION_MAIL with issuing actor, token-generation operation/request key and expected hash and recorded signing key ID. A replay cannot enqueue a second mail job. The worker verifies current invitation state, expiry, tenant, hash and issuing membership/role before regenerating the HMAC bearer token from that job's immutable key value (legacy INVITATION_TOKEN_SECRET or named INVITATION_TOKEN_KEYS). Only the server handles the raw link; SQL/private replay/outbox storage excludes it.

Configured API receipts report EMAIL_QUEUED. The Team invitation list shows queued/accepted/failed/suppressed metadata for the current token. EMAIL_ACCEPTED means transport acceptance, not recipient delivery. A transport failure uses the same durable retries/dead-letter recovery and stable job idempotency key. If an HTTP response is lost after provider acceptance, retrying the same job must not send a second email through the approved adapter. Local tests inject an adapter and never call an external provider.

Absent mail configuration uses LINK_ONLY and a private copy link; its mail job is safely cancelled by a worker. To enable email for an older copy-only invite, use Resend/new link. Revoked, expired, consumed and superseded invitation jobs are suppressed before submission. Secret rotation makes old queued token regeneration fail its expected-hash check; issue a new link. Rotating the secret alone does not revoke previously issued valid links: revoke pending invitations separately when required. An in-flight transport call can race revocation; SQL acceptance still rejects the revoked link.

## Monitoring and operator actions

Status/worker responses include due_lag_seconds, outbox_lag_seconds, pending_jobs, failed_jobs and alert. Due lag measures the oldest currently eligible recipient pair without a notice. Closed, blocked or unauthorized work does not create artificial due lag. alert is true above 900 seconds of due/outbox lag or when any job is FAILED. Zero is distinct from a configuration/database error, which returns 503. Structured logs include request/job IDs, states, counts and elapsed time; no customer text, email, bearer link or provider body.

1. On lag, verify protected scheduler reachability and that queued work is being drained. Repeated/parallel calls are safe; do not convert the queue into unbounded loops.
2. On failure, inspect safe job IDs/codes in protected logs/database, correct configuration or the underlying fault, then POST the failed job ID/current attempts to retry. Recovery preserves the job ID, dedupe keys and audit. Do not delete jobs to force redelivery.
3. On interrupted requests, let the lease expire; the next worker recovers with a new token. Stale completion cannot overwrite recovery.
4. On credential compromise, rotate private credentials in the deployment and scheduler together, then check old Bearer rejection. Follow separate invitation/integration revocation requirements. Never place private keys in a user client or logs.

HTTP policy uses the FSD proposed fixed-minute limits: 60 reads and 30 mutations per verified user, shared across agencies/instances. Read and mutation counters are independent. A separate 30-successful-DB-write guard prevents direct business RPC commits from bypassing the write policy. HTTP attempts count even when business validation later fails; failed DB transactions roll back their DB counter while the separate HTTP gate remains committed. 429 carries Retry-After and safe retry_after metadata; forms retain input and notification polling pauses. Authentication/signup/reset abuse remains subject to provider and release edge controls; direct provider reads retain RLS and require provider/edge cost controls in P8. No universal provider-edge limiter is claimed. P5/P6 share atomic UTC daily/monthly AI operation reservation and the ten-new-jobs/user/hour guard; configured seat enforcement is retained from P2.

Rate-window metadata is private and retired in batches of at most 100 rows when older than two hours; this does not delete customer records or business audit. Business notification/job retention, privacy workflows and approved production retention remain P8 policy work.

## Verification and release gates

The P3 milestone verified 78 local tests; P4 adds later evidence in CAPTURE.md. Both package type checks and production build pass. Local checks cover actual migrations/bundle guard, role/tenant/recipient isolation, current previews/open, cyclic assignment, due catch-up/dedupe/lag, manager queue, contact/terminal/task suppression, offboarding redirects, strict read/dismiss/replay, bounded scans/large fan-out, fresh fencing tokens, three abandoned/failed attempts, retry recovery, audit/outbox rollback, durable invitation email state/hash secrecy/resend/revoke, shared limits and safe cron/worker errors. Transport tests use injected fetch/adapters.

Hosted Auth/service-role mapping, overlapping database connections, true process interruption, protected scheduler/execution limits, actual adapter dedupe/delivery, measured backlog throughput/15-minute alert routing, browser journeys and release performance remain unverified. Supabase public/private keys and scheduler are unavailable. Existing browser permission denial remains respected. Atomic large offboarding remains implemented; resumable large transfers and agency-lock contention benchmarks remain P8. This is not an SLA, production-scale or full A01–A24 acceptance claim.

## P5/P6 AI workers

POST /api/internal/cron/analysis and POST /api/internal/cron/drafts synchronize platform policies and process their respective ANALYSIS/DRAFT kinds. GET on each exposes protected metrics; both require CRON_SECRET Bearer and separate worker credentials. Their Node routes declare maxDuration=180 (the P3 notification workers above retain 60). No scheduler is provisioned. Shared usage, fenced leases, conservative unknown-charge reconciliation and access/input rechecks are documented in AI_ANALYSIS.md and REPLY_DRAFTS.md. Disable server flags and invoke the relevant worker to synchronize SQL policy; tenant processing gates act immediately in SQL. Model calls and browser clipboard text already dispatched cannot be recalled.

P6 local evidence is 312/312 regression tests, both package type checks and production build. Hosted Supabase/private role/scheduler/concurrent connections, latency/cost/retention and interactive journeys remain pending; no external customer message or deployment occurred.

P7 adds read-only dashboard aggregation/list RPCs; no scheduler or provider call is needed. Local evidence is 330/330 tests, both type checks and build. See DASHBOARD.md for current versus dated populations, scope and statement/page snapshot limits. True overlapping connections/load and hosted acceptance remain P8 evidence.

## P8 hardening continuation

GET /api/internal/health adds a read-only aggregate snapshot behind Bearer CRON_SECRET and service_role-only RPC. It exposes database reachability, due/outbox/AI lag, pending/failed counts, reservations/reconciliation, current UTC reservation-month observed tokens and privacy pending/execution false; no customer IDs/text or secrets. cost_amount is null and tokens are not a provider bill. Alert is set for lag >900 seconds, failed work or reconciliation, but monitoring/alert routing is not deployed. Optional OPERATIONAL_LOGS_ENABLED=true emits only generated request ID, status and duration through shared API handlers; defaults off. Health never cleans limits or claims work.

RUNBOOKS.md covers containment, retry/lease recovery, signing/encryption key dependencies, migration forward fixes, isolated restores, MFA/support and unresolved privacy rules. recovery.test.ts actually dumps/loads a synthetic isolated database and verifies receipts/audit/children/current permissions/holds and reclaimed-lease fencing. Cloud Auth/backup/key recovery, deletion replay and purchased-tier RPO/RTO are pending. LOCAL_LOAD_REPORT.md provides a measured 10k-lead/1k-task fixture with 50 sequential identities on one connection; it is not real concurrent HTTP/UI load evidence. RELEASE_CHECKLIST.md maps A01–A24 to local checks and unresolved hosted/reviewer gates. P8 remains IN PROGRESS and no deployment occurred.

P8 second slice adds a private intake encryption policy, key-ID/revision envelopes and an explicit operator CLI for read-only plan/verify and reviewed versioned activate/rewrap. It never connects without --connect-staging; a supplied --staging-config file replaces ambient credential configuration. Complete bounded preflight, current locks/hash/revisions, exact retries, atomic receipts/audit and resumed revoked-row inventory preserve website signing identities. No rotation endpoint or automatic scheduler trigger is added. All 382 tests/type checks/build pass locally; actual legacy migration/backup restore and negative worker permissions are exercised. Original derivation/backup keys remain required; no real key was changed or live connection made. See INTAKE_KEY_ROTATION.md and RUNBOOKS.md.

P8 third slice adds invitation HMAC issuance/job key provenance and a private versioned policy. Historical create/resend retries retain their key after activation; fresh stale-key writes fail safely. Queued mail uses recorded IDs, and missing inventory triggers durable retry without that attempt sending/completing. The explicit operator CLI plans/activates/verifies through narrow worker RPCs, requires a reviewed version/reference/reusable request UUID for writes, and never connects without --connect-staging. Policy+journal and business issuance/audit/outbox/receipt changes are atomic. Actual synthetic mixed-key dump/load and legacy-upgrade rollback are exercised. Historical keys and backups remain required; no real key change, mail or hosted connection occurred. See INVITATION_KEY_ROTATION.md.

P8 fourth slice separately versions website signing derivation roots and records private create/rotate provenance. Global root activation changes future issuance only; existing website signatures, key versions and saved envelopes stay intact. Exact retries select the original root, and signing rotation/revocation/current membership continue to invalidate obsolete secret disclosure. AES verification/rewrap uses only storage dependencies and reports signing_root_retirement_evaluated=false. Explicit root plan/activate/verify requires connection plus reviewed version/reference/reusable request UUID for writes. Actual legacy upgrade/failure rollback and mixed-root dump/load exercise journals, scope and signature/event replay. No real root, website credential or hosted policy changed. See INTAKE_SIGNING_ROOT_ROTATION.md.

P8 fifth slice exposes selected-agency Operations status to current verified owners/admins through a cookie-only, read-only SQL projection. Seven fixed alerts cover overdue reminder creation, notification/AI lag and retained failures, expired leases and AI reconciliation. Settings displays snapshot time/counters with minute polling while visible; owner quota usage uses the existing protected API. The projection contains no job/customer IDs, raw errors or payloads, secrets, monetary estimates or commercial limits. It cannot run/retry jobs or acknowledge incidents; scheduler_verified stays false and cost_amount null. Real scheduler/transport, global monitoring/paging/billing and browser/concurrent acceptance remain pending. See AGENCY_OPERATIONS.md.

## Platform health monitor continuation

Migration 019 adds expired notification/AI lease counts and alerts to the protected global health snapshot, with statement-time cutoff/lag/expiry/month selection. The API rejects extra/private or inconsistent fields through a strict contract and retains safe private/no-store failures. A read-only explicit operator command distinguishes fresh NO_ALERTS (exit 0), ATTENTION (1) and UNAVAILABLE/BLOCKED (2), with bounded transport and snapshot age/skew validation. It does not run workers, retry jobs, page anyone or prove cron/provider delivery; scheduler_verified and release_accepted stay false. Real monitoring/paging/outage/clock/rotation integration is pending. See PLATFORM_MONITORING.md for permitted staging commands and local test boundaries.

## P8 private provider attempt history

Migration 020 retains a durable private correlation UUID before successful analysis/draft preparation. Same-claim retries reuse the receipt and renewed leases get new IDs; workers require the recorded ID before provider dispatch. A narrow worker-only single-job diagnostic RPC/explicit operator command exposes bounded operational metadata without customer context or credentials. Journal failures roll back preparation atomically, and actual local restore/legacy upgrade are tested. The journal proves preparation only: provider idempotency, charge verification, historical completeness, approved refunds/reconciliation, hosted fleet and release acceptance remain pending. See AI_ATTEMPT_TRACKING.md.
