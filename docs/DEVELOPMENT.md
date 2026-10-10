# Development status

The baseline is LP BRD 001/FSD 001 (5 October 2026). PRODUCT_PLAN.md contains the complete ordered roadmap and acceptance tracker.

## Current milestone

P0–P7 are locally verified, including evidence-backed AI analysis and reviewed reply drafts with shared atomic usage reservation. P7 now supplies authorized dashboard metrics/lists and product UX foundations. Next planned development is P8: hardening and release candidate. Hosted acceptance and release gates remain pending.

| Requirement | Implemented locally | Remaining |
| --- | --- | --- |
| F01 identity | Verified cookie Auth, onboarding, invite/accept/resend/revoke, own profile, TOTP, recent-MFA owner transfer, checklist | Hosted Auth/email/MFA and browser evidence; MFA recovery hardening |
| F02 tenancy | RLS, verified/current membership, tenant parent keys, scope-safe replay and team privacy | New-module coverage; hosted/concurrency verification |
| F03 intake | Manual/full-facts capture, CSV validation/preview/confirm/resume, signed website intake and duplicate resolution | Hosted intake/retention/key lifecycle and measured performance |
| F04 lead workflow | Lifecycle/qualification/outcomes, contact/budget, assignment, archive, DNC; deactivation transfers work | Resumable large transfers/performance |
| F05 conversation | Scoped manual logging/revisions, prior text/reason/actor/time, occurrence-time pagination and immutable WEBSITE provenance | Hosted/browser verification and release retention |
| F06–F07 AI | Private minimized snapshots, durable jobs/usage, fenced provider worker, validated evidence, conflicts/unknowns, current/stale UI, score expiry, 100 synthetic analysis contracts; reviewed reply lifecycle/copy receipts/actual external log/feedback and 56 constructed draft outlines; manual CRM available | Approved live 100-inquiry extraction and measured draft usefulness evaluation, bilingual/model/rubric/language/processing and hosted acceptance |
| F08 tasks | Versioned task actions, transfer/queue, cancellation, UTC/agency time | Hosted scheduler/lag acceptance, per-task assignee chooser |
| F09 dashboard | Authorized database summary/list parity, creation/outcome/queue definitions, local calendar/DST boundaries, current assignment scope, first user-logged contact sample | Hosted/concurrency/load and browser metric/keyboard/screen-reader acceptance |
| F10–F11 | Team hierarchy, invitation seats, offboarding, owner transfer and agency/pilot settings | Hosted notification/transport evidence |
| F12 audit | Atomic critical events, history, read-only lead timeline, private deduped outbox | Security events/retention and release monitoring |
| F13–F14 | Safe errors, bounded JSON, no shared cache, versions, permission/rollback tests | Provider/edge abuse controls, privacy, production monitoring/load/recovery/backup/UAT |

## Verification evidence

7 October 2026, latest P7: 330/330 full regression tests, both package type checks and production build pass with bundled Node 24. Fresh setup includes 001–013. Eighteen new dashboard checks cover scope/child permissions, direct-RPC denial, timezone/DST, card/stage/list parity, outcomes/reopening/duplicates, contact sample, tied-time pages, revocation and safe URL/cursor binding. UI uses Tailwind, maintained shadcn-style source primitives, React Hook Form dates and Radix core dialogs. See DASHBOARD.md; no interactive WCAG or hosted performance claim is made.

7 October 2026, latest P6: 312/312 full regression tests, both package type checks and production build pass with bundled Node 24. Fresh setup includes migrations 001–012. P6 adds 83 checks for constrained replies, current-version review, copy receipts, access/context invalidation, feedback, external logging and rollback. All 56 constructed outline contracts pass; no live provider or usefulness measurement is claimed. See REPLY_DRAFTS.md and REPLY_EVALUATION.md.

7 October 2026, P5: 227 full regression tests plus final 112 domain/provider checks (229 distinct tests), both package type checks and production build pass with bundled Node 24. P5 tests cover quota/scope/replay, safe provider failures, exact evidence, score aging, atomic audit rollback, leases, revocation and stale/current notifications. The 100 constructed synthetic contract cases pass; no provider was called and no live extraction accuracy is claimed. See AI_ANALYSIS.md and AI_EVALUATION.md.

6 October 2026: 97 distinct local tests verified (96 full regression + final capture/bundle checks), both package type checks and production build pass with bundled Node 24. Tests apply migrations 001–010 with emulated Auth. Generated fresh-project bundle is tested for successful application and existing-table guard. Team tests cover role hierarchy, direct/RPC privacy, foreign agency denial, invitation token hash secrecy, verified matching email, expired/revoked/old-link rejection, seat reservation/release, retry dedupe, recent MFA, immediate revocation, OPEN-work movement with completed attribution, owner uniqueness and forced audit rollback. Optional mail transport uses injected fake fetch only.

Settings supports Profile/Team/Agency/Pilot according to current role, TOTP setup/verification, paginated team/invites, versioned edits, workload confirmation, private copy links and onboarding checklist. /join reads the fragment token, supports Auth verification/sign-in and accepts without a tenant header. Preview remains session-only and does not simulate account access or mail delivery. See TEAM_ADMINISTRATION.md for contracts and limitations.

Supabase URL/publishable key are unavailable. Hosted migrations/Auth/email/MFA/RLS and browser journeys are unverified. Previous Supabase/localhost browser permission denial remains respected; no blocked action or alternate network workaround was attempted. This is not complete A01–A24 acceptance or production readiness.

## Workspace and setup

Root contains exactly docs, frontend and backend. Frontend owns Next UI/route adapters/environment/lockfile; backend owns domain/services/SQL/tests. Development uses port 4000. System Node is 16; project needs >=22.18, and local verification uses bundled Node 24.

Fresh projects apply backend/supabase/setup.sql with all fifteen migrations once. Existing projects apply only missing numbered migrations in order, through 202610070015_intake_key_rotation.sql. setup:supabase preserves environment values, generates missing server-only invitation/cron/intake-encryption secrets and rebuilds the bundle. Public Supabase fields remain unconfigured. See SUPABASE_SETUP.md.

## P3 verification and limits

The Notifications screen has unread badges, Inbox/Unread/Dismissed filters, cursor pages, read/dismiss with versions/replay, polling and fresh resource open. Outdated/unauthorized previews stay neutral. Private outbox workers provide bounded claims, 90-second fenced leases, three attempts, backoff/jitter, dead-letter recovery, due catch-up, per-recipient dedupe and lag/failure metrics. Large manager fan-out continues in persisted pages. Invitation email is queued atomically, regenerated from the secret and submitted through an optional approved adapter with stable job dedupe; missing transport keeps copy-link behavior. No real messages were sent during development.

Shared fixed-minute policy limits verified HTTP users to 60 reads/30 mutations; direct successful business RPC writes also have a separate 30-write guard. Tests exercise isolation, late/stale schedules, cyclic assignment, manager queues, deactivation, cross-parent worker denial, lease recovery/exhaustion, failed publication/recovery, bounded batches/fan-out, queue/audit rollback, mail hash secrecy/revoke/resend/actor-scoped replay, safe cron errors and durable limiter denial. See OPERATIONS.md for scope/configuration/recovery.

Hosted private role mapping, true overlapping connections, scheduler/transport and measured lag/throughput, browser journeys and release evidence remain pending. Current atomic bulk offboarding is retained; resumable large transfers and contention benchmarks remain P8. P5/P6 now provide current-input AI notice producers and shared atomic usage reservation.

## Next execution

P8 first and second local hardening slices are verified: 382/382 regression tests, both package type checks, constructed AI evaluations and production build. See P8_HARDENING.md, LOCAL_CHECKS.json and RELEASE_CHECKLIST.md. Nonce CSP/security headers, verified direct RLS, privacy intake/triage/holds/history, private aggregate health, actual isolated restore/rollback and a measured 10k sequential SQL benchmark are implemented. Privacy erasure/closure and restored deletion replay are unimplemented pending an approved policy. Continue P8 with approved irreversible work and permitted hosted/provider/cron/concurrent/tier backup/browser UAT evidence; P9 is not started. Local checks and zero advisory snapshot do not establish release acceptance. Scripts verify:local, benchmark:local and check:release operate offline; the release audit intentionally reports NOT_READY. See RUNBOOKS.md for concrete procedures.

P8 rotation continuation: versioned intake AES keys, private global write policy, explicit operator plan/activate/rewrap/verify, strict dual reads, CAS/audit/replay/restore evidence and retained signing identity are locally verified. See INTAKE_KEY_ROTATION.md. The CLI is prepared for an authorized configured staging operator; development used injected/local databases only. Preserve the legacy signing derivation root and all backup read keys; neither live rewrap completion nor local tests approves retirement. Next P8 work remains approved privacy execution/restore replay, further derivation/invitation rotation preparation and permitted hosted/concurrent/provider/browser UAT gates.
