# LeadPilot AI

LeadPilot is a multi-tenant lead-management workspace for UAE real estate agencies. It helps teams capture inquiries, assign leads, record conversations, schedule follow-ups and review their pipeline. Optional AI analysis and reply drafts support the agent's work while keeping review and customer communication in human hands.

The interface is English. Customer inquiries can contain multilingual text; enabled AI processing depends on approved languages and evaluation.

## Current status

**Development / pre-pilot — updated 10 October 2026.**

| Area | Status |
| --- | --- |
| P0–P7: foundation, CRM workflows, team, capture, AI modules and dashboard | Implemented and verified locally |
| P8: hardening and release preparation | In progress; twenty-six local slices verified, including CSV import recovery, Leads inbox/Add lead recovery, Dashboard recovery, Follow-up queue recovery, Notifications inbox/badge recovery, AI/reply-draft recovery, Facts/duplicate-review recovery and authenticator setup UX |
| Latest complete local regression | 740/740 tests pass |
| Backend and frontend type checks | Pass |
| Constructed analysis / draft contract evaluations | 100 analysis cases and 56 draft cases pass |
| Production build | Pass |
| Database schema | Numbered migrations 001–023 |
| Hosted multi-agency, Auth/MFA, browser accessibility and deployment acceptance | Pending |
| Controlled pilot and later commercial releases | Not started |

Local tests use synthetic data, injected transports and isolated databases with emulated Auth. They do not establish live AI accuracy, hosted security acceptance or production readiness. Limited development worker checks are recorded separately. The user has reported applying development migrations 022 and 023; independent hosted migration acceptance remains pending.

See [the product plan and execution tracker](docs/PRODUCT_PLAN.md), [local verification manifest](docs/LOCAL_CHECKS.json) and [release evidence](docs/RELEASE_EVIDENCE.md) for the detailed history and limitations.

## Product capabilities

| Module | Available implementation |
| --- | --- |
| Accounts and agencies | Email/password Auth, verified-account onboarding, agency membership, agency switching, profile and authenticator setup/verification |
| Team administration | OWNER / ADMIN / AGENT roles, invitations, role changes, offboarding, work transfer and sensitive owner-transfer checks |
| Lead management | Search and filters, confirmed facts, contacts and budgets, lifecycle/outcomes, assignment, archive/restore, do-not-contact and duplicate review |
| Capture | Manual lead entry, CSV validation/preview/confirmed import and signed website intake |
| Conversations | Manual message logging, revisions with reasons and saved provenance |
| Follow-ups | Scheduling, completion, cancellation, rescheduling and agency-timezone display |
| Notifications | Recipient-scoped inbox, unread counts, read/dismiss controls and durable reminder jobs |
| Dashboard | Authorized metrics, matching drilldowns, date filters, outcomes, overdue tasks and contact samples |
| AI analysis | Durable analysis jobs, evidence-linked facts, unknown/conflicting information, scoring and current/stale results; requires approved configuration |
| Reply drafts | Generate, edit, approve/reject, copy confirmation, external-message logging and feedback; requires approved configuration |
| Settings and operations | Role-aware agency settings, usage, operational counters, privacy request/review/history and partial privacy impact preview |
| Recovery and audit | Version checks, transactional critical events, scoped retry keys, preserved form input and read-only refresh after confirmed saves |

AI does not send customer messages or choose sales outcomes. Copying a reply and recording an actual external message are separate actions. Manual CRM remains available when AI is disabled.

Privacy request recording, review and holds are implemented. Irreversible lead erasure, agency closure and deletion replay after backup restoration are still unimplemented and require an approved policy and further development.

## Architecture and folders

```text
LeadPilot/
├── README.md
├── docs/                     Requirements, plan, API contracts and operational evidence
├── frontend/                 Next.js application host and UI
│   ├── src/app/              Pages and thin API/auth route adapters
│   ├── src/components/       Workspace, forms and feature panels
│   ├── src/lib/              Client requests, scope and recovery helpers
│   ├── .env.example          Configuration template without credentials
│   └── pnpm-workspace.yaml   Frontend + sibling backend workspace
└── backend/                  Shared backend package
    ├── src/domain/           Validation and business contracts
    ├── src/routes/           Server request handlers
    ├── src/server/           Auth, providers, workers and server utilities
    ├── supabase/migrations/  Ordered SQL migration sources
    ├── supabase/setup.sql    Generated fresh-project SQL bundle
    ├── scripts/             Setup, checks and operator tooling
    └── tests/               Domain, database and recovery regression tests
```

The three project directories are `docs`, `frontend` and `backend`. The backend is a workspace package named `@leadpilot/backend`, hosted by Next.js through route adapters. **There is no separate backend HTTP server to start.** Frontend and API share `http://localhost:4000`.

User requests use verified cookie identity, active agency membership and Supabase Row Level Security. Private workers use separate server credentials and constrained worker operations. PostgreSQL jobs and outbox records provide durable work state; the local runner supplies a development trigger.

### Technology

| Layer | Repository technology |
| --- | --- |
| Application host | Next.js 16.3.8 |
| UI | React 19.2, TypeScript, Tailwind CSS, Radix primitives and React Hook Form |
| Validation | Zod |
| Database and identity | Supabase PostgreSQL, Auth, RLS and SQL functions |
| Background processing | PostgreSQL jobs/outbox with leases, retries and deduplication |
| Local database verification | PGlite with isolated fixtures |
| Package workspace | pnpm; lockfile and workspace configuration live in `frontend` |

## Local setup

### 1. Requirements

- Node.js **22.18.0 or newer**. The recorded local verification used Node 24.19.0.
- pnpm **11.25.0**, as declared in `frontend/package.json`.
- A development Supabase project for connected Auth and persisted CRM data.
- Git, if cloning or contributing to this repository.

Commands below run from the repository root unless a different folder is shown. Check `node --version` before starting; an older system Node installation can fail even when another runtime is available on the machine.

### 2. Install the workspace

```sh
git clone https://github.com/faizansidd97/LeadPilot.git
cd LeadPilot/frontend
pnpm install --frozen-lockfile
```

Installing from `frontend` installs both workspace packages. There is no root package install command.

### 3. Prepare local configuration

From `frontend`, move to the backend and run the setup helper:

```sh
cd ../backend
pnpm setup:supabase
```

This prepares `frontend/.env.local`, preserves existing configuration, generates missing invitation/cron/intake-encryption secrets and rebuilds `backend/supabase/setup.sql`. It does not connect to Supabase or execute remote SQL. Preserve generated secrets when moving or deploying an existing environment.

Edit `frontend/.env.local` and fill these values from your development project's configuration:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
APP_URL=http://localhost:4000
```

Use a publishable key or compatible legacy anon key for the public field. Private service credentials belong only in server-side fields.

### 4. Apply the database schema

| Project state | What to apply |
| --- | --- |
| Fresh development project without LeadPilot tables | Execute `backend/supabase/setup.sql` once in the Supabase SQL Editor. The current bundle contains migrations 001–023 in one transaction. |
| Existing LeadPilot project | Review what is already applied, then execute only missing files from `backend/supabase/migrations/` in filename order. |

The combined bundle stops if existing LeadPilot business tables are found. Do not rerun all migrations on an initialized project or apply the same migrations again after using the bundle. Latest migration: `202610100023_team_email_type.sql`.

### 5. Configure development Auth

Enable email/password sign-in and email confirmation. Configure development email delivery so accounts can receive verification/reset messages.

Set the development Site URL to `http://localhost:4000` and allow these redirect URLs:

```text
http://localhost:4000/auth/callback
http://localhost:4000/auth/callback?next=/reset-password
```

Authenticator setup is available under **Settings → Profile → Account security** and inline for privacy changes. Start setup, scan the QR code in an authenticator app, enter its current six-digit code and finish verification. Sensitive mutations still require server-confirmed recent verification.

### 6. Check configuration and start the app

From `backend`:

```sh
pnpm check:supabase
cd ../frontend
pnpm dev
```

Open [http://localhost:4000](http://localhost:4000). Configured mode uses the connected account/agency flow. Without public Supabase configuration, the application provides a sample workspace; preview data is session-only and does not prove persisted backend behavior.

Restart the development server after changing environment configuration. Port **4000** is used for both development and production start commands.

## Environment reference

All application configuration lives in `frontend/.env.local`. Start from [the complete environment template](frontend/.env.example); it also documents optional key rings and logging.

| Variables | Purpose / requirement |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public project configuration required for connected mode |
| `APP_URL` | Development origin: `http://localhost:4000` |
| `INVITATION_TOKEN_SECRET` | Server-only invitation signing secret; generated when missing by setup |
| `CRON_SECRET` | Server-only protected worker-route credential; generated when missing |
| `SUPABASE_SERVICE_ROLE_KEY` | Private credential for configured worker/intake operations; not used as the ordinary user's database client |
| `INTAKE_ENCRYPTION_KEY` | Server-only website signing-secret encryption/legacy derivation key; generated when missing |
| `INVITATION_MAIL_URL`, `INVITATION_MAIL_TOKEN` | Optional approved invitation mail adapter configuration |
| `OPENAI_API_KEY`, `OPENAI_ANALYSIS_MODEL` | Server-side AI provider configuration when approved AI processing is enabled |
| `AI_PLATFORM_ENABLED`, `AI_PROCESSING_APPROVED`, `AI_RUBRIC_APPROVED`, `AI_APPROVED_LANGUAGES` | AI configuration gates; tenant-level permission and quotas also apply |
| `AI_DRAFTS_ENABLED` | Additional reply-draft enablement gate; defaults false |
| `OPERATIONAL_LOGS_ENABLED` | Optional minimized timing/status logs |
| `INTAKE_ENCRYPTION_KEYS`, `INVITATION_TOKEN_KEYS`, `INTAKE_SIGNING_ROOT_KEYS` | Optional versioned server key rings; follow the corresponding rotation runbooks |

`.env.local`, dependencies, build output and local caches are ignored by Git. Commit `.env.example` with empty values/placeholders. Never put private credentials in a `NEXT_PUBLIC_` variable. Existing data, invitations and backups can depend on retained keys; key rotation requires the documented procedure.

## Automatic development reminders

The standalone notification runner checks immediately, then every **60 seconds** while its process and PC remain running. From a separate terminal in `backend`:

```sh
pnpm check:workers
pnpm worker:local
```

From another terminal in `backend`:

```sh
pnpm worker:status
pnpm worker:stop
```

The runner uses narrow Supabase worker operations, processes due reminders and catches up eligible past-due work after restart. The browser and Next app do not need to stay open for this worker. It does not install a startup task or production scheduler, send invitation email or dispatch AI jobs. It refuses configured invitation mail transport. After PC shutdown/restart, start it again manually.

See [Local scheduler](docs/LOCAL_SCHEDULER.md) for locks, safe status reporting, bounds and recovery. Production triggering and delivery acceptance remain separate work.

## Development commands

| Folder | Command | Purpose |
| --- | --- | --- |
| `frontend` | `pnpm dev` | Development application on port 4000 |
| `frontend` | `pnpm build` | Build UI and bundled backend handlers |
| `frontend` | `pnpm start` | Serve the built application on port 4000 |
| `frontend` | `pnpm typecheck` | Check both frontend and backend types |
| `backend` | `pnpm test` | Run backend regression tests |
| `backend` | `pnpm verify:local` | Run bounded full regression, both type checks, contract evaluations and production build; write fresh evidence |
| `backend` | `pnpm check:supabase` | Offline public configuration validation |
| `backend` | `pnpm check:workers` | Offline worker configuration validation |
| `backend` | `pnpm check:intake` | Offline worker/intake configuration validation |
| `backend` | `pnpm evaluate:analysis` / `pnpm evaluate:drafts` | Constructed contract evaluations |
| `backend` | `pnpm benchmark:local` | Synthetic local database benchmark |
| `backend` | `pnpm check:release` | Offline evidence/configuration audit; currently reports `NOT_READY` with a nonzero exit |

Stop the development server before a full verification/build using the same checkout to avoid overlapping `.next` output. Restart it afterward. Full verification logs are saved under `backend/.cache/p8-verification/`; generated results are recorded in `docs/LOCAL_CHECKS.json`.

Staging checks, platform monitoring, private AI diagnostics and key-rotation tools are documented separately. Connecting operator tools requires explicit connection flags and suitable environment configuration; these are not part of the basic local quick start.

## Troubleshooting

| Symptom | Check / next step |
| --- | --- |
| The app shows sample leads | Check both public Supabase fields, run `check:supabase` and restart Next.js. Preview is not connected persistence. |
| Backend appears unavailable | Start the application from `frontend`; its API handlers run in the same Next.js process. |
| Sign-up or reset email does not arrive | Review development Auth email delivery and redirect settings; complete required email verification. |
| A database operation fails after an upgrade | Confirm missing numbered migrations were applied in order, then use the page's refresh/recovery control. Do not rerun the fresh setup bundle. |
| No authenticator is listed | Use **Set up authenticator**, scan its QR and verify the first code. Unfinished setups explain how to verify or clear and restart. |
| Follow-up notification is missing | Check runner status, task OPEN state, due time in the agency timezone and worker configuration. Sleeping/stopped PCs pause the runner. |
| AI analysis/drafts are unavailable | Review platform, processing, rubric, language, tenant and quota gates. Manual lead work can continue. |
| Commands fail on TypeScript/module features | Check that the terminal is using Node 22.18+ and the repository's pnpm workspace dependencies. |
| Release check fails | Read its unresolved gates. Passing local tests alone does not complete hosted, policy, performance or browser acceptance. |

## Documentation guide

| Topic | Document |
| --- | --- |
| Start-to-end roadmap and actual execution | [Product plan](docs/PRODUCT_PLAN.md) |
| Original product requirements | [Business requirements](docs/LeadPilot_AI_BRD.pdf), [functional specification](docs/LeadPilot_AI_FSD.pdf) |
| API contracts | [API](docs/API.md) |
| Supabase setup and verification | [Supabase setup](docs/SUPABASE_SETUP.md), [staging verification](docs/STAGING_VERIFICATION.md) |
| Team, invitation and account behavior | [Team administration](docs/TEAM_ADMINISTRATION.md), [Auth recovery](docs/AUTH_RECOVERY.md) |
| Capture and lead data | [Capture](docs/CAPTURE.md), [client recovery](docs/CLIENT_RECOVERY.md), [facts recovery](docs/FACTS_RECOVERY.md) |
| AI analysis and evaluations | [AI analysis](docs/AI_ANALYSIS.md), [analysis evaluation](docs/AI_EVALUATION.md) |
| Reviewed drafts | [Reply drafts](docs/REPLY_DRAFTS.md), [draft evaluation](docs/REPLY_EVALUATION.md), [AI client recovery](docs/AI_CLIENT_RECOVERY.md) |
| Metrics | [Dashboard](docs/DASHBOARD.md) |
| CSV import recovery | [File mapping, saved progress and safe batch reconciliation](docs/CSV_IMPORT_RECOVERY.md) |
| Leads inbox and Add lead recovery | [Search, pagination, current opening and original save recovery](docs/LEAD_INBOX_RECOVERY.md) |
| Dashboard recovery | [Metrics, date ranges, drilldown and latest lead opening](docs/DASHBOARD_RECOVERY.md) |
| Follow-up queue recovery | [Queue loading, pagination and latest lead opening](docs/FOLLOW_UP_RECOVERY.md) |
| Notifications client recovery | [Inbox and unread badge recovery](docs/NOTIFICATION_RECOVERY.md) |
| Worker operation and monitoring | [Operations](docs/OPERATIONS.md), [local scheduler](docs/LOCAL_SCHEDULER.md), [platform monitoring](docs/PLATFORM_MONITORING.md) |
| Privacy and retained-input verification | [Privacy impact](docs/PRIVACY_IMPACT.md), [privacy recovery](docs/PRIVACY_RECOVERY.md) |
| Release preparation and incident procedures | [Release checklist](docs/RELEASE_CHECKLIST.md), [release evidence](docs/RELEASE_EVIDENCE.md), [runbooks](docs/RUNBOOKS.md) |

Historical documents contain dated milestone snapshots. Use the product execution tracker and latest generated verification manifest for current implementation/evidence status.

## Contributing

Read the applicable `AGENTS.md` files and product plan before changing a workflow. Keep server rules, SQL and workers in `backend`; keep UI and thin Next.js route adapters in `frontend`.

Preserve verified identity, tenant scope, version checks, retry identity and atomic audit behavior. Add database changes as ordered numbered migrations and regenerate the fresh bundle. Verify meaningful permission/recovery behavior and the relevant package types/build. Record local, hosted and release evidence separately, and keep the application on port 4000.

Future work follows the plan: finish P8 acceptance and policy-dependent privacy work, then the controlled pilot, commercial readiness and later integrations. Billing, direct WhatsApp/email customer sending, Arabic UI, property inventory, calendars and advanced reporting are future scope.
