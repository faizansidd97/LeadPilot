# LeadPilot frontend

Next.js UI and application host. Install the frontend and sibling backend workspace from this folder:

```sh
pnpm install
pnpm dev
```

Open http://localhost:4000. `pnpm build` produces the application and bundled backend handlers; `pnpm start` serves it on port 4000. `pnpm typecheck` checks both packages. `pnpm test` runs the backend suite.

Copy `.env.example` to `.env.local` to configure Supabase. Full setup is in `../docs/README.md`.

Business logic and database code belong to `../backend`. Files under `src/app/api` and `src/app/auth/callback` only expose backend handlers through Next.js routing. Shared validation schemas are imported from the backend package.

P6 adds the Reply drafts tab: current-version review, retained edits/conflicts, approval/rejection, clipboard completion receipts, actual external-message logging and immutable feedback. AI remains disabled until approved configuration; preview fabricates no replies. See ../docs/REPLY_DRAFTS.md. P7 is now locally complete; next local milestone is P8 hardening.

P7 adds authorized database-wide dashboard counts, matching paginated lists, agency calendar/outcome/task/queue definitions and a labelled first user-logged contact sample. It also adds safe shareable filters, responsive navigation/form improvements, source Button/Dialog primitives, React Hook Form dates and manager Integration settings. Evidence: 330/330 tests, both package type checks and production build. See ../docs/DASHBOARD.md. Hosted/browser/WCAG/concurrent performance and release acceptance remain pending. Next: P8 hardening.
