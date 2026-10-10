# Team and agency administration: P2

Local implementation only; hosted Auth, MFA, email, remote deployment, concurrency/load and interactive browser acceptance remain pending. Development origin is http://localhost:4000. The root remains docs, frontend and backend.

## Setup and operation

Fresh development projects apply backend/supabase/setup.sql once. It combines migrations 001–010 in one transaction and refuses existing business tables. Existing projects apply only missing numbered migrations in order; a project through 005 needs 202610060006_team.sql followed by 202610060007_notifications.sql. It replaces seven existing writer RPCs to coordinate their locks with offboarding. Back up a populated environment before a separately approved deployment. No remote changes were performed here.

Run backend's setup:supabase with Node >=22.18. It preserves existing environment values, generates a server-only INVITATION_TOKEN_SECRET when absent and rebuilds setup.sql. Keep the legacy secret and named key values immutable across application instances and deployments; never use a NEXT_PUBLIC name or disclose them. P8 migration 016 adds INVITATION_TOKEN_KEYS and a versioned signing policy. New invitations select the active key; historical retries/mail jobs select their recorded key. Existing hashed links stay valid subject to current authority/state/email/MFA. See INVITATION_KEY_ROTATION.md for explicit operator plan/activate/verify and retained-key/backup limits.

In a connected workspace, the owner opens Settings → Pilot and records the agreed seat/AI limits. Blank means unconfigured, not unlimited. Invites/reactivation require a seat limit. All active memberships, including the owner, plus unexpired pending invites count as seats. Expiry releases a reservation through the query predicate without waiting for a cleanup job. Pilot limits are only visible/editable to the owner; regular agency columns cannot reveal them through direct reads.

Profile editing changes only the current user's agency display name with expected_version. Team directory returns same-agency metadata to managers and only self to an agent; lists use ascending created_at/id cursor pages (25 by default, 100 maximum). Disabled members remain in the manager directory with stable IDs. Settings uses fresh server role metadata. Agency timezone, English locale, processing reference and AI consent are versioned manager settings. Enabling the preference requires approval and a configured AI cap; generation and atomic AI usage enforcement arrive in P5. Manual CRM stays available.

## Invitations and delivery

OWNER can invite ADMIN/AGENT; ADMIN can invite AGENT. Verified email is normalized and must match the invitation. Acceptance does not require a caller-selected tenant: the database derives it from the hashed token after verified identity. Tokens are single use, expire after 72 hours and are rotated on resend. Revocation/expiry/previous resend links cannot be accepted. Existing same-agency memberships are managed rather than duplicated, including disabled memberships.

Tokens are 256-bit HMAC outputs scoped to agency, actor, operation and a random UUID request key, using a randomly generated server secret. This allows safe regeneration for a retry without storing raw bearer tokens. The database stores only SHA-256(token); audit, outbox and stored replay receipts never contain raw tokens. SQL receives the hash, not the URL. Replay verifies the current invitation hash/state/access; an old create/resend key cannot reproduce an obsolete link. Keep API response bodies out of transport/access logs.

The acceptance URL uses /join#token=... so the bearer token is absent from server paths and referrers. The client removes the fragment from address history after reading it into memory. Reloading that page requires reopening the original private link. New accounts verify email with the existing Auth callback, then reopen the original invitation link to sign in and accept. An accepted account opens the normal workspace. An ADMIN invitation also requires authenticator verification before acceptance.

Without an approved mail adapter the API returns LINK_ONLY and the UI offers a private copy link. It does not claim email was sent. Raw links are shown in the mutation receipt only, never fetched from invitation history. Resend creates a new link; old links stop working. Configured transport failures return EMAIL_FAILED while keeping the invitation/link available. EMAIL_ACCEPTED means HTTP acceptance by the adapter, not recipient delivery.

Optional server-only configuration:

```
INVITATION_MAIL_URL=https://your-approved-adapter.example/invitations
INVITATION_MAIL_TOKEN=<private adapter credential>
```

The custom adapter must accept POST JSON `{to,subject,text,idempotency_key}` with Authorization: Bearer and Idempotency-Key headers. It must durably deduplicate the same key. HTTPS is required, redirects are refused and timeout is ten seconds. Text contains the private join URL; approve the transport and its logs before use. No specific vendor integration or live delivery is claimed. P3 now enqueues mail atomically with the invitation. Configured receipts report EMAIL_QUEUED, and the worker submits with invitation-mail:<job-id> for durable adapter deduplication. Resend rotates the link and creates a new mail job. Failures/recovery and current delivery metadata are documented in OPERATIONS.md. No actual emails were sent during local development.

## Access, ownership and work preservation

OWNER manages ADMIN/AGENT. ADMIN manages AGENT only: no self-promotion, owner changes or admin management. Version checks, permitted fields and role checks are enforced in SQL as well as API schemas. Granting ADMIN and creating/resending/accepting an ADMIN invitation require aal2 plus a signed TOTP AMR timestamp within five minutes. Refreshing a session or a password-only login does not meet this condition.

Settings → Profile supports TOTP enrollment and challenge/verification through verified cookie identity. QR and setup key are shown only during enrollment; keep them private. Users can clear their own unfinished enrollment only; verified factor removal, recovery and administrative MFA resets are outside this slice and need P8 acceptance. The recent status uses verified SDK claims; sensitive SQL independently evaluates auth.jwt(). An admin invitee can perform the same verification on the join page before acquiring membership.

Ownership transfer requires the current owner, recent MFA, active same-agency target, versions for both memberships, reason and explicit confirmation. Demotion/promotion/audit/outbox/replay record commit atomically. The unique active-owner index is retained. Replaying the receipt after the previous owner became ADMIN cannot transfer ownership again. Pending ADMIN invitations issued by the previous owner are revoked.

Deactivation or role change with work requires confirmation and a replacement active same-agency member or the manager queue. All assigned leads, including archived/terminal ones, transfer. OPEN tasks on those leads transfer with version/schedule invalidation; COMPLETED/CANCELLED tasks preserve historical attribution. A departing member's other OPEN tasks move to a replacement only when the replacement can access the parent lead, otherwise the manager queue. Access is denied on the next request and direct RLS reads; the Auth account is not deleted. Pending invitations lose authority on deactivation/demotion.

Agency-row writer locks serialize tenant mutations before membership/parent/task locks, preventing workload creation races with offboarding and seat reservation races. This is a conservative modular-monolith implementation. Bulk transfers currently complete in one atomic transaction; resumable large-workload transfers, contention benchmarks, real concurrent connections and hosted performance remain P8 work. Do not claim production scale from PGlite's single-process tests.

The private outbox records settings, assignment, member access and invite acceptance changes with dedupe keys. It contains IDs/versions, not tokens/customer text. P3 implements authorized notification dispatch; P2 alone has no active reminder worker. The onboarding checklist derives agency settings, processing approval, invitation, sample lead and reminder evidence from scoped records.

## Local and hosted verification

The P2 milestone verified 53 local tests covering prior flows plus team roles/scope/privacy, seats, verified email, expiration/revoke/resend, retries, MFA staleness, owner uniqueness, immediate deactivation, preserved completed work, atomic audit rollback and private outbox/dedupe. Unit transport tests inject a fake fetch; no network delivery occurs. Both package type checks and production build pass. The generated bundle applies locally and rejects reruns against existing tables.

Hosted checks still need real verified accounts, TOTP/cookie session updates, SMTP/approved adapter, signed JWT AMR shape, configured migrations and permitted browser journeys. Include OWNER/ADMIN/AGENT, incorrect invited email, revoked/expired links, capacity conflicts, disabled sessions, concurrent invites/offboarding and ownership rollback. Missing project credentials currently prevent that evidence. Existing browser permission denial is respected.

P3 upgrade: apply migration 007 after 001–006 to connect queued invitation email, delivery-state metadata, recipient notifications, protected workers and shared limits. See OPERATIONS.md. Hosted mail/cron evidence still remains pending.

## Capture and Settings client recovery

P8 adds shared in-memory retry identity through both mutation and post-save refresh, scoped abort/generation guards and a synchronous action gate. Identical retries after a lost response or refresh failure reuse the same tenant/path/method/payload key; completed workflows acknowledge it. Authorization failures/role scope changes clear protected caches and link/signing receipts. Safe API handling preserves auth/rate/field errors without raw proxy/parser failures. No schema or server permission changes are introduced. Helper tests use injected/deferred transports; React/browser workflows remain pending. See CLIENT_RECOVERY.md for recovery/session boundaries and acceptance cases.

Authenticated workspace recovery now refreshes current membership/role before opening a selected agency and keys the mounted workspace by user, tenant and role. Agency creation keeps account-scoped retry identity through failed post-save bootstrap; uncertain sign-out hides mounted private data and offers confirmation retry. These client controls do not replace cookie/RLS authority or prove cross-tab logout. See CLIENT_RECOVERY.md.


## Invitation and authenticator client recovery

P8 adds effect-replay-safe mounted invitation fragment memory, current-account checks and account-scoped acceptance retries, fenced join/account-switch/sign-out transitions, and strict acknowledgement handling. MFA now fences private factor/setup data, preflights enrollment against current factors, refreshes inventory after uncertain non-idempotent setup and requires explicit unfinished-factor cleanup rather than an automatic second enrollment. Failed verification retains entered code; successful writes wait for fresh factor status. Fifteen injected/deferred helper tests provide local evidence; they do not mount React or establish hosted Auth, cross-tab logout/enrollment dedupe, browser or release acceptance. See CLIENT_RECOVERY.md for recovery boundaries and required journeys.

