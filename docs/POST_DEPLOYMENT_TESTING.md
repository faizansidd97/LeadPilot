# Post-deployment testing

Started 19 October 2026 at the user's request, specifically for the supplied deployment:

`https://lead-pilot-i9e7g49gb-fazeeqa50-3737s-projects.vercel.app/`

Story: open the deployed application, sign in, load the authorized agency through the API, and verify that records/actions render and persist with the correct access boundaries. This report records actual observations; the application journey has not yet passed.

## Initial evidence

| Check | Result | Observed evidence and limit |
| --- | --- | --- |
| Development CI | PASS | GitHub Actions run [39225348937](https://github.com/faizansidd97/LeadPilot/actions/runs/39225348937), revision `53bd8751420d20ecd288822bf0df02a37ebd196f`, completed successfully. These are isolated synthetic/compiler checks, not live application acceptance. |
| Vercel completion signal | OBSERVED | The GitHub Vercel status on main revision `61f9fe870cfafe064d48d86241ad6c25209ab8d3` is success, description `Deployment has completed`, with [deployment dashboard 6Vw5UHMqjvbqhqUhFkAmCLYEiJVd](https://vercel.com/fazeeqa50-3737s-projects/lead-pilot/6Vw5UHMqjvbqhqUhFkAmCLYEiJVd). This matches the dashboard visible beside the supplied app tab; deployed revision has not been independently verified through Vercel's deployment API. |
| Test-browser access | BLOCKED | Opening the exact supplied URL in the in-app browser redirects to Vercel's login page before LeadPilot is visible. Deployment Protection is an access boundary, not evidence of an application defect. No protection setting was weakened. |
| Existing Chrome session | UNAVAILABLE | Two attempts to bind the existing app tab timed out while establishing browser control. An independent in-app tab reached the Vercel login boundary. No cookies or credentials were copied between browsers. |
| Authorized deployment metadata | BLOCKED | Vercel deployment API returned HTTP 403 for team `fazeeqa50-3737s-projects`. The authorized protected-URL fetch also returned 403 at `read_protection_bypass`; no alternate account or access rule was used. No authenticated local Vercel CLI was available as a fallback. |
| Pipeline target consistency | OPEN FINDING | The supplied deployment/dashboard identifies project `lead-pilot`. The development workflow currently binds the previously discovered `leadpilot` project ID `prj_uPXy3tjLwI2dGfXDM42lmffPLe8K`. Confirm the intended project's ID/branch/environment before activating Preview deployment; a similarly named project must not be treated as the same target. No binding was changed without verified metadata. |

Status: **APPLICATION TESTING BLOCKED AT HOSTING AUTHENTICATION**. Application rendering, account login, connected API/data, schema revision, worker scheduling, provider transport and browser acceptance remain unverified. A Vercel completion status or green CI cannot establish those outcomes.

## Access needed to continue

The in-app Vercel login tab is left available for the user to complete authentication. Alternatively, update the Vercel connector's access to the intended project/team, then confirm it can retrieve this deployment. The connector's error alone does not establish which account/connection change will resolve access. No secret, password, OTP or bypass token is requested in chat. Do not disable Deployment Protection to make this check pass.

After access is available, first confirm the exact deployed revision, project ID, target environment and testing database. Resolve the pipeline target finding before enabling deployment automation.

## Functional checks queued after access

1. Application entry, console/request errors, desktop/mobile viewport and keyboard navigation.
2. Sign-in/session/callback and access denial while signed out. Account confirmation/MFA journeys require the designated test accounts.
3. Authorized dashboard, leads/search/filter/detail, follow-ups, notifications, Capture and Settings reads; empty/loading/error/retry states.
4. Synthetic test-lead creation and reload persistence, manual message/revision, assignment, follow-up schedule/reschedule/complete, archive/restore and audit consistency in the designated testing agency. Preserve unrelated existing records.
5. Two-agency OWNER/ADMIN/AGENT isolation, shared-user scope and access revocation with the required separate accounts/agency fixtures.
6. Separately approved invitation email, website intake, deployed scheduler/reminders and optional AI/provider checks. Merely opening a page does not authorize customer mail or paid provider work.
7. Record real outcomes against A01-A24, retain failures and recoveries, and keep privacy execution/backup/pilot/release gaps explicit.

No app form submission, CRM mutation, account creation, SQL change, Auth setting change, email, AI call, worker dispatch, deployment/promotion or customer-data inspection occurred in this initial check. Existing localhost/Supabase access restrictions remain unchanged. See RELEASE_CHECKLIST.md for acceptance boundaries and CI_CD.md for deployment configuration.
