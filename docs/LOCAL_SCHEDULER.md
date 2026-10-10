# Local automatic reminders

This standalone development runner uses the existing private worker RPCs and SQL notification queue. It runs immediately, then every 60 seconds while the PC and runner are running. The browser tab and Next app do not need to stay open for queue processing; the product UI stays on localhost:4000. Sleeping/shutting down the PC pauses scanning. Start again to catch up eligible past-due OPEN tasks; database dedupe and fenced leases remain authoritative.

From `D:\Faizan Learning\LeadPilot\backend`, with Node >=22.18 installed:

```powershell
npm run worker:local
```

Keep that terminal running, or use a hidden background process as activated during this development session. This installs no Windows startup task or production scheduler. A PC restart requires starting the runner again. There is no fast interval or alternate endpoint option.

Check from another terminal in the same backend folder:

```powershell
npm run worker:status
```

Stop gracefully:

```powershell
npm run worker:stop
```

For a foreground process, Ctrl+C also stops it. The stop command requests cancellation through a session-bound local marker, aborts the active network/wait and removes its own lock. It does not force-kill a process. An interrupted database claim remains recoverable through the existing expiring lease. A lock prevents a second workspace runner. After a crash, verify the PID recorded in `backend/.cache/local-notifications.lock` is no longer running before removing that exact stale lock; do not delete the lock while its process is alive.

Only `--start` reads `frontend/.env.local` and makes worker connections. Configuration must have APP_URL `http://localhost:4000`, an HTTPS Supabase project base URL and a private worker credential. The runner refuses configured invitation mail transport and uses a dedicated link-only handler for any old invitation jobs. It never dispatches email or AI/provider jobs. It never reads business tables or authenticates as a user; its allowlist contains only notification/due/link-only worker RPCs. User APIs retain verified identity and RLS.

Runs are sequential, with a 45-second run deadline and eight-second request deadlines. Seeding remains bounded to 100 recipient pairs, processing to 20 jobs and new claims to the existing 20-second budget. A transient failure produces a safe unavailable result and the next scheduled pass retries; failed jobs retain their SQL retry budget and require existing operator recovery when exhausted. Slow runs skip missed ticks instead of bursting. A status-write failure stops the runner. This cadence is a development policy, not a production capacity or latency guarantee.

`backend/.cache/local-notifications.json` holds aggregate counts, safe queue metrics and the last eight completed results, without credentials, customer text, job/task/recipient identifiers or raw database errors. Its counts begin afresh for each process session. `--status` reports process presence and the last saved report; always check the timestamp/state, since a crash can leave a historical RUNNING report. Queue metrics can show ATTENTION through `alert:true` even when the RPC completed successfully.

`docs/DEV_LOCAL_SCHEDULER_CHECK.json` records the narrowly observed automatic cadence. The earlier manual due-notification smoke is in `docs/DEV_REMINDER_CHECK.json`. Local cadence does not establish protected HTTP cron, a deployed scheduler, recipient browser rendering, exactly-once email/provider delivery or release acceptance. The platform health contract's `scheduler_verified:false` remains unchanged until the actual deployment is accepted.
