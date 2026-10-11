# Dashboard metrics and drilldown recovery

P8 twenty-fourth local slice, 11 October 2026. All 706/706 regression tests, both package type checks, 100 analysis/56 draft constructed contracts and production build pass. Schema remains 001–023; no new key or migration is required.

## Current metrics and lists

Agency, actor, role and timezone changes remount the Dashboard. Revision refreshes and effect cleanup cancel the previous controller. Current request tickets fence late results even when transport ignores abort. Date submission, refresh, metric selection, paging and lead opening share a synchronous action gate. Close list remains available to cancel a pending list or lead-opening read.

Summary validation projects the displayed fields, checks requested dates/timezone/role, coherent pipeline/contact counts and manager versus assigned scope. Date checks handle agency calendar days, including DST. They do not independently prove exact SQL midnight calculations or metric accuracy. Current verified cookie identity, membership and server RPC/RLS remain authoritative; the summary response itself does not carry independent actor/agency identity proof.

Read failure preserves requested dates without displaying unverified counts as zero. Only a successful current summary resets accepted form dates or publishes a shared date range. Invalid input performs no request. List loading and failure mask unverified record previews and disable opening/paging. Retry list starts from the first page. Confirmed empty lists have a separate state. A current 401/403/404 clears protected summary and list state. Date and metric URL parameters contain no customer or actor identifiers, cursor or secret.

Pages validate bounded projected lead/task fields, agency and row identity, metric membership, descending timestamp/UUID order and duplicates. Unused contact fields, notes, creators and unexpected private response properties are discarded. A next cursor binds current agency/actor, dates, metric, snapshot cutoff and final row. Opening first obtains the latest scoped projected lead and uses a current synchronous workspace callback; cached parent rows and the separate unfenced parent request are removed. Removed, archived, denied or malformed targets prevent navigation. The lead dialog still independently loads current details and permissions.

## Timestamp precision and limits

Dashboard cursors now retain the original PostgreSQL timestamp. Converting descending creation-time boundaries through Date previously discarded microseconds and could skip matching records within the last row's millisecond. Client ordering and cursor checks retain full precision, including equivalent timestamp offsets. No SQL definition or cursor shape changes.

Summary counts describe their displayed snapshot. Later pages recheck current state and access; they are not a frozen historical database snapshot. Concurrent creation, assignment, status or task changes can change membership. Page validation does not assert that subsequent list length equals the earlier aggregate or establish concurrent completeness. Existing SQL metric definitions, snapshot age checks and server authority remain unchanged.

Temporary failures retain hidden history only in mounted memory. Leaving the view discards that state. This workflow adds no mutation, automatic retry, polling or durable browser storage, and does not serialize cookies or work across tabs.

## Local verification

Seventeen new tests execute the real summary/page/workflow helpers with injected or deferred transport. They cover projection, role/date/timezone/count consistency, DST, every metric, microsecond order, actor/agency/range/cutoff cursor binding, synchronous duplicate gates, unavailable versus empty, retained dates, ignored abort/effect replay, close-list selection and navigation fences, failed continuation/retry, overlapping pages, definitive access loss and latest projected lead opening.

One test applies actual migrations 001–023 to an isolated PostgreSQL emulator, seeds 32 leads within one millisecond and consumes 25 plus 7 rows exactly once using the shared server cursor helper. It checks current assigned scope, latest lead reads, unchanged lead versions and foreign-agency/inactive-member denial. The injected transport runs actual SQL under emulated Auth; it does not exercise the Next HTTP entry, hosted cookies or PostgREST.

Focused Dashboard checks pass 35/35. Initial type checks identified two component summary/pipeline typing issues and two test-only narrowing issues; these were corrected before both package types and the final complete verification passed. No focused runtime test failed. The generated LOCAL_CHECKS.json records the final source fingerprint and all passing checks.

Tests execute helpers and compile components; they do not mount React or prove URL/form retention, keyboard/focus, responsive layout, assistive technology or real hosted acceptance. Hosted multi-agency/browser testing remains deferred. No hosted API, provider, worker, Auth, mail, environment, key, schema or deployment action occurred. Development remains localhost:4000. P8 remains IN PROGRESS; P9 has not started.
