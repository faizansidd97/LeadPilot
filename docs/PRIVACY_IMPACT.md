# Privacy request impact preview

Settings → Privacy → choose a case with “Review / use latest version”. The preview appears before the review form and remains available for withdrawn cases. OWNER and ADMIN can refresh the statement-time snapshot. It shows related leads, messages/revisions, follow ups, activity evidence, AI jobs/results, reply drafts/feedback, notifications, privacy cases and review notes. Archived leads and historical records are included.

The snapshot also shows whether an identity-verification reference has been recorded, how many review holds intersect the scope, open follow ups, active AI jobs and usage requiring reconciliation. A recorded reference is a review entry; it does not independently verify identity. A lead request intersects its own lead holds and agency closure holds. An agency request intersects every hold in that agency. Other agencies never contribute counts.

These are related workspace records, not rows approved for deletion. The inventory excludes private background contexts/queues/receipts, import/integration artifacts, membership/invitation closure dependencies, provider copies and backups. Retention approval, complete inventory, deletion execution and restored-deletion replay are still pending. The preview explicitly returns `retention_policy_approved:false`, `inventory_complete:false` and `execution_available:false`. It does not freeze processing, cancel jobs/tasks, approve a case, purge/anonymize records or close an agency.

PRIVACY_POLICY_REQUIREMENTS.md now lists the concrete policy inputs, full inventory and implementation/test sequence needed to unblock this work. Preparing that worksheet does not approve a retention policy or enable execution.

Existing owner-requested case intake and manager review/hold/withdrawal retain recent MFA, versions, replay and atomic audit. Reading requires verified current membership and OWNER/ADMIN role; it does not require another write/MFA event. The STABLE SQL read uses the lock-free membership helper and a statement snapshot. No request/receipt/audit/job row is written by the impact RPC. The normal authenticated HTTP read rate gate remains in force.

API: `GET /api/v1/privacy/{case_id}/impact?expected_version={case_version}` with signed cookie identity and X-Tenant-Id. The server validates path/query, calls only `read_privacy_impact` through the ordinary user database client, validates the strict response and binds tenant/case/version. Agents, inactive/unverified users and foreign tenants/cases are denied; anonymous/private worker roles have no execute grant. No customer text, recipient IDs, provider data, credentials, private errors or review references are returned.

Refresh case records and reselect “Review / use latest version” after a case-version conflict. Client reads are scoped to tenant/case/version/state, cancel on close or switch, reject stale completions and refuse mismatched/old/future snapshots. Refresh clears counts while loading and exposes retry on failure. Parent request/review inputs are preserved. The preview is an observation at its timestamp; ordinary workspace changes can change counts immediately afterward.

Migration: an existing initialized project through 021 needs only `backend/supabase/migrations/202610100022_privacy_impact.sql` applied once. Fresh-project setup.sql now contains 001–022. Do not rerun fresh setup on an initialized project. On 2026-10-10, the user reported successfully running migration 022 in development Supabase. Application is user-confirmed; the agent has not independently verified the hosted revision or preview. Hosted testing remains deferred at the user's request while only one agency/test identity is available.

Local checks execute actual SQL with synthetic fixtures: manager/agent/shared-user/foreign/inactive/unverified permissions, lead/agency counts, archived records, holds, reconciliation, content minimization, READ ONLY and unchanged business/queue/receipt/limit/audit rows. Injected migration failure rolls back the function/grants and preserves intake. Server/client checks reject wrong scope/version/state, malformed counts, unsupported execution claims, stale timestamps and deferred completions after close/switch. Types/build verify integration; hosted RLS, browser accessibility/UAT, full inventory and release acceptance remain pending.

Settings loading recovery: the later user screenshot and existing server log identify a separate team directory failure while privacy records return successfully. Migration 023 fixes the locally reproduced Auth email return-type mismatch; apply it after 022 and refresh Settings. Hosted visible recovery remains pending. See TEAM_DIRECTORY_RECOVERY.md.


Intake/review save and read recovery is documented in PRIVACY_RECOVERY.md. No new migration is needed for that client slice; the user reported applying 022 and 023. Hosted preview and visible Settings recovery remain independently unverified.

