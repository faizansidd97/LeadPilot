# P6 human-reviewed reply drafts

P6 is implemented and locally verified. Reply assistance uses the P5 durable queue, private minimized context, fenced provider transport and shared daily/monthly operation ledger. AI remains disabled by default; manual Conversation logging remains available. Local evidence does not complete hosted or live usefulness acceptance.

## Configuration and migration

Existing projects through 011 apply backend/supabase/migrations/202610070012_drafts.sql once. Fresh projects apply the generated setup.sql containing 001–012 once; its existing-table guard prevents overwriting an initialized database. setup:supabase preserves environment values and adds the default-disabled AI_DRAFTS_ENABLED field.

Reply generation requires every documented P5 platform/tenant processing, model, rubric, approved-language and quota gate, plus server-only AI_DRAFTS_ENABLED=true and the synchronized private draft policy. English (en) and Arabic (ar) are the current draft choices; the requested language must also be approved in AI_APPROVED_LANGUAGES. No model is assumed or key embedded in browser code. See AI_ANALYSIS.md for the base configuration and privacy limitations.

An approved scheduler calls POST /api/internal/cron/drafts with Authorization: Bearer <CRON_SECRET> and the separately configured private worker client. GET exposes protected draft queue/failure/withholding counts. Query parameters and cookie identity cannot authorize a worker. Routes declare Node runtime/maxDuration=180; eligible hosting and a durable scheduler remain required and unprovisioned.

The worker synchronizes both base and draft policy, claims only DRAFT jobs, and starts at most three jobs within its 35-second claiming budget. P5 analysis workers claim only ANALYSIS jobs. Both kinds share the ten-new-jobs/user/hour guard, UTC daily/monthly operations and conservative token reservation. Same-input/parameter retries reuse the active draft; conflicting parameters require waiting or cancellation. Existing AI cancellation handles both job kinds. Three-attempt transient retry, fenced 90-second leases, observed usage and uncertain-charge RECONCILE behavior follow P5.

Disabling tenant AI/processing acts in SQL. Disabling the server draft flag blocks new HTTP generation/approval/copy; invoke the protected draft worker to synchronize the private SQL kill switch and cancel pending jobs. Already dispatched provider calls and already copied clipboard text cannot be recalled. Publication and receipt completion reauthorize current policy and access.

## Constrained generation and safety

The provider selects a strict draft-1 outline from fourteen maintained reply blocks, requested language/tone and exact versioned source excerpts for customer callback/viewing requests. The server renders the customer text. It acknowledges only human-confirmed intent, budget/currency and areas, or asks clarification questions. Availability wording explicitly requires checking before confirmation. A FRIENDLY tone adds a greeting. Instructions are bounded at 500 characters and can influence permitted block selection; they cannot introduce arbitrary generated promises or free prose.

This constrained catalogue is the initial P6 implementation choice recorded in PRODUCT_PLAN.md. There is no inventory source, listing retrieval, availability confirmation, return promise or legal/visa/financing conclusion. Provider output must pass strict schema plus semantic evidence validation. OpenAI documents strict structured output and refusal handling; schema compliance alone does not establish factual correctness. [Official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

Private snapshots reuse the 12,000-character P5 cap and permitted inbound context, exclude contact fields/internal notes/outbound/audit/unrelated records, and redact recognized contacts from instructions. Only authorized users can read published text. Provider transport uses store:false, no tools, fixed Responses endpoint, 25-second timeout and bounded response size. These settings do not constitute an approved retention or zero-data-retention policy.

A shared SQL/domain lexical screen withholds recognized unsupported availability, guarantee, finance/legal/visa, injection and script phrases, including selected Arabic patterns. This screen is limited: it can miss paraphrases and flag benign discussion. Human edits are free text and need substantive review; an empty flag list does not prove truthfulness. Arabic catalogue language, combined replies, provider selection and all actual customer use remain subject to bilingual review and live quality evaluation.

## Draft lifecycle and review

GENERATED → EDITED → APPROVED → COPIED records the working workflow. REJECTED requires a 5–500-character reason. WITHHELD records recognized unsafe output/edits or human UNSAFE feedback; a safe edit may create a fresh EDITED version for review. A newer generation supersedes earlier drafts; changed input makes previous results STALE/SUPERSEDED. Late results remain historical and produce no current-ready notice.

Original generated text is preserved separately from working text. Edits advance content/version and clear approval. Approval requires acknowledged=true and binds the reviewer, content/input versions, membership version and lead assignment version. Copy requires that same current reviewer and valid approval. Context changes, assignment cycles, archive/contact/terminal changes, membership changes, policy changes and revoked scope prevent reusing old approval. Regenerate after changed context; there is no stale-context override.

Current tenant membership and parent-lead visibility are rechecked before mutations and retry receipts. RLS exposes authorized history only; direct writes to drafts/feedback are denied. Critical text/state/receipt/message changes and audits commit atomically. Expected versions prevent silent concurrent overwrite.

The Reply drafts tab keeps unsaved editor text across refresh/errors and reports version conflicts. Users explicitly compare the latest server text before retaining local text against the new saved version or replacing it. Unsaved/conflicting edits prevent approval/copy. Preview explains availability and fabricates no drafts. History is paginated in 25-job pages with scoped polling and 429 backoff.

## Copy and actual external messages

1. Authorize copy against current approval; receive current text and a private actor/content/version-bound receipt expiring in two minutes. Authorization alone records no successful copy.
2. Write to the browser clipboard. Only after success submit the receipt completion. Completion records COPIED and a copy activity; replay is deduplicated.
3. The human sends externally. Separately enter the actual sent text and agency-local occurrence time, confirm actual sending and save the outbound conversation record. The draft panel requires a completed actor-owned copy; manual Conversation logging remains available for other external messages.

Clipboard and database cannot share an atomic transaction. If clipboard succeeds but completion fails or access/context changes, text may already be on the clipboard while the server records no COPIED state. The UI explains this and offers receipt retry where still valid. There is no automatic send, delivery claim or lifecycle change. Actual external logging requires current lead/draft versions, prevents future times and commits its message/audit/retry receipt together.

## Feedback and acceptance

USEFUL, INCORRECT, UNSAFE and UNHELPFUL feedback is an immutable separate observation tied to actor and content version, with an optional bounded comment. UNSAFE feedback clears approval and withholds a current draft; it cannot revive superseded history. Owner/admin summaries report tenant-scoped entry counts. Repeated feedback entries are observations, not unique-draft votes, a usefulness percentage or purchase probability.

Local verification: 312/312 backend tests, both package type checks and production build pass with bundled Node 24 on 7 October 2026. P6 adds 83 domain/provider/database tests including copy/edit/scope/replay/expiry, stale publication, policy/retry/usage, feedback, external-log and forced-audit rollback. Run backend evaluate:drafts for the 56 constructed outline-contract report in REPLY_EVALUATION.md. No real provider, hosted migration or customer message was used.

Pending: approved model/processing/languages, representative deidentified live-provider evaluation and proposed 70% sampled usefulness gate; bilingual reviewer evidence and unsupported-claim checks; hosted Auth/RLS/private role/concurrent connections/cron/latency/cost/reconciliation/retention; interactive clipboard, conflict and responsive keyboard journeys. Supabase credentials are still unavailable and prior browser denials remain respected. Next local development is P7 dashboard and product UX; release acceptance stays separate.

## P8 private provider attempt history

Migration 020 retains a durable private correlation UUID before successful analysis/draft preparation. Same-claim retries reuse the receipt and renewed leases get new IDs; workers require the recorded ID before provider dispatch. A narrow worker-only single-job diagnostic RPC/explicit operator command exposes bounded operational metadata without customer context or credentials. Journal failures roll back preparation atomically, and actual local restore/legacy upgrade are tested. The journal proves preparation only: provider idempotency, charge verification, historical completeness, approved refunds/reconciliation, hosted fleet and release acceptance remain pending. See AI_ATTEMPT_TRACKING.md.
