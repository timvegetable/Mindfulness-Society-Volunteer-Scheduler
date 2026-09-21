## Context

The current center route is a flat candidate table. Confirmed candidates remain mixed with unresolved proposals even though their resulting occurrences belong to the schedule. A center contact needs a single-center weekly/monthly view, while an administrator needs cross-center attribution. Today the route can derive a center name only from candidate rows, so an empty center has no usable heading.

## Goals / Non-Goals

**Goals:**

- Make sessions and proposals understandable in weekly and monthly calendar views.
- Tailor headings, attribution, and actions to center-contact and administrator roles.
- Keep coverage and shortfall meaning visible through text, color, and accessible semantics.
- Preserve the server authorization and confirmation boundaries.

**Non-Goals:**

- Allowing center contacts to confirm sessions or edit locked occurrences.
- Turning candidate comparison into an assignment promise.
- Moving session times through the calendar.
- Removing historical candidate/audit linkage after confirmation.

## Decisions

### Project a role-scoped calendar model from the server

The center read returns caller context separately from rows: role, authorized center identity/name when singular, unresolved candidates, and relevant confirmed/locked occurrences. The server remains responsible for tenant filtering; the client only chooses role-appropriate presentation.

Alternative considered: infer the heading and scope from the first candidate. Rejected because it fails for empty lists and makes presentation depend on incidental row order.

### Treat candidates and occurrences as distinct calendar entities

Unresolved candidates retain coverage, staffing request, notes, and authorized actions. Confirmed candidates stop presenting edit/confirm controls; their generated occurrences appear as sessions, with an audit link back to the source candidate retained in data rather than duplicated as an actionable proposal.

Alternative considered: leave confirmed rows in the proposal list indefinitely. Rejected because it obscures the current schedule and continues to offer a workbook-centric mental model.

### Use one calendar data model with weekly and monthly renderers

Normalize entities into dated or recurring display intervals, stable identifiers, center attribution, state, and accessible labels. Weekly view emphasizes duration and overlap; monthly view emphasizes session/candidate summaries and navigation to detail.

Alternative considered: build unrelated week and month components. Rejected because state labels, permissions, and interval navigation would drift.

### Keep shortfall confirmation visible but deliberately guarded

Do not remove the only discoverable explanation of the server refusal. A shortfall candidate's confirmation control may remain enabled to return the current authoritative refusal, or appear disabled only if adjacent copy exposes the same reason and a refresh path. The implementation decision must be recorded by tests and copy review.

## Risks / Trade-offs

- [Calendar density hides details] → Provide list-like accessible detail for the selected day/entity and retain readable labels.
- [Client-side filtering leaks another center] → Project only authorized rows on the server and retain tenant-isolation contract tests.
- [Recurring candidates and dated occurrences are conflated] → Give each entity an explicit kind and render recurrence separately from generated occurrences.
- [Color becomes the only state cue] → Pair green/red styling with text, icons or patterns, and accessible names.

## Migration Plan

1. Extend the center read projection and tests without changing mutation authority.
2. Introduce the normalized calendar view model and weekly/monthly renderers behind the existing route.
3. Replace the table as the primary surface after role, empty-state, and accessibility browser verification.
4. Deploy read-side changes first; roll back to the table renderer if calendar presentation fails while leaving server authorization intact.

## Open Questions

- Whether administrators need a center filter in both views or only the monthly view.
- Whether confirmed source candidates remain available in a read-only history drawer or only through audit tooling.
- Whether shortfall confirmation stays enabled with server refusal or is disabled with an equally explicit inline reason.
