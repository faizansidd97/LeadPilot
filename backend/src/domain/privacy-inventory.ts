import {z} from 'zod';
const identifier=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),qualified=z.string().regex(/^(public|private|auth)\.[A-Za-z_][A-Za-z0-9_]{0,62}$/);
export const privacyCatalogSchema=z.array(z.object({name:qualified,kind:z.enum(['r','p','v','m']),rls:z.boolean(),forced_rls:z.boolean(),
 columns:z.array(z.object({name:identifier,type:z.string().min(1).max(256),nullable:z.boolean()}).strict()).min(1).max(500),
 foreign_keys:z.array(z.object({name:identifier,columns:z.array(identifier).min(1).max(32),target:qualified,target_columns:z.array(identifier).min(1).max(32),delete_action:z.enum(['a','r','c','n','d']),deferrable:z.boolean(),initially_deferred:z.boolean()}).strict()).max(100),
 unique_keys:z.array(z.object({name:identifier,kind:z.enum(['p','u']),columns:z.array(identifier).min(1).max(32)}).strict()).max(100),
 triggers:z.array(z.object({name:identifier,function_schema:identifier,function_name:identifier,enabled:z.enum(['O','D','R','A'])}).strict()).max(100),
 dependencies:z.array(qualified).max(500),
 policies:z.array(z.object({name:identifier,command:z.enum(['ALL','SELECT','INSERT','UPDATE','DELETE']),permissive:z.enum(['PERMISSIVE','RESTRICTIVE']),roles:z.array(identifier).max(100)}).strict()).max(100)
}).strict()).max(500);
export type PrivacyCatalog=z.infer<typeof privacyCatalogSchema>;
type Class={category:string;scope:string;review:string};
const classes:Record<string,Class>={
 workspace:{category:'Workspace and customer content',scope:'Tenant or explicit lead',review:'Define child handling and field-level retention; include archived/history and delayed writes.'},
 identity:{category:'Agency, membership and invitation identity',scope:'Tenant with shared Auth references',review:'Preserve independent memberships/accounts; define closure, revocation and retained attribution.'},
 audit:{category:'Audit and privacy review evidence',scope:'Tenant; some events have no lead reference',review:'Review reasons/details/verification references and minimized justified evidence; no blanket audit exemption.'},
 ai:{category:'AI processing, evidence and replies',scope:'Tenant or job-parent scope',review:'Fence active/late processing; inspect private input/output, provider copies and uncertain usage.'},
 import:{category:'Import content and progress',scope:'Tenant; rows may have no saved lead yet',review:'Review pending/invalid/duplicate payloads and errors; lead_id alone does not find all matching inquiry content.'},
 intake:{category:'Website intake and encrypted credentials',scope:'Tenant or integration parent',review:'Review captured event provenance, revoke access as approved and preserve required backup/key dependencies.'},
 queue:{category:'Private worker payload and replay',scope:'Tenant plus opaque entity/operation/payload links',review:'Inspect indirect/JSON references and late jobs; do not delete an entire tenant queue for one lead.'},
 usage:{category:'Usage reservations and accounting',scope:'Tenant aggregate; not individual lead attribution',review:'Resolve uncertain provider usage; a current aggregate is not a per-lead deletion target.'},
 actor:{category:'Shared actor limits',scope:'Cross-tenant Auth actor',review:'Do not remove another agency\'s actor state or Auth account through one agency closure.'},
 platform:{category:'Platform policy',scope:'Shared platform configuration',review:'Shared configuration is not a tenant deletion target; review operational retention separately.'},
 key:{category:'Signing/encryption issuance and operation evidence',scope:'Tenant issuance or opaque global operation',review:'Review original receipts/operator references and historical key/backup dependencies; never infer a safe key retirement.'},
 derived:{category:'Derived scanner view',scope:'Derived tenant/lead/task/recipient rows',review:'No stored view rows to purge; verify underlying records and processing fences.'}
};
const groups:Record<string,string[]>={
 workspace:['public.leads','public.messages','public.message_revisions','public.follow_ups','public.notifications'],
 identity:['public.agencies','public.memberships','public.invitations'],audit:['public.activity_events','public.privacy_cases','public.privacy_case_actions'],
 ai:['public.ai_jobs','public.ai_analyses','public.reply_drafts','public.draft_feedback','private.ai_context','private.ai_provider_attempts','private.draft_copy_receipts'],
 import:['private.lead_imports','private.lead_import_rows'],intake:['private.website_integrations','private.intake_events','private.intake_limits'],
 queue:['private.api_requests','private.outbox_events'],usage:['private.ai_usage_windows'],actor:['private.ai_submission_limits','private.request_limits'],
 platform:['private.ai_policy','private.ai_policy_events','private.draft_policy','private.intake_encryption_policy','private.intake_signing_policy','private.invitation_signing_policy'],
 key:['private.intake_encryption_operations','private.intake_signing_issuances','private.intake_signing_operations','private.invitation_issuances','private.invitation_signing_operations'],derived:['private.due_candidates']
};
export const privacyRelationReview:Readonly<Record<string,Class>>=Object.freeze(Object.fromEntries(Object.entries(groups).flatMap(([key,names])=>names.map(name=>[name,Object.freeze({...classes[key]})]))));
export const privacyExternalInventory=[
 'Hosted Auth accounts, sessions, MFA and provider storage beyond the emulated fixture',
 'Provider and mail transport copies, traces and charge reconciliation',
 'Backup snapshots, retained key rings and independent restored-deletion manifest',
 'Application, platform, support and external monitoring logs',
 'Operator files, CSV uploads, exports, clipboard/browser state and customer channels',
 'Function bodies, expression/index/extension storage and deployment-specific schema changes'
] as const;
