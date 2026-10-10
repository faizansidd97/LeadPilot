# LeadPilot delivery

Read ../docs/PRODUCT_PLAN.md and its execution tracker before a new milestone. Continue the first unfinished dependency and preserve completed slices. Update the plan with actual local/hosted/release evidence. BRD/FSD in ../docs remain the product baseline.

Keep domain/services/SQL/workers/tests in backend; Next UI/adapters stay in frontend. Root has only docs, frontend and backend. Use port 4000. User requests use verified cookie identity and RLS, never a broad privileged client. Critical mutations need versions, scope-safe replay where applicable and atomic audit. Add numbered migrations. Verify meaningful database permission/rollback behavior, both package type checks and production build for changed workflows.
