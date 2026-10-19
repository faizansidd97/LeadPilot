# Offline privacy inventory tool

P8 thirtieth local development slice, 12 October 2026. This prepares the next A22 dependency without choosing retention periods, deleting/anonymizing data or enabling agency closure. The report covers the reviewed local public/private schema only; full privacy inventory and execution remain pending.

From backend with Node 22.18+:

```sh
node --experimental-strip-types scripts/privacy-inventory.mjs
node --experimental-strip-types scripts/privacy-inventory.mjs --check
```

The first command generates docs/PRIVACY_DATA_INVENTORY.json and docs/PRIVACY_DATA_INVENTORY.md. The second compares current migrated metadata, reviewed relation fingerprints, migration hashes and both saved artifacts; it writes no report. Both create and close an isolated PGlite database using current numbered migrations and emulated Auth references. They never connect remotely or read .env.local; unknown/remote/configuration arguments fail before database creation. No new Supabase migration or key is needed.

Inside that local database, metadata collection owns one repeatable READ ONLY transaction. It reads only pg_catalog relation/column/type/foreign/primary/unique/trigger/view-dependency/RLS-policy metadata. Row values, defaults, SQL function/view bodies, private credentials and actual hosted Auth/provider/storage data are not queried. On failure, rollback releases the transaction and a generic diagnostic is returned. The reader owns its local connection; do not run it inside another transaction or expose it as a user/worker API.

The current schema has 39 tables and one derived view. Each relation has an explicit record class, scope and review concerns. Fingerprints cover the collected column/type/nullability, foreign-key pairing/delete action/deferral, unique constraints, trigger identity/enabled state, policy name/roles/command and direct view dependencies. They do not prove complete SQL function behavior or authorize deletion. New/missing relations and changed collected metadata fail coverage; the CLI never changes the reviewed baseline. A reviewer must examine a schema change and manually update classifications/fingerprints and regenerate the report.

The metadata baseline does not hash RLS predicate/with-check expressions, SQL routine/trigger bodies or expression/index definitions. The saved artifact also binds the exact migration files, and full local evidence fingerprints source, but those checks do not replace manual review of logical behavior or a hosted schema inventory. Git attributes enforce LF text checkouts across Windows and Linux so migration/source byte checksums do not depend on OS line endings. Do not interpret a matching relation metadata hash as a complete security or deletion approval.

The report calls out original replay responses/outbox payloads, pending/invalid import rows without a saved lead, AI input contexts and provider correlation, aggregate usage, shared actor limits, global rotation receipts and key dependencies. Declared foreign keys include cycles and do not establish a safe execution order. Opaque JSON, logical IDs without a declared key, function bodies, hosted Auth beyond the fixture, extensions/default/index storage, platform/provider/support logs, local uploads/exports/clipboard state and backups still need separate review. No row attribution, automatic cascade, retention default or safe key retirement is inferred.

catalog_coverage_complete means the collected metadata agrees with the reviewed local registry. inventory_complete, retention_policy_approved and execution_available always remain false. Existing Privacy impact UI and its partial case-specific counts are unchanged. Scripts provide developer preparation, not a signed hosted inventory or privacy/release acceptance.

Ten new tests exercise actual schema rebuild stability, composite/cyclic relationships, opaque/shared scope classification, malformed contracts, added relations/columns and changed policy/trigger/key metadata. Synthetic private/customer sentinel records are absent from the report and before/after records are unchanged. An injected write fails in the actual READ ONLY transaction and rollback allows a later clean read. CLI checks reject remote arguments without printing the argument value. Full local verification additionally runs the saved artifact check; actual results are recorded in LOCAL_CHECKS.json and RELEASE_EVIDENCE.md.

Full local verification: 806/806 regressions, both package types, 100 analysis/56 draft contracts, privacy inventory artifact check and production build PASS. LOCAL_CHECKS.json records the exact verified source. The user confirms policy is not decided; execution remains unavailable.
