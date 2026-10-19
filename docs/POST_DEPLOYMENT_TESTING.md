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

Status at this point: **BLOCKED AT CONNECTED CONFIGURATION**. PD-01 was subsequently resolved by the explicitly authorized setup below. Sample UI interactions are not backend acceptance.

The requested remediation was to configure the corresponding Supabase URL/publishable key and APP_URL for **Production**, then create a replacement deployment. The initial inspection did not read or transfer .env.local values; the later user grant and completed setup are recorded below. Use the fixed origin `https://lead-pilot-five.vercel.app` for APP_URL and subsequent connected tests; mutations compare Origin to APP_URL, so per-deployment hostnames are not interchangeable. Auth callback allowlist verification and separate invitation/intake/worker configuration remain prerequisites for their respective tests.

## Authorized Production setup and connected checks (19 October 2026)

The user explicitly requested setup from existing local configuration in response to the three-variable Production setup/redeploy question. Only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY were copied from local configuration, plus APP_URL set to the verified fixed origin. The URL/key were validated for public client use; no service-role, invitation, encryption, worker or AI secret was transferred. A filtered ignored temporary import file was removed after saving. Existing localhost/Supabase access restrictions remain unchanged.

| Check | Result | Evidence |
| --- | --- | --- |
| Production configuration / PD-01 | RESOLVED | Vercel's masked Environment Variables list and save confirmation show all three entries scoped to Production. The existing Corepack entry remains. |
| Replacement deployment | PASS | One uncached Production redeploy completed Ready at 14:08 GMT+5: [ZcN65wRrqPNMU7GLnAUpuTasGbas](https://vercel.com/fazeeqa50-3737s-projects/lead-pilot/ZcN65wRrqPNMU7GLnAUpuTasGbas), deployment ID dpl_ZcN65wRrqPNMU7GLnAUpuTasGbas, unique hostname lead-pilot-qwr6luh3r-fazeeqa50-3737s-projects.vercel.app, unchanged main revision 61f9fe870cfafe064d48d86241ad6c25209ab8d3. No development-branch promotion was performed. |
| Connected entry | PASS | [Stable application](https://lead-pilot-five.vercel.app/) returns HTTP 200 and renders Welcome to LeadPilot with Email/Password, Sign in, Create account and Reset password. The sample workspace is no longer rendered. This verifies configuration selection, not upstream Auth/database health. |
| Signed-out membership gate | OBSERVED PASS | GET /api/v1/me/memberships returns 401 while signed out. This alone does not verify authenticated roles or RLS. |
| Empty sign-in | PASS | Native required-field feedback appears on Email and the captured network events contain zero POST requests. |
| Synthetic invalid sign-in / PD-03 | BLOCKER | Exactly one synthetic nonexistent-account attempt returns POST /api/v1/auth/sign-in HTTP 503, code AUTH_UNAVAILABLE, retryable true, Cache-Control private, no-store. Expected healthy invalid-credential behavior is HTTP 401 AUTH_FAILED. No actual user credentials or account creation were used. |
| Error/recovery UI | PASS FOR OBSERVED FAILURE | Safe Authentication service is temporarily unavailable message appears, the form becomes enabled again and input is retained. Synthetic values were cleared after observation. No repeated login, reset or signup request was sent. |
| Runtime correlation | VERIFIED | Vercel logs confirm the same POST 503 at 2026-10-19T09:09:30.938Z, request bz22z-1792400970938-30861ef8dbca, on the replacement deployment. Firewall allowed the request; the selected log has no upstream error detail. |

Current status: **CONNECTED SIGN-IN BLOCKED BY AUTH_UNAVAILABLE (PD-03)**. The source maps retryable/malformed/upstream Auth failures to this safe 503; available evidence does not establish a specific cause. The user reports the Supabase project is Active; this is user-confirmed status, not an independent Auth health check. Do not replace the 503 with an invalid-credentials response to make the test pass.

19 October diagnostic continuation: offline checks of the two authorized local public configuration fields confirm one definition each, HTTPS base URL with expected hosted Supabase hostname format, publishable key format and no whitespace. These checks do not validate the key against its project or prove hosted runtime connectivity. All 13 focused backend/tests/auth-recovery.test.ts checks pass using actual installed SDK error classes; invalid credentials map to 401 while upstream/transport/malformed responses remain 503. No application code was changed.

The user then explicitly permitted read-only Auth health/settings checks on the configured project. Using only the public key, GET /auth/v1/health and GET /auth/v1/settings both returned HTTP 502 with JSON responses. One second health observation also returned 502, with Cloudflare server identification, an sb-request-id header and a message matching an upstream/gateway failure. No invalid-key, paused-project, DNS, TLS or access-denial text pattern was detected; that absence does not prove credentials or every network layer healthy. Bodies, keys, project reference and diagnostic header values were not printed or committed. The settings response could not establish current Auth signup/confirmation settings.

This independently reproduces unavailability before a login submission and is consistent with the deployed app's safe 503. It establishes a failing configured Auth gateway boundary, not the internal service/database cause or a global Supabase outage. The next remediation step is project Auth/service-log investigation by an authorized operator, followed by a healthy Auth read before resuming sign-in acceptance. No further repeated probes, login, account creation, SQL, service restart, redeploy or access-setting change occurred. The grant was limited to these Auth reads; other existing restrictions remain unchanged.

Proof screenshots are saved locally under backend/.cache/post-deployment/: production-env-saved.jpg (masked settings), connected-sign-in.jpg and auth-unavailable.jpg (cleared form). They are ignored artifacts, not public configuration/credential exports.

Successful sign-in, authenticated API/data round-trips, persistence, tenant isolation, schema revision, callbacks/MFA, workers/providers and complete desktop/mobile/accessibility acceptance remain pending. Production checks remain unconfigured and protected development Preview remains disabled. A Ready deployment and green local CI do not establish those acceptance results.

## Access handoff history

The initial in-app Vercel login was completed by the user. The connector's separate 403 alone does not establish which account/connection change would resolve API access. No secret, password, OTP or bypass token is requested in chat. Deployment Protection was preserved; browser authentication was sufficient to inspect the app and its non-secret deployment metadata.

The user completed hosting login, authorized the three-variable setup and Production redeployment, reports the Supabase project is Active, and separately authorized scoped direct Auth reads. Those reads reproduce HTTP 502; project Auth/service logs remain needed to determine the internal cause. Connector API access remains independent of browser login and was not re-tested as if browser login granted API access.

## Functional checks queued after access

1. Application entry, console/request errors, desktop/mobile viewport and keyboard navigation.
2. Sign-in/session/callback and access denial while signed out. Account confirmation/MFA journeys require the designated test accounts.
3. Authorized dashboard, leads/search/filter/detail, follow-ups, notifications, Capture and Settings reads; empty/loading/error/retry states.
4. Synthetic test-lead creation and reload persistence, manual message/revision, assignment, follow-up schedule/reschedule/complete, archive/restore and audit consistency in the designated testing agency. Preserve unrelated existing records.
5. Two-agency OWNER/ADMIN/AGENT isolation, shared-user scope and access revocation with the required separate accounts/agency fixtures.
6. Separately approved invitation email, website intake, deployed scheduler/reminders and optional AI/provider checks. Merely opening a page does not authorize customer mail or paid provider work.
7. Record real outcomes against A01-A24, retain failures and recoveries, and keep privacy execution/backup/pilot/release gaps explicit.

No app form submission, CRM mutation, account creation, SQL change, Auth setting change, email, AI call, worker dispatch, deployment/promotion or customer-data inspection occurred in this initial check. Existing localhost/Supabase access restrictions remain unchanged. See RELEASE_CHECKLIST.md for acceptance boundaries and CI_CD.md for deployment configuration.
