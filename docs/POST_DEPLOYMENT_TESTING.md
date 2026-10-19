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

Status before the recovery recorded below: **CONNECTED SIGN-IN BLOCKED BY AUTH_UNAVAILABLE (PD-03)**. The source maps retryable/malformed/upstream Auth failures to this safe 503; available evidence does not establish a specific cause. The user reports the Supabase project is Active; this is user-confirmed status, not an independent Auth health check. Do not replace the 503 with an invalid-credentials response to make the test pass.

19 October diagnostic continuation: offline checks of the two authorized local public configuration fields confirm one definition each, HTTPS base URL with expected hosted Supabase hostname format, publishable key format and no whitespace. These checks do not validate the key against its project or prove hosted runtime connectivity. All 13 focused backend/tests/auth-recovery.test.ts checks pass using actual installed SDK error classes; invalid credentials map to 401 while upstream/transport/malformed responses remain 503. No application code was changed.

The user then explicitly permitted read-only Auth health/settings checks on the configured project. Using only the public key, GET /auth/v1/health and GET /auth/v1/settings both returned HTTP 502 with JSON responses. One second health observation also returned 502, with Cloudflare server identification, an sb-request-id header and a message matching an upstream/gateway failure. No invalid-key, paused-project, DNS, TLS or access-denial text pattern was detected; that absence does not prove credentials or every network layer healthy. Bodies, keys, project reference and diagnostic header values were not printed or committed. The settings response could not establish current Auth signup/confirmation settings.

This independently reproduces unavailability before a login submission and is consistent with the deployed app's safe 503. It establishes a failing configured Auth gateway boundary, not the internal service/database cause or a global Supabase outage. The next remediation step is project Auth/service-log investigation by an authorized operator, followed by a healthy Auth read before resuming sign-in acceptance. No further repeated probes, login, account creation, SQL, service restart, redeploy or access-setting change occurred. The grant was limited to these Auth reads; other existing restrictions remain unchanged.

## Authorized service-log investigation (19 October 2026)

The user separately authorized reading the configured project's previous 15 minutes of Auth/gateway error logs. The connector was queried with explicit bounds **2026-10-19T09:46:20Z to 2026-10-19T10:01:20Z** (14:46:20–15:01:20 Asia/Karachi), without extending the window or accessing another project.

| Check | Actual result | Limit |
| --- | --- | --- |
| Auth/API gateway source counts | No rows for auth_logs or edge_logs | Absence in this connector/window is not proof of healthy Auth or absence of earlier errors. |
| Available source discovery | Only pgbouncer_logs, 120 entries | These are connection-pooler events, not 120 demonstrated errors. No event text or identifiers were returned. |
| Pooler attribute names | Runtime/sequence/host/project metadata keys only | Only key names/counts were selected, not their private values; they do not identify the cause. |
| Bounded error-category aggregate | Connector returned a backend error | No raw events were requested as fallback, and the failed query was not polled/retried. No error category was established. |
| Public service status | [Supabase Status](https://status.supabase.com/) reported fully operational at inspection | A global status page does not establish the configured project's health or exclude an unreported incident. |

**Outcome: root cause remains unconfirmed.** The preceding direct Auth 502 and deployed login 503 remain the actionable evidence; these log results neither resolve nor contradict them. The next required evidence is project-specific Auth/service health or an internal diagnostic from Supabase support. Do not infer an invalid key, database password/permission failure, stopped Auth process, connection exhaustion or a global outage from these results, and do not apply speculative SQL/credential/service changes.

Escalation evidence is already in this report: stable application origin, deployed revision/deployment ID, correlated Vercel request/time, two failing public Auth paths, safe upstream response classification and exact service-log window/results. An operator can supply the project reference and original Supabase request IDs privately through support. No support message was sent, no service was restarted, and no customer data, raw logs, tokens or keys were printed or committed. Application source and existing local verification evidence remain unchanged; hosted sign-in acceptance is still blocked.

## Recovery after the user's Healthy status screenshot (19 October 2026)

At approximately **10:16Z / 15:16 Asia/Karachi**, the user supplied a project-status screenshot showing all services, including Auth, Healthy. Visual project URL comparison matches the configured local public project URL; no URL/key change was needed. An initial comparison used a mistranscribed screenshot character and was discarded after viewing the original image; the corrected comparison matches.

| Boundary | New direct evidence | Result / limit |
| --- | --- | --- |
| Public Auth health | GET /auth/v1/health returns 200 with GoTrue identity | PASS for current availability, not a durability guarantee. |
| Public Auth settings | GET /auth/v1/settings returns 200, email enabled, mailer_autoconfirm false, disable_signup false | PASS for these public settings; email delivery is not tested. |
| Deployed app → Auth | Exactly one new synthetic nonexistent-account attempt at the stable application origin returns 401 AUTH_FAILED, retryable false | Expected invalid-credentials behavior; the previous 503 is no longer reproduced by this path. |
| Response → UI | Check your credentials and verify your email appears; controls become enabled again | Expected safe generic denial. Synthetic values were cleared; page reload returns to the signed-out Sign in with a verified email screen. |

Status at recovery: **PD-03 AVAILABILITY RECOVERED; REAL-ACCOUNT SIGN-IN USER-CONFIRMED.** The internal outage/recovery cause remains unknown. No agent restart, Auth setting change, migration, credential replacement, source fix or new deployment caused this observed recovery. Historical failures/log limits remain recorded above; no permanent resolution is claimed.

Screenshots are ignored local artifacts at backend/.cache/post-deployment/auth-recovered-invalid-credentials.jpg and auth-recovered-sign-in.jpg. The browser is left on the stable sign-in page for the user to authenticate using their existing verified account. No actual password/OTP was requested in chat, and no account was created, reset or signed in successfully by the agent. Authenticated membership/workspace loading, persistence and subsequent acceptance still require verification.

The user's later sample-dashboard screenshot came from the original immutable lead-pilot-i9e7g49gb-fazeeqa50-3737s-projects.vercel.app deployment, as confirmed by their exact address-bar URL. That deployment predates the three-variable setup and explicitly labels its records as sample data. The current fixed alias still renders sign-in while signed out; the sample screenshot does not demonstrate an authenticated-data bypass on the connected deployment. The user was directed to the fixed alias and then reported login works there.

At that point real-account login was user-confirmed and the agent's original test tab remained signed out in a separate browser session. The user was asked to authenticate directly for Dashboard/Leads read-only verification, without transferring cookies, tokens, passwords or OTPs. The subsequent authenticated verification is recorded below.

## Authenticated Dashboard and Leads smoke check (19 October 2026)

After the user reported in-app login complete, the browser inventory identified a new signed-in app tab separate from the original signed-out tab. Approximately **10:28–10:34Z / 15:28–15:34 Asia/Karachi**, the agent used that user-authenticated tab at the stable origin for the explicitly requested read-only checks. No credentials or session values were copied.

| Boundary / check | Direct observation | Result / limit |
| --- | --- | --- |
| Session survives page reload | Reload opens Connected agency workspace; GET /api/v1/me/memberships returns 200 with one OWNER membership, then Leads/Dashboard load | PASS for the current session. Password submission itself was performed by the user. |
| Authorized agency scope | Captured tenant headers for Leads, Dashboard and notification summary match the membership returned by the verified session | PASS for this selected agency. This is not a negative cross-agency/RLS isolation test. |
| Dashboard / data / rendering | Dashboard API 200; rendered total 1, qualified 0, due 1, won 0, unassigned 1; pipeline NEW 1 and other states 0 | PASS for current returned data/UI consistency, not independent recalculation of every database metric. Agency timezone is Asia/Dubai. |
| Dashboard drill-down | Total metric API 200 returns one projected item matching the inbox lead identity; Qualified metric API 200 renders No records match this metric | PASS for populated and confirmed-empty metric reads. |
| Leads inbox and search | GET /api/v1/leads returns 200 and one existing record. A synthetic unmatched search returns 200 and No leads match these filters | PASS; clearing search restores the record. No customer search term is recorded here. |
| Status filter | WON returns 200 with zero rows; restoring All statuses returns the original record | PASS; Active leads filter remains selected. |
| Lead details | Scoped detail, follow-up, activity, control-summary, assignment-directory and message reads return 200; Overview, Facts and Activity sections render | PASS for these reads and section navigation. No contact/fact/status/message/task was saved or edited. |
| Notification summary | Summary API returns 200 with unread count 2 | Incidental shell read only; opening notifications or changing read state was not tested. |
| Captured request/console samples | All collected app request samples use GET; collected app response samples are 200; no console error appears in the collected post-reload sample | The rolling final event capture reports truncation, so this is not an exhaustive whole-session network/console audit. Earlier incremental captures preserve the tested API results. |

Status at the read-only handoff: **AUTHENTICATED READ-ONLY SMOKE PASS FOR ONE OWNER AGENCY; NEW-WRITE PERSISTENCE PENDING APPROVAL.** This establishes a real cookie-authorized browser → API → saved data → rendered UI round-trip for the observed reads, rather than sample mode. The later approved fixture check is recorded below.

Local ignored proof artifacts: backend/.cache/post-deployment/connected-dashboard-verified.jpg and connected-leads-verified.jpg. Customer contact/record identifiers and raw authenticated payloads are omitted from committed reports. The sidebar follows the narrow browser viewport; complete responsive, keyboard and screen-reader acceptance was not performed.

At that handoff the Add a lead form was prepared but not submitted by the agent: Full name LeadPilot QA 2026-10-19, email leadpilot-qa-20261019@example.invalid, no phone, Manager queue, and inquiry Synthetic post-deployment persistence check. No outreach or AI processing requested. The form's assignment-choice read succeeded. Permission was requested for save → reload verification → archive of only this disposable fixture, with no existing lead edits, mail, AI or worker dispatch. The review screenshot is backend/.cache/post-deployment/persistence-test-prepared.jpg. No CRM write was performed in the read-only slice.

## Approved disposable-fixture persistence and archive (19 October 2026)

The user explicitly approved save → reload → archive of the prepared synthetic lead in the current agency. At the first observation after approval, the form was already closed and the exact fixture was visible in the active inbox. The creation POST/acknowledgement was not captured; the rolling event buffer was truncated. **The agent did not submit another create request or attribute creation to its own actions.** Subsequent checks used the same persisted fixture identity throughout.

| Check | Direct result | Evidence boundary |
| --- | --- | --- |
| Saved fixture after full page reload | Membership/lead reads 200; exactly one matching synthetic name/email record, NEW, version 1, plus the original active record | PASS for saved fixture persistence; initial create submission/acknowledgement remains unobserved. |
| Archive preflight | Scoped detail 200 matches the fixture ID/version 1; zero open follow-ups | The original lead was not selected for mutation. |
| Archive write | One captured POST /api/v1/leads/:fixture/archive returns 200; response targets the same fixture, affected_open_tasks 0 | Explicit user approval; reason Post-deployment QA persistence verified; archive approved disposable test lead. No retry or restore was performed. |
| Post-write read/UI | Detail 200 shows archived_at and version 2; UI shows Archived and Saved | PASS for acknowledged archive plus current read reconciliation. |
| Saved audit | Activity renders Lead created and one Lead archived entry with the submitted reason and zero tasks affected | PASS for visible archive audit; no exhaustive audit-history/rollback test is implied. |
| Active inbox | Automatic refresh after closing the detail removes the fixture; its synthetic search produces zero rows | PASS after the normal refresh settles. |
| Archived state after another full reload | Archived filter shows the same fixture ID at version 2; archived list reads 200 | PASS for archive persistence. Exactly one fixture occurrence per returned page. |
| Original record / final handoff | Original record remains active with its pre-test version unchanged; normal Active leads / All statuses / empty search restored | One original active record remains visible. No original-record mutation was performed. |

Status at fixture completion: **SAVED FIXTURE RELOAD AND ACKNOWLEDGED ARCHIVE PERSISTENCE PASS.** The bounded captured archive request/response sample is not truncated. Creation UI submission, edit/restore/replay/rollback/concurrent mutation paths and other fixtures remain unverified; this is not full mutation acceptance or a release sign-off. The fixture remains archived and recoverable, not permanently removed. No email, AI/provider request, worker dispatch, account/SQL/configuration/source change or redeploy was performed.

Local ignored proof artifacts: test-lead-persisted.jpg, test-lead-archive-audit.jpg, test-lead-absent-active.jpg and test-lead-archived-after-reload.jpg under backend/.cache/post-deployment/. Archive/audit UI time is 19 October 14:42 Asia/Dubai; final verification completed about 10:44Z / 15:44 Asia/Karachi. Committed evidence omits real customer contacts, row/actor identifiers, keys, tokens and raw authenticated payloads.

## Extended read-only module smoke (19 October 2026)

At the user's next-work instruction, continued in the same authenticated OWNER agency and stable deployment. Completed approximately **10:56Z / 15:56 Asia/Karachi**. No record, task, notification, invitation, factor, processing flag or limit was changed by the agent in this slice.

| Module / boundary | Actual API/UI evidence | Result / limit |
| --- | --- | --- |
| Follow-up queue | GET /api/v1/follow-ups 200; one OPEN task displayed as overdue in Asia/Dubai. COMPLETED filter returns 200 with No completed follow ups; OPEN restored | PASS for queue/filter reads. No completion, reschedule, cancellation or task creation was submitted. |
| Notifications | Inbox and summary reads 200; three notices, two unread, one outdated. Unread filter displays two; Dismissed returns 200 with No dismissed notifications; Inbox restored | PASS for these reads/counts. Outdated notice hides the sensitive resource preview. No Mark read, Dismiss or Open latest action was used. |
| CSV capture | GET /api/v1/imports 200; No saved imports yet; template and file chooser render | PASS for list/empty UI only. No file selected/uploaded or import prepared/processed. |
| Website integrations | Integration metadata and assignment-directory GETs 200; No website integrations yet | PASS for paired reads only. No signing credential was issued/revealed/rotated and no intake request was sent. |
| Settings bootstrap / Team | Team snapshot, member directory and invitation metadata GETs 200; one active OWNER, no invitations | PASS for current read rendering. No invitation, membership/ownership or profile change. |
| Profile / MFA inventory | GET /api/v1/me/mfa 200; existing authenticator shows Setup unfinished | Read passes; MFA enrollment/verification and recent-MFA protected writes remain pending. No factor was cleared/enrolled/verified by the agent. |
| Agency preferences | Asia/Dubai / English and onboarding render; processing approval false and agency AI false | Correct observed configuration; no processing approval or AI enablement was inferred. |
| Operations | GET /api/v1/agency/operations 200; zero reminders awaiting creation, one pending notification/invitation job, zero running/retained failures/expired leases; oldest pending 767 seconds at that snapshot; alert set empty | Read passes. One pending job and an empty below-threshold alert set do not establish healthy/deployed worker execution or delivery. No job was dispatched or retried. |
| Privacy | GET /api/v1/privacy 200; No privacy requests recorded; Execution is unavailable notice remains explicit | List/empty read passes. Request/review/MFA writes and anonymization/closure executor are not accepted by this check. |
| Pilot / AI usage | Usage GETs 200; one active seat, zero pending reservations; seat/daily AI/monthly AI limits null; usage/reconciliation counts zero | Read passes. Seat limit is needed before invitations; AI processing/limits/provider acceptance remain unconfigured. No arbitrary values were saved. |

**Current status: CONNECTED MODULE READ SMOKE PASS FOR THE OBSERVED OWNER; MFA/WORKER/INVITATION/PROVIDER AND BROADER ACCEPTANCE STILL PENDING.** No failing API response was observed in the tested reads. This does not convert unconfigured limits, an unfinished factor, pending outbox work or the explicitly unimplemented privacy executor into passing acceptance.

The next user action is to complete the existing authenticator setup directly under Settings → Profile → Account security, using their own authenticator app. If its QR was previously scanned, the user can enter their current code in the app; otherwise the UI offers clearing the unfinished setup and starting again. The browser is left on this form and the user was asked for completion status. No QR, secret or code is requested in chat; no other account credential or session setting is altered by the agent.

Ignored local proof artifacts under backend/.cache/post-deployment/: follow-up-queue-verified.jpg, notifications-empty-verified.jpg, operations-read-verified.jpg and authenticator-setup-pending.jpg. Reads do not verify actual invitation transport, import/intake correctness, deployed scheduler operation, multi-agency/role denial, mutation recovery, full responsive/a11y acceptance, backups or release readiness. Application source and the existing local verification manifest are unchanged.

Proof screenshots are saved locally under backend/.cache/post-deployment/: production-env-saved.jpg (masked settings), connected-sign-in.jpg and auth-unavailable.jpg (cleared form). They are ignored artifacts, not public configuration/credential exports.

Initial create submission/acknowledgement, other mutation/recovery paths, cross-agency/role isolation, hosted schema revision, callbacks/MFA, workers/providers and complete desktop/mobile/accessibility acceptance remain pending. Production checks remain unconfigured and protected development Preview remains disabled. The one-agency read-only and disposable archive checks do not establish those remaining results.

## Notification navigation and dialog keyboard finding (19 October 2026)

Continued the authorized read-only checks in the same signed-in OWNER session after the user asked to check further modules. MFA remains unfinished; no code, QR or secret was read, and no factor action was submitted.

| Check | Direct result | Boundary |
| --- | --- | --- |
| Already-read outdated notification → latest lead | GET notification open and current scoped lead/detail reads return 200; the current lead opens. The bounded captured open flow contains no non-GET request; unread count remains two | Used an already-read notice because opening an unread notice marks it read. No notification write was requested. |
| AI analysis | Analysis history GET 200, No analysis yet; Analyze inquiry disabled with configuration/approval/limit notice | Read rendering passes; no provider/generation request or AI quality acceptance. |
| Reply drafts | Draft history and agency feedback GETs 200; no drafts, zero feedback; Generate draft disabled | Read rendering passes; no generation, review, clipboard or external-message action. |
| Narrow dialog / keyboard sample | At 759×668, dialog fits the viewport with no dialog/content horizontal overflow; 12 successive Tab steps remain inside; Escape closes | Partial responsive/keyboard evidence only, not complete mobile/screen-reader/WCAG acceptance. |
| Escape destination | After notification navigation, rendered heading is Leads but URL remains view=Notifications; after Escape, focus is BODY | **PD-04: reproducible live navigation/focus defect.** Production acceptance for this path is open. |

Source correction on developement routes notification Lead and Team destinations through the existing workspace navigation handler, serializes current lead filters, and restores dialog focus to the current workspace when the original trigger has unmounted or cannot accept focus. Existing connected trigger restoration and busy/escape guards are preserved. Six focused focus-target regressions and the existing navigation/notification recovery checks pass together (26/26); these synthetic tests do not mount React or verify the corrected deployed callback. The Team destination correction is source-derived; no invitation/team notice was available for a live journey.

The first full local run passed 812 regressions and backend types, then failed on a pre-existing malformed generated Next dev validator. Only that ignored validator was quarantined. Official Next typegen initially failed from the repository cwd while resolving the relative backend config import, then succeeded from frontend; standalone frontend types passed. The final full verification result is recorded in LOCAL_CHECKS.json and RELEASE_EVIDENCE.md. No compiler exclusion or application configuration was weakened.

**PD-04 remains open on Production until the corrected candidate is deployed and this browser journey is repeated.** The live site still runs main 61f9fe8. The browser route was restored through the normal Leads navigation and left there for handoff. No localhost access workaround, CRM/account/notification write, SQL/configuration change, email, AI/provider call, worker dispatch or deployment occurred in this slice. P8 remains IN PROGRESS / NOT_READY.

Ignored local evidence: backend/.cache/post-deployment/notification-navigation-mismatch.jpg and a minimized matching JSON record of heading, view parameter, focus and viewport. No real contact, factor, row identifier, cookie or raw authenticated response is committed.

## Access handoff history

The initial in-app Vercel login was completed by the user. The connector's separate 403 alone does not establish which account/connection change would resolve API access. No secret, password, OTP or bypass token is requested in chat. Deployment Protection was preserved; browser authentication was sufficient to inspect the app and its non-secret deployment metadata.

The user completed hosting login, authorized the three-variable setup and Production redeployment, and separately authorized scoped Auth reads, error-log investigation, Dashboard/Leads reads and the named disposable fixture's save/reload/archive check. Further next-work instruction advanced the module reads above. The authenticated read flow and fixture's persisted/archived state are independently observed; the initial fixture create acknowledgement was not captured. The fixture stays archived; the browser is now on Leads after the additional navigation checks. The user's authenticator setup remains unfinished. Other existing restrictions and remaining acceptance boundaries are unchanged. Supabase log connector access succeeded; Vercel connector access remains independent of browser login and was not re-tested as if browser login granted API access.

## Functional checks queued after access

1. Application entry, console/request errors, desktop/mobile viewport and keyboard navigation.
2. Sign-in/session/callback and access denial while signed out. Account confirmation/MFA journeys require the designated test accounts.
3. Authorized dashboard, leads/search/filter/detail, follow-ups, notifications, Capture and Settings reads; empty/loading/error/retry states.
4. Synthetic test-lead creation and reload persistence, manual message/revision, assignment, follow-up schedule/reschedule/complete, archive/restore and audit consistency in the designated testing agency. Preserve unrelated existing records.
5. Two-agency OWNER/ADMIN/AGENT isolation, shared-user scope and access revocation with the required separate accounts/agency fixtures.
6. Separately approved invitation email, website intake, deployed scheduler/reminders and optional AI/provider checks. Merely opening a page does not authorize customer mail or paid provider work.
7. Record real outcomes against A01-A24, retain failures and recoveries, and keep privacy execution/backup/pilot/release gaps explicit.

No app form submission, CRM mutation, account creation, SQL change, Auth setting change, email, AI call, worker dispatch, deployment/promotion or customer-data inspection occurred in this initial check. Existing localhost/Supabase access restrictions remain unchanged. See RELEASE_CHECKLIST.md for acceptance boundaries and CI_CD.md for deployment configuration.
