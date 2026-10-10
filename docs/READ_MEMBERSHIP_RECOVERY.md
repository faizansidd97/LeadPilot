# Read-only membership recovery

## Observed failure

On 10 October 2026 the user reported a lead detail panel that could not load. Development server requests showed the lead, messages, follow-ups, control summary and activity returning 200 while assignment members returned 503. A temporary development-only diagnostic recorded SQLSTATE `25006`, without customer data, SQL text, credentials or provider diagnostics. The diagnostic was removed after identifying the cause.

`private.active_member` uses `SELECT ... FOR SHARE`. Stable directory/dashboard/operations/key-selection RPCs transitively called it. PostgREST executes STABLE/IMMUTABLE RPCs in READ ONLY transactions even for POST, where this row lock is forbidden. See the [PostgREST transaction access-mode reference](https://docs.postgrest.org/en/stable/references/transactions.html#access-mode-on-functions). Ordinary local READ WRITE SQL tests did not reproduce this hosted boundary. The lead panel requires a complete snapshot, so its successful requests do not unlock forms after directory failure.

## Correction

Migration `backend/supabase/migrations/202610100021_read_membership.sql` introduces a private stable `read_member` helper. It checks the same verified Auth actor, active membership and explicit tenant without a row lock. Twenty-one existing read functions use this helper, including dashboard internals, team/directory, Operations, key selection, imports, notifications, duplicate review and privacy lists. Function signatures, output, volatility and existing execution grants are preserved.

Mutation paths retain `active_member`, `writer_member`, their locks, quota enforcement, audit and replay checks. The helper is not callable by public, anon or authenticated roles directly; authorized SECURITY DEFINER read functions execute it internally. No service-role client is introduced into user APIs. The migration changes function definitions, adds no business table or policy, and requests PostgREST schema-cache refresh after commit.

## Apply to the initialized development project

After migrations 001–020, run only `202610100021_read_membership.sql` once in the development project's Supabase SQL Editor. The private worker key cannot execute arbitrary DDL through PostgREST; the agent has prepared and locally checked the migration but has not applied it remotely. Do not rerun the fresh-project setup bundle against the initialized project. Fresh setup now contains 001–021.

After SQL completes, reload LeadPilot on port 4000 and open the lead again. Check directory, dashboard and team loading, then schedule the INTERNAL reminder fixture and continue the bounded worker test. The agency timezone shown in the user's screenshot is Asia/Dubai; choose Due at using the field's displayed timezone.

## Verification and boundaries

`read-membership.test.ts` reproduces the original directory and dashboard `25006` failure in actual READ ONLY transactions, then verifies the migration. Tests exercise successful directory/team/dashboard/operations/CRM and manager key selection, unchanged persisted state, shared-user role scope, foreign-tenant denial, inactive/unverified identity, unchanged function grants, private helper denial, byte-identical mutation membership definitions, write/replay behavior, failed-migration rollback and actual isolated dump/load compatibility.

The full verification manifest in LOCAL_CHECKS.json is the authoritative current local build result. Hosted correction is pending user SQL application and signed requests; browser automation remains blocked. Earlier DEV_WORKER_CHECK.json proves private worker authentication and one assignment notification with an idle repeat, not due-reminder delivery, protected HTTP cron, scheduler or release acceptance.
