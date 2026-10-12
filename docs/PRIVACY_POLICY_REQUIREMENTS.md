# Privacy execution requirements

This worksheet makes the remaining A22 implementation dependency concrete. It records requirements to decide; it is not an approved legal policy or a deletion authorization. Current Privacy supports request intake, identity-reference review, holds/history and a partial impact preview. It cannot erase leads, close agencies or replay deletions after restore.

12 October 2026 latest user decisions: retain anonymous history instead of permanently deleting records; keep that history for 30 days starting from anonymization; take daily backups and retain them for 7 days. The user also accepted the proposed requirement to reapply anonymization when restoring an older backup so customer identities do not return. These decisions supersede the earlier undecided mode/duration/frequency answers. Exact field treatment, expiry behavior, backup implementation and the remaining decisions below are still unresolved. These product settings do not enable execution or establish a complete implemented policy.

Anonymous history must no longer identify the customer. Implementation design must review direct identifiers and identifying content throughout messages, notes, revisions, facts, AI inputs/outputs, imports, replay/queue payloads and related copies; removing a name or hiding a record alone is insufficient. Define which non-identifying history can remain and how linkage and re-identification risks will be checked before implementation is accepted. These are design requirements to resolve, not an already implemented anonymizer.

The project owner and appropriate privacy reviewer must provide the remaining dated decision references before irreversible execution is designed. The confirmed 30-day history period applies after anonymization, not to active CRM records. Do not infer permanent deletion, indefinite retention, automatic extension or a retained summary after day 30: the user has not yet selected the expiry outcome. No residency, blanket retention exemption or paid backup tier has been selected.

## Confirmed product settings

| Setting | User decision on 12 October 2026 |
| --- | --- |
| Deletion mode | Anonymize identifying data and retain anonymous history rather than permanently deleting the record. |
| Anonymous history window | 30 days from anonymization; exact expiry outcome and treatment of audit/completion/restore evidence still require definition. |
| Backup frequency | Daily; exact schedule/timezone, monitoring and operator ownership remain to be configured. |
| Backup retention | 7 days; actual provider/tier, copied backups and expiry verification remain to be configured. |
| Restore requirement | Reapply anonymization before serving restored records; design a protected manifest independent of the restored backup and test replay. |

These are recorded decisions only. No backup job, provider configuration, data anonymization or expiry automation has been created. Supabase's managed daily backups and retention depend on the selected plan; Free projects require their own export/backup setup. Database backups do not include Storage objects, which require separate inventory and coverage if used. See [Supabase database backup documentation](https://supabase.com/docs/guides/platform/backups).

| Required decision | Value / evidence still needed |
| --- | --- |
| Processing authority and roles | Responsible agency/platform parties, notices/contracts, allowed data uses and any subprocessors |
| Regions and transfers | Approved database/Auth/storage/log/provider/backup regions and permitted transfers |
| Lead erasure result | User selected anonymous history instead of permanent record deletion on 12 October 2026. Define field-level anonymization, identifying free-text/copy treatment, identity matching, retained non-identifying history and completion proof. |
| Agency closure result | Membership/Auth ownership, revoked integrations/invitations, termination order, permitted post-closure access and user accounts shared with other agencies |
| Retention by record class | Anonymous history: 30 days from anonymization, confirmed by the user. Define day-30 expiry outcome and exact treatment of lead/contact/facts, messages/revisions, tasks, notifications, AI job/context/analysis/draft/feedback/attempts, activity/audit, imports, private replay/queue receipts, invitations and integration metadata. Active-record retention and separate completion/restore evidence are not inferred. |
| Holds and conflicting cases | Who can create/release a hold, required evidence, scope, priority and when ordinary CRM/processing must stop |
| Verification and execution authority | Required identity-verification reference, reviewer/executor roles, recent MFA, approval separation and error/appeal procedure |
| In-flight/uncertain processing | Worker fencing/cancellation, dispatched provider requests, charge reconciliation, late responses and records legally required for disputes |
| Audit minimization | Justified event fields, pseudonymization, duration, access and immutable proof without retaining erased customer text |
| Backups and restore deletion replay | Daily frequency and 7-day retention confirmed by the user, with anonymization reapplied on restore. Select actual backup tier/provider, schedule/timezone, all-copy coverage and expiry verification; define protected manifest retention/availability independent of restored data, replay authority/order and a fail-closed restore gate. |
| External copies | Provider/transport/log/export copies, supported removal process, retained exceptions and verification evidence |
| Support and recovery | Named support access rules, verified account recovery, escalation, complaints and incident procedure |

## Implementation sequence after decisions

Local preparation now includes PRIVACY_DATA_INVENTORY.md and its JSON companion. The offline tool classifies the 39 current public/private tables and one derived view, records declared dependencies and detects unreviewed metadata drift. This is reviewed local catalog coverage only. Hosted Auth/storage, function bodies, row/opaque-content attribution, external/provider/log/backup copies and the independent restore manifest are not inventoried or approved. The CLI never enables deletion or modifies its reviewed baseline automatically.

1. Inventory public and private relationships, constraints, triggers, background context/queue/replay/limit data, integration/import artifacts, shared Auth identities and approved external/backup copies. Extend the current partial impact preview; do not turn its counts directly into deletion instructions.
2. Add a versioned policy and version-bound execution plan with explicit denied/unapproved/held/uncertain states. A reviewed request or identity reference alone never grants execution. Recheck current scope, role, MFA, holds, case/policy versions and dependencies before committing.
3. Fence processing and revoke relevant work/access as defined by the approved policy. Execute bounded durable phases with audit, replay/conflict behavior and consistent failures; late jobs cannot recreate erased facts. Preserve unrelated tenants and a shared user's independent account access.
4. Persist minimized completion evidence and the separately protected deletion replay manifest. Define recovery for partial/unknown outcomes and reconcile provider usage/copies without an automatic second destructive operation.
5. Exercise synthetic actual SQL audit rollback, scope/role/hold/overlap, child relationships, idempotent replay, delayed worker/reply, shared-user closure and partial failure. Restore an actual isolated backup, replay the manifest before serving records, and prove erased data cannot reappear.
6. Verify those operations in approved staging with the purchased backup tier, documented operator procedure and reviewer sign-off. Only then expose the execution UI and accept A22.

The exact migration, executor and storage protocol depend on the decisions above. They are still unimplemented. Policy preparation can proceed locally; execution approval must refer to the concrete tested implementation. See PRIVACY_IMPACT.md, PRIVACY_RECOVERY.md, RUNBOOKS.md and RELEASE_CHECKLIST.md.
