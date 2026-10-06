# Validation guidance

## Choose evidence at the boundary that can fail

Before a change, inspect `package.json`, the CI workflow, and the validation section of [README.md](../../README.md). Those files own the commands and configuration; use their current definitions.

Use the existing public interfaces for functional coverage. For browser or Worker integration changes, distinguish mock coverage from evidence in the actual runtime. A mock passing does not establish that native APIs, authentication, or the development proxy work.

For third-party imports and stored-data compatibility, verify the input structure before choosing a fixture. Build synthetic fixtures that preserve the relevant structure, identity collisions, escaping, empty values, and time representation. Synthetic names alone do not make an invented format representative. Validate the complete API response, including nested records, against its schema.

If representative input is unavailable, report that integration compatibility is unverified. Obtain authorized read-only evidence or an operator-provided sample before claiming it works.

## Keep functional tests; discard diagnostic probes

Permanent tests cover overall behavior through public interfaces: sign-in and rejection recovery, schedule preview and publication, matching and import promotion, or candidate confirmation. Extend an existing workflow test when it already exercises the relevant behavior.

Use temporary probes for one-off bug reproduction, native API invocation details, and inspection of private inputs. Remove them after diagnosis. Retain a probe only after converting it into meaningful functional coverage that survives implementation changes. Private records never become checked-in test fixtures.

Before declaring completion, identify which requirements were exercised, which checks passed, and what remains unverified. A successful build, mock test suite, or local dry run establishes only the boundary it actually exercised.

## Work with the local preview and private inputs

Inspect Git status before editing and preserve existing work. Treat the ignored root `seed.sql`, `.dev.vars`, and local D1 state as operator-owned inputs. Validate their presence and configuration without printing values. Use disposable databases and synthetic fixtures for tests; follow README's setup distinction between a new database and an initialized private roster.

Check preview readiness before browser actions, especially after a turn boundary or process restart. The client and Worker must both be reachable. If the preview stops, restore it before diagnosing an application transport failure. Record whether a refresh requires the user to sign in again.

For sensitive runs, emit allowlisted status and error categories rather than environment dumps, request bodies, credentials, or raw private records. Preserve enough diagnostic signal to distinguish transport, authentication, schema, fetch, and parse failures. Use screenshots only within the user's authorized scope.

External reads and mutations are separate permissions. A live results-page fetch does not authorize import promotion, email delivery, or production writes. Keep validation within the current authorized scope and report any blocked boundary explicitly.

## Known coverage gaps

The CI workflow runs the existing commands but does not establish native browser-to-Worker behavior. A synthetic runtime smoke flow remains an automation opportunity; it should exercise authenticated workspace loading, preview, and import staging without production credentials.

See the [2026-10-06 retrospective](../retrospectives/2026-10-06-scheduler.md) for the evidence behind this guidance and unresolved review findings.
