## 1. Role-Scoped Read Projection

- [ ] 1.1 Extend the center read schema with caller role and independently projected authorized center identity/name plus typed candidate and session calendar entities
- [ ] 1.2 Populate the projection server-side while retaining center-contact tenant filtering and administrator cross-center attribution
- [ ] 1.3 Add contract tests for a center with no candidates, single-center contact scope, administrator multi-center attribution, and cross-center exclusion

## 2. Calendar View Model

- [ ] 2.1 Define a shared typed view model that distinguishes unresolved candidates, resolved candidate outcomes, locked sessions, and confirmed occurrences
- [ ] 2.2 Implement proportional weekly layout and monthly summaries with shared state labels, date navigation, and selected-entity details
- [ ] 2.3 Add responsive and keyboard-accessible behavior with readable non-color labels for every entity

## 3. Role and Candidate Presentation

- [ ] 3.1 Render a center contact's center-specific heading without a redundant Center column and an administrator's generic cross-center heading with per-entity attribution
- [ ] 3.2 Style Candidate coverage and Coverage shortfall as accessible positive and negative states and improve spacing around edit notes and actions
- [ ] 3.3 Record and implement the shortfall-confirmation affordance decision while keeping the current refusal reason discoverable
- [ ] 3.4 Remove edit and confirmation controls from resolved candidates and present confirmed occurrences in the session calendar with source linkage retained

## 4. Verification and Documentation

- [ ] 4.1 Update center subsystem documentation for the role-scoped projection, entity lifecycle, calendar presentation, and shortfall-action decision
- [ ] 4.2 Run focused center service, integration, client rendering, accessibility, and tenant-isolation tests, then run `npm test` and `npm run check`
- [ ] 4.3 Browser-verify empty and populated center-contact views, administrator cross-center views, weekly/monthly navigation, keyboard details, state styling, locked-session protection, and administrator-only confirmation
