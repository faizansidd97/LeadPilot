# Server Auth recovery and hosted baseline

P8 twelfth slice, 10 October 2026. Basic Auth/anonymous API checks now have real, user-authorized development evidence in DEV_BASELINE.json. Source tests/build remain separate in LOCAL_CHECKS.json. Neither report approves signed sessions, tenancy, email, workers, UI or release.

## Safe server decisions

Cookie APIs continue to validate identity through Supabase getUser; they never authorize from cached session/user metadata or a service-role client. authorizeVerifiedUser checks the complete returned confirmed identity before consuming the existing database HTTP limit or accessing tenant/business data. Auth errors override a cached-looking user. Missing/unconfirmed identity is denied; malformed successful identity fails unavailable. Auth and database rate errors cannot return an authorized user.

The shared auth-errors boundary uses structured SDK status/name/code, never provider message text. Definitive missing/invalid/expired/revoked session codes become AUTH_REQUIRED (401). Unknown gateway/configuration 401/403 responses become AUTH_UNAVAILABLE (503) and remain denied; an unknown error is not evidence that a user's session expired. Network/retryable SDK errors, malformed/unknown token responses, refresh races and upstream timeouts/5xx become safe 503 across the integrated workflows. Auth throttling becomes AUTH_RATE_LIMITED (429), retaining the existing private HTTP envelope and default 60-second retry suggestion; no provider reset-time claim is made.

Sign-in invalid credentials/unconfirmed email retain a generic AUTH_FAILED (401). Known signup/password/MFA input errors retain operation-specific safe errors. Session guards, sign-in/up, password reset/update, sign-out and MFA factor/enrollment/cleanup/verification handlers use this boundary. MFA cleanup checks factor-list errors before deciding whether an unfinished factor exists. Current RPC permissions, origin checks, cookie updates, SQL limits and generic account-disclosure behavior remain unchanged. Callback redirects and actual signup/email/MFA/session/outage/browser workflows still need separate live acceptance.

No automatic client/server retry is added. An uncertain non-idempotent Auth write can already have committed; the existing mounted MFA inventory/uncertainty recovery remains necessary. This boundary cannot preserve a cookie already removed by the SDK, revoke another tab, recover a lost enrollment secret or establish exactly-once writes.

## Documented anonymous denial

The first permitted live baseline exposed a checker defect: all anonymous table denials returned HTTP 401 with SQLSTATE 42501, while the checker accepted only 403. PostgREST documents 42501 as HTTP 401 for anonymous requests and 403 for authenticated requests: https://docs.postgrest.org/en/stable/references/errors.html. The corrected checker requires 401 or 403 AND the exact 42501 code. A generic 401, invalid JWT (PGRST301), anonymous-role configuration failure (PGRST302), missing table, malformed/oversized response, unexpected 500 or successful empty 200 cannot pass. Successful table bodies remain cancelled without reading data; denied bodies stay bounded and reports never include raw diagnostics, URLs or keys.

The corrected live result is BASELINE_PASS for email signup enabled, email confirmation required, signup enabled and anonymous denied SELECT id LIMIT 0 on all 15 expected public table endpoints. This proves the public Auth settings/anonymous denial boundary only. Schema-level denial can conceal missing relations, so table existence/current migrations/RLS tenant policies are not independently verified. Migration revision, authenticated acceptance, workers, browser and release remain false. No account, email, SQL change, job/provider request or deployment was performed by these checks.

## Evidence

Thirteen new tests instantiate the actual installed Supabase SDK error classes and execute the pure server identity/gate/error/HTTP boundaries. They cover outage versus definitive denial, safe input errors, unknown gateway responses, malformed identity, throttling/private retry headers, cached-looking identity with an error, denied-before-database access and preserved database gate errors. Two additional staging tests cover both documented denial statuses and malformed/oversized anonymous 401 diagnostics. Existing tests still cover real isolated SQL anonymous privileges, table inventory, tenant/role/replay/audit/rollback and unknown provider capacity.

Real authenticated Auth/agency/lead persistence, signed MFA, two-agency cookie/API/direct-RPC permissions, background worker configuration and scheduling, providers, concurrent load/tier restore, approved privacy execution, browser QA and release acceptance remain pending. Read-only API permission does not authorize browser automation or Auth/mutation/email/provider actions.
