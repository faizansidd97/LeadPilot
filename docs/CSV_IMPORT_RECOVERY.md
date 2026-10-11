# CSV import recovery

P8 twenty-sixth local slice, 11 October 2026. CSV capture now has its own scoped workflow, separate from the existing website signing panel. Schema stays 001–023; no new key or migration is required.

## Preparing and reviewing imports

The verified workspace's actor/agency/role mounting and Capture's agency/role/mode mounting isolate client state. Current cancellable tickets and a synchronous gate fence list/detail/preview/process/recovery actions. File decoding has its own generation guard; choosing a second file or closing the view prevents late publication from the first. Invalid UTF-8, oversized CSV, identity columns and column names longer than the existing API's 120-character bound are rejected. Mapping is restricted to supported CSV fields. Parsing an older file cannot reset a newer mapping.

Preparation captures the original CSV, mapping and random request key before awaiting. Lost or malformed preparation acknowledgements keep the original attempt and inputs; recovery repeats only that original request. A validated acknowledgement must have the expected total. Once acknowledged, failed detail/history refresh recovers with reads only. The file/mapping is cleared only after current validated detail and history reads succeed. No raw file or retry key is saved in browser storage.

History validates projected progress, reconciled totals, state/policy, bounded pages, descending full-precision timestamp/UUID ordering and final-row cursors. Detail binds the selected import ID, validates bounded contiguous 20-row pages and rejects changed summaries across continuation pages; first-page reload is required after concurrent progress changes. Preview fields are intentionally authorized customer data, validated against the capture contract. Completed/processing previews must be null. Raw unexpected response properties are discarded and unsupported error fields are rejected; retained row errors after prior failed attempts remain compatible with actual SQL.

Unavailable history/detail differs from confirmed empty results. Failed reads hide unverified counts and customer previews while keeping same-import confirmation inputs mounted and inert. Manual retry loads current saved state. Current 401/403/404 clears CSV, mapping, history, selected import and retry/hold state. Server verified cookie identity, active manager membership and tenant-scoped RPCs remain authoritative. Summary/list responses do not independently carry tenant or actor proof; client scope does not replace server authorization.

## Processing is a separate operation

The current process API has no per-batch idempotency receipt. Repeating its POST can process the next 25 pending rows or retry failed rows again, even when the body is identical. The earlier generic Capture retry wrapper therefore cannot safely recover processing by resubmission.

The new workflow never repeats a process POST to fix an uncertain acknowledgement or refresh failure. A known, validated process acknowledgement recovers detail/history with reads only, then publishes the completion callback. Unknown transport or malformed/mismatched process acknowledgements enter an inspection phase and an uncertainty hold. Recover import reads saved progress; it does not process more rows or claim that the individual request succeeded.

After successful inspection, the hold remains. Users can refresh saved progress again and explicitly choose “I reviewed progress; enable a new batch.” That action performs no POST. A separately requested Confirm/Resume/Retry then processes a new batch under current SQL policy and row authority. This does not establish exactly-once batches, identify which operator changed counts, or prove an earlier request cannot still commit later. Other managers, delayed requests and navigation remain reconciliation boundaries. Durable per-batch receipts would require a separate server/schema change.

Submitted confirmation data is captured before awaiting. Invalid input/conflict returns to read recovery without replay; a missing or denied import clears protected state. Existing SQL preserves duplicate policy once processing starts, row identity, maximum attempts, bounded batches and atomic audit. The client adds no automatic processing/retry scheduler.

CSV busy/pending/uncertainty state synchronously disables Capture tab changes; recovery remains available. Root navigation/unmount still discards mounted state and cannot undo a committed transaction. Inspect saved imports before repeating work after returning. Website signing APIs, encrypted secret handling and their earlier recovery implementation remain separate; this slice does not certify that workflow or perform website/provider actions.

## Local evidence and remaining acceptance

Sixteen new actual-helper checks cover projected/coherent summaries, history/cursor precision, contiguous detail paging, real retained retry errors, unavailable versus empty, duplicate gates, same-import read recovery, file/UTF-8/size/authority/header fences, original prepare body/key, read-only acknowledged recovery, uncertain-process hold/release, mismatched receipts, authorization clearing and late scope callbacks.

Two fixtures apply actual migrations 001–023 under emulated Auth. One prepares 27 rows, loads 20+7 detail rows, commits a first 25-row process before losing its response, inspects the saved 25/2 counts without another POST, then explicitly requests the final two rows. It verifies 27 distinct saved leads and agent/foreign-manager denial. The other proves unique prepare replay and forced-audit rollback with unchanged PREVIEW progress and no partial lead. These transports call actual SQL, not the Next HTTP entry or hosted PostgREST/Auth.

Focused CSV plus shared client checks pass 29/29. Initial extracted JSX and test-summary nullability typing issues were corrected before passing both package type checks; no focused runtime test failed. The final full run passes 740/740 regression tests, both package type checks, 100 analysis/56 draft constructed contracts and production build. Its current source fingerprint and timings are recorded in generated LOCAL_CHECKS.json and RELEASE_EVIDENCE.md.

Tests execute helpers and compile components. They do not establish mounted React file/mapping/reason retention, tab locks, keyboard/focus, screen-reader/mobile, delayed hosted commits, real concurrency or live release acceptance. No hosted/browser/API/provider/Auth/mail/worker/environment/key/schema/deployment action occurred. Hosted multi-agency/browser acceptance remains deferred. Development stays localhost:4000; P8 remains IN PROGRESS and P9 has not started.
