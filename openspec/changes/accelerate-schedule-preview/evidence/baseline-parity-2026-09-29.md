# Baseline differential parity report — schedule preview (2026-09-29)

Evidence for `accelerate-schedule-preview` tasks 1.2 and 3.1. The permanent
regression suite is `src/server/scheduling/preview-parity.contract.test.ts`
(it passed unchanged in the recorded validation runs below); the per-case
digests here were produced by
`node scripts/staging/profile-schedule-preview.mjs --parity --confirm-local`
(raw JSON in ignored `staging-local/parity-baseline-2026-09-29.json`), which
bundles the same engine modules and runs the same case builders.

## What is compared

Every case runs the **live** preview computation and the **frozen
pre-optimization implementation** (`src/server/scheduling/reference/` —
verbatim copies of `src/shared/time.ts` and the scheduler as of the change's
baseline commit) side by side over identical inputs, through the same staged
publication boundary, and compares:

* the complete preview envelope exactly as `scheduleProjection` assembles it
  for `admin.schedule.preview` — every session projection field (identifiers,
  display names, assignment rows with volunteer names, backup ordering and
  names, shortfall), `revision`/`inputRevision`/`scheduleRevision`/`outputRevision`
  continuity, `summary`, exclusions; and
* the raw `ScheduleResult` (assignments, backups, shortfalls, excluded ids).

Equality is byte-level (`stableJson` over the whole envelope); the contract
suite's `engine anchor` test additionally proves the harness envelope equals
what the **real preview handler** returns for the same fixture and clock, so
the harness cannot drift from the served operation. The comparator is proven
non-vacuous by its own test: a deliberate, unrelated edit to a copied
reference envelope surfaces as concrete field paths
(`sessions[0].assignments[0].volunteerId`, `sessions[0].displayName`).

The fixture-identity test pins the differential to the deployed workbooks: the
regenerated representative and larger fixtures must match the archived staging
manifest's digests (`aedfec2ba60623013a0427df0f084020ab3e84118e0b4f1370e602e0db3372a9`,
`fc05ff654fff5304b8cf9af200413f2eab03692674182132d4150f2690fcb517`), including
the Sheets-typed cells (serial dates and clocks; ISO instants left as strings,
exactly as the deployed read-back has them).

## Baseline digests (canonical live envelope, SHA-256 over `stableJson`)

| Case | Digest | Equal |
| --- | --- | --- |
| representative@2026-10-05T12:00:00.000Z | `343edc229eebe0755bec690a3ae52348b0ed61ca2dda6a77d195fe648f88842e` | true |
| representative@2026-11-03T12:00:00.000Z | `e56d8b79a6232883d8eb1767ba4a540ecd0cc026e41e2fef5f31f8c011fb304d` | true |
| larger@2026-10-05T12:00:00.000Z | `342390c901aa2ab78f56954a61545ac56299b82dbcfdfb654c7c72a024649ced` | true |
| larger@2026-11-03T12:00:00.000Z | `88025d3644263480aea42395726c3d9ddc11582c3b6f1460b398b6d4b31e7fc8` | true |
| exact-cutoff (session starts exactly at the clock) | `9b17685665a46271e2143697c3c86c1f5662566f51120ce07dd264f9762e18a8` | true |
| duplicates-and-blank-rank | `443543303af7ad7d0c60b436f761295867b3777f3eeed9fd12a8da0110f96eca` | true |
| exception-overlay (available + unavailable kinds) | `0f10d16beb316f40c6196a9fc3d16141f8f44792aac00bf672f79a68ecc32595` | true |
| dst-ambiguous (2026-11-01 01:30–03:30 start) | `fb842b1a51ce51a27bda17cc825f3620d284eefd6424e82101a5bea3ff7bda2e` | true |
| seed-1 … seed-31 (12 seeded randomized workbooks) | one digest per seed in the raw report | true |

All 20 cases: digest equality between the live and frozen computations; zero
differing field paths.

## Validation runs recorded for tasks 3.1/3.2 (2026-09-29)

| Command | Result |
| --- | --- |
| `pnpm test` | 41 files, 259 tests passed (includes the parity suite) |
| `pnpm run test:worker` | 8 files, 126 tests passed |
| `pnpm run check` | clean: `tsc --noEmit`, worker typecheck, ESLint zero warnings |
| `pnpm run build` | client + Apps Script bundle 498.1 KB + bundle audit passed |
| `pnpm run build:worker` / `:host` / `:gateway` | dry-run builds pass; gateway bundle audit 5,074 bytes, no forbidden imports |
| `openspec validate accelerate-schedule-preview --strict` | valid |
