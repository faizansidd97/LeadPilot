# Development CI/CD

Added 19 October 2026 at the user's request. The branch is `developement`. `.github/workflows/ci.yml` is the necessary GitHub infrastructure exception to the three product-folder layout; Next.js stays in `frontend` with its sibling `backend` workspace.

## Checks

Pushes to `developement` or `main`, pull requests targeting either, and manual runs execute **Tests, types, contracts and build** on Ubuntu 24.04, Node 24 and pnpm 11.25.0. The frozen `frontend/pnpm-lock.yaml` installs both packages. The existing full verifier runs regressions, backend/frontend types, constructed analysis/draft contracts, saved privacy inventory verification and the production build.

This job uses synthetic isolated databases and no application/deployment secrets. It does not connect to Supabase, send mail or run provider jobs. A fresh verification manifest is uploaded for seven days; the checked-in manifest is removed first so an early failure cannot publish an old PASS. On verification failure the last bounded portion of that failed synthetic check's log is printed for diagnosis. Environment files, deployment output and browser state are never uploaded.

Official actions are pinned to full SHAs resolved from their v6 tags on 19 October. Checkout does not persist credentials. Permissions are `contents: read`; CI does not push generated evidence or comment/merge/change databases. New runs cancel superseded runs for the same workflow/ref.

Git attributes enforce LF for tracked text on Windows and Linux. The first hosted run passed 806 regressions, both type checks and both contract suites, then exposed an inventory migration checksum saved from mixed Windows line endings. The regenerated inventory binds canonical Git LF migration bytes; reviewed schema fingerprints and SQL content are unchanged. Full hosted verification after that correction is tracked by the Actions run, not inferred from the earlier partial run.

The next run exposed a pre-existing minute-boundary test flake in website intake: 60 separate rate-limit calls could straddle a new minute. The fixture now pins `now()` within one transaction, commits the denial state and verifies the persisted capped count. Runtime rate limiting and migrations are unchanged; the gate is not bypassed or weakened.

## Protected Preview deployment

After CI passes, a push/manual run on `developement` can deploy to Vercel Preview. PRs, forks and `main` cannot enter this job. It is disabled until repository variable `VERCEL_PREVIEW_DEPLOY_ENABLED` equals `true`.

| Target | Checked non-secret identifier |
| --- | --- |
| Team | `team_oALUEwZbzxonide0Y16W4mkr` (`fazeeqa50-3737s-projects`) |
| Existing LeadPilot project | `prj_uPXy3tjLwI2dGfXDM42lmffPLe8K` |
| Root Directory | `frontend` |
| Environment | Vercel Preview / GitHub `preview-deploy` |

The job checks out the exact verified revision, installs pinned Vercel CLI 64.3.1, pulls Preview settings including `developement` overrides, verifies the linked team/project/root, runs `vercel build` from the repository root and uploads that artifact with `vercel deploy --prebuilt`. No production command or promotion is present. The validated HTTPS `.vercel.app` URL appears in the job summary/environment; it is not hosted acceptance evidence.

`VERCEL_TOKEN` is an environment secret supplied only to pull/deploy steps, never a command argument. Pulled application credentials are available to the reviewed Preview build; use testing credentials. Cleanup removes generated `.vercel` directories even after failure; Git also ignores them.

`frontend/vercel.json` supplies the frozen pnpm install and Next.js build commands, correcting the reported build-as-install mistake. It disables Vercel native Git deployments **for `developement` only** to prevent duplicate/ungated previews. Thus that branch cannot deploy until Actions deployment is configured. Other branches retain their existing Vercel Git behavior; this workflow does not gate any separately configured `main` production deployment.

## One-time setup

1. GitHub **Settings > Environments**: create `preview-deploy`, allow only `developement`, add a required reviewer to approve each revision and disable protection bypass where supported. Do this before adding secrets or enabling deployment. If required reviewers are unavailable on the repository plan, protect `developement` with required PR reviews/checks before enabling secrets. An automatically created unprotected environment is not approval.
2. Add `VERCEL_TOKEN` directly to that environment's **Secrets**. It needs access to the exact Vercel team/project above. Never put its value in chat, YAML or a commit. The Vercel connector returned 403 for this scope on 19 October; listing the project does not prove deploy-token access. The workflow never falls back to another account/project.
3. Vercel settings: Root Directory `frontend`, Framework Next.js, Node 24, and **Include source files outside Root Directory in the Build Step** enabled. Install/build overrides are supplied by `frontend/vercel.json`.
4. Configure Vercel **Preview** variables and any `developement` overrides with the approved testing configuration: public Supabase URL/publishable key, server-only service key, stable invitation/intake secrets and cron secret where required. Keep AI disabled and optional mail unset until approved. Set `APP_URL` to the fixed approved testing HTTPS origin and configure its Auth redirect allowlist before connected user acceptance. Production-only variables are not automatically Preview values.
5. Once protection, credentials and Preview settings are ready, add repository **Actions variable** `VERCEL_PREVIEW_DEPLOY_ENABLED=true`. Push a reviewed revision to `developement`; checks must pass, then the environment reviewer approves deployment. Manual dispatch becomes available once the workflow is on the default branch; before that use the push trigger.
6. Require CI check **Tests, types, contracts and build** in branch protection where appropriate. This source change does not automatically create protections, reviewers, secrets or remote project settings.

CI can run immediately after push; Preview stays skipped until enabled. No deployment is established merely by committing these files. Migrations, scheduler/monitoring, backups, production promotion and release acceptance remain separate.

## Recovery

- Next.js missing: Root Directory must be `frontend`; the repository root has no package manifest.
- `next: command not found` during install: apply the committed install/build commands; install dependencies before building.
- Frozen lock failure: fix/review the real manifest/lock mismatch; keep the frozen flag.
- CI failure: inspect the failed step; deployment cannot run. Synthetic PASS never authorizes production.
- Preview skipped: check branch/event, successful CI and activation variable. Skipped means not deployed.
- Preview waiting: review the exact revision in the protected environment.
- 403 or target mismatch: correct the intended team's token access or root setting; do not change scope to bypass the error.
- Build/deploy failure: fix the cause and push a reviewed revision; recovery never promotes production or changes SQL.

References: [Vercel Actions guide](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel), [branch deployment configuration](https://vercel.com/docs/project-configuration/git-configuration), [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Source validation

Workflow syntax/expressions pass actionlint 1.7.12 (official Windows release verified against its published SHA256 checksum). Explicit install/build/branch rules and secret/production boundaries were checked locally. Application runtime behavior and schema are unchanged; canonical LF checkout and the minute-boundary fixture correction were verified by the full pipeline.

The [19 October successful Actions run](https://github.com/faizansidd97/LeadPilot/actions/runs/39224768716) on revision `5b8a33ae97a39f6e4e5df72f7f48a75f33934152` passed 806/806 regressions, both types, both contract suites, saved inventory verification and production build on Node 24.21.0 / Ubuntu 24.04. Its exact LOCAL_CHECKS.json artifact was downloaded and the ZIP digest `fa0b565d939a2ce329bbc96487bb3af5d2afe2af19d13cc2bd8e65e535749349` verified before saving it. Source fingerprint `f6db0772278fc259ec09d8015a94f336a3fd8da8758b683ff7cc56e10d822081` matches the local checkout. Preview was skipped because activation/configuration is still pending; no successful app deployment, environment protection or release acceptance is claimed.
