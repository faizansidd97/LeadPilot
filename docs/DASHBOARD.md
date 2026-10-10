# P7 dashboard and product UX

The connected dashboard reads authorized database aggregates across the agency scope rather than counting a loaded inbox page. Its cards and pipeline open matching, paginated lead/task lists. Manual lead work remains independent of dashboard or AI availability. Preview is labelled session sample data and makes no hosted metric claim.

## Metric definitions

Dates are inclusive local calendar dates in the saved agency timezone. PostgreSQL converts the first midnight and the midnight after the final date to UTC; the end is exclusive. The default is the last 30 local calendar days including today. A range can contain at most 366 dates. Date input does not use the browser timezone or assume every day lasts 24 hours.

| Metric | Population / time basis | Matching list |
| --- | --- | --- |
| Total leads | Nonarchived leads created within the selected range and current scope | TOTAL |
| Qualified | Current QUALIFIED within that same creation cohort | QUALIFIED |
| Pipeline | Current status of each lead in the creation cohort | STAGE_NEW / CONTACTED / QUALIFIED / FOLLOW_UP / WON / LOST |
| Won | Nonarchived current WON with won_at inside the selected range, regardless of creation date | WON |
| Follow ups due | Visible OPEN tasks due at or before the displayed as_of on visible nonarchived leads; no creation-cohort filter | DUE |
| Unassigned | Nonarchived, nonterminal, unassigned leads; no creation-cohort filter; manager only | UNASSIGNED |
| First logged contact | First USER_REPORTED OUTBOUND occurred_at at/after creation and at/before as_of, among cohort leads with such a message | CONTACTED_IN_COHORT |

Contact latency is the median elapsed seconds from creation to that first eligible outbound, displayed in minutes, with the sample denominator and without-contact count. Multiple outbound rows do not inflate the sample. Entries before creation and future entries do not contribute. It measures user-reported logging; it is not verified contact/delivery or historic agent performance. A missing sample has a null median, distinct from a zero-minute sample. Preview does not fabricate contact evidence.

Reopened Won records leave the current Won metric. A Won pipeline count can differ from Won outcome-range count by design. Lost is a current pipeline stage; no historical lost-date report is invented. Each separately retained duplicate record counts once. Archived records do not contribute. Do-not-contact does not remove a lead from operational counts; outreach rules continue to apply elsewhere. The due definition includes visible OPEN tasks, including INTERNAL tasks; lifecycle/archiving transactions normally cancel ineligible work.

## Authorization and reconciliation

Migration 013 adds dashboard_summary and dashboard_drilldown behind verified cookie user clients. Narrow definer RPCs call verified/current membership checks and use one private row selector for both cards and lists. Owner/admin see current agency scope; AGENT sees currently assigned leads. Agent task totals additionally require current task assignment, matching parent/task visibility. Unassigned is unavailable to AGENT, rather than a misleading zero. Same-user roles in different agencies are independent; no caller supplies an actor or scope override.

Read functions are STABLE so aggregate queries observe the calling statement snapshot. Membership is checked on each call. Lists sort by time/id descending and use a cursor bound to actor, agency, metric, dates and as_of. Current scope and saved state are rechecked on every page. A displayed due cutoff remains fixed while paging; this is not a historical database snapshot across requests. Edits, new data, timezone changes or access changes can alter later pages; refresh metrics after such changes. A list snapshot expires after 24 hours. No database writes, AI calls, exports or outbound messages occur through these routes.

Each card's count and matching list are tested on the same fixed database fixture, including more than one page and tied timestamps. The server does not aggregate unauthorized children or send contacts/customer bodies in the summary. Authorized drilldowns return normal lead/task metadata, and opening a record uses the existing freshly authorized lead endpoint.

## UX and implementation

Date errors retain inputs and focus invalid fields through React Hook Form. Loading, unavailable error, genuine zero and no contact sample have distinct states. Failed reads do not replace metrics with zero. Requests are aborted/fenced across date, metric and tenant changes; retry buttons preserve current filters. Safe date/metric/view/status/archive filters are shareable in URLs; names, contacts, search text, tokens and tenant authority are excluded. Agency switching/sign-out clears URL filters and cached workspace records.

The UI now uses Tailwind utilities through its PostCSS plugin, while omitting Preflight to preserve existing form styles. This follows the supported plugin setup in [Tailwind's Next.js guide](https://tailwindcss.com/docs/installation/framework-guides/nextjs). Button/Dialog are maintained shadcn-style source components using CVA/Slot and Radix, with components.json aliases; the [manual shadcn installation guide](https://ui.shadcn.com/docs/installation/manual) supports maintaining source components in the project. This is incremental adoption; existing business forms retain their tested contracts.

Core Add lead and lead detail dialogs use Radix modal behavior, labelled titles/descriptions, focus containment, explicit focus return and busy-close handling. Dashboard lists are labelled tables; keyboard users can use native buttons/selects/date inputs. The workspace includes a skip link, responsive wrapped navigation/cards/forms, readable customer text, visible focus, improved text contrast and reduced-motion support. Browser checks remain required before claiming WCAG 2.2 AA conformance.

Settings now exposes a manager-only Integrations tab backed by the existing signed website configuration, with no duplicate business implementation. Agent navigation omits manager capture actions. Existing Overview/Facts/Conversation/AI/Reply drafts/Follow ups/Activity and Profile/Team/Agency/Pilot settings remain connected with their existing permission and version behavior.

## Setup and acceptance

Existing projects through 012 apply backend/supabase/migrations/202610070013_dashboard.sql once. Fresh projects apply the generated guarded setup.sql containing 001–013 once. Existing projects must not rerun that fresh bundle. Frontend dependencies/lockfile include Tailwind/PostCSS, React Hook Form, Radix and the source-component utilities. No external account or scheduler configuration is required for local development.

Local evidence on 7 October 2026: 330/330 regression tests, both package type checks and production build passed with bundled Node 24; eighteen checks are new dashboard coverage. Evidence is recorded in PRODUCT_PLAN.md and DEVELOPMENT.md. Dashboard tests cover calendar/DST boundaries, direct-RPC input denial, cross-tenant/shared-user/agent/task scope, revocation, count/list parity, Won reopening, duplicate records, contact sampling, paging and safe URL/cursor handling. They use PGlite with emulated Auth and do not establish hosted overlapping-connection performance.

Pending acceptance: hosted migrations/Auth/RLS and real concurrent connections; interactive desktop/tablet/mobile, keyboard/dialog/screen-reader/clipboard/retained-error journeys and WCAG review; production latency/load targets. Previous browser access denials remain respected. No hosted migration, browser workaround or deployment occurred. Next local milestone is P8 hardening, with unresolved privacy/retention/hosting approvals and measurements tracked separately in the product plan.
