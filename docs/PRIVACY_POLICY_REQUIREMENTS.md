# Privacy execution requirements

This worksheet makes the remaining A22 implementation dependency concrete. It records requirements to decide; it is not an approved legal policy or a deletion authorization. Current Privacy supports request intake, identity-reference review, holds/history and a partial impact preview. It cannot erase leads, close agencies or replay deletions after restore.

The project owner and appropriate privacy reviewer must provide a dated decision reference for these values before irreversible execution is designed. No fixed number of retention days, assumed residency or blanket retention exemption has been selected.

| Required decision | Value / evidence still needed |
| --- | --- |
| Processing authority and roles | Responsible agency/platform parties, notices/contracts, allowed data uses and any subprocessors |
| Regions and transfers | Approved database/Auth/storage/log/provider/backup regions and permitted transfers |
| Lead erasure result | Hard delete versus defined anonymization; field-level treatment, identity matching and what proof remains |
| Agency closure result | Membership/Auth ownership, revoked integrations/invitations, termination order, permitted post-closure access and user accounts shared with other agencies |
| Retention by record class | Lead/contact/facts, messages and revisions, tasks, notifications, AI job/context/analysis/draft/feedback/attempts, activity/audit, imports, private replay/queue receipts, invitations and integration metadata |
| Holds and conflicting cases | Who can create/release a hold, required evidence, scope, priority and when ordinary CRM/processing must stop |
| Verification and execution authority | Required identity-verification reference, reviewer/executor roles, recent MFA, approval separation and error/appeal procedure |
| In-flight/uncertain processing | Worker fencing/cancellation, dispatched provider requests, charge reconciliation, late responses and records legally required for disputes |
| Audit minimization | Justified event fields, pseudonymization, duration, access and immutable proof without retaining erased customer text |
| Backups and restore deletion replay | Backup tier/retention, protected deletion manifest independent of restored data, replay authority/order, fail-closed restore gate and manifest availability |
| External copies | Provider/transport/log/export copies, supported removal process, retained exceptions and verification evidence |
| Support and recovery | Named support access rules, verified account recovery, escalation, complaints and incident procedure |

## Implementation sequence after decisions

1. Inventory public and private relationships, constraints, triggers, background context/queue/replay/limit data, integration/import artifacts, shared Auth identities and approved external/backup copies. Extend the current partial impact preview; do not turn its counts directly into deletion instructions.
2. Add a versioned policy and version-bound execution plan with explicit denied/unapproved/held/uncertain states. A reviewed request or identity reference alone never grants execution. Recheck current scope, role, MFA, holds, case/policy versions and dependencies before committing.
3. Fence processing and revoke relevant work/access as defined by the approved policy. Execute bounded durable phases with audit, replay/conflict behavior and consistent failures; late jobs cannot recreate erased facts. Preserve unrelated tenants and a shared user's independent account access.
4. Persist minimized completion evidence and the separately protected deletion replay manifest. Define recovery for partial/unknown outcomes and reconcile provider usage/copies without an automatic second destructive operation.
5. Exercise synthetic actual SQL audit rollback, scope/role/hold/overlap, child relationships, idempotent replay, delayed worker/reply, shared-user closure and partial failure. Restore an actual isolated backup, replay the manifest before serving records, and prove erased data cannot reappear.
6. Verify those operations in approved staging with the purchased backup tier, documented operator procedure and reviewer sign-off. Only then expose the execution UI and accept A22.

The exact migration, executor and storage protocol depend on the decisions above. They are still unimplemented. Policy preparation can proceed locally; execution approval must refer to the concrete tested implementation. See PRIVACY_IMPACT.md, PRIVACY_RECOVERY.md, RUNBOOKS.md and RELEASE_CHECKLIST.md.
