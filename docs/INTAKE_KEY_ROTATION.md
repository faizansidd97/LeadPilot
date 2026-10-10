# P8 website intake encryption rotation

The second P8 local slice adds versioned AES storage keys and an operator workflow for planning, activating, rewrapping and verifying encrypted website signing credentials. **No live key was changed, no staging connection was made and P8 remains IN PROGRESS.** Hosted deployment/rotation/backup acceptance is pending.

## Storage and signing are separate

Migration 015 labels existing ciphertext with encryption_key_id=legacy and encryption_revision=1. It does not change existing ciphertext, AAD, signing secret/hash, integration business version or website key_version. A private global policy initially selects legacy for new/rotated signing-credential encryption. The authenticated manager API obtains that key ID from a narrow verified membership RPC, then encrypts with server-held material. A stale server attempting a fresh write under another key ID is rejected by the DB policy fence. Managers/agents never receive master keys, ciphertext or the global inventory through the product API.

INTAKE_ENCRYPTION_KEY remains the original 32-byte lowercase hex legacy value. It serves both legacy AES reads and legacy deterministic HMAC signing-secret derivation. Migration 017 separately versions signing roots for future issuance and records original roots for historical retries; see INTAKE_SIGNING_ROOT_ROTATION.md. **Keep it unchanged.** New AES keys are held in optional server-only INTAKE_ENCRYPTION_KEYS, a JSON object mapping bounded lowercase IDs to 32-byte lowercase hex values. At most ten additional keys are accepted; legacy/constructor/prototype entries, invalid names/values and malformed objects are rejected. Key IDs are case-sensitive; no fallback decryption tries unrelated keys. Ciphertext remains the authenticated nonce/tag/data envelope; AES-GCM also binds its original AAD.

For example, in a private staging configuration file, replace the placeholder through your secret manager:

```text
INTAKE_ENCRYPTION_KEYS='{"k2026_10":"<64 lowercase hex characters>"}'
```

This is a placeholder, not a usable key. No new real key is generated or stored by the local tests. setup:supabase adds only the optional blank ring field and preserves populated settings.

Every envelope is decrypted with its exact stored ID, checked against its existing signing-secret hash, and locally round-trip verified under the target key before a rewrap is sent. Rewrap updates only secret_cipher, encryption_key_id and encryption_revision. Website signatures and key_version keep working, including an intake request that fetched the previous envelope before rewrap. Existing integration signing-key rotation/revocation remains a separate manager operation that changes key_version. A same-operation integration retry across AES policy changes derives the same secret; replay returns current metadata and rejects an old signing receipt after actual signing rotation/revocation.

## Private operator workflow

The CLI has no default connection or write. `--connect-staging` is mandatory for all connected modes; activate/rewrap additionally require an explicit current policy version and bounded change reference. An explicit `--staging-config` file supplies the complete configuration instead of mixing with inherited process credentials. Use a private ignored file such as backend/.env.staging (the backend .env* ignore rule covers it), and keep its values out of source control. It must contain the HTTPS Supabase base URL, private service-role worker credential, preserved legacy key and complete read/write ring. No localhost/public-key fallback is accepted. This file name is an application flag; it does not use Node's startup env-file option.

This prepares a tool for an authorized operator; it cannot prove a supplied project is staging, that all servers have the same configuration, or that cloud credentials/regions are approved. Confirm project identity and deployment inventory outside the tool before using the connection flag. No connected mode was executed in this local development slice.

Use Node >=22.18; run from backend. The following commands are examples for a configured, approved staging project:

```text
node --experimental-strip-types scripts/rotate-intake-encryption.mjs --help
node --experimental-strip-types scripts/rotate-intake-encryption.mjs --connect-staging --staging-config .env.staging --mode plan --target k2026_10
node --experimental-strip-types scripts/rotate-intake-encryption.mjs --connect-staging --staging-config .env.staging --mode activate --target k2026_10 --expected-policy-version 1 --reference change-42
node --experimental-strip-types scripts/rotate-intake-encryption.mjs --connect-staging --staging-config .env.staging --mode rewrap --target k2026_10 --expected-policy-version 2 --reference change-42
node --experimental-strip-types scripts/rotate-intake-encryption.mjs --connect-staging --staging-config .env.staging --mode verify --target k2026_10
```

Do not copy example versions into a real change without reading current plan output. Package script rotate:intake-encryption exposes the same command. There is no customer UI, public rotation endpoint or automatic cron trigger.

| Mode | Behavior |
| --- | --- |
| plan | Read-only global policy/envelope scan; decrypt/hash validation; report missing rewrap count |
| activate | Complete validated preflight, reviewed policy-version CAS, select target for future writes; does not rewrap existing rows |
| rewrap | Complete validated preflight; target must already be current; CAS each pending envelope; preserve signing identity; safe resume skips target rows |
| verify | Read-only validation and key-reference counts; READY only when inventory is complete, target policy is current and no other live storage-key IDs remain |

All modes scan active **and revoked** integration rows across the private worker inventory. Pages contain at most 25 envelopes. A full preflight is bounded to max_records (default 500, configurable 25–10000); an incomplete scan returns INCOMPLETE and performs no activation/rewrap. Choose a reviewed bound large enough for the staging inventory. Policy changes, malformed/nonmonotonic pages, missing/wrong keys, hash mismatch or changed inventory stop readiness. A policy change at the final acknowledgement also blocks the result.

Deploy dual-read/key-ring-capable code and target key material to **every** API/intake worker before policy activation. During the config/policy transition, stale writers fail safely and can retry with the same request key after refresh. No global configuration switch can prove every deployment node has the new material. Plan this maintenance/rollout and monitor errors through the configured operator procedure.

## Concurrency, recovery and audit

Every rewrap locks the agency in the same order as integration management, then holds the global policy fence and checks current ciphertext hash, old key ID, encryption revision and policy version. Concurrent signing rotation/revocation cannot be silently overwritten. Policy activation is versioned. Worker functions require service_role internally even if EXECUTE is accidentally granted to a normal user; clients cannot read private inventory/operations tables or invoke rotation through cookie identity.

One mutation is retried at most once using the **same** generated key/payload/request ID after an unknown transport result. Successful operations store minimized idempotency/change-reference receipts atomically. Rewrap stores a scoped summary activity event without signing secret, plaintext, ciphertext, AAD or copied operator reference; activation stores its private operation record. Audit/receipt failure rolls back the corresponding policy or envelope change. No application table is read/written through a broad client; the operator adapter calls narrow worker RPCs only.

The operation is resumable rather than an all-instance transaction. A failure after earlier rows committed can leave a mixed-key inventory. Preserve the complete read ring and run plan/review again; do not restore old ciphertext by bypassing version checks. READY from rewrap means completion for the observed live inventory, not blanket human approval. Run verify separately after the rollout stabilizes. Errors/reports expose only fixed status, counts, policy/key IDs and versions, with no integration/customer IDs, ciphertext, reference, keys or raw database/transport error text.

Restored backups may contain older key IDs even after the live inventory reaches zero old-key references. Isolated tests actually restore envelopes/policy/operation receipts and verify current scope/decrypt/replay behavior; a separate migration drill upgrades an existing legacy envelope and proves failure rolls back new columns/policy/replacement RPC. Hosted Auth, secret manager history and purchased-tier restore remain unverified.

## Limits and retirement

Reports now set signing_root_retirement_evaluated=false and backup_key_retirement_approved=false. AES verification validates the active/target/storage-envelope keys and does not load unrelated derivation roots. **A completed live rewrap never authorizes key retirement.** Original derivation roots remain needed for their historical signing retries, and older backups require their original encryption keys. Invitation HMAC and intake derivation-root local workflows are documented in INVITATION_KEY_ROTATION.md and INTAKE_SIGNING_ROOT_ROTATION.md. Approved backup retention/restore policy, compromise response and verified hosted fleet/secret-manager rollout remain separate work. This tool does not erase data, execute privacy requests, close agencies, rotate website signing identities or resolve unknown provider/mail outcomes.

Local verification uses synthetic AES keys and emulated Auth/PGlite with injected transport failures. No customer data, real credentials, external message or hosted change is involved. See LOCAL_CHECKS.json, RELEASE_EVIDENCE.md, RUNBOOKS.md and RELEASE_CHECKLIST.md for release boundaries.
