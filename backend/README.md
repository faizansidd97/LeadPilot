# LeadPilot backend

Server handlers, authenticated Supabase clients, validation/domain rules, database migrations and backend tests live here.

The backend runs inside Next.js through thin route adapters in `../frontend/src/app`. It shares the frontend origin on port 4000; no second server or CORS boundary is introduced.

Install both packages from `../frontend` with `pnpm install`. Run `pnpm test` and `pnpm typecheck` here. Apply `supabase/migrations/*.sql` in filename order to a development Supabase project.

Environment configuration belongs to the Next.js host at `../frontend/.env.local`. Shared browser-safe schemas are exported under `@leadpilot/backend/domain/*`; server modules remain behind `server-only`.

API contracts and setup are documented in `../docs/API.md` and `../docs/README.md`.

Supabase setup helpers: `pnpm setup:supabase` prepares `supabase/setup.sql` and creates `../frontend/.env.local` only when missing. `pnpm check:supabase` validates configuration without exposing values or connecting remotely. See `../docs/SUPABASE_SETUP.md` for hosted setup.

P2 adds team/profile/settings/MFA handlers, hashed single-use invitations, configured seats, safe membership transfer/deactivation, recent-MFA owner transfer and private outbox. setup:supabase generates a missing server-only invitation secret while preserving other environment values. See ../docs/TEAM_ADMINISTRATION.md for optional mail adapter contract, upgrade and acceptance limitations.

P3 adds recipient notification handlers, private durable outbox leases/fencing/retries, due catch-up and lag metrics, queued invitation mail and shared HTTP/direct-write policy. Protected worker clients are separate from cookie user clients. Run check:workers for local configuration validation; see ../docs/OPERATIONS.md for narrow RPCs, scheduler/adapter contracts and release gates. No hosted scheduler is provisioned by development scripts.

P4 adds capture contracts/CSV parsing, confirmed facts, scope-safe duplicates, manual message revision history, private resumable imports, encrypted website integrations and separately signed intake. Narrow service-role intake RPCs are separate from user clients. Migration sources 008–010 and ../docs/CAPTURE.md define configuration, replay/recovery and release gates. check:intake is local-only; setup:supabase prepares a missing encryption key without exposing it.

P5 adds private analysis snapshots, atomic daily/monthly operation reservations, fenced Responses workers, evidence/score validation, stale history and AI analysis/owner usage UI. See ../docs/AI_ANALYSIS.md and AI_EVALUATION.md. Run backend evaluate:analysis for the 100 synthetic contract report. Provider configuration/approvals and hosted acceptance remain pending. P6 is locally complete; P7 dashboard/product UX is now locally complete; next milestone is P8 hardening.

P6 adds human-reviewed replies, original/working text, edit/context review invalidation, unsafe withholding, successful-copy receipts, explicit actual external-message logging and separate immutable feedback. Evidence: 312/312 tests, both package type checks, production build and 56 constructed outline contracts. See ../docs/REPLY_DRAFTS.md and ../docs/REPLY_EVALUATION.md; run backend evaluate:drafts. AI_DRAFTS_ENABLED defaults false. Live usefulness, hosted/browser and release evidence remain pending. Next: P7.

P7 adds authorized database-wide dashboard counts, matching paginated lists, agency calendar/outcome/task/queue definitions and a labelled first user-logged contact sample. It also adds safe shareable filters, responsive navigation/form improvements, source Button/Dialog primitives, React Hook Form dates and manager Integration settings. Evidence: 330/330 tests, both package type checks and production build. See ../docs/DASHBOARD.md. Hosted/browser/WCAG/concurrent performance and release acceptance remain pending. Next: P8 hardening.
