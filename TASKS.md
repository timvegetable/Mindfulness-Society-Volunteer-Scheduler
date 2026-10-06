# Implementation evidence

Canonical requirements: local `plan.md`. All work uses local resources or deterministic fakes.

- [x] Stage 1: shared schemas and pure domain foundation; domain/schema unit tests
- [x] Stage 2: local D1 schema, repositories, atomic revisions/idempotency; real Miniflare D1 integration tests
- [x] Stage 3: Effect capability services and live/test implementations; adapter and JWT tests
- [x] Stage 4: authenticated API, all 45 role/operation combinations, concurrency and replay tests
- [x] Stage 5: volunteer dashboard, availability, exceptions, cancellation and post-commit notification tests
- [x] Stage 6: preview, atomic publication, history and stale state tests
- [x] Stage 7: candidate edits, advisory coverage, dated confirmation and conflict tests
- [x] Stage 8: fixture-based WhenIsGood parsing, matching, staging, atomic promotion and provenance tests
- [x] Stage 9: live insights, sortable leftover-volunteer table and accessible numeric heatmap; domain and DOM tests
- [x] Stage 10: all role surfaces, in-memory credentials and confirmations; client API and DOM tests
- [x] Stage 11: full tests, type checks, client/Worker build, local HTTP smoke checks and dry run
- [x] Stage 12: sortable availability-overlap table alongside the heatmap, responsive containment, and client functional coverage

## Verification on 2026-10-04

- Dependency installation completed successfully; no reported npm vulnerabilities.
- `npm test`: **193 tests passed across 11 files**. Includes real local D1 transactional rollback, concurrent writes, durable replay, role coverage, and all application workflows.
- `npm run check`: both Worker/test and client strict TypeScript checks passed.
- `npm run build`: Vite client build and `wrangler deploy --dry-run` passed. No deployment occurred.
- `wrangler d1 execute DB --local --file=schema.sql` and the synthetic seed load succeeded; a local query verified **five synthetic volunteers**.
- `npm run dev` started Wrangler on port 8787 and Vite on port 5173. HTTP checks verified static client delivery, public configuration, method rejection, and rejected unknown-operation requests through both the Worker and Vite proxy.
- Regression evidence: mapping updates selected an unrelated staged import before the fix; tied import timestamps selected an older preview before the fix. Both focused regressions pass after the fixes, including an A → B → A preview sequence.
- Regression evidence: a nonempty malformed participant availability staged an empty replacement before the parser fix. It now records a failed import and preserves saved availability; explicitly empty availability remains valid.
- Client behavior tests verify role navigation, cancellation dismissal, reviewed publication revisions, scoped center controls, heatmap details, placeholder configuration, and sign-out.

## Local integration verification on 2026-10-05

- Restored the locked dependencies with `npm ci`; no vulnerabilities were reported.
- Confirmed `.dev.vars` and the private root `seed.sql` are ignored and untracked. Validated configuration formats and private file permissions without printing values. A blank `EMAIL_API_KEY` is accepted as intentionally disabled local email.
- Checked the existing local D1 schema and revision metadata read-only. Did not initialize, reload, or modify the private roster.
- `npm test`: **193 tests passed across 11 files**, using synthetic fixtures and mocks in disposable test databases.
- `npm run check`: both strict TypeScript checks passed.
- Vite production build and `wrangler deploy --dry-run` passed. Child-process output and Wrangler disk logs were disabled during checks involving private configuration.
- Verified static client delivery, local configuration overrides, API method rejection, and unknown-operation rejection through both the local Worker and the Vite proxy. No authenticated operations were invoked.
- Changed the development client host to `localhost` to match the Google JavaScript origin configured by the integration wizard.
- Verified that `.dev.vars` and `seed.sql` remained unchanged. Sent no real email, fetched no live WhenIsGood results, and made no production writes.

## Operator setup and remaining manual verification

### Sign-in transport regression on 2026-10-05

- Both authorized accounts encountered the client transport error during interactive sign-in. Synthetic HTTP requests confirmed that the local Worker and Vite proxy were reachable.
- Added a receiver-sensitive fetch regression: invoking native browser fetch as an `ApiClient` method reproduced the exact transport error. API calls now invoke the fetch function without binding the client as its receiver.
- `npm test`: **194 tests passed across 11 files** with synthetic data and disposable local databases. Strict TypeScript checks and the Vite production build passed.
- Reloaded the corrected local client. Interactive sign-in confirmation remains pending because browser-control activation of the Google iframe button does not open its dialog; direct user activation is required in this environment.
- Follow-up verification exposed an authentication rejection that was cleared when the client rebuilt the sign-in page. Rejections now remain visible; the retained functional test covers rejected sign-in, explanation, and successful retry. The implementation-specific fetch regression was removed at the user's request.
- An isolated temporary Worker probe reproduced native fetch's incorrect-receiver error while fetching Google's public signing keys; the standalone invocation returned a valid key set. Corrected the same invocation in Google authentication, email, and WhenIsGood adapters. Email and WhenIsGood validation uses mocks only.
- Read-only local account checks confirmed the specified admin account is active. The specified volunteer account is absent from local users; no roster data was changed.
- Interactive admin sign-in succeeded. The Schedule view initially rejected legacy stored shortfalls using `unfilled`; database decoding now maps that field to `missing` without changing stored records. A read-only temporary field-validation diagnostic failed before the fix and passed after it, then was deleted.
- Confirmed Schedule, import form, center proposals, and Insights load without errors using the signed-in admin account. No import preview or mutation controls were activated.
- Layout measurements found Insights expanded the mobile page to 682px at a 390px viewport. A bounded content-grid column now contains wide tables/heatmaps within their horizontal scroll areas; both Insights and Schedule passed the 390px page-overflow check.
- Full functional suite: **194 tests passed across 11 files**; strict TypeScript and Vite build passed. Screenshot capture was rejected by automatic approval review because private roster rows could appear; screenshot-based visual verification remains incomplete.

- [x] Export the production domain tables into the ignored private root `seed.sql`, validate it against `schema.sql`, and load it into local D1. The export omitted runtime revision/idempotency state; local revisions start at zero.
- [x] Complete the local integration wizard and validate the local Google client, recipients, WhenIsGood template, and application settings without revealing their values.
- [x] Complete interactive Google sign-in and verify the authorized admin account's read-only surfaces. Volunteer verification with the specified account remains unavailable because it is absent from local users.
- [ ] Optionally configure a verified Resend sender and API key when local email delivery is wanted. Local email was intentionally skipped; blank-key behavior is valid.
- [x] Finish screenshot-based visual browser verification of the signed-in admin surfaces. After the user explicitly approved screenshots, inspected Schedule, the import form, center proposals, and Insights, including the heatmap and mobile forms. Navigation wraps, form controls remain usable, and wide tables/heatmaps scroll within their containers at 390px. Restored the default viewport and left Schedule open. No authenticated mutations, real email, or live WhenIsGood requests were performed. The specified volunteer account remains absent from local users.

Production deployment and mutations are outside this implementation request.

## Continuous integration on 2026-10-05

- Added GitHub Actions validation on pushes, pull requests, and manual dispatch: Node 24, `npm ci`, strict type checks, functional tests, and the client/Worker build dry run.
- Workflow uses pinned official actions, read-only repository permissions, a 15-minute timeout, and cancellation of superseded runs. No deployment credentials or private seed are required.
- Reproduced CI in an isolated copy containing only application sources and synthetic fixtures: installation, type checks, all **197 tests across 11 files**, and the complete build/dry run passed. Workflow YAML and command sequence were validated; GitHub-hosted execution awaits a push.
- Independent Standards and Spec reviews found no issues in the CI workflow and its documentation.

## Time display refinement on 2026-10-05

- Removed visible timezone labels from session, availability, proposal, and import displays while retaining the configured timezone for domain calculations and saved intervals.
- Formatted displayed intervals, confirmation text, and heatmap labels with AM/PM; widened heatmap columns for the longer labels. Native time-entry controls retain their browser-provided US format.
- Updated the existing functional heatmap test's displayed-label expectation. All nine client DOM tests, strict TypeScript checks, and the Vite build passed.
- Restarted the private local preview after its processes stopped. Reauthentication is required after loading the updated client.

## Schedule preview refinement on 2026-10-05

- Preview now replaces the published table in the same card. The heading and explanation identify the proposed assignments; publishing controls appear only after a valid preview.
- Added a return control that restores the published table and clears the reviewed preview. Refreshing a preview still checks the displayed data revision before enabling publication.
- Updated the existing publication workflow test to cover one table, preview mode, returning to the published schedule, and publication with the reviewed revision. All nine client DOM tests, strict TypeScript checks, and the Vite build passed. No real publication was performed.

## WhenIsGood compatibility on 2026-10-05

- After the user authorized live fetching, fetched the previously attempted results page privately. The page builds respondent objects and timestamp slot lists in JavaScript rather than embedding the JSON intervals supported by the initial parser.
- Added text-only decoding of that native results format without executing scripts. Reads displayed grid clocks, infers the slot duration from grid rows, and merges adjacent selections into recurring intervals. Unrecognized nonempty availability fails rather than becoming an empty replacement.
- Verified the fetched private snapshot parses successfully using a temporary diagnostic, then removed the diagnostic and private capture. Expanded the existing participant parsing test with a synthetic native-format fixture; no private source data was committed.
- Failed preview UI now displays the saved diagnostic. Participant matching now uses manual mappings first, then unique email matches, then unique exact names normalized for case and whitespace. Missing or ambiguous matches remain for manual review; ambiguous email matches are not overridden by name fallback.
- No availability was promoted, no email was sent, and no production write occurred. All **195 functional tests across 11 files**, strict TypeScript checks, and the client build passed.

- Added functional matching coverage for email precedence, normalized name fallback, duplicate names, and unmatched participants. All **196 functional tests across 11 files**, strict TypeScript checks, and the client build passed. Name matching changes preview staging only; no saved availability was promoted during verification.

## Import mapping UX on 2026-10-05

- Matched participants are ready to import without saving mappings. Mapping forms now appear only for unmatched participants, with matched overrides behind a collapsed disclosure.
- All automatic matches can be imported together using “Import matched availability”; the existing confirmation describes the replacement of weekly availability. Completed imports no longer show mapping or import controls.
- Added an overall client import workflow test proving matched participants can be imported without mapping-save requests. All ten client DOM tests, strict TypeScript checks, and the Vite build passed. No real availability was imported during validation.

## Schedule staffing display on 2026-10-05

- Unfilled places now reflects required staffing minus the assigned volunteers displayed in the published or preview table. A missing historical shortfall entry no longer defaults the display to zero. Cancelled sessions show zero required places.
- Removed the legacy “Center session:” prefix from displayed session titles, including volunteer session lists and confirmation text, without editing stored titles.
- Expanded the existing schedule publication workflow checks to include an unassigned session requiring two volunteers. All ten client DOM tests, strict TypeScript checks, and the Vite build passed.

## Sortable availability-overlap table on 2026-10-06

- Added a distinct Insights table with weekday, merged interval, available-volunteer count, and names. It uses the same current grid cells as the heatmap.
- Sorting supports weekday/time and volunteer count from high to low, with weekday, time, and volunteer IDs as deterministic tie-breakers. Displayed intervals keep the existing AM/PM format without timezone labels.
- The wide table stays inside a horizontal scroll area. Synthetic DOM coverage checks sorting, count ties, agreement with heatmap selection, refreshed data, empty intervals, and zero-coverage intervals.
- `npm run check` passed; `npm test` passed all 202 tests across 11 files with approved loopback access for Miniflare; the Vite build and Wrangler deployment dry run passed. No deployment occurred.
