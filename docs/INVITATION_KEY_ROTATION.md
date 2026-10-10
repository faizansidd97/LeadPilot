# Invitation signing key rotation

P8 third local slice, 7 October 2026. Local synthetic database/transport evidence only; no real keys changed, staging connection, email or deployment. P8 remains IN PROGRESS.

Invitation tokens remain HMAC-SHA256 over the existing tenant/actor/operation/request-UUID tuple. Acceptance still uses the saved SHA-256 token hash, matching verified email, current inviter authority, expiry, seats and MFA for ADMIN. Adding a key ID does not invalidate previously issued links or change the acceptance contract.

## Configuration and migration

`INVITATION_TOKEN_SECRET` is the immutable legacy HMAC root. Optional server-only `INVITATION_TOKEN_KEYS` is a JSON object of immutable key IDs to independent 32-byte lowercase hex secrets. IDs use `^[a-z][a-z0-9_-]{0,39}$`; at most ten entries, no legacy override or prototype names. No key uses a NEXT_PUBLIC name. Malformed inventory or an unavailable required key fails with a safe retryable 503. Do not print keys, tokens or join URLs in operator logs.

Migration 016 creates a private versioned global signing policy, initially legacy; private issuance provenance; and a private platform change journal. It labels existing issuance receipts and invitation mail jobs legacy without changing their token hashes, timestamps, business versions or dedupe identities. The legacy create/change RPC signatures move to revoked private cores; authenticated wrappers retain their business checks and expose an optional final key-ID argument defaulting to legacy. Existing application calls remain compatible while the policy is legacy. Only numbered missing migrations belong on existing databases; fresh setup.sql contains 001–016 and refuses initialized business tables.

Verified cookie APIs ask `invitation_signing_key` for the active key on fresh create/resend requests and the recorded key on historical request retries. The selector rechecks current agency/role/verification, invitation scope/state and recent ADMIN MFA. Mutation wrappers lock the agency and shared global policy, fence fresh writes, and persist provenance atomically with the existing invitation/hash/audit/outbox/receipt transaction. Request payload and hash conflict checks remain in the business core. A key-policy change between selection and mutation returns 409; retry the same request UUID. Historical retries regenerate their original token, and superseded, consumed, expired or unauthorized invitations still fail.

Queued mail reads its job's recorded signing key after rechecking the current invitation/hash/issuer and fenced lease. Old jobs use legacy; new jobs use the active key. An unavailable key causes the durable worker retry path rather than sending or marking that attempt complete. Existing retry/backoff/exhaustion/recovery bounds still apply. Correctly configured keys whose regenerated token no longer matches the expected hash retain the existing TOKEN_ROTATED cancellation behavior. Key mappings must therefore never be edited in place.

## Operator procedure

The CLI has no HTTP endpoint or scheduler trigger. It connects only with explicit `--connect-staging`. A supplied `--staging-config` file replaces ambient configuration completely, requires the exact HTTPS project base URL/private worker credential, and is never printed. Node's special `--env-file` flag is intentionally absent; use `--staging-config`.

1. Record the actual environment, reviewed change reference and rollout owner. Preserve the original legacy value and all historical named values in the approved secret store, including backup dependencies. Prepare a new independent key under a new ID. Apply migration 016 while policy stays legacy, deploy the capable API/worker readers, and load the complete ring on every replica before activation. Verify the actual hosted RPC signatures/grants, immutable secret values and fleet health separately.
2. Run read-only plan with the intended target. Preflight checks the format/presence of the active key, target and every retained issuance key. Its minimized counts are historical issuance counts, not active seat or live-job counts. It cannot authenticate every historical key value, prove replica configuration, operator approval or backup recovery.
3. With reviewed state, activate using the observed policy version, change reference and a reusable request UUID. Preserve that UUID and exact arguments on transport retry. SQL fences versions and saves the change journal/receipt in the same transaction as the policy update. A later superseding policy remains current when an old operation is replayed; replay never switches it back.
4. Run verify and perform authorized hosted old/new link, resend, queued mail, stale replica, signed Auth/MFA and backup recovery checks. Remove a failed target from active use only through another reviewed, versioned activation with all dependencies available; preserve its material for requests already issued. Never overwrite an ID's value.

From backend, using Node >=22.18:

```text
pnpm rotate:invitation-signing --help
pnpm rotate:invitation-signing --mode plan --target TARGET_ID --connect-staging --staging-config .env.staging
pnpm rotate:invitation-signing --mode activate --target TARGET_ID --expected-policy-version OBSERVED_VERSION --reference REVIEWED_CHANGE --request-key REUSABLE_UUID --connect-staging --staging-config .env.staging
pnpm rotate:invitation-signing --mode verify --target TARGET_ID --connect-staging --staging-config .env.staging
```

Output contains only target/active key IDs, policy version, issuance counts, replay and readiness flags. `key_retirement_approved` and `fleet_readiness_verified` are always false. Verify is BLOCKED when the target is no longer active. Plan READY means this process has the syntactically valid retained inventory; it grants no deployment or rotation approval. No connected command was run during this implementation.

## Local evidence and remaining gates

23 new checks cover byte-compatible legacy generation, strict key/config/options guards, no-connect CLI behavior, preflight without writes, scope-safe create/resend retries across two policy changes, immediate issuer revocation, current email/roles/MFA, atomic audit/journal rollback, old-link acceptance, recorded-key mail with injected transport, missing-key retry, real legacy-data upgrade and failed-upgrade rollback, and actual mixed-key dump/load with expired/renewed lease fencing. Full regression and compiler/build results are recorded in LOCAL_CHECKS.json and RELEASE_EVIDENCE.md.

No historical bearer-token rewrite, invitation key retirement or deletion is implemented. Keep all retained issuance/backup dependencies; approved retention/restore policies remain unresolved. Actual hosted fleet rollout, correctness of stored real key values, transport recovery, backup tier RPO/RTO, browser/UAT and release acceptance remain pending. The separate intake signing derivation root is still unchanged by AES rewrap; see INTAKE_KEY_ROTATION.md.

P8 fourth slice now adds a separate versioned intake signing-root issuance policy; see INTAKE_SIGNING_ROOT_ROTATION.md. AES rewrap itself still leaves the website signing credential/root receipt identity unchanged. No real root transition or retirement is accepted.
