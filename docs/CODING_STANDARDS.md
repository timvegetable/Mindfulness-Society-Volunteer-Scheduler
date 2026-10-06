# Coding standards for review

These are judgment criteria for the reviewer. Use the originating spec and subsequent user requirements as the behavior contract. Report documented violations separately from heuristic maintainability concerns. Let automated checks enforce mechanically decidable syntax and types.

## Give shared rules one owner

When several callers resolve the same domain fact, compare their normalization, precedence, ambiguity handling, and tie-breaking. Keep those decisions in one shared rule rather than maintaining near-duplicates across reads and writes.

For identity matching, review a complete sequence: stage participants, save an override, re-stage, and promote. Distinct participant identities must remain distinct when weaker fields coincide. Use scenarios with duplicate names or emails, and differences in case or whitespace. Confirm that a mapping update affects the intended identity and that later reads use the same resolution rules.

Review duplicated publication selection and role-navigation construction for divergence. Prefer using the existing authoritative rule over adding another version, including unused versions that could mislead a future caller.

## Account for every required surface

Trace each requested surface to its data and user action. A sortable volunteer table does not demonstrate a required sortable overlap table; a heatmap does not substitute for a separately specified table. Require evidence for each distinct requirement before reporting full spec compliance.

Review complete user workflows, not just isolated controls. Distinguish current state from a proposed preview, automatic results from unresolved choices, and optional overrides from required actions. A successful automatic match should not look like unfinished administrative work.

Display counts must describe the records shown. Compare empty, partial, and complete staffing states, and clarify how cancelled sessions are represented. Review terminology, local time formatting, and responsive layout together with the user's stated audience.

## Calibrate the report

State the concrete trigger, observed or predicted result, and practical impact of a finding. Cite its spec or standard and the source location. Label speculative smells as judgment calls; verify consequential correctness claims with a focused synthetic scenario where feasible.

Keep review findings separate from fixes. Documentation or a passing unrelated test does not resolve a confirmed behavior defect.
