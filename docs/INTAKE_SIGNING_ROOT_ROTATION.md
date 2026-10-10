# Website intake signing root transition

P8 fourth local slice, 7 October 2026. No real master key, website credential or hosted policy changed. P8 remains IN PROGRESS; this prepares a separately authorized operator workflow.

## Three independent versions

| Identity | Purpose | Change behavior |
| --- | --- | --- |
| Signing derivation root ID/policy | Deterministically issue a signing secret for a create/rotate request | Select a new root for future operations; preserve original root on exact retries |
| Integration key_version/business version | Website's current signing credential and authority | Explicit manager rotate/revoke invalidates old website credentials |
| AES key ID/encryption revision/policy | Store an existing signing secret in an authenticated envelope | Rewrap changes storage only; signing secret/hash/AAD/business version stay intact |

Legacy HMAC derivation remains byte compatible: HMAC-SHA256 over `leadpilot-intake-v1:` plus the existing tenant/actor/action/integration/request scope, using the original INTAKE_ENCRYPTION_KEY bytes. That immutable legacy value still supplies legacy AES decryption and historical root retries. Optional server-only INTAKE_SIGNING_ROOT_KEYS maps independent immutable root IDs to 32-byte lowercase hex values. At most ten named roots; no legacy override or prototype names. INTAKE_ENCRYPTION_KEYS remains the independent AES ring. Missing or malformed required material fails safely before issuing a credential; no key fallback is attempted.

New named-root/named-AES issuance can run without a legacy value when that operation has no legacy dependency. This is a capability check, not permission to remove retained historical or backup material. Exact legacy retries still require their original root. Decrypting an already saved website signing secret and validating an intake request require its AES key, not its derivation root. AES-only verification now reports signing_root_retirement_evaluated=false rather than claiming a permanent derivation dependency.

## Migration and protected request flow

Migration 017 adds a private global root policy initially legacy, private issuance provenance and a private activation journal/receipt. Existing create/rotate receipts receive legacy provenance without changing any website ciphertext, AAD, hash, timestamps, business version or key_version. The existing manager RPC moves to a revoked private core; its authenticated wrapper retains the old optional AES argument and adds an optional final root argument defaulting to legacy. Old application calls stay compatible while root policy remains legacy. Fresh setup contains 001–017; apply only missing numbered migrations to existing databases.

Cookie APIs obtain the root from integration_signing_root using verified current manager membership and exact tenant/action/integration/request scope. Historical requests select their recorded root; fresh requests select the active root. User payloads cannot set the key IDs. The mutation wrapper locks the agency and shared root policy before fencing the selected root, then invokes the existing manager core. Payload/hash idempotency, assignment checks, integration limits, business version, active state, AES policy and atomic business audit remain authoritative. Provenance, encrypted credential, business metadata and replay receipt commit or roll back together. A policy change between selection and mutation returns 409; keep the same request UUID when retrying.

Create/rotate replay returns the original secret only while its saved hash still matches the current active integration. Actual signing rotation/revocation, scope loss, unverified email or issuer offboarding prevents historical secret disclosure or website credential use. Revocation requires no AES or derivation-root material. Global root activation changes no existing website key; migrating an individual website credential remains an explicit manager action with website-side coordination.

## Private operator procedure

1. Preserve every immutable legacy/named root, AES key and backup dependency in the approved secret store. Record the actual environment, operator and reviewed change reference. Prepare a new independent root under a new ID. Apply migration 017 while root policy stays legacy; deploy capable API readers with the complete root/AES inventory before activation. Confirm the exact hosted RPC signatures/grants, stored real values and replica readiness separately.
2. Run read-only plan against the intended explicit staging configuration. It validates format/presence of the active/target/historically recorded roots and active AES key. Issuance counts include historical and revoked records; they are not live website counts. Plan does not authenticate all real key values, prove deployment consistency or authorize retirement.
3. Activate with the observed root policy version, reviewed reference and reusable request UUID. Preserve exact arguments and UUID for uncertain transport retries. Policy and immutable private change journal commit atomically. Replay reports current policy; it never switches a later policy back.
4. Run verify, then perform authorized hosted old/new issuance, same-operation create/rotate retry, website signature, replay/conflict, stale-replica, revocation/offboarding and backup recovery checks. A rollback is a separately reviewed versioned activation of a preserved root; all keys already used remain available. Never replace the material behind an existing ID.

From backend with Node >=22.18:

```text
pnpm rotate:intake-signing-root --help
pnpm rotate:intake-signing-root --mode plan --target ROOT_ID --connect-staging --staging-config .env.staging
pnpm rotate:intake-signing-root --mode activate --target ROOT_ID --expected-policy-version OBSERVED_VERSION --reference REVIEWED_CHANGE --request-key REUSABLE_UUID --connect-staging --staging-config .env.staging
pnpm rotate:intake-signing-root --mode verify --target ROOT_ID --connect-staging --staging-config .env.staging
```

No connection occurs without --connect-staging. A supplied --staging-config replaces ambient configuration completely; only an HTTPS project base URL and private worker credential are accepted. Node's special --env-file option is intentionally absent. No public rotation endpoint or automatic trigger is added. Output contains root/AES IDs, versions, counts and flags, never secret values, ciphertext, scopes or customer data. Verify is BLOCKED if the target is no longer active. key_retirement_approved and fleet_readiness_verified are always false.

## Local evidence and remaining gates

24 new checks cover byte-compatible legacy derivation, separate named root/AES material, strict inventory/options/no-connect guards, current verified manager/tenant permissions, hidden cores and worker defense after accidental grants, policy/transport replay, fresh stale-root fencing, signing-rotation hash/version checks, revocation/offboarding, business-audit/platform-journal rollback, existing website signatures/event replay after root/AES transition without loading roots, and actual mixed-root dump/load. A real pre-017 create/rotate fixture proves unchanged envelopes/receipts and failed-upgrade rollback. Full regression/type/build results are recorded in LOCAL_CHECKS.json and RELEASE_EVIDENCE.md.

Hosted policy changes, fleet rollout, real immutable key-value checks, credential coordination with website operators, purchased-tier backup/RPO/RTO and release acceptance remain pending. No blanket key retirement, history deletion, privacy executor, restore-deletion replay or live website change is implemented. See INTAKE_KEY_ROTATION.md, INVITATION_KEY_ROTATION.md and RELEASE_CHECKLIST.md.
