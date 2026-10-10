# Local database load observation

Generated 2026-10-07T11:26:10.553Z. PGlite 0.5.8, in-process PostgreSQL; v24.19.0, win32/x64.

Fixture: 10,000 synthetic leads, 1,000 OPEN internal tasks, 50 verified identities (10 managers/40 agents). One PGlite connection runs identities sequentially, two measured rounds and two warm-up identities. Scope assertions pass on every workload. SQL timings include the local JavaScript database call and result decoding, excluding identity switching; total fixture/workload duration 53022 ms.

| Query | Samples | p50 ms | p95 ms | p99 ms | Max ms |
| --- | --- | --- | --- | --- | --- |
| inbox | 100 | 310.1 | 405.51 | 437.27 | 437.48 |
| detail | 100 | 1.78 | 3.42 | 3.93 | 5.31 |
| dashboard | 100 | 31.85 | 568.22 | 612.71 | 632.92 |
| follow_ups | 100 | 32.85 | 52.34 | 64.18 | 78.21 |

This is not HTTP API latency, browser interactivity, hosted RLS/PostgREST behavior, write contention, 50 real concurrent users, AI latency, availability or purchased-tier backup RPO/RTO evidence. The proposed release targets remain pending. No live credentials or customer data were used.

Repeat from backend with Node >=22.18: `node --experimental-strip-types scripts/benchmark-local.mjs`. The isolated database is closed; no dump or customer data file is retained.
