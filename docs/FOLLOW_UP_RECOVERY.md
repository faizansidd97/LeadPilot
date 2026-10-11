# Follow-up queue recovery

P8 twenty-third local slice, 11 October 2026. All 689/689 regression tests, both package type checks, 100 analysis/56 draft constructed contracts and production build pass. Schema stays 001–023; no new key or migration is required. The standalone queue now owns scoped read/navigation recovery. Task creation, completion, rescheduling and cancellation remain in the existing versioned lead workflow.

## Queue snapshots and navigation

Agency, role and timezone changes remount the queue. Revision refreshes and effect cleanup abort/close the previous request controller. Current tickets also fence responses from transports that ignore abort. Refresh, paging, filters and opening share a synchronous gate, including before React renders a disabled button. Leaving the section clears the mounted helper's rows and prevents late workspace selection.

Only a validated current page publishes. Rows bind agency, selected task state and joined lead ID; bounded task titles, types, due timestamps, versions and joined lead names are projected. Unused notes, creator identifiers, contact fields and unexpected private response properties do not reach the queue model. Server cookie verification, active membership and current task/lead RLS remain authoritative.

Unavailable initial reads are distinct from a confirmed empty queue. A recoverable failed read preserves loaded rows in memory, while hiding previews and disabling opening/paging. Definitive 401/403/404 denial clears protected queue rows. Refresh queue is explicit read-only recovery from the first page. No read failure is shown as a confirmed empty result, and no write or automatic retry is introduced.

Opening performs a new scoped lead read and validates/projects its latest identity/version before the current synchronous workspace callback. It does not open a cached parent lead or perform a second unfenced parent request. An unavailable, malformed, foreign or denied lead prevents navigation and requires queue refresh. The lead dialog independently loads current details/tasks and continues to enforce mutation permissions. Opening a task is not proof that its state has remained unchanged since the queue page.

## Precise pagination

The API now encodes the original database due timestamp in its keyset cursor. Previously converting it through Date rounded away PostgreSQL microseconds and could repeat tasks that shared one millisecond. The cursor shape stays due_at/id, retaining existing API compatibility; no database revision is needed.

Client validation retains full timestamp precision and ascending UUID tie ordering, requires a full 100-row page for a next cursor and binds it to the final row. It rejects overlapping IDs or backward pages rather than silently dropping duplicates. A failed continuation keeps unavailable history until first-page refresh. Pages are current statement reads, not a frozen database snapshot: concurrent reschedules/state/assignment changes may still alter membership between pages. Refresh obtains a new queue; client validation does not prove real concurrent completeness or a transaction-wide snapshot.

## Verification boundaries

Fifteen new checks execute actual queue/helper contracts with deferred transports and one isolated SQL fixture. They cover projection, scope/filter/lead binding, malformed/oversized pages, microsecond order and cursor binding, duplicate gates, ignored abort/revision/paging/filter fences, unavailable versus empty, read-only recovery, latest projected lead opening and definitive access loss. The SQL fixture seeds 102 tasks within one millisecond, shows how rounding the cursor would revisit all 102, consumes both correct pages exactly once, preserves task/schedule versions during reads and proves current foreign-agency/inactive-member RLS visibility denial.

Focused queue and existing workflow checks pass 24/24. Initial test fixtures reused an ID across two distinct sample tasks and assumed one textual timestamp format; these fixtures were corrected to use distinct IDs and compare exact SQL timestamps. The final complete rerun passes all 689/689 regression tests, both package types, 100 analysis/56 draft constructed contracts and production build; generated LOCAL_CHECKS.json records the source fingerprint. The SQL transport models the existing route query under emulated Auth; it does not exercise the actual Next HTTP entry or hosted PostgREST/Auth.

The first complete run passed all fifteen new queue checks but failed the existing isolated runner process test (685/686 overall). A focused retry also failed; synthetic diagnostic instrumentation reproduced Windows EPERM during status-file replacement. The instrumentation was removed after identifying the fault. The shipped CLI now retries the same atomic rename up to five times for EPERM/EACCES/EBUSY, with 50/100/200/400 ms delays. It never repeats a worker tick during persistence retry; nontransient or persistent failures retain fail-closed shutdown. Three new injected checks cover transient success, bounded persistent failure and immediate disk-error failure. The actual isolated CLI start/status/duplicate/stop lifecycle passes after the fix. Combined queue/workflow/runner checks pass 39/39; final full rerun evidence is recorded separately. No real runner was restarted or real worker tick dispatched by this correction.

No mounted React/browser, keyboard/focus, actual pagination performance, hosted roles, concurrent writes, worker/provider dispatch or release acceptance is established. Existing development runner evidence is unchanged; it was not retested by this slice. Hosted multi-agency/browser testing remains deferred. Development uses localhost:4000; P8 remains IN PROGRESS and P9 has not started.
