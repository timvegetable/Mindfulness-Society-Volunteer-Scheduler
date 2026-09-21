## Context

The administrator schedule table currently uses one Status column for both the stored session lifecycle and the computed staffing result. A locked center session and a confirmed class describe what the session is; an understaffed count describes how it is staffed. Mixing them impairs preview review without changing the scheduler itself.

## Goals / Non-Goals

**Goals:**

- Separate session classification from staffing outcome in every administrator schedule row.
- Use reader-facing labels derived from typed values.
- Keep preview and current-schedule rendering consistent.

**Non-Goals:**

- Changing session lifecycle enums, scheduler eligibility, assignments, backups, or publication.
- Adding new staffing policy.

## Decisions

### Render two explicit concepts

Expose columns or equivalent labelled fields for Session type and Staffing. Session type maps locked center and confirmed class inputs to human-readable labels. Staffing derives from required count, assignment count, and shortfall rather than the stored session status.

Alternative considered: improve the strings in the existing Status column. Rejected because one cell would still combine unrelated dimensions and remain difficult to scan.

### Prefer typed projection data over parsing display text

Use existing typed session fields when sufficient. If the client lacks the needed distinction, extend the least-privilege schedule projection with an explicit enum; do not infer classification from names or raw Sheet values.

## Risks / Trade-offs

- [Additional columns reduce narrow-screen readability] → Use stacked labelled fields at responsive breakpoints.
- [Labels diverge between preview and current schedule] → Share one row presentation function and one label map.

## Migration Plan

This is a presentation-only rollout unless the typed projection needs one additive field. Deploy the compatible server projection before or with the client and roll back the static client if the layout regresses.

## Open Questions

- Whether a fully staffed row should say `Fully staffed` or include the explicit ratio, such as `2 of 2 staffed`.
