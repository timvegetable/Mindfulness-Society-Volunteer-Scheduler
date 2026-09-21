## Context

The volunteer route currently renders recurring intervals and dated exceptions as long form/list structures. Successful mutations invalidate and reload the route, which erases transient success copy and resets scroll and focus. Dated exceptions can be created but not withdrawn, and cancellation may commit before backup promotion or notification fails.

The browser remains untrusted, Google Sheets remains authoritative, and every mutation must use the operation allowlist, caller ownership checks, expected global revision, workbook repository boundary, and audit path.

## Goals / Non-Goals

**Goals:**

- Give volunteers one accessible week-calendar mental model for recurring and dated availability.
- Preserve clear mutation feedback and interaction position through authoritative refreshes.
- Add safe withdrawal of caller-owned future dated exceptions.
- Make cancellation confirmation and failure copy match the actual commit boundary.

**Non-Goals:**

- Replacing the administrator insights heatmap or making its aggregate data available to volunteers.
- Adding drag-and-drop as the only editing mechanism.
- Undoing a committed cancellation automatically when promotion or notification fails.
- Allowing volunteers to edit another person's availability or historical audit records.

## Decisions

### Share calendar geometry and accessibility primitives, not aggregate insight state

Extract reusable week-grid layout, interval positioning, keyboard focus, and readable time-label helpers from the existing heatmap. The volunteer editor supplies only the caller's projected intervals and editing commands. This avoids a second inconsistent calendar without coupling self-service to administrator-only insight data.

Alternative considered: reuse the heatmap component and payload wholesale. Rejected because aggregate names/counts and self-service draft state have different authorization and interaction contracts.

### Keep authoritative refresh while carrying an explicit local interaction handoff

After a successful mutation, retain a short-lived in-memory notice plus a semantic anchor for the edited day/control. Refresh from the server, render the authoritative response, then restore focus/scroll when the anchor still exists. Do not persist private route state in browser storage.

Alternative considered: mutate the rendered snapshot optimistically and skip the read. Rejected because cached client data is not authoritative and the mutation can change revisions, schedule staleness, or normalized intervals.

### Withdraw exceptions through a dedicated ownership-checked operation

Use a narrow operation that accepts an exception ID and expected global revision. Resolve the authenticated volunteer on the server, verify the exception belongs to that volunteer and is withdrawable, remove it through the workbook repository, append audit evidence, advance relevant revisions, and return no broader data.

Alternative considered: overwrite the complete exception collection from the browser. Rejected because it expands the mutation surface and makes omission indistinguishable from unauthorized deletion.

### Treat cancellation as a commit followed by fallible consequences

The client confirms intent before issuing the cancellation. Server errors retain stable codes/details that distinguish a pre-commit refusal from a downstream failure after the cancellation was saved. When commit state cannot be proven to the client, copy instructs the volunteer to reload before retrying rather than risking a duplicate action.

Alternative considered: report every downstream failure as if the cancellation failed. Rejected because it contradicts persisted state and invites unsafe retries.

## Risks / Trade-offs

- [Shared calendar primitives accidentally expose administrator data] → Keep data projection and authorization outside the visual primitive and test volunteer payloads for own-data isolation.
- [Restoring an obsolete DOM position produces confusing focus] → Use semantic anchors and fall back to the calendar heading when the edited control no longer exists.
- [Exception withdrawal changes schedule eligibility] → Advance the same scheduling-input and global revisions as exception creation and mark the current schedule stale.
- [Ambiguous cancellation failures remain possible across the network boundary] → Make retry guidance conservative and verify state through a fresh read.

## Migration Plan

1. Add contracts and server operation for exception withdrawal with repository, authorization, revision, and audit tests.
2. Extract and test accessible calendar primitives before replacing the volunteer lists.
3. Add interaction handoff state and cancellation outcome mapping.
4. Deploy with writes disabled, browser-verify both roles and failure states, then follow the normal write-enable procedure only with explicit approval.
5. Roll back the static client independently if presentation fails; disable the new operation through the dispatcher registry if the server path must be rolled back.

## Open Questions

- Whether dated overrides should be edited in place or withdrawn and recreated in the first iteration.
- Whether the calendar should default to the current week or the next week containing an assignment when opened from an assignment action.
