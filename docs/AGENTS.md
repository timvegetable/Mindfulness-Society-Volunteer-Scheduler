# Documentation guide

The files in `docs/` explain the system as it exists. OpenSpec artifacts explain proposed and unfinished work. Keep those roles separate: do not describe an unchecked task as implemented, and do not use a documentation edit to silently change a requirement.

## Where information belongs

| Topic | Canonical document |
| --- | --- |
| End-to-end flow, boundaries, authorization, revisions | `architecture.md` |
| Installation, configuration, build, local loop | `development.md` |
| Test layers, regression procedure, CI gaps | `testing.md` |
| Release, verification, snapshots, rollback | `deployment.md` |
| Secrets, public/private config, trust boundaries | `security.md` |
| Live write gate, diagnostics, probes, observations | `operations.md` |
| Module ownership and detailed contracts | `subsystems/*.md` |
| Work not yet complete | `../openspec/changes/volunteer-session-scheduling/tasks.md` |

`AGENTS.md` at the repository root stays short and action-oriented. Put explanations here rather than growing the root file into an architecture manual.

## Editing rules

1. Read the source and relevant OpenSpec requirements before changing a behavioral claim. Prefer symbol or file links over copied implementation.
2. Distinguish invariants from observations. Date measured performance, deployment state, and other facts that can go stale; link them to the OpenSpec task that owns follow-up.
3. Never copy Sheet IDs, roster data, OAuth tokens, `.clasp.json`, private configuration, exported rows, or administrator/volunteer email addresses into documentation.
4. Commands must be runnable from the repository root. Use placeholders such as `<deployment-id>` and `<snapshot.xlsx>` for private or environment-specific values.
5. Production procedures must remain fail-closed: explicit approval, live `WRITE_ENABLED` verification, snapshot first, and verification after the action. A local config or generated report is not evidence of live Script Property state.
6. When a code change alters an operation, tab, revision, configuration field, build step, or deployment check, update the owning subsystem document and any affected top-level document in the same change.
7. Do not mark an OpenSpec checkbox complete from code inspection alone. Record the measured or browser evidence in `tasks.md`, then run `openspec validate volunteer-session-scheduling --strict`.

## Review checklist

- Every named path and command still exists.
- Security and authorization statements match server enforcement, not client presentation.
- Revision language says which revision is meant: tab, scheduling input, schedule output, or global data.
- Operations observations are dated and do not imply current production state without a live check.
- New subsystem details live in one canonical place and are linked elsewhere instead of copied.

