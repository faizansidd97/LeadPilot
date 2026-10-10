# Private AI attempt tracking

P8 prepares durable correlation for analysis/draft outage investigations. The existing adapter receives a private request UUID saved before the worker calls it. This is **prepared-call evidence**, not proof the request was dispatched, accepted, charged, deduplicated or delivered. No live provider request, hosted migration or reconciliation write occurred in this slice.

## Schema and worker behavior

Migration `202610080020_ai_attempt_tracking.sql`, after 001–019, adds private.ai_provider_attempts. Each row holds only job ID, claim-attempt number, provider_request_id and prepared_at. There are no customer/agency/user IDs, prompt snapshots, generated text, models, bearer/lease tokens, keys or provider error bodies in this journal. The job reference remains private operational metadata, not a public log.

The original analysis/draft prepare implementations move into revoked private cores. Public worker-only wrappers retain their kind, lease, access, context and lock checks. A successful prepare inserts a receipt and returns its request UUID in the same transaction as the dispatch marker. Same-job/same-claim prepare retries reuse one immutable receipt; a renewed claim receives a new UUID. Stale/wrong-kind/unknown/revoked preparation creates no receipt. The original authorized snapshot is unchanged.

Direct SQL journal reads/writes and private core/helper execution are denied to cookie users, anon and even the worker role. Only the fenced prepare wrappers can add rows and the narrow diagnostic RPC can project them. The private journal is the atomic preparation receipt; it does not create a customer activity entry containing request IDs. Journal insertion failure rolls back the dispatch marker and receipt together, preserving the running lease, usage reservation and quota windows. Existing audit/result/usage fencing remains intact.

Workers require a valid recorded UUID before calling the provider adapter. A missing/malformed ID produces a known zero-token transient database failure without calling the adapter; there is no random-ID fallback. Once the provider call starts, transport loss retains unknown usage through the existing conservative RECONCILE handling. Known observed tokens are preserved even if analysis/draft validation rejects the output. Worker results do not expose provider_request_id or raw content.

Multiple calls can still occur, including repeated processing with the same lease/correlation ID. This identifier provides correlation, not an idempotency guarantee. At most one SQL result can publish per job under the existing fencing rules, but provider dispatch/billing is not exactly once. Never infer a refund, verified charge or complete attempt count from these rows.

## Upgrade and recovery

For a permitted hosted rollout, stop analysis/draft dispatchers, apply the missing migration, deploy the updated workers and let existing leases expire before recovery. Avoid mixed old workers that ignore the returned ID. Existing jobs/leases/results/usage are preserved; no historical correlation IDs are invented or backfilled. A reclaimed previously dispatched lease remains uncertain and receives a new receipt when prepared. Prove the exact fleet and outage behavior in staging before live acceptance.

Use only missing numbered migrations for initialized projects; fresh setup.sql contains 001–020. Local failure injection verifies original prepare definitions/grants survive migration rollback, followed by successful upgrade of existing in-flight data. An actual local dump/load preserves request identities, uncertain usage/reservations and private permissions. This does not verify hosted Auth, bought-tier backup/RPO/RTO or deletion replay.

The new journal is a child of ai_jobs. Its retention, access logging and handling during approved privacy erasure/closure/restore must be included in the pending record-class policy. No retention duration, automatic purge or irreversible privacy executor is introduced.

## Read-only operator diagnostics

From `backend`, run `pnpm inspect:ai-attempts --help`. When environment access is permitted, use `pnpm inspect:ai-attempts --job <job-uuid> --connect-staging --staging-config <private-staging-env-file>`. Without the explicit flag, the command reads no config file and makes no connection. A supplied file replaces ambient values; otherwise explicitly connected checks use the process environment. Configure an HTTPS staging base NEXT_PUBLIC_SUPABASE_URL and server-only SUPABASE_SERVICE_ROLE_KEY. Public keys are refused. No session persistence, redirects, raw credentials, URLs or remote diagnostic text are allowed in output.

The command invokes only worker_ai_attempt_diagnostics for the requested UUID. This service-only read returns opaque job/request identifiers, kind/version/state/usage state, uncertainty, observed/reserved tokens, claim count and at most three sorted prepared receipts. Cookie owners/admins/agents and anon cannot access it. The helper validates a strict schema and exact requested-job identity before printing; unexpected/private fields or inconsistent history fail safely. Reports are private operational artifacts and must follow the approved support/log-access rules, not be copied into customer UI or public tickets.

claims_without_prepare_record is the number of claims without a saved preparation receipt. It can include legacy attempts or attempts cancelled/failed before preparation; it does not count verified provider calls or charges. provider_usage_verified=false and resolution_available=false remain explicit even when all claims have receipts. There is no refund, quota release, reconciliation resolution, retry or provider API operation in this command.

For an incident, preserve the exact private job/request IDs and revision, investigate provider-side evidence through the approved operator process, and retain uncertain capacity until that process authorizes a resolution. Existing RUNBOOKS.md containment/lease/usage rules still apply. Live provider trace lookup, billing proof, fleet/clock verification and an approved recorded reconciliation process remain pending.

## Local checks

Twenty-two new tests cover worker identity use, no untracked dispatch, known versus unknown usage, strict private reports and CLI opt-in; real SQL same-claim retries, renewed-lease identity/stale fencing, two worker kinds, current access revocation, narrow single-job reads, direct role/core/journal denials, unchanged diagnostic reads, forced journal rollback for both kinds, actual dump/load and legacy migration rollback/upgrade. Existing analysis/draft regression fixtures now include prepared UUIDs. Synthetic checks do not verify actual provider trace lookup, charges or release readiness.
