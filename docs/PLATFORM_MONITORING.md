# Platform health monitoring

P8 prepares a read-only operator monitoring boundary. No live monitor, scheduler, pager, email or webhook has been deployed. Local tests use injected transport and isolated PostgreSQL fixtures. Hosted delivery/recovery, real concurrency, purchased-tier RPO/RTO and release acceptance remain pending.

## Protected snapshot

Apply migration `202610080019_platform_health.sql` after 001–018 before deploying the new API validation. Existing projects apply only missing numbered migrations; fresh setup.sql contains 001–019. Migration 019 replaces the existing `worker_health_snapshot()` function, preserving service-role-only execution and adding expired notification/invitation and analysis/draft lease counts, the existing 900-second lag threshold and scheduler_verified=false.

GET `/api/internal/health` requires the configured Bearer CRON_SECRET. Credentials or scope in query parameters are refused. Cookie roles, anon and public function privileges cannot read the global database aggregate. The API validates a strict schema before returning data; old or malformed SQL output, extra fields, inconsistent alert/count relationships and unexpected execution/billing/scheduler claims produce a safe failure. Responses remain private/no-store and never reflect raw SQL/schema diagnostics.

The snapshot includes database reachability, captured_at, due/outbox/AI lag, pending/failed work, expired running leases, reserved/reconciliation operations, current UTC-month observed tokens and pending privacy review. No customer/agency/job IDs, private job payloads, models, errors, bearer tokens or provider responses are projected. Monetary cost stays null, privacy_execution_available=false and scheduler_verified=false. Counts cover the whole platform; agency Operations remains an independently authorized manager projection.

The SQL function is STABLE and reads one statement snapshot. Captured time, lag, lease expiry and UTC token-month selection use statement_timestamp. Due reminders match the worker's current recipient/parent/contact eligibility with a statement-time due cutoff; worker claim behavior is unchanged. In an older transaction, a task becoming due or a lease expiring is visible at the new health statement. Queries do not seed, claim, retry, cancel, settle usage, clean rate windows or write audit/receipts.

Seven fixed alert codes are shared with agency Operations: REMINDERS_DELAYED, NOTIFICATION_QUEUE_DELAYED, AI_QUEUE_DELAYED, FAILED_NOTIFICATION_JOBS, FAILED_AI_JOBS, AI_USAGE_RECONCILIATION and EXPIRED_WORKER_LEASES. Lag alerts use **greater than 900 seconds**; any retained failed job, reconciliation operation or expired running lease also alerts. A recent expired lease is actionable even below the lag threshold. Privacy review counts, observed tokens and reservations alone do not prove failure or cost.

## Operator command

From `backend`, use `pnpm check:health --help`. A permitted staging check uses `pnpm check:health --connect-staging --staging-config <private-staging-env-file>`. Existing environment access denials still apply. Without the connection flag, no config file is read and no request is made. A supplied file replaces ambient values; otherwise explicitly connected checks use the process environment. Configure an HTTPS base APP_URL without credentials/path/query/fragment or common loopback hosts, and the existing server-only CRON_SECRET (32–512 URL-safe characters). Never place this secret in a browser, public env variable, URL, report or committed file.

The command issues one GET to the fixed `/api/internal/health` path with the cron bearer; no Supabase service/public key is sent. It rejects redirects, disables cache, uses an eight-second timeout and caps JSON at 16 KiB. HTTP errors, unexpected content types/envelopes, malformed/inconsistent schemas and transport errors report UNAVAILABLE without remote bodies, error text, URLs or credentials.

Freshness policy accepts snapshots at most 120 seconds old or at most 30 seconds ahead of the operator clock. These are local monitor constants, not an approved SLA or scheduler heartbeat. Clock errors and stale/future snapshots cannot become a healthy outcome. Keep operator/server clocks synchronized.

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | NO_ALERTS | A fresh validated database snapshot currently has no defined alert conditions |
| 1 | ATTENTION | Fresh snapshot has fixed actionable alert codes |
| 2 | UNAVAILABLE or BLOCKED | Health could not be verified, or local options/configuration are invalid |

NO_ALERTS does not prove cron executions, external delivery, provider availability, all Auth/user journeys or release readiness. Every report retains scheduler_verified=false and release_accepted=false. ATTENTION reports safe aggregate metrics and fixed alert codes only. A failed monitor check cannot be interpreted as empty queues or zero lag.

For alerting integration, route ATTENTION and UNAVAILABLE/BLOCKED according to the approved incident procedure; avoid reporting exit 2 as success. Use RUNBOOKS.md for lease/failure/reconciliation triage. This command never retries jobs or acknowledges an incident. Alert transport, cadence, deduplication, paging ownership, retention and actual scheduler/cron/outage drills must be configured and verified separately before release. No Codex automation or external alerting action was created.

## Local evidence

Tests cover strict response minimization/consistency, all seven alert categories and lag boundaries, bearer/query rejection before DB access, private cache/error responses, minimized monitor requests, safe invalid-config handling, timestamp age/skew boundaries, HTTP/schema/body/transport failures and no-connect CLI behavior. SQL tests cover global counts across two agencies and both AI kinds, isolated expired versus active leases, current reminder eligibility, read-only queue/reservation/audit/receipt preservation, statement-time behavior in an older transaction, actual dump/load with service-only permissions and migration rollback/retry. These are local synthetic checks, not hosted recovery or monitoring acceptance.
