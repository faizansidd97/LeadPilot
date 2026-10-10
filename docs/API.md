# Backend API



Implementations: `backend/src/routes/`. Next.js adapters: `frontend/src/app/`. SQL: `backend/supabase/migrations/`. Backend tests: `backend/tests/`.



Base URL: `http://localhost:4000/api/v1`. Responses use `{data: ...}` or `{error: {code, message, field_errors, request_id, retryable}}` and `Cache-Control: private, no-store`.



All business routes require verified Supabase Auth cookies. Tenant routes require `X-Tenant-Id` set to an active membership's agency ID. Cookie mutations require `Origin: http://localhost:4000` (or the configured APP_URL origin) and JSON content type. Replayable creation/logging requires an `Idempotency-Key` UUID; retain the same key and payload after a network failure. Different payloads under the same key return 409.



| Method | Route | Current behavior |

| --- | --- | --- |

| POST | /auth/sign-up | Email/password account registration and verification email |

| POST | /auth/sign-in | Verified email/password sign-in |

| POST | /auth/sign-out | Clear Supabase session |

| POST | /auth/reset-password | Request reset email with generic account response |

| POST | /auth/update-password | Change password under a verified session |

| GET | /me/memberships | Own active memberships and agency summaries |

| POST | /agencies | Idempotent agency + OWNER onboarding |

| GET | /leads | Tenant/assignment-scoped inbox, q/status/archived/cursor/limit filters |

| POST | /leads | Atomic manual lead, optional inbound message and audit |

| GET | /leads/{id} | Authorized detail or neutral 404 |

| PATCH | /leads/{id} | Replace contact/fact fields with expected_version |

| GET | /leads/{id}/messages | Authorized conversation records with cursor pagination |

| POST | /leads/{id}/messages | Audited manual text, expected_version and retry key |

| POST | /leads/{id}/status | Versioned explicit lifecycle, qualification and outcome transaction |
| POST | /leads/{id}/assignment | Manager reassignment with OPEN-task transfer confirmation |
| POST | /leads/{id}/archive | Manager archive with reason and cancellation confirmation |
| POST | /leads/{id}/restore | Manager restore; preserves lifecycle and closed tasks |
| POST | /leads/{id}/contact-preference | Restrict outreach; only manager may clear with basis |
| GET | /leads/{id}/control-summary | Current role/version and visible task totals |
| GET | /leads/{id}/activity | Authorized read-only activity with cursor pagination |
| GET | /team/assignment-members | Active same-tenant assignment choices; agent self only |

| GET | /follow-ups | Authorized due-time queue, optional lead_id/state, cursor/limit |

| POST | /follow-ups | Future task with expected_lead_version and retry key |

| POST | /follow-ups/{id}/complete | Complete OPEN task with expected_version and summary |

| POST | /follow-ups/{id}/reschedule | New future due_at, expected_version and reason |

| POST | /follow-ups/{id}/cancel | Cancel OPEN task with expected_version and reason |



Auth callback is `GET /auth/callback?code=...`; safe destinations are the workspace and password reset page.



## Lead creation



```json

{

  "full_name": "Sample Buyer",

  "email": "buyer@example.com",

  "phone": "+971501234567",

  "initial_message": "Looking for a two bedroom in Dubai Marina",

  "budget_min": 1200000,

  "budget_max": 1500000,

  "currency": "AED"

}

```



Optional `assignee_id` must be an active same-tenant membership. AGENT requests may specify only themselves and are self-assigned when omitted. Tenant, creator and status fields are rejected.



## Lead replacement



PATCH currently replaces the editable contact/fact set rather than merging an arbitrary partial payload. Supply full_name, at least one valid contact, budget/currency values to retain, and expected_version. Omitted budget fields become null. Assignment, tenant, status and initial_message are not accepted here.



## Conversation logging



```json

{

  "direction": "INBOUND",

  "body": "Please arrange a viewing this week",

  "occurred_at": "2026-10-06T05:00:00Z",

  "expected_version": 1

}

```



Directions: INBOUND, OUTBOUND, INTERNAL. Timestamp must not be future. The server supplies MANUAL channel, actor and created time. Outbound logging means USER_REPORTED contact, not delivery confirmation. Logging does not silently advance lifecycle status. Inbound text increments context_version; every log increments lead version.



Message pagination orders by occurred_at, created_at and ID, newest first. Cursors include all three fields. Edit/revision support remains pending.



## Configuration and limits



Missing credentials return 503 BACKEND_NOT_CONFIGURED. Invalid fields return 422. Missing or unverified session returns 401; inactive tenant membership returns 403; inaccessible lead returns 404; stale version or changed retry payload returns 409. JSON request limit is 256 KB; list size defaults to 25 and caps at 100. P3 adds shared fixed-minute HTTP limits: 60 reads/30 mutations per verified user; 429 includes Retry-After. Direct business RPC commits also have a separate write guard. See OPERATIONS.md for scope and release edge controls.



## Lifecycle changes



All status/task mutations require an Idempotency-Key UUID. Status payload requires `status` and the current lead `expected_version`. Transitions follow the documented matrix; CONTACTED needs stored outbound evidence, FOLLOW_UP needs an OPEN task, QUALIFIED needs confirmed_intent and qualification_summary. Supply locations (up to five) and acknowledge_unknowns=true when budget or area is unknown.



WON requires a nonfuture won_at and outcome_summary; optional deal_value requires deal_currency. LOST requires lost_reason from NO_RESPONSE, NOT_INTERESTED, BUDGET_MISMATCH, ALREADY_CLOSED, DUPLICATE, OTHER; OTHER also requires reason. Reopening WON/LOST requires reason of 5–500 characters. Closing a lead with OPEN tasks requires cancel_open_tasks=true. Outcome, cancellations, per-task audit and status audit commit together. Reopening does not revive tasks. Audit retains previous outcome details.



## Follow ups



Creation payload: lead_id, type (CALL/MESSAGE/EMAIL/VIEWING/INTERNAL), title (1–150), optional notes (up to 2,000), future due_at with offset, expected_lead_version, optional assignee_id. Default assignee is the current lead assignee, or the manager queue (null task assignee) for an unassigned lead. AGENT can create only for their own assigned lead and themselves. Manager assignment to another AGENT requires that agent to own the parent lead. Managers can assign tasks to active managers with access to the parent.



List order is due_at then ID ascending. Filters: lead_id, state (OPEN/COMPLETED/CANCELLED), limit (1–100), opaque cursor. OPEN tasks past due_at display as overdue; overdue is computed, not a stored state. Complete takes expected_version and summary (1–2,000); server records completion time. Reschedule takes expected_version, future due_at and reason (5–500); increments schedule_version. Cancel takes expected_version and reason. Task mutations increment parent lead version but do not automatically change lifecycle. Closed tasks cannot be reopened.



Do-not-contact leads permit INTERNAL task creation/rescheduling only. New tasks are blocked on terminal or archived leads. An agent must still have access to both task and parent lead, including on replay. Anonymous/direct authenticated task writes are denied. Database rules and audit commit atomically.



Connected UI supports message/status/task forms and cursor loading. Preview mode keeps mutations in memory for the session only. Per-task assignee selection remains separate work; P3 reminder scans/recipient notices are implemented; manager lead reassignment is implemented.


## Lead controls: P1

POST controls require expected_version, reason (5–500 characters), same-origin JSON and an Idempotency-Key UUID. Role and parent access are checked in both API/database context and on replay.

Assignment: assignee_id must be an active same-tenant membership or null. transfer_open_tasks=true is required when OPEN tasks exist. All OPEN tasks move to the target or manager queue; task version/schedule_version advance. Closed tasks retain attribution. Archived leads require restoration first. Agents cannot assign.

Archive: cancel_open_tasks=true is required when OPEN tasks exist. Cancellation, archive state and audits are atomic. Restore preserves lifecycle and never revives tasks. Both require OWNER/ADMIN.

Contact preference: do_not_contact boolean. An assigned agent or manager can set restriction; only manager can clear with documented basis. Setting cancels all OPEN non-INTERNAL tasks; INTERNAL remains open. Clearing never recreates tasks.

Task assignee null means manager queue. Active managers with parent access can read/complete/reschedule/cancel queue tasks. Reassignment moves OPEN tasks to the new assignee. Reminder workers notify each active manager separately and suppress obsolete schedules.

Inbox archived=true selects only archived leads; default false selects active leads. Search covers name/contact and confirmed locations; created_at/ID cursor order is unchanged. Connected UI uses server-filtered 25-record pages.

Summary returns current role/membership_id/lead_version and visible open_task_count/outreach_task_count under task RLS. Agent counts include own tasks only; restricting outreach still cancels all outreach in the transaction. Directory returns id/role/label without exposing Auth accounts. Unset display names fall back to role plus short membership ID when no profile name is configured.

Activity returns id, actor_id, event_type, reason, created_at and details; default 25/max 100 and opaque cursor. Direct authenticated writes are denied. Task history preserves IDs and assignment/schedule/version changes; contact values are not copied into control audit.


## Team and agency: P2

All cookie mutations require same Origin and JSON. Team/profile/agency mutations require X-Tenant-Id, verified account, active membership and UUID Idempotency-Key. Versioned payloads reject unknown authority fields. Invitation acceptance uses verified identity and the token-derived agency without X-Tenant-Id. TOTP operations require verified identity and same Origin; Auth owns their challenges.

| Route | Method | Contract |
| --- | --- | --- |
| /api/v1/team | GET | Current profile/role, agency preferences, manager checklist, owner-only pilot caps/counts |
| /api/v1/team/members | GET | Manager directory including disabled; agent self only; limit/cursor |
| /api/v1/me/profile | PATCH | display_name, expected_version; self only |
| /api/v1/team/invitations | GET | Permitted manager directory; computed EXPIRED; limit/cursor |
| /api/v1/team/invitations | POST | email, role ADMIN/AGENT; reserves a seat |
| /api/v1/team/invitations/{id}/resend | POST | expected_version; rotates link, renews 72-hour expiry |
| /api/v1/team/invitations/{id}/revoke | POST | expected_version; releases reservation |
| /api/v1/team/invitations/accept | POST | token (64 lowercase hex), display_name; verified matching email |
| /api/v1/team/members/{id} | PATCH | expected_version, role/active, reason; optional replacement_id/null, transfer_workload |
| /api/v1/agency | PATCH | expected_version, name, timezone, locale=en, processing_approved, processing_reference, ai_enabled; owner-only optional seat_limit/ai_monthly_limit |
| /api/v1/agency/transfer-owner | POST | expected_version (actor), target_member_id, target_expected_version, confirmed=true, reason |
| /api/v1/me/mfa | GET | Own TOTP factors and verified recent status |
| /api/v1/me/mfa | POST | action=enroll; verify with factor_id/code; cancel-pending with own unverified factor_id |

Manager directory pagination is ascending created_at/id, default 25/max 100. No Auth-wide account search. Raw invitation links appear only in create/resend responses: {invitation,accept_url,delivery}. Safe directory/audit/outbox/replay storage excludes raw tokens; authenticated column reads cannot access token_hash. delivery is LINK_ONLY, EMAIL_QUEUED, EMAIL_ACCEPTED or EMAIL_FAILED; it is not recipient delivery confirmation. Revoke returns {invitation}. Accept returns newly authorized tenant_id/membership.

OWNER manages ADMIN/AGENT, ADMIN manages AGENT. Privilege elevation/admin invitation and owner transfer require signed aal2 with recent TOTP AMR (five minutes), checked in SQL. Deactivation/role change with assigned leads or OPEN tasks requires transfer_workload=true and replacement_id (active same-agency ID or explicit null manager queue). Closed-task attribution persists; Auth users are retained. Owner transfer atomically preserves one active owner.

Missing seat configuration is 422 SEAT_LIMIT_REQUIRED; capacity/conflicting reservations are 409 SEAT_LIMIT_REACHED; stale versions/idempotency conflicts are 409; unavailable invitations use generic 422 INVITATION_UNAVAILABLE; recent MFA/roles are 403. Workload confirmation and approval gates are 422. Transport failure preserves a committed invitation and manual link. See TEAM_ADMINISTRATION.md for environment, lock/scale limitations and hosted acceptance.


## Notifications and operations: P3

| Route | Method | Contract |
| --- | --- | --- |
| /api/v1/notifications | GET | Own recipient only; filter ALL/UNREAD/DISMISSED, limit 1–100/default 25 and opaque cursor |
| /api/v1/notifications/summary | GET | Own unread_count excluding dismissed rows |
| /api/v1/notifications/{id} | PATCH | expected_version and read=true and/or dismiss=true; UUID Idempotency-Key |
| /api/v1/notifications/{id}/open | GET | Fresh authorization: available=false, or latest lead/team reference |
| /api/internal/cron/follow-ups | GET | Separate Bearer credential; seed max 100 due recipient pairs and process bounded jobs |
| /api/internal/cron/jobs | GET | Separate Bearer; process queued notice/invitation-mail jobs |
| /api/internal/cron/status | GET | Protected global lag/failure metrics and alert flag |
| /api/internal/cron/retry | POST | Protected strict JSON {job_id,expected_attempts}; failed-job recovery and atomic audit |

Notification list order is created_at/id descending. current=false suppresses resource_label/due_at; can_open separately indicates current parent permission, so an outdated notice can open the latest authorized lead. Stored notification rows contain no contact/body snapshot. No manager override to other recipients. Read/dismiss preserves monotonically set timestamps, checks versions, rejects recipient/tenant/type injection, and replay rechecks current active membership. Inactive recipients lose direct RLS/API access immediately.

Assignment versions, task schedule versions, recipient eligibility and immutable dedupe keys govern publication. Queued mail stores only issuing scope/request key/hash; worker regenerates a private link and uses invitation-mail:<job-id> as transport dedupe key. Team invite directory includes delivery_state for the current token. P5/P6 now provide current-input AI notice producers and shared atomic usage reservation. No automatic customer contact occurs.

Cookie APIs use verified identity, current tenant, Origin for mutations and durable per-user limits. Cron uses CRON_SECRET and a separate server-only SUPABASE_SERVICE_ROLE_KEY client with narrow worker RPCs; no user-selected tenant or batch authority. Missing worker configuration is 503, incorrect Bearer is 401, and no raw provider/database errors are returned. See OPERATIONS.md for bounds, fencing, retries, mail adapter, scheduler provisioning, monitoring and pending hosted evidence.


## P4 capture and provenance routes

Cookie user routes require verified active tenant membership, X-Tenant-Id and mutation origin checks. UUID Idempotency-Key applies to create/facts/duplicate/revision/integration mutations; import processing instead uses durable import+row identity. All new reads are bounded and return safe errors.

| Route | Method | Contract |
| --- | --- | --- |
| /api/v1/leads | POST | Manual contacts plus optional confirmed facts and active assignee |
| /api/v1/leads/{id}/facts | PATCH | Partial confirmed fields + expected_version |
| /api/v1/leads/{id}/duplicates | GET / POST | Manager candidates (25 + cursor) / reasoned separate resolution; agents get generic flags |
| /api/v1/leads/{id}/messages/{messageId} | PATCH | body, reason, expected_version, expected_lead_version; manual channel only |
| /api/v1/leads/{id}/messages/{messageId}/revisions | GET | Previous text/reason/editor/time, 25/page; optional before revision cursor |
| /api/v1/imports | GET / POST | 25 operations/page + cursor / {csv, mapping}, 5 MiB decoded CSV and 1,000 rows |
| /api/v1/imports/{id} | GET | Reconciled summary + 20 row results; after row_index cursor |
| /api/v1/imports/{id}/process | POST | {create_separate, reason, retry_failed}; at most 25 pending rows |
| /api/v1/integrations/website | GET / POST | Manager safe metadata / {name, default_assignee_id}; private signing receipt |
| /api/v1/integrations/website/{id} | PATCH | {action: rotate or revoke, expected_version, reason} |
| /api/v1/intake/{integrationId}/leads | POST | Separate raw-body HMAC credentials; external_event_id, lead, optional occurred_at |

Website intake resolves authority from the integration, not cookies or a tenant header. Signature uses Unix-seconds timestamp + dot + exact UTF-8 JSON bytes; five-minute skew and 60/minute durable integration limit. Returns 201 create / 200 replay / 409 changed body for same event. Reported website facts remain separate from human confirmations. See CAPTURE.md for full fields, recovery, encryption and deployment limitations.

## P5 AI analysis routes

| Route | Method | Contract |
| --- | --- | --- |
| /api/v1/leads/{id}/analyze | POST | {expected_version} + Idempotency-Key; 202 queued/reused, current cookie/tenant/parent + platform/processing gates |
| /api/v1/leads/{id}/analyses | GET | 25 authorized jobs/results + cursor; current/stale, safe availability and current lead context |
| /api/v1/ai/jobs/{id}/cancel | POST | {expected_version} + Idempotency-Key; release known-unused or retain RECONCILE if dispatched |
| /api/v1/agency/ai-usage | GET | Owner-only UTC daily/monthly caps, operations and reconciliation count |
| /api/internal/cron/analysis | POST / GET | Separate CRON_SECRET Bearer authorization; synchronize policy/process bounded jobs / protected metrics |

Agency PATCH adds optional owner-only ai_daily_limit (null or integer 0–1,000,000); omitted caps remain unchanged. User requests never use the private worker client. Per-user ten new jobs/hour and atomic agency operation caps are enforced in SQL; transient attempts never reserve additional operations. History emits evidence, model/prompt/schema/rubric, uncertainty/conflicts and original timing, excluding private snapshots/leases/provider errors. Lead inbox/detail also return only current authorized score metadata, with timeline points projected against the current clock. AI_DISABLED=503, AI_LIMIT_REQUIRED=422, AI_QUOTA_REACHED=409, AI_RATE_LIMITED=429. Refusal/invalid evidence are safe permanent job failures. See AI_ANALYSIS.md for lifecycle/configuration and AI_EVALUATION.md for local/live evidence separation.

## P6 reviewed reply routes

Every user route uses verified cookie identity/current tenant membership and current parent-lead scope. Mutations require origin checks, a random request key for actor-scoped retry and strict JSON. Worker credentials cannot substitute for user authority. See REPLY_DRAFTS.md for state/review semantics.

| Route | Method | Contract |
| --- | --- | --- |
| /api/v1/leads/:id/drafts | GET | Cursor-only history, 25 DRAFT jobs/page with authorized results, current input and availability |
| /api/v1/leads/:id/drafts/generate | POST | expected_version (lead), language en/ar, tone PROFESSIONAL/FRIENDLY, optional instruction <=500; durable shared-quota submission; 202 |
| /api/v1/drafts/:id/edit | PATCH | expected_version (draft), text 1–5000; original preserved, content advances and approval clears |
| /api/v1/drafts/:id/approve | POST | expected_version, acknowledged:true; current safe text and outreach gates; binds current reviewer/versions |
| /api/v1/drafts/:id/reject | POST | expected_version, reason 5–500; explicit rejected state |
| /api/v1/drafts/:id/feedback | POST | expected_version, category USEFUL/INCORRECT/UNSAFE/UNHELPFUL, optional comment <=500; immutable separate observation |
| /api/v1/drafts/:id/copy | POST | expected_version; current own approval; returns text/copy_token/current version/expiry, no successful-copy claim |
| /api/v1/drafts/:id/copied | POST | expected_version from authorization, copy_token; only after clipboard success; expires in two minutes, completion deduped |
| /api/v1/drafts/:id/external-message | POST | expected_version (draft), expected_lead_version, actual body 1–10000, occurred_at UTC/offset <=now, sent_confirmed:true; requires actor-owned completed copy; logs actual OUTBOUND only |
| /api/v1/agency/draft-feedback | GET | Owner/admin tenant-scoped feedback entry counts; no calculated usefulness percentage |
| /api/internal/cron/drafts | POST / GET | Separate Bearer CRON_SECRET; synchronize policies/process bounded DRAFT jobs / protected metrics |

Existing /api/v1/ai/jobs/:id/cancel supports either job kind. New safe errors include DRAFT_DISABLED (503), DRAFT_LANGUAGE_UNAPPROVED/DRAFT_REVIEW_REQUIRED/DRAFT_UNSAFE/EXTERNAL_LOG_CONFIRMATION_REQUIRED (422), and DRAFT_IN_PROGRESS/DRAFT_STALE/COPY_EXPIRED (409). VERSION_CONFLICT retains unsaved user text. History is private/no-store. Neither copy stage sends a message, inserts an outbound row or changes lifecycle; actual external logging is a separate audited transaction. Manual Conversation remains available for externally sent messages outside this copy flow.

## P7 dashboard

GET /api/v1/dashboard uses verified cookie identity, current agency membership, the shared read limiter and private/no-store responses. No privileged user client is introduced.

Without metric: optional from/to YYYY-MM-DD must both be present or both omitted. Defaults are the last 30 agency-local calendar days including today; range <=366 dates. Returns window (from/to/timezone/start_at/end_at/as_of/current scope/manager), metrics (total/qualified/due/won/unassigned), pipeline counts and contact sample (sample_count/without_logged_contact/median_seconds). Unassigned is null for agents; no contact sample has a null median. No customer bodies/contacts are returned in aggregates.

With metric: require from/to and displayed as_of, optional limit 1–100 (default 25) and cursor <=1024. Supported metrics: TOTAL, QUALIFIED, WON, UNASSIGNED, DUE, CONTACTED_IN_COHORT, STAGE_NEW, STAGE_CONTACTED, STAGE_QUALIFIED, STAGE_FOLLOW_UP, STAGE_WON, STAGE_LOST. Returns items {row_id,sort_at,entity:LEAD|TASK,payload} and pagination.next_cursor. Cursors bind actor/tenant/metric/range/as_of and cannot be replayed under a changed filter; INVALID_CURSOR is 422. Unknown query fields, partial/inverted/oversized dates, future/over-24-hour snapshots and invalid direct-RPC bounds fail validation. Agent UNASSIGNED returns ROLE_REQUIRED (403).

SQL dashboard_summary/dashboard_drilldown use the same current-authorized row selector. STABLE reads preserve a statement snapshot; later requests/pages recheck membership/parent/task assignment and saved state. as_of fixes the due cutoff, not a historical data snapshot across requests. Definitions and agency-day/outcome/contact limitations are in DASHBOARD.md. Copy, delivery, lifecycle mutations and AI processing are independent of dashboard reads.

## P8 privacy review and operations

Verified current tenant context is required for privacy endpoints. Owner/admin may read cases/history; only OWNER requests; all creation/triage needs recent TOTP and UUID Idempotency-Key. Strict payloads accept no actor/tenant/approval authority. Versions are positive 32-bit integers. Every response uses private/no-store and safe errors.

| Route | Method | Contract |
| --- | --- | --- |
| /api/v1/privacy | GET | Cursor-only manager list, 25 cases, next_cursor, execution_available:false |
| /api/v1/privacy | POST | kind LEAD_ERASURE/AGENCY_CLOSURE, lead_id UUID/null matched to kind, expected_version of lead/agency, reason 5–500; owner and recent MFA; 201 |
| /api/v1/privacy/:id | GET | Current manager/tenant case required; cursor-only immutable action/reason/version/time history, 25 rows and next_cursor |
| /api/v1/privacy/:id | PATCH | action REVIEW/HOLD/RELEASE_HOLD/WITHDRAW, expected_version of case, reason 5–500; REVIEW requires verification_reference 5–200; owner/admin recent MFA, WITHDRAW owner-only/not held |
| /api/internal/health | GET | Separate Bearer CRON_SECRET; no queries/body scope; private worker RPC returns aggregate health/lag/usage/reconciliation and privacy execution false |

PRIVACY_CASE_EXISTS (409) protects duplicate open scope. VERSION_CONFLICT/STATE_CONFLICT/IDEMPOTENCY_CONFLICT retain client input; fresh authority/MFA is rechecked before returning retry state. Manager review notes are scoped and immutable; general audit stores no copied notes or verification reference. No approve/purge/anonymize/closure operation is accepted and no customer data is deleted. REVIEW records an external verification reference, not automatic identity validation or erasure approval. Holds are review records, not CRM locks. See P8_HARDENING.md and RUNBOOKS.md.

Health returns global content-free counts and seconds, current UTC job reservation-month observed tokens, cost_amount:null and privacy_execution_available:false. It performs no claims/cleanup/retries. Alert thresholds are proposed; no provider billing, availability, per-tenant cost dashboard or external alert delivery is implied. OPERATIONAL_LOGS_ENABLED=true emits fixed request ID/status/duration only through the shared API wrapper.

## P8 intake AES rotation continuation

No new public HTTP rotation endpoint is exposed. Existing manager integration create/signing-rotate routes read the current encryption policy through integration_encryption_key(p_tenant) and send optional p_encryption_key_id to the replacement manage_website_integration RPC. Signing HMAC derivation remains stable across AES changes; replay returns current safe metadata and denies superseded/revoked signing credentials. INTAKE_KEY_POLICY_CONFLICT is a safe 409; retry unchanged input with the same request key after configuration/policy refresh. No master/encrypted credential is returned through product APIs.

| Private worker RPC | Contract |
| --- | --- |
| worker_intake_encryption_state() | Global active key ID/version and storage-key counts; no ciphertext/tenant/customer metadata |
| worker_list_intake_encryption(after, limit) | Bounded 1–25 encrypted envelopes, ordered UUID cursor; includes revoked rows; operator only |
| worker_set_intake_encryption_key(target, expected_version, reference, key, request_id) | Explicit versioned policy activation and atomic minimized operation receipt; no envelope rewrite |
| worker_rewrap_intake_encryption(payload, key, request_id) | Strict integration ID, source ciphertext hash/key ID, current encryption/policy revisions, target cipher/key ID and bounded reference; agency/policy CAS; atomic summary audit/receipt; no signing-identity change |

All require service_role internally and deny cookie/anonymous callers even after an accidental function grant. Operators use narrow RPCs, not table access. Active-key lookup is verified/current tenant manager-only. Raw keys/ciphers/IDs/references/database/transport text are excluded from operator progress reports. Live-envelope completion cannot approve legacy derivation/backup-key retirement or hosted fleet acceptance. See INTAKE_KEY_ROTATION.md.


## Privacy impact preview

GET /api/v1/privacy/{id}/impact?expected_version={case_version} uses verified cookie identity, current X-Tenant-Id membership and manager-only read_privacy_impact. It returns validated related-record counts and hold/work indicators at as_of, bound to tenant/case/version. Invalid query fails 422, missing case 404, missing membership/role 403 and stale version 409. It is a read-only preview; retention approval, complete inventory and execution flags remain false. Existing projects need migration 022. See PRIVACY_IMPACT.md.
