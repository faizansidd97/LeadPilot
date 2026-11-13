# Private manifest store and scheduler setup

Prepared 13 November 2026. The Cloudflare Worker adapter and one-minute Cron Trigger are implemented and bundled locally. This is not evidence of a created bucket, applied hosted migration, deployed Worker, configured backup or active scheduler. Both Worker flags default to false; application execution and the database policy remain separate gates. No customer cleanup is part of infrastructure setup.

Current access observation: OAuth succeeded for the user-selected personal Cloudflare account. The account-scoped R2 API still returned 10042 after the user reported activation; bucket creation and deployment have not been attempted. Supabase/Vercel integrations are not connected. No credentials were printed or committed.

## Access and target

The existing target is LeadPilot on Vercel, with the configured Supabase project. Confirm current account/project IDs before changing either service. The stable application origin in the example configuration is `https://lead-pilot-five.vercel.app`; confirm that it is still the intended Production target and that the commit containing migration-024 application routes is deployed. Do not schedule an old preview deployment or silently promote developement to main.

Cloudflare account authorization is required separately. From `backend/manifest-store`, use the pinned CLI:

```powershell
npx --yes wrangler@4.160.1 login --scopes account:read user:read workers:write workers_scripts:write
npx --yes wrangler@4.160.1 whoami
```

Complete OAuth directly in the browser. Never put login codes or credentials in chat. If several accounts are returned, bind the intended account explicitly using `CLOUDFLARE_ACCOUNT_ID` for setup commands. An existing Cloudflare account does not prove R2 is activated. If R2 requires billing activation, the account owner must review that step; these commands do not purchase a plan. Approve the storage jurisdiction/region before creation. See [Cloudflare R2 setup](https://developers.cloudflare.com/r2/get-started/workers-api/).

## Migration 024

Use Supabase management access or the SQL editor for the already configured project. A service-role application key is not a management SQL credential. Before applying anything, inspect migration history/schema and run this read-only existence check:

```sql
select to_regclass('private.privacy_policy') as policy_table,
       to_regprocedure('public.prepare_privacy_execution(uuid,uuid,jsonb,uuid,uuid)') as prepare_rpc,
       to_regprocedure('public.read_privacy_execution(uuid,uuid)') as status_rpc,
       to_regprocedure('public.worker_claim_privacy()') as claim_rpc;
```

For an existing 001–023 schema, apply only `backend/supabase/migrations/20261019122219_privacy_anonymization.sql`. It has its own transaction. Never run the fresh `setup.sql` on existing tables or blindly use `db push` when earlier manually-applied migrations are absent from migration history. If any 024 objects already exist or an acknowledgement is lost, inspect the full schema before retrying. A partial/inconsistent schema requires operator review.

After applying, confirm the above objects, the expected service-only worker grants, and:

```sql
select enabled, version, history_days from private.privacy_policy;
select count(*) as privacy_relations, bool_and(c.relrowsecurity) as all_rls
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='private' and c.relname in
 ('privacy_policy','privacy_jobs','privacy_subjects','privacy_history','privacy_context',
  'privacy_intake_barriers','privacy_restore_gate','privacy_restore_receipts');
```

Expected initial policy: disabled/version 1/30 days; eight RLS-protected private relations. Do not enable the policy or invoke the worker as a migration smoke test. Record the exact target, migration digest and acknowledgement privately.

## Private R2 store

The reviewed example bucket name is `leadpilot-privacy-manifests`. In the intended account, first inspect whether that bucket exists. For a new bucket with approved placement, run:

```powershell
npx --yes wrangler@4.160.1 r2 bucket create leadpilot-privacy-manifests
```

Keep `r2.dev`, public custom domains and public bucket access disabled. Bind only this dedicated bucket in `wrangler.jsonc`; do not reuse the CRM database or its backup storage. There is no public list/delete API in the Worker.

Before enabling writes, configure an approved bucket-lock rule covering `manifests/` and inspect it with:

```powershell
npx --yes wrangler@4.160.1 r2 bucket lock list leadpilot-privacy-manifests
```

Use the [bucket lock settings](https://developers.cloudflare.com/r2/buckets/bucket-locks/) to prevent overwrites/deletes. The approved 30-day anonymous summary and seven-day daily-backup policy do not automatically define ledger retention. The ledger/key ring must outlive every restorable identifying backup and unfinished operation; confirm its retention and operator access separately. Locks can be changed by account administrators, so access separation and recovery evidence remain necessary. No bucket lock or data lifecycle is applied by this repository configuration.

The adapter authenticates all requests, validates exact signed manifest scope, accepts only GET/conditional PUT to `/manifests/<job UUID>.json`, bounds writes to 2 MiB and rejects extra customer fields, signature failures, overwrites and unknown key IDs. R2 conditional-create and bucket-lock races return a safe existing-object response only after confirming the object exists. The CRM still performs signed read-back before cleanup. Conditional semantics are based on the [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## Secrets and deployment

Generate and retain a random server-only manifest token (32–256 characters) and a 32-byte HMAC key represented by 64 lowercase hex characters. Retain the original token and all old signing keys across deploys/restores. Do not regenerate secrets on an ordinary redeploy.

Application configuration, in local `frontend/.env.local` and the correct Vercel environment:

```dotenv
PRIVACY_EXECUTION_ENABLED=false
PRIVACY_MANIFEST_STORE_URL=https://<worker-subdomain>.workers.dev/manifests
PRIVACY_MANIFEST_STORE_TOKEN=<private-random-token>
PRIVACY_MANIFEST_ACTIVE_KEY=v1
PRIVACY_MANIFEST_KEYS={"v1":"<64-lowercase-hex-characters>"}
```

Worker secrets: `PRIVACY_MANIFEST_STORE_TOKEN`, `PRIVACY_MANIFEST_KEYS`, and `CRON_SECRET`. The first two must exactly match application configuration; CRON_SECRET must match the server's worker authorization and be 32–256 characters. The Worker never receives a Supabase service key. The application worker still needs its existing server-only `SUPABASE_SERVICE_ROLE_KEY` and CRON_SECRET in the intended deployment environment.

Create a protected ignored `backend/manifest-store/.secrets.json` with these three string fields, then from that directory:

```powershell
npx --yes wrangler@4.160.1 secret bulk .secrets.json
npx --yes wrangler@4.160.1 deploy --dry-run --outdir ../.cache/privacy-manifest-worker
npx --yes wrangler@4.160.1 deploy
```

For a first deployment Wrangler may create the Worker while importing secrets; confirm the named target first. No secret values belong in wrangler.jsonc, source control, build logs or NEXT_PUBLIC_ names. The checked-in ignore rules cover .secrets.json, .dev.vars and .wrangler artifacts. CLI auth is stored outside the repository by Wrangler.

## Scheduler and activation

`wrangler.jsonc` declares `* * * * *` using the [Cloudflare scheduled handler](https://developers.cloudflare.com/workers/configuration/cron-triggers/). It calls only authenticated **POST /api/internal/privacy** at the configured application origin, never a query-string secret. Each invocation has a 45-second network timeout, refuses redirects, bounds/validates the worker acknowledgement and throws a fixed error on failure. A Vercel login page with HTTP 200 cannot count as success. There is no automatic immediate retry; SQL leases and idempotency remain authoritative. Cron timing is not an exact delivery SLA, and this schedules only privacy cleanup/expiry, not email, AI or notification workers.

Keep `MANIFEST_WRITES_ENABLED=false` and `PRIVACY_SCHEDULER_ENABLED=false` until the lock, independent recovery/export process, retained keys, application route/auth configuration and migration are verified. Then enable writes for a protected, synthetic manifest create/read/replay smoke. This does not require invoking a live cleanup job. Inspect all pending privacy work with authorized operator access before any worker smoke.

Enable actual execution only after operator acceptance: the deployed app's execution flag, the private database policy (with version increment), and Worker scheduler flag must all be deliberately enabled. Do not run or schedule existing jobs merely to prove infrastructure works. Stop scheduler/app enablement to pause future triggering; do not remove retained objects, jobs or barriers. Keep flags in the source configuration aligned with the approved deployment to avoid a later redeploy reverting an intentional activation.

## Current evidence

Local checks include adapter authentication, missing/oversized/invalid input, changed signatures/scope, replay and conditional/lock races, unavailable storage, CRM signed-readback integration, scheduler gates, bounded POST and malformed/HTML acknowledgements. The pinned Wrangler dry-run bundles the actual Worker with its R2 binding and disabled flags. Full local compiler/regression/build results are in LOCAL_CHECKS.json. These checks do not establish hosted durability, region approval, storage lock, complete export, concurrency, actual Cron delivery, migration application or release acceptance. Restore completeness and reopening remain the operator workflow in [PRIVACY_EXECUTION.md](PRIVACY_EXECUTION.md).
