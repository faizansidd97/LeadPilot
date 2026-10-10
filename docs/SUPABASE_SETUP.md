# Supabase development connection



Use the existing development Supabase project. LeadPilot runs at http://localhost:4000.



## Fill configuration



Edit `frontend/.env.local` from the LeadPilot root:



```dotenv

NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co

NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY

APP_URL=http://localhost:4000

```



Use the publishable key (or a legacy anon key). The application does not require a service-role key. Existing `.env.local` values are preserved by the setup helper; key values are never printed by the checker.



From `backend`, run:



```sh

pnpm check:supabase

```



This validates local configuration format only; it does not contact the hosted project.



## Apply schema



Open `backend/supabase/setup.sql` and execute it in the development project's SQL Editor. The generated bundle creates all twenty-one current migrations in one transaction. It does not modify Auth settings or existing users.



If any LeadPilot table already exists, the bundle stops before changes. In that case, inspect the project's applied migrations and run only the missing files from `backend/supabase/migrations/` in filename order. Do not apply both the combined bundle and the same migrations again. Avoid running the bundle against a production project.



Regenerate the combined bundle after changing migration sources:



```sh

cd backend

pnpm setup:supabase

```



The versioned migration files remain the source of truth. The setup helper never executes remote SQL.



## Auth settings



Enable email/password sign-in and email confirmation. Set Site URL to `http://localhost:4000` and allow these Auth redirect URLs:



```text

http://localhost:4000/auth/callback

http://localhost:4000/auth/callback?next=/reset-password

```



Configure the project's email delivery so the development signup can receive a verification email. LeadPilot does not bypass email verification.



## Verify the real flow



1. Restart the app from `frontend` with `pnpm dev` (port 4000).

2. Open the app. Configured mode shows the login screen instead of sample data.

3. Register an account with an email you can access, verify it, and sign in.

4. Create a test agency. The database should contain one agency and one active OWNER membership; the API writes the audit in the same transaction.

5. Create a synthetic test lead with a valid email or international phone number and initial inquiry.

6. Reload the page and sign out/in. The lead and inquiry must persist under the same agency.

7. Verify a second account cannot read that agency's leads before membership is granted.



Hosted verification is complete only when these steps pass against the real project. Local PGlite tests emulate Auth and do not prove hosted Auth/email behavior.



## Current status



2026-10-10: the user reports that the SQL queries ran in Supabase. The local configuration checker now passes, and the LeadPilot Next server is listening on port 4000. This confirms local configuration format and server availability only; the agent has not independently verified hosted migration completion, signup/email, agency creation or persisted leads. The subsequently authorized read-only API baseline passed public email-confirmation/signup settings and anonymous privilege denial on all 15 expected table endpoints; see DEV_BASELINE.json. Signed Auth/tenant/business acceptance remains pending. Browser access remains restricted. Complete the authenticated verification steps above before marking hosted acceptance.



The read-only staging checker requires an explicit connection: from backend, run `pnpm verify:supabase --connect-staging --staging-config <private-staging-env-file>` only when environment access is permitted. Without the flag it reads no configuration and makes no requests; `--help` describes the options. It checks strict email-confirmation/signup settings and anonymous denial on all 15 current public tables with the public key and `limit=0`. It rejects open empty tables, missing tables, unsafe settings, redirects and private keys. It never runs migrations or creates accounts. BASELINE_PASS does not verify the migration revision, authenticated signup/agency/lead workflow, workers or release readiness. See STAGING_VERIFICATION.md for configuration and report boundaries.



Workflow upgrade: an already initialized project needs `202610060004_workflows.sql` applied once after migrations 001–003. Fresh projects use the regenerated setup.sql containing all twenty-one migrations. Never re-run the fresh-project combined script against existing LeadPilot tables.


P1 upgrade: after migrations 001–004, apply 202610060005_lead_controls.sql once. It adds member labels, manager-queue task assignment, transactional controls, authorized directory/summary and archive-aware inbox. Fresh-project setup.sql includes all twenty-one migrations; existing projects apply only missing files in order.


P2 upgrade: after 001–005, apply 202610060006_team.sql once. It adds invitation/seat/profile/processing metadata, team RPCs and private outbox, and replaces old writer RPCs to coordinate locks with offboarding. setup:supabase now generates INVITATION_TOKEN_SECRET in frontend/.env.local when missing and preserves existing values. Optional approved mail transport variables are documented in TEAM_ADMINISTRATION.md; otherwise invitations use private copy links.

Enable TOTP in the development Auth project, then verify real enrollment/challenge cookie updates and signed AMR timestamps before testing admin invitations, elevation or ownership transfer. Add the P2 hosted cases from TEAM_ADMINISTRATION.md to the original signup/lead flow. Hosted setup remains pending; these instructions do not claim remote execution.


P3 upgrade: after 001–006, apply 202610060007_notifications.sql once. The P3 migration is included in the current fresh bundle (001–013). It adds recipient notifications, durable outbox leases/retries, assignment/review capture, due workers, shared policy buckets and queued invitation email. Run setup:supabase to prepare CRON_SECRET and blank private worker/mail fields without overwriting existing values. check:workers validates local public/private worker fields without networking or printing values. Hosted scheduler/private role/delivery verification remains pending; see OPERATIONS.md for concrete setup and recovery steps.


P4 upgrade: projects through 007 apply 202610060008_capture.sql, 202610060009_imports.sql and 202610060010_website_intake.sql in order. Fresh setup.sql includes 001–010. New message_revisions use current-parent RLS; imports, signing credentials and event receipts remain private. setup:supabase prepares a missing server-only INTAKE_ENCRYPTION_KEY while preserving existing values. check:intake validates local public/private/encryption fields without networking or printing values. See CAPTURE.md. No hosted execution is claimed.

P5 upgrade: projects through 010 apply 202610070011_analysis.sql once. Fresh setup.sql now includes 001–011. It adds private analysis policy/context/usage, RLS jobs/results, leased worker RPCs, atomic publishing/notices, daily owner quota settings and current result pointer. setup:supabase adds blank server-only provider/model/approval fields while preserving existing values. Defaults remain disabled. See AI_ANALYSIS.md before approved live configuration; no hosted execution or provider call is claimed.

P6 upgrade: projects through 011 apply 202610070012_drafts.sql once. The current fresh bundle includes 001–012. It separates ANALYSIS/DRAFT queue claims, adds private default-off draft policy and copy receipts, parent-RLS reply history/immutable feedback, current-version review and actual external logging transactions. setup:supabase adds the default-disabled AI_DRAFTS_ENABLED field while preserving existing values. See REPLY_DRAFTS.md for protected draft worker policy synchronization, shared quota, copy limits and pending hosted/live usefulness acceptance. No hosted migration is claimed.

P7 upgrade: projects through 012 apply 202610070013_dashboard.sql once. The current fresh bundle contains 001–013. It adds shared current-authorized metric/list selectors, agency-local date boundaries, outcome/task/queue/contact definitions and narrow read RPCs with verified/current membership. Existing initialized projects apply only missing numbered sources in order; do not rerun the fresh bundle. See DASHBOARD.md. Hosted application and concurrency evidence remain pending.

P8 upgrade: projects through 013 apply 202610070014_hardening.sql once. The current fresh bundle contains 001–014. It replaces verified direct-read RLS helpers, adds restrictive identity read policies, owner/manager privacy review cases/immutable notes and a narrow read-only service-role health RPC. Existing initialized projects apply only missing numbered sources; never rerun setup.sql. This migration grants no privacy purge/anonymization/closure or deletion replay executor. setup:supabase preserves existing values and adds optional OPERATIONAL_LOGS_ENABLED (disabled unless exactly true). Verify real hosted Auth role/claim mapping, negative direct-table permissions and signed recent TOTP before accepting the privacy workflow. Hosted application, production origin/CSP behavior and tier backup/concurrency remain pending. See P8_HARDENING.md and RELEASE_CHECKLIST.md.

P8 rotation upgrade: projects through 014 apply 202610070015_intake_key_rotation.sql once. The current fresh bundle contains 001–015. It preserves legacy envelopes, labels encryption key IDs/revisions independently of signing versions, replaces manager integration RPC with an optional encryption-key-ID argument and adds a verified-manager active-key lookup plus service-role-only policy/inventory/rewrap RPCs. Verify new signature/schema discovery and negative grants in hosted API before allowing writes. setup:supabase adds optional blank INTAKE_ENCRYPTION_KEYS while preserving populated values. Keep INTAKE_ENCRYPTION_KEY unchanged for legacy decrypt and deterministic signing derivation. No live key generation/rotation or hosted migration occurred. See INTAKE_KEY_ROTATION.md for explicit staged preflight/policy/rewrap/verify and backup limitations.

P8 platform health upgrade: after 001–018, apply 202610080019_platform_health.sql once before the new strict health API is deployed. The current fresh bundle contains 001–019. Existing cookie/anonymous roles remain denied global health; only the private worker role reads aggregate snapshots. The optional read-only operator monitor requires explicit permitted connection, staging HTTPS APP_URL and CRON_SECRET. See PLATFORM_MONITORING.md. No hosted migration or monitor connection occurred.

P8 AI attempt tracking upgrade: after 001–019, apply 202610080020_ai_attempt_tracking.sql once before deploying updated analysis/draft workers. Fresh setup contains 001–020. Pause dispatchers for rollout and allow old leases to expire before recovery; existing jobs/usage remain intact and old request identities are not backfilled. Worker-only private diagnostics and retention/restore/rollout boundaries are documented in AI_ATTEMPT_TRACKING.md. No hosted migration or provider call occurred.

## Private worker configuration update — 2026-10-10

The user saved SUPABASE_SERVICE_ROLE_KEY. The offline setup checker with --check --workers --intake now passes, and the workspace Next development server was restarted on port 4000 to load .env.local. This validates configuration format only, not the private credential against Supabase or worker execution. No privileged API request, queued-job claim, email, provider call or hosted SQL change was performed. Next acceptance steps are the signed account/agency/lead persistence flow above, followed by a scoped worker exercise in the permitted development environment.

## Manual persistence check — 2026-10-10

The user supplied a connected-agency lead-list screenshot and confirmed that the saved manual lead remained visible after page refresh. The single-lead save/reload check is recorded as user-confirmed MANUAL_PASS. Agent browser testing remains blocked. This does not complete email/signup, sign-out/in, second-account isolation, migration revision or worker acceptance.

## Read-only RPC correction — migration 021

For a project already through 001–020, apply only backend/supabase/migrations/202610100021_read_membership.sql once. It fixes hosted SQLSTATE 25006 in assignment/directory/dashboard/other read RPCs by separating lock-free verified read membership from mutation locks. Fresh setup.sql now contains 001–021; never rerun the fresh bundle against initialized tables. Hosted application is pending. See READ_MEMBERSHIP_RECOVERY.md before reloading the lead and continuing the reminder test.


2026-10-10 privacy development update: fresh setup contains migrations 001–022. An initialized project through 021 needs only 202610100022_privacy_impact.sql, once, to enable Settings Privacy impact previews. No hosted migration was applied in this slice. The preview remains a read-only partial inventory; erasure/closure/restore replay is not implemented. See PRIVACY_IMPACT.md.

2026-10-10 migration status update: the user reported applying migration 022 to development Supabase. This is user-confirmed application, not independent hosted revision/API/RLS/browser acceptance. A subsequent supplied Settings Privacy screenshot shows a database error above the privacy panel; preview acceptance remains pending and the read failure is under investigation. Hosted multi-agency testing remains deferred. P8 remains IN PROGRESS and P9 not started.

2026-10-10 Settings recovery: existing server output shows team snapshot 200, team members 503 and privacy list 200 for the supplied screenshot. Reproduced SQLSTATE 42804 locally with the real Supabase Auth varchar(255) email type; previous text fixtures hid the team RPC return-type mismatch. Migration 023 casts only the returned Auth email to text, retaining verified read membership, function signature/grants, scopes/paging and workload counts. Five new checks cover reproduction, rollback, permissions, read-only/pagination/type compatibility and restore. Shared current-schema/fresh-bundle fixtures now reflect varchar(255); migration 021 retains an explicit historical text fixture to isolate locking. Focused 25/25 checks pass. Full verification is in progress. Fresh setup is 001-023; existing development through user-reported 022 needs only 023 once, then top Settings Refresh. No agent hosted SQL/API/browser/customer/Auth/key/provider/mail/deployment action occurred. Exact hosted SQLSTATE and visible recovery remain unverified; multi-agency testing stays deferred. See TEAM_DIRECTORY_RECOVERY.md.

2026-10-10 user update: the user reports migration 023 run. Record development application as user-confirmed; hosted revision and visible Settings recovery are not independently verified. Continue development while hosted multi-agency testing stays deferred.

P8 eighteenth execution design: harden Privacy intake/review client recovery with scope-keyed mounting, synchronous action gates, abort/current request tickets, verified list/history/search/receipt contracts and immutable original save recovery. Lost write acknowledgement preserves payload/key; acknowledged writes recover post-save lists using reads only. Retain form input through temporary failures and MFA requirements; clear access-sensitive case state on definitive authorization loss. Do not expose a failed read as an empty case list or carry a late response into a selected case/search. SQL remains 001-023 and erasure/closure remains unavailable. Run meaningful deferred transport checks and both types/build; hosted/browser acceptance remains deferred.
