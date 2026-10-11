# Controlled pilot preparation

Prepared locally on 11 October 2026 from PRODUCT_PLAN.md and LP BRD 001. This is a protocol and recording template. No partner recruitment, training, baseline observation or live pilot is claimed. Proposed targets require Product Owner approval before start; P9 remains not started.

## Start conditions and schedule

Release owner records the accepted staged revision, remaining permitted deviations, responsible operations contact and rollback procedure. Agency owner records partner consent, agreed intake sources, participating roles, supported languages, approved processing/data boundaries and limits. Use case references rather than names, customer text or credentials in review files. Keep approved source evidence in access-controlled storage.

1. Two baseline weeks: reconcile inquiries across the agreed sources, record inquiry time and first user-logged contact consistently, document missing data and working practices. Select comparable weekdays/source cohorts; preserve raw observation references without importing unrestricted customer data into a shared report.
2. Onboarding before pilot: owner creates the agency, sets timezone/limits and approved processing choices, invites staff, verifies access and practises create/assignment/contact/follow-up/outcome and recovery. Demonstrate reviewed copy versus external send, do-not-contact, stale AI, denied access and incident escalation. Use synthetic training leads.
3. At least four pilot weeks: review coverage, usage, reminders, AI samples and defects weekly. Optional AI stays disabled until its separate processing/rubric/provider/language gate passes; report disabled/not evaluated, not zero-quality results.
4. End review: compare the approved metrics, examine missing/biased data, collect willingness-to-pay evidence from at least two agencies and record expand/fix/stop with a named decision owner. No billing integration or invented price is needed for manual pilot terms.

## Metric dictionary

The BRD proposes these goals. Agree denominators and cutoffs before collecting data. Small/missing denominators are reported explicitly; no denominator means not measured.

| Metric / proposed target | Recording rule and evidence boundary |
| --- | --- |
| Invited agent activation: 80% | Distinct intended AGENT users who accepted and completed the agreed onboarding, divided by distinct intended invited AGENT users. Deduplicate resends; record exclusions such as withdrawn/departing invitees. Invitation creation alone is not activation. |
| Weekly adoption: 70% use on 3 days | Participating active AGENT users with meaningful CRM work on at least three distinct agreed agency-local days, divided by participating active AGENT users for that week. Define partial weeks and meaningful work in advance; sign-in, timer polls and AI job ticks do not prove adoption. Current CRM events are not a complete usage telemetry feed: use approved observation records and label gaps. |
| Intake capture: 90% | Valid inquiries saved from agreed pilot sources divided by valid inquiries independently reconciled from those sources. Record rejected/failed/duplicate inquiries separately; do not count two imports of one inquiry as coverage. |
| Reminder handling: 90% within 24h | Agreed task schedules completed or explicitly rescheduled within 24 hours after their original due instant, divided by schedules due in the measurement window. Define exclusions/cancellations in advance, preserve original schedule/event evidence and require a full 24-hour observation horizon. Current OPEN counts do not prove historical handling. |
| Contact latency: 25% median improvement | Baseline and pilot use the same eligible creation/source cohort and first user-reported outbound at/after creation. Compute (baseline median - pilot median) / baseline median. Report both medians, contacted/missing counts and time horizon; undefined if baseline is zero or absent. This is logged contact, not verified delivery. |
| AI usefulness: 70% sampled suggestions | Useful independent reviewed suggestions divided by the approved representative reviewed sample, recording incorrect/unsafe/unusable outcomes and language/source mix. Copy count, edit count and feedback entry count are separate observations. Avoid selecting only successful/copied outputs. |
| Extraction support: 95% populated fields | Populated extraction fields supported by exact permitted source evidence divided by populated fields in the approved sample. Record conflicts/unknowns, language, model/prompt/schema/rubric versions, failures and reviewer disagreements. Run at least 100 approved inquiries for the P5 live gate; constructed local contracts are not the sample. |
| Unauthorized release operations: zero | Record actual security/access incidents and reviewer checks. Zero observed incidents does not prove complete isolation; A01–A24 still require evidence. A critical isolation/data-loss/unsafe-send defect blocks continuation pending triage. |
| Willingness to pay: two agencies | Record dated interview/reference, workflow value, stated terms and decision confidence from two distinct partners. Do not interpret product usage as purchase intent or guaranteed revenue. |

## Weekly review record

Copy this blank record for each agency/week. It is intentionally unfilled.

| Field | Value |
| --- | --- |
| Agency pseudonym / reviewer / date | Pending |
| Revision / agreed timezone / week start and end | Pending |
| Partner/data/metric approval reference | Pending |
| Eligible agents / activated / three-day users | Pending |
| Source inquiries / saved / rejected / duplicate / missing | Pending |
| Due schedules / handled within 24h / excluded / immature observations | Pending |
| Contact median / contacted / missing / baseline cohort | Pending |
| AI enabled / reviewed sample / useful / incorrect / unsafe | Pending |
| Populated extraction fields / supported / conflicts / language split | Pending |
| Blocking defects / incident references / owner / due date | Pending |
| Training/support feedback and agreed fix | Pending |
| Willingness-to-pay interview reference | Pending |
| Continue / pause / fix / expand decision and owner | Pending |

Existing Dashboard, activity and reply feedback can contribute authorized observations, but do not produce a complete historical pilot dataset. No new telemetry, scoped data export, automated sending, scheduler or provider call is implied. Resolve any required collection/export capability and processing policy before adding it.
