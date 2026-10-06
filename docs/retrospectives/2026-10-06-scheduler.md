# Scheduler session retrospective — 2026-10-06

## Evidence and scope

Sources: the implementation conversation, user refinements, [TASKS.md](../../TASKS.md), and the two-axis review of `0b0ca35...c8f356d`. This retrospective changes agent guidance; it does not fix application defects or claim production readiness.

## Improvements in severity order

| Priority | Session evidence | Environment response |
| --- | --- | --- |
| High | Saving distinct same-name participants' mappings overwrote the first identity; a synthetic review probe confirmed both subsequently mapped to the second volunteer. | Review identity behavior across staging, mapping updates, and promotion, including collisions. Shared resolution rules belong to one owner. |
| High | Mock tests passed while native browser and Worker fetch invocations failed; invented import fixtures missed WhenIsGood's actual script format, and legacy nested shortfalls failed response validation. | Distinguish runtime evidence from mock coverage; use structurally faithful synthetic fixtures and validate complete responses. A native-runtime functional smoke flow remains a tooling gap. |
| Medium | The required sortable overlap table was absent, although a different sortable table existed. | Review each required surface independently against the spec and later user refinements. |
| Medium | Duplicate schedule tables and mapping-save controls made preview and automatic matching appear to require extra work. Displayed staffing defaults concealed missing assignments. | Review end-to-end user actions, state distinctions, required clicks, and the relationship between displayed records and counts. |
| Medium | Stopped preview processes caused transport failures, while suppressed output obscured diagnostic categories. | Check both services before browser work; preserve sanitized failure categories and record reauthentication needs. A supported private-preview command remains a tooling opportunity. |
| Lower | Bug-specific test retention conflicted with the user's preference, and repeated logic introduced precedence, normalization, and tab-selection drift. | Retain functional coverage; remove temporary probes. Give cross-file consistency and single rule ownership explicit reviewer attention. |

## Existing checks and remaining work

CI is now defined in [ci.yml](../../.github/workflows/ci.yml). Its existing install, typecheck, functional-test, and build/dry-run commands passed in an isolated copy without private inputs. GitHub-hosted execution was not established in this session. There is no configured lint command; this documentation adds no prose-only ban on a mechanically detectable syntax pattern.

The mapping collision and missing sortable overlap table remain application findings. Lower-priority findings include inconsistent matching normalization, an unused duplicate publication selector, and duplicate role-tab construction. Updating guidance does not close these findings.

The lasting guidance lives in [validation](../agents/validation.md) and [coding standards](../CODING_STANDARDS.md). AGENTS.md contains only their invocation pointers.
