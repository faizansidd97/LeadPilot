# Agency operations status

P8 fifth local slice, 8 October 2026. Settings → Operations is available to verified active OWNER/ADMIN members of the selected agency. Credentials, actual scheduler/delivery, browser usability and release acceptance remain separate gates.

The cookie endpoint GET /api/v1/agency/operations uses the existing verified identity, HTTP read limit and selected-tenant membership flow. Migration 018 supplies a STABLE manager-only security-definer aggregate projection. Current verification and role are checked inside SQL on every call, including direct authenticated RPC access. No global service client is used. An agent, unverified/deactivated user, different-role shared user or nonmember cannot read the projection. Anon/service-role do not receive EXECUTE grants.

## Snapshot definitions

| Metric | Population and meaning |
| --- | --- |
| Reminder deliveries awaiting creation | Eligible due task/schedule/recipient pairs from the existing durable scanner view without a matching saved in-app notification. A manager-queue task can have several recipients. Existing queued outbox work can still await notification creation; this is not an email-delivery count. |
| Oldest due reminder | Age of the oldest pair above. Archived/terminal leads, restricted contact tasks, completed tasks, invalid assignments and unverified/inactive recipients follow the scanner's existing eligibility rules. |
| Notification/invitation pending/running/failed | All retained outbox jobs in this agency in those states, including invitation mail and internal events. Oldest pending age includes PENDING and RUNNING jobs, even during backoff. Completed/cancelled jobs are excluded. |
| AI queued/running/failed | All retained analysis and draft jobs in this agency in those states. Oldest pending age includes QUEUED/RUNNING, regardless of whether processing is currently enabled. |
| Expired leases | RUNNING jobs with lease_until <= snapshot time. Existing workers retain responsibility for fenced lease recovery. |
| AI reconciliation | Retained agency jobs with usage_state=RECONCILE, including completed/cancelled work with uncertain provider usage. No reservation is released or charged by reading status. |

Counts use one database statement snapshot. captured_at records that snapshot, and every projection explicitly filters the selected tenant. The response contains fixed counters/timestamps/alert codes only: no job/customer/recipient IDs, text, email, tokens, model names, private errors, payloads, master keys or commercial limits. Schema validation rejects unexpected data before API output. Responses are private/no-store.

Seven alert categories cover overdue reminder creation, notification queue delay, AI queue delay, retained notification failure, retained AI failure, AI reconciliation and expired worker leases. Lag alerts begin strictly after 900 seconds; this is the existing proposed operating threshold, not an accepted SLA. Historical FAILED jobs continue to count until an authorized operator recovers them. Reconciliation requires investigation of actual provider usage; it is not permission to refund or retry uncertain operations.

## UI behavior and operational limits

The panel shows snapshot time, queue cards and plain alert explanations. It loads on opening Operations, refreshes manually, and polls every minute while the document is visible; returning to a visible document refreshes immediately. Requests are not overlapped. Cleanup aborts in-flight reads and removes interval/listener state. Tenant changes clear data and ignore older responses; a failed read clears the current metrics. Agents have no Operations tab. Owner-only quota usage reuses the existing independently authorized AI usage endpoint; admins do not receive commercial limit/token details.

No queue alert in a snapshot does not verify that a scheduler ran, that an email was delivered or that the service is available. scheduler_verified remains false and cost_amount remains null. Provider cost is not reconciled into a monetary dashboard. The panel is read-only: it never seeds/claims/requeues jobs, changes reservations, adds receipts/audits, acknowledges incidents or suppresses alerts. Protected platform health and existing reviewed recovery runbooks remain with the operations team.

This implements in-product status/alerts while the panel is open. External paging, scheduled monitoring, incident acknowledgements, provider billing reconciliation and hosted observability require separate configured/approved operation. No monitor automation, hosted request, message, migration or deployment was run during this slice.

## Evidence

12 new local checks cover strict minimized projection contracts, tenant-specific queue ages and all alert categories, owner/admin parity with owner-only usage permissions, agent/shared-role/nonmember/anon/service-role denials, immediate verification/deactivation checks, unchanged queues/reservations/receipts/audit on reads, eligible reminder recipient/schedule semantics, empty agency behavior, actual dump/load permissions and migration-failure rollback. Tenant/state/time indexes support the queue selectors. Full regression, both package type checks, constructed AI evaluations and production build are recorded in LOCAL_CHECKS.json and RELEASE_EVIDENCE.md. Interactive polling/visibility/accessibility journeys, hosted RLS/Auth and concurrent query latency remain unverified.

See OPERATIONS.md, P8_HARDENING.md, RUNBOOKS.md and RELEASE_CHECKLIST.md. P8 remains IN PROGRESS; P9 has not started.
