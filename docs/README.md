# LeadPilot AI



Development baseline: LP BRD 001 and LP FSD 001, version 1.0, 5 October 2026, in `docs/`.



## Delivery plan

The start-to-end roadmap and execution tracker are in [PRODUCT_PLAN.md](PRODUCT_PLAN.md). Continue in dependency order and track actual local, hosted and release evidence separately.

The current handoff is in [DELIVERY_STATUS.md](DELIVERY_STATUS.md). Remaining privacy decisions are in [PRIVACY_POLICY_REQUIREMENTS.md](PRIVACY_POLICY_REQUIREMENTS.md), and the prepared baseline/training/weekly pilot protocol is in [PILOT_PROTOCOL.md](PILOT_PROTOCOL.md). These documents do not claim release or pilot completion.

The [local privacy schema inventory](PRIVACY_DATA_INVENTORY.md) and [offline inventory tool](PRIVACY_INVENTORY_TOOL.md) cover reviewed public/private metadata and identify opaque/shared/indirect dependencies. Full data inventory, policy and execution remain pending; no customer values or remote configuration are read by this developer tool.

Development branch checks and protected Vercel Preview deployment are described in [CI_CD.md](CI_CD.md). Deployment activation and credentials are separate from committing the workflow.

## Folder structure



```text

LeadPilot/

├── docs/       Requirements, API contracts and development notes

├── frontend/   Next.js UI, route adapters and app configuration

└── backend/    Server handlers, domain rules, SQL migrations and tests

```



The application keeps the FSD modular monolith architecture. The backend is a workspace package executed through Next.js route adapters; both use the same origin on port 4000. UI imports browser-safe schemas from the backend package, while server implementations remain guarded.



## Run



Requires Node.js 22.18+ and pnpm.



```sh

cd frontend

pnpm install

pnpm dev

```



Use http://localhost:4000. The dev and production start commands both use port 4000.



```sh

pnpm test

pnpm typecheck

pnpm build

pnpm start

```



Without Supabase environment variables, the app opens an explicitly labelled sample preview. Preview records are session-only. Backend routes return a safe configuration error rather than storing data in memory.



## Connect the backend



Follow `SUPABASE_SETUP.md` for the existing-project setup, local checker and combined SQL bundle.



1. Create a development Supabase project and enable email confirmation under Auth settings.

2. Apply all SQL files in `backend/supabase/migrations/` in filename order through Supabase SQL Editor or your migration workflow. The first migration creates the schema; subsequent migrations add transactional services and lead controls.

3. Copy `frontend/.env.example` to `frontend/.env.local`. Set the project URL, publishable key, and `APP_URL=http://localhost:4000`. User APIs use authenticated cookies and RLS; they do not use a service-role key.

4. In Supabase Auth URL configuration, allow `http://localhost:4000/auth/callback` and `http://localhost:4000/auth/callback?next=/reset-password`. Configure transactional email delivery for the pilot.

5. Restart the server, create an account, verify its email, sign in, and create an agency. Configured mode opens the connected workspace; Add Lead persists through the API. Multiple memberships require agency selection.



Live customer intake still depends on BRD processing and retention approvals. No remote Supabase project, credentials or migration deployment has been provisioned here.



## Implemented backend slice



Cookie-based Supabase Auth, verification callback, password reset and password update. Each business API verifies the current user with Auth and checks active tenant membership. The `X-Tenant-Id` header selects a tenant; it never grants access.



Transactional agency onboarding creates exactly one owner, agency audit and idempotency record. Lead creation validates contacts and budgets, determines assignment from membership, saves initial inbound text, checks duplicate contacts without revealing other lead identities, and inserts audit in one transaction. Agent-created leads are self-assigned; managers can select an active same-agency assignee or leave them unassigned.



Lead list and detail use RLS and stable cursor pagination. Contact/fact replacement uses `expected_version` and increments context freshness. Conversation logging validates timestamps, records user-reported outbound contact, checks current access and version, blocks prohibited outreach, and invalidates context on inbound text. Failed audit inserts roll back the entire mutation.



User writes to underlying tables remain denied. Narrow RPCs verify identity, email verification, membership and assignment at the database boundary with fixed search paths. API cookie mutations require same Origin, request bodies are bounded, errors omit raw provider/database details, and responses disable shared caching.



See `API.md` for routes and examples.



## Verification



From `backend`, `pnpm test` runs domain tests, request-boundary tests and local PostgreSQL integration tests through PGlite. Database tests apply the actual migrations, then exercise role-scoped reads, denied direct writes, same-tenant assignments, replay conflicts, message versions, immediate membership revocation, and forced audit failure rollback.



These tests emulate Supabase Auth users and `auth.uid()` locally. Hosted Supabase Auth, email delivery and remote migration deployment still require integration verification after configuration.



## Remaining development



P7 date/timezone dashboard aggregates and UX foundations are locally complete. Release privacy workflows remain to be implemented. P5/P6 durable AI analysis and reviewed drafts are locally complete; live AI remains disabled until configured and approved. Tailwind utilities, maintained shadcn-style Button/Dialog and React Hook Form dates are integrated incrementally; existing forms retain their business contracts.



The connected dashboard now uses authorized F09 database metrics and matching lists; preview remains labelled session sample data. BRD D02 processing, D03 retention, D05 rubric, D07 visibility and D09 service targets require resolution before release.



The next workflow slice is implemented: message logging UI with occurrence-time pagination, lifecycle/qualification/outcome forms, and follow-up scheduling/completion/rescheduling/cancellation. Database transactions preserve audit/history and cancel OPEN tasks atomically when a lead closes. Agency-local time inputs convert to UTC. Preview mutations persist only for the session; connected mode requires all migrations through 013 and Supabase credentials.



Development requires Node.js >=22.18. Validation here uses the bundled Node 24 runtime because the system default is Node 16. Frontend check/test scripts now invoke workspace tools directly instead of spawning a second pnpm installation.


P1: contact/budget editor, manager assignment and OPEN-task transfer/queue, archive/restore, contact preference and outreach-task cancellation, activity timeline, role-aware controls and server-filtered paginated inbox are implemented. Local verification: 35 tests, both package type checks and production build pass. Hosted/browser verification remains pending.

P2 team/agency/onboarding is implemented locally. Settings and /join connect profile/TOTP, role hierarchy, invitations and seats, workload transfer/deactivation, owner transfer, processing preferences and pilot limits. Local verification: 53 tests, both type checks and production build. Hosted Auth/email/MFA/browser acceptance remains pending. P3 is now locally implemented as recorded below. See TEAM_ADMINISTRATION.md.

P3 durable operations and notifications are locally implemented. Protected cron/RPC workers, due catch-up/lag, fenced leases/retries/recovery, recipient-only notices/read/dismiss/current-open, shared limits and queued invitation mail are connected. Local evidence: 78 tests, both type checks and production build. Hosted worker credentials/scheduler/email/browser/performance remain pending; no live reminders or delivery are claimed. P4 is now locally implemented as recorded below. See OPERATIONS.md.

P4 capture/facts/conversations are locally implemented: CSV template/mapping/validation/20-row preview/bounded confirmation/resume/reconciliation, older import pagination, encrypted signed website integrations with rotate/revoke/replay, complete human facts, manager duplicate review and manual revision history with immutable source provenance. Evidence: 97 distinct tests verified (96 full regression plus final capture/bundle checks), both type checks and production build. Hosted Supabase/website/browser/concurrency/retention verification remains pending. Next: P5 evidence-backed AI analysis. See CAPTURE.md.

P5 adds private analysis snapshots, atomic daily/monthly operation reservations, fenced Responses workers, evidence/score validation, stale history and AI analysis/owner usage UI. See AI_ANALYSIS.md and AI_EVALUATION.md. Run backend evaluate:analysis for the 100 synthetic contract report. Provider configuration/approvals and hosted acceptance remain pending. P6 is locally complete; P7 dashboard/product UX is now locally complete; next milestone is P8 hardening.

P6 adds human-reviewed replies, original/working text, edit/context review invalidation, unsafe withholding, successful-copy receipts, explicit actual external-message logging and separate immutable feedback. Evidence: 312/312 tests, both package type checks, production build and 56 constructed outline contracts. See REPLY_DRAFTS.md and REPLY_EVALUATION.md; run backend evaluate:drafts. AI_DRAFTS_ENABLED defaults false. Live usefulness, hosted/browser and release evidence remain pending. Next: P7.

P7 adds authorized database-wide dashboard counts, matching paginated lists, agency calendar/outcome/task/queue definitions and a labelled first user-logged contact sample. It also adds safe shareable filters, responsive navigation/form improvements, source Button/Dialog primitives, React Hook Form dates and manager Integration settings. Evidence: 330/330 tests, both package type checks and production build. See DASHBOARD.md. Hosted/browser/WCAG/concurrent performance and release acceptance remain pending. Next: P8 hardening.
