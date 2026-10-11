# Settings recovery

P8 twenty-eighth local slice, 11 October 2026. Profile, team, invitations, agency/pilot preferences and ownership transfer now share a scoped Settings workflow. Existing verified cookie identity, manager hierarchy, recent MFA, SQL actor/tenant/payload replay and atomic audit remain authoritative. Schema stays 001–023; no new key or migration is required.

## Current reads and retained forms

Settings publishes a complete projected agency/membership/member/invitation snapshot only after all required reads validate. Snapshot binds agency and the first current membership ID, preserves current role boundaries and separates owner-only pilot counts and manager onboarding. Changed accounts or unrelated roles clear private state and require reopening the workspace. A verified ownership-transfer acknowledgement permits its expected OWNER to ADMIN transition; it does not preserve owner privileges.

Members/invitations use bounded 25-row ascending full-precision timestamp/UUID pages, unique IDs and final-row cursor binding. Continuation rechecks current membership/role and rejects overlapping, unordered or malformed rows. Agent pages contain only the current member and no invitation page; admin invitation pages contain agents only. Metadata does not independently prove each row's tenant or email verification; current SQL authority governs these. Multiple reads are not a frozen snapshot or an atomic cross-tab cookie lock.

Unavailable differs from confirmed empty. Partial snapshots are never published. Temporary failures hide unverified metadata/links and leave original profile, agency, pilot, member-action and invitation inputs mounted and inert. Manual refresh/recovery restores current access. Initial unavailable/loading states are explicit. Settings tabs, member editor and parent refresh use synchronous gates while saves or recovery are pending. Website integration work also locks its Settings parent navigation; the parent's fieldset does not disable the child's recovery button. Root navigation/unmount still discards mounted state.

## Recovering the original save

Inputs are parsed against existing backend contracts. Current versions, permitted role hierarchy, active replacement/ownership choices and owner-only pilot fields are checked before dispatch; SQL independently rechecks them. Original serialized payload, path/method and random key are captured before awaiting. Lost or malformed acknowledgements retain only that attempt; recovery cannot capture edited fields or silently create a new operation. Invalid/conflict results release the attempted write and require current read recovery before another save.

Validated profile/agency/member/invitation/ownership receipts bind their operation's identity and expected result. Acknowledged saves enter read recovery. Refresh failure never repeats profile update, settings change, invitation creation/resend/revoke, member deactivation/work transfer or ownership transfer. Snapshots behind acknowledged profile/agency versions cannot complete recovery. Current snapshots can reflect later authorized changes; the success notice explicitly reports saved work plus current settings reload.

RECENT_MFA_REQUIRED retains the original pending write and exposes the existing authenticator component outside inert fields. After verification, explicit recovery retries the same operation/key. This is not a substitute for real signed hosted MFA claims. Form reset/editor close/context-refresh callbacks run only after complete current recovery and after the synchronous gate releases. Current 401/403/404 other than the specific MFA requirement clears pending work, metadata, private links and callbacks. Late ignored-abort writes/reads cannot affect a new or unmounted scope.

## Invitation receipts and clipboard

Private link receipts require the expected tenant, normalized invitation email/role/version/state and an exact same-origin /join URL with only a 64-character token fragment and known transport state. The route's APP_URL must match the visible application origin; mismatched configuration fails safely. Extra response properties are discarded. Fresh matching PENDING invitation metadata and unexpired validity are required before showing the link. Consumed/revoked/superseded/expired/missing receipts are discarded. Metadata remains valid only at its read time; server acceptance still checks current expiry, inviter authority, matching identity and state.

Because invitation history is ascending, a new invitation can be beyond the first page. Receipt reconciliation follows validated invitation pages until the target is found or history ends, at most 100 pages/2,500 rows. Exceeding that defensive client bound fails read recovery without another save or private disclosure. Large historical fleets need a targeted server read design before claiming large-scale performance.

Hide link permanently clears the mounted holder; list refresh cannot reconstruct it. Copy first reloads current metadata and rechecks that the same receipt remains valid, then calls clipboard once. Same-frame copies are gated; scope/unmount fences completion notices. An already invoked OS clipboard write cannot be undone or cancelled by a later scope change; no automatic copy retry or send occurs. No link/token/key/customer form text is persisted in browser storage.

## Local evidence and remaining acceptance

Twenty-three new actual-helper checks cover projected scoped snapshots, exact links, role/identity changes, ascending precision/cursors, atomic partial failures, original saves, read-only acknowledged profile/agency/member/resend/revoke recovery, recent-MFA ownership recovery, private receipt reconciliation beyond page one, invalidation/hide/copy gating, pagination, malformed receipts, denial and unmount callbacks.

Two fixtures apply actual migrations 001–023 under emulated Auth. One commits profile/agency/invitation/member deactivation changes, loses each acknowledgement and replays the original key, proving four durable request receipts and current foreign/revoked access denial. The other forces ownership audit failure with unchanged owner/version/receipt state, then exercises uncertain owner transfer and original replay after demotion with exactly one owner and one transfer event. Transport responses use SQL JSON to retain timestamps/count types. These fixtures do not exercise Next HTTP, live cookie/Auth, real mail/link acceptance, workload concurrency or clipboard.

Focused Settings plus shared client checks pass 36/36. An initial fixture counted the wrong invitation operation prefix; assertion typing was also corrected before passing checks. Generated LOCAL_CHECKS.json and RELEASE_EVIDENCE.md record the final complete verification and source fingerprint.

Mounted React form retention, fieldset/child/MFA behavior, keyboard/focus/mobile/screen-reader, real signed MFA, cross-tab sessions, concurrent reads and large-history latency remain acceptance work. No live browser/HTTP/hosted API/provider/mail/worker/configuration/key/schema/ownership/deployment action occurred. Local development stays localhost:4000. Hosted multi-agency/browser acceptance remains deferred. P8 remains IN PROGRESS; P9 depends on release, partners and real pilot evidence.

Full local verification: 782/782 regression tests, both package type checks, 100 analysis/56 draft constructed contracts and production build passed. The generated LOCAL_CHECKS.json identifies the verified source; this is local emulated evidence, not hosted or browser acceptance.
