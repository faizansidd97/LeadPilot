# Post-deployment testing

Started 19 October 2026 at the user's request, specifically for the supplied deployment:

`https://lead-pilot-i9e7g49gb-fazeeqa50-3737s-projects.vercel.app/`

Story: open the deployed application, sign in, load the authorized agency through the API, and verify that records/actions render and persist with the correct access boundaries. This report records actual observations; the application journey has not yet passed.

## Initial evidence (before the user's Vercel login)

| Check | Result | Observed evidence and limit |
| --- | --- | --- |
| Development CI | PASS | GitHub Actions run [39225348937](https://github.com/faizansidd97/LeadPilot/actions/runs/39225348937), revision `53bd8751420d20ecd288822bf0df02a37ebd196f`, completed successfully. These are isolated synthetic/compiler checks, not live application acceptance. |
| Vercel completion signal | OBSERVED | The GitHub Vercel status on main revision `61f9fe870cfafe064d48d86241ad6c25209ab8d3` is success, description `Deployment has completed`, with [deployment dashboard 6Vw5UHMqjvbqhqUhFkAmCLYEiJVd](https://vercel.com/fazeeqa50-3737s-projects/lead-pilot/6Vw5UHMqjvbqhqUhFkAmCLYEiJVd). This matches the dashboard visible beside the supplied app tab; deployed revision has not been independently verified through Vercel's deployment API. |
| Test-browser access | BLOCKED | Opening the exact supplied URL in the in-app browser redirects to Vercel's login page before LeadPilot is visible. Deployment Protection is an access boundary, not evidence of an application defect. No protection setting was weakened. |
| Existing Chrome session | UNAVAILABLE | Two attempts to bind the existing app tab timed out while establishing browser control. An independent in-app tab reached the Vercel login boundary. No cookies or credentials were copied between browsers. |
| Authorized deployment metadata | BLOCKED | Vercel deployment API returned HTTP 403 for team `fazeeqa50-3737s-projects`. The authorized protected-URL fetch also returned 403 at `read_protection_bypass`; no alternate account or access rule was used. No authenticated local Vercel CLI was available as a fallback. |
| Pipeline target consistency | OPEN FINDING | The supplied deployment/dashboard identifies project `lead-pilot`. The development workflow currently binds the previously discovered `leadpilot` project ID `prj_uPXy3tjLwI2dGfXDM42lmffPLe8K`. Confirm the intended project's ID/branch/environment before activating Preview deployment; a similarly named project must not be treated as the same target. No binding was changed without verified metadata. |

The initial hosting-authentication blocker was resolved when the user completed Vercel login in the testing browser. The current blocker is described below; the initial observations are preserved as history.

## Continuation after the user's login (19 October 2026)

| Check | Result | Direct browser evidence |
| --- | --- | --- |
| Hosting access | PASS | The exact supplied deployment now opens LeadPilot in the in-app browser using the user's existing Vercel authentication. No protection setting was disabled. |
| Deployed revision and target | VERIFIED | Vercel Deployment Details shows Ready, Production, main revision `61f9fe870cfafe064d48d86241ad6c25209ab8d3`, and fixed domain `https://lead-pilot-five.vercel.app`. This is the deployment supplied by the user, not the newer developement branch. |
| Build settings | VERIFIED | Authenticated settings show Next.js, frontend root, outside-root source inclusion enabled, Node 24.x and install command `npx --yes pnpm@11.25.0 install --frozen-lockfile`. No build setting was changed. |
| Application entry | SAMPLE UI ONLY | The rendered banner states `Sample data preview · Changes last for this session. Authentication and database are not connected.` The displayed agency/records are sample fixtures, not proof of connected Auth or persisted CRM data. |
| Connected configuration | BLOCKER PD-01 | The project's Environment Variables tab, with all types/environments selected, displays only `ENABLE_EXPERIMENTAL_COREPACK` for Production and Preview. No Supabase URL/publishable-key entries are visible. Repository Page selects the sample Workspace when either NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is absent; therefore backend-connected acceptance cannot begin. Values were not revealed or copied. |
| Pipeline target | CORRECTED IN REPO PD-02 | Authenticated General settings verifies `lead-pilot` ID `prj_OgmYOFAbzoZgKirrCG5ASEE9974N`. The workflow and CI guide now bind this project instead of the earlier similarly named project. Preview activation remains disabled pending protected setup; this correction does not redeploy Production. |
| Production checks | NOT CONFIGURED | Vercel Build and Deployment shows `No checks configured`. The development workflow does not gate native main production deployments; release checks/review remain a separate outstanding configuration. |

Current status: **APPLICATION TESTING BLOCKED AT CONNECTED CONFIGURATION**. Hosting access and sample rendering are verified. Application login, authenticated API/data round-trips, persistence, tenant isolation, schema revision, workers/providers and complete desktop/mobile/accessibility acceptance are still untested. Do not record sample UI interactions as backend acceptance.

Immediate remediation: configure the corresponding Supabase URL/publishable key and APP_URL in this project's **Production** environment, then create a new deployment with those values. Use the observed fixed origin `https://lead-pilot-five.vercel.app` for APP_URL and subsequent connected tests; mutations compare Origin to APP_URL, so the old per-deployment hostname is not interchangeable. Configure the matching Auth callback allowlist before callback/email verification. Existing deployments retain their old configuration; verify the replacement deployment and revision before resuming tests. Separate invitation/intake/worker secrets are required before those respective feature tests. No .env.local values were read or transferred by this testing pass.

## Access handoff history

The initial in-app Vercel login was completed by the user. The connector's separate 403 alone does not establish which account/connection change would resolve API access. No secret, password, OTP or bypass token is requested in chat. Deployment Protection was preserved; browser authentication was sufficient to inspect the app and its non-secret deployment metadata.

The user has now completed hosting login and project/revision/environment metadata is verified above. The next needed input is connected configuration for the intended testing database. Connector API access remains independent of the browser login and was not re-tested as if browser login granted API access.

## Functional checks queued after access

1. Application entry, console/request errors, desktop/mobile viewport and keyboard navigation.
2. Sign-in/session/callback and access denial while signed out. Account confirmation/MFA journeys require the designated test accounts.
3. Authorized dashboard, leads/search/filter/detail, follow-ups, notifications, Capture and Settings reads; empty/loading/error/retry states.
4. Synthetic test-lead creation and reload persistence, manual message/revision, assignment, follow-up schedule/reschedule/complete, archive/restore and audit consistency in the designated testing agency. Preserve unrelated existing records.
5. Two-agency OWNER/ADMIN/AGENT isolation, shared-user scope and access revocation with the required separate accounts/agency fixtures.
6. Separately approved invitation email, website intake, deployed scheduler/reminders and optional AI/provider checks. Merely opening a page does not authorize customer mail or paid provider work.
7. Record real outcomes against A01-A24, retain failures and recoveries, and keep privacy execution/backup/pilot/release gaps explicit.

No app form submission, CRM mutation, account creation, SQL change, Auth setting change, email, AI call, worker dispatch, deployment/promotion or customer-data inspection occurred in this initial check. Existing localhost/Supabase access restrictions remain unchanged. See RELEASE_CHECKLIST.md for acceptance boundaries and CI_CD.md for deployment configuration.
