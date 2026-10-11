# Local privacy schema inventory

Catalog coverage: COMPLETE for the reviewed local public/private schema. 39 tables and 1 views. This is catalog metadata only; full data inventory, approved retention and deletion execution remain unavailable. No record values or live credentials are read.

| Relation | Kind | Record class | Scope to review | Foreign keys | Opaque fields |
| --- | --- | --- | --- | ---: | --- |
| private.ai_context | Table | AI processing, evidence and replies | Tenant or job-parent scope | 1 | snapshot |
| private.ai_policy | Table | Platform policy | Shared platform configuration | 0 | None |
| private.ai_policy_events | Table | Platform policy | Shared platform configuration | 0 | None |
| private.ai_provider_attempts | Table | AI processing, evidence and replies | Tenant or job-parent scope | 1 | None |
| private.ai_submission_limits | Table | Shared actor limits | Cross-tenant Auth actor | 1 | None |
| private.ai_usage_windows | Table | Usage reservations and accounting | Tenant aggregate; not individual lead attribution | 1 | None |
| private.api_requests | Table | Private worker payload and replay | Tenant plus opaque entity/operation/payload links | 0 | response |
| private.draft_copy_receipts | Table | AI processing, evidence and replies | Tenant or job-parent scope | 2 | None |
| private.draft_policy | Table | Platform policy | Shared platform configuration | 0 | None |
| private.due_candidates | View | Derived scanner view | Derived tenant/lead/task/recipient rows | 0 | None |
| private.intake_encryption_operations | Table | Signing/encryption issuance and operation evidence | Tenant issuance or opaque global operation | 0 | response |
| private.intake_encryption_policy | Table | Platform policy | Shared platform configuration | 0 | None |
| private.intake_events | Table | Website intake and encrypted credentials | Tenant or integration parent | 2 | None |
| private.intake_limits | Table | Website intake and encrypted credentials | Tenant or integration parent | 1 | None |
| private.intake_signing_issuances | Table | Signing/encryption issuance and operation evidence | Tenant issuance or opaque global operation | 0 | None |
| private.intake_signing_operations | Table | Signing/encryption issuance and operation evidence | Tenant issuance or opaque global operation | 0 | response |
| private.intake_signing_policy | Table | Platform policy | Shared platform configuration | 0 | None |
| private.invitation_issuances | Table | Signing/encryption issuance and operation evidence | Tenant issuance or opaque global operation | 0 | None |
| private.invitation_signing_operations | Table | Signing/encryption issuance and operation evidence | Tenant issuance or opaque global operation | 0 | response |
| private.invitation_signing_policy | Table | Platform policy | Shared platform configuration | 0 | None |
| private.lead_import_rows | Table | Import content and progress | Tenant; rows may have no saved lead yet | 2 | payload, errors |
| private.lead_imports | Table | Import content and progress | Tenant; rows may have no saved lead yet | 2 | None |
| private.outbox_events | Table | Private worker payload and replay | Tenant plus opaque entity/operation/payload links | 1 | payload |
| private.request_limits | Table | Shared actor limits | Cross-tenant Auth actor | 1 | None |
| private.website_integrations | Table | Website intake and encrypted credentials | Tenant or integration parent | 3 | None |
| public.activity_events | Table | Audit and privacy review evidence | Tenant; some events have no lead reference | 3 | details |
| public.agencies | Table | Agency, membership and invitation identity | Tenant with shared Auth references | 0 | None |
| public.ai_analyses | Table | AI processing, evidence and replies | Tenant or job-parent scope | 1 | result |
| public.ai_jobs | Table | AI processing, evidence and replies | Tenant or job-parent scope | 4 | None |
| public.draft_feedback | Table | AI processing, evidence and replies | Tenant or job-parent scope | 2 | None |
| public.follow_ups | Table | Workspace and customer content | Tenant or explicit lead | 4 | None |
| public.invitations | Table | Agency, membership and invitation identity | Tenant with shared Auth references | 4 | None |
| public.leads | Table | Workspace and customer content | Tenant or explicit lead | 4 | reported_facts |
| public.memberships | Table | Agency, membership and invitation identity | Tenant with shared Auth references | 2 | None |
| public.message_revisions | Table | Workspace and customer content | Tenant or explicit lead | 3 | None |
| public.messages | Table | Workspace and customer content | Tenant or explicit lead | 2 | None |
| public.notifications | Table | Workspace and customer content | Tenant or explicit lead | 4 | None |
| public.privacy_case_actions | Table | Audit and privacy review evidence | Tenant; some events have no lead reference | 2 | None |
| public.privacy_cases | Table | Audit and privacy review evidence | Tenant; some events have no lead reference | 4 | None |
| public.reply_drafts | Table | AI processing, evidence and replies | Tenant or job-parent scope | 2 | safety_flags, outline |

## Review before execution

- private.ai_context: Fence active/late processing; inspect private input/output, provider copies and uncertain usage.
- private.ai_policy: Shared configuration is not a tenant deletion target; review operational retention separately.
- private.ai_policy_events: Shared configuration is not a tenant deletion target; review operational retention separately.
- private.ai_provider_attempts: Fence active/late processing; inspect private input/output, provider copies and uncertain usage.
- private.ai_submission_limits: Do not remove another agency's actor state or Auth account through one agency closure.
- private.ai_usage_windows: Resolve uncertain provider usage; a current aggregate is not a per-lead deletion target.
- private.api_requests: Inspect indirect/JSON references and late jobs; do not delete an entire tenant queue for one lead.
- private.draft_copy_receipts: Fence active/late processing; inspect private input/output, provider copies and uncertain usage.
- private.draft_policy: Shared configuration is not a tenant deletion target; review operational retention separately.
- private.due_candidates: No stored view rows to purge; verify underlying records and processing fences.
- private.intake_encryption_operations: Review original receipts/operator references and historical key/backup dependencies; never infer a safe key retirement.
- private.intake_encryption_policy: Shared configuration is not a tenant deletion target; review operational retention separately.
- private.intake_events: Review captured event provenance, revoke access as approved and preserve required backup/key dependencies.
- private.intake_limits: Review captured event provenance, revoke access as approved and preserve required backup/key dependencies.
- private.intake_signing_issuances: Review original receipts/operator references and historical key/backup dependencies; never infer a safe key retirement.
- private.intake_signing_operations: Review original receipts/operator references and historical key/backup dependencies; never infer a safe key retirement.
- private.intake_signing_policy: Shared configuration is not a tenant deletion target; review operational retention separately.
- private.invitation_issuances: Review original receipts/operator references and historical key/backup dependencies; never infer a safe key retirement.
- private.invitation_signing_operations: Review original receipts/operator references and historical key/backup dependencies; never infer a safe key retirement.
- private.invitation_signing_policy: Shared configuration is not a tenant deletion target; review operational retention separately.
- private.lead_import_rows: Review pending/invalid/duplicate payloads and errors; lead_id alone does not find all matching inquiry content.
- private.lead_imports: Review pending/invalid/duplicate payloads and errors; lead_id alone does not find all matching inquiry content.
- private.outbox_events: Inspect indirect/JSON references and late jobs; do not delete an entire tenant queue for one lead.
- private.request_limits: Do not remove another agency's actor state or Auth account through one agency closure.
- private.website_integrations: Review captured event provenance, revoke access as approved and preserve required backup/key dependencies.
- public.activity_events: Review reasons/details/verification references and minimized justified evidence; no blanket audit exemption.
- public.agencies: Preserve independent memberships/accounts; define closure, revocation and retained attribution.
- public.ai_analyses: Fence active/late processing; inspect private input/output, provider copies and uncertain usage.
- public.ai_jobs: Fence active/late processing; inspect private input/output, provider copies and uncertain usage.
- public.draft_feedback: Fence active/late processing; inspect private input/output, provider copies and uncertain usage.
- public.follow_ups: Define child handling and field-level retention; include archived/history and delayed writes.
- public.invitations: Preserve independent memberships/accounts; define closure, revocation and retained attribution.
- public.leads: Define child handling and field-level retention; include archived/history and delayed writes.
- public.memberships: Preserve independent memberships/accounts; define closure, revocation and retained attribution.
- public.message_revisions: Define child handling and field-level retention; include archived/history and delayed writes.
- public.messages: Define child handling and field-level retention; include archived/history and delayed writes.
- public.notifications: Define child handling and field-level retention; include archived/history and delayed writes.
- public.privacy_case_actions: Review reasons/details/verification references and minimized justified evidence; no blanket audit exemption.
- public.privacy_cases: Review reasons/details/verification references and minimized justified evidence; no blanket audit exemption.
- public.reply_drafts: Fence active/late processing; inspect private input/output, provider copies and uncertain usage.

The JSON companion records every column/type/nullability, declared foreign-key delete action, primary/unique constraint, trigger identity, RLS policy name/roles/command and direct view dependency. It does not classify SQL function bodies or inspect defaults, index expressions, provider schemas, row values or deployment-specific extensions. Foreign-key graph cycles and absent/opaque lead references require a reviewed plan; no deletion order, auto-cascade or safe key retirement is inferred. New/missing relations or reviewed metadata changes fail the coverage check.

## External inventory still pending

- Hosted Auth accounts, sessions, MFA and provider storage beyond the emulated fixture: NOT_INSPECTED
- Provider and mail transport copies, traces and charge reconciliation: NOT_INSPECTED
- Backup snapshots, retained key rings and independent restored-deletion manifest: NOT_INSPECTED
- Application, platform, support and external monitoring logs: NOT_INSPECTED
- Operator files, CSV uploads, exports, clipboard/browser state and customer channels: NOT_INSPECTED
- Function bodies, expression/index/extension storage and deployment-specific schema changes: NOT_INSPECTED

See PRIVACY_POLICY_REQUIREMENTS.md and PRIVACY_IMPACT.md. The existing case impact preview remains partial; this developer tool neither enables that UI nor grants execution authority.
