# Application screen recovery

19 October 2026 P8 continuation, independent of unfinished MFA and policy-dependent privacy execution.

## Implemented behavior

- `frontend/src/app/error.tsx` replaces an unexpectedly failed route render with a recovery screen. The user can explicitly invoke the installed Next.js `retry` callback to refetch/rerender that segment, or navigate to the workspace.
- `frontend/src/app/global-error.tsx` handles root-layout/template failure with its own English document, title, body and independently imported styles. It does not depend on the normal layout, workspace state, API client, icon library, database or global stylesheet.
- `frontend/src/app/not-found.tsx` gives missing pages a fixed explanation and canonical workspace link. It does not echo the requested path, query, invitation fragment or other potentially private URL content.
- The shared view focuses its heading on mount, uses semantic headings/main content and normal links/buttons, provides visible keyboard focus and at least 44px action height, and wraps at narrow widths. It includes no animation, external asset or automatic navigation.

The application fallback never reads, renders or forwards the caught error object, message, stack or digest. It adds no error-reporting transport or console logging; existing framework/platform logging behavior is unchanged. No customer/contact/session information is part of its props or rendered copy. Both workspace links are the fixed `/` destination, using normal document navigation without private query/fragment forwarding or prefetch behavior.

## Saving and recovery boundaries

An unexpected render failure cannot establish whether an earlier mutation committed. The screen explicitly warns that a change may already be saved, tells the user to inspect the current record before submitting again, and says unsaved text may need to be entered again. The fallback does not claim rollback, guaranteed input preservation, exactly-once saves or that a retry resumes the original mutation.

There is no automatic retry, mutation call or saved-request persistence in the recovery component. The retry button invokes only the framework's render/refetch callback in response to user input; existing on-mount flows read session/data, while business mutations remain explicit actions. Expected API/form errors and their original-request recovery continue through the existing workflow components. Event-handler and asynchronous errors are not generally caught by a React render boundary; those existing handlers remain necessary.

An invitation error followed by a reload may require reopening the original complete invitation link after its fragment has been scrubbed. No token is reconstructed or automatically accepted by this fallback. Root-layout failure may also prevent some ordinary metadata/security rendering; real TLS/proxy and browser checks remain part of A24.

## Verification and limits

Implementation follows the installed Next.js 16.3.8 error-handling, error-file and not-found-file guides, including its `retry` callback and standalone global-error document requirements. Complete local verification at 2026-10-19T12:08:48.977Z passes 812/812 existing regressions, both package types, 100 analysis/56 draft constructed contracts, saved privacy inventory and production build. Generated LOCAL_CHECKS.json binds 317 source files; RELEASE_EVIDENCE.md records the fingerprint/timings. No extra regression count is claimed for presentation alone. Source review checks fixed copy/destinations, no error-object access/logging, no API/credential imports, stable hook order and scoped independent styles. Build-generated next-env.d.ts import-path changes are restored rather than committed.

Mounted exception injection, failed root-layout rendering, retry behavior through the real browser, CSS delivery under the actual nonce/TLS proxy, focus/screen-reader announcements and narrow-screen layout remain unverified. Existing localhost browser restrictions were preserved; no alternate port/origin was used to bypass them. This change does not deploy Production or complete A24. No SQL migration, credentials, hosted account/MFA change, mail, AI/provider call or worker action is required.
