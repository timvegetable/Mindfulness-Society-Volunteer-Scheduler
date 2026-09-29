# schedule-preview-performance Specification

## Purpose
Keep the schedule preview computation fast enough for production-scale workloads on the selected free Workers execution topology, while preserving its exact scheduling semantics and deterministic outputs.

## Requirements

### Requirement: Identical preview results through optimization

The preview operation (`admin.schedule.preview`) SHALL return results that are identical to the pre-optimization implementation's results for the same workbook state, scheduling zone, and request clock — including assignment and backup row identifiers, revision continuity, shortfall summaries, backup ordering, and every envelope field. Optimization SHALL change only the computation's efficiency, never what it produces.

#### Scenario: Parity on the pinned production-scale fixtures

- **WHEN** the preview computation is executed on the pinned representative and larger fixtures at their pinned clocks, including the larger fixture spanning the 2026-11-01 US daylight-saving-time transition
- **THEN** every resulting projection field matches the recorded pre-optimization output exactly, with a stable digest per fixture

#### Scenario: Cutoff and malformed-input edge cases keep their existing semantics

- **WHEN** a session starts exactly at the request clock, or workbook rows contain malformed, blank, or ambiguous date/time cells, or a volunteer row is repeated in source data
- **THEN** the preview result reflects the existing exclusion, decoding, and de-duplication rules unchanged, and no previously-passing case regresses

#### Scenario: Deterministic repeat results

- **WHEN** the same preview is computed repeatedly for unchanged workbook state at the same clock
- **THEN** the responses are identical, and none of the optimization's derived structures are observable in the output

### Requirement: Fresh previews reflect current workbook state

The preview operation SHALL compute each result from the request's own workbook snapshot: it MUST NOT reuse another request's computed result, and it MUST remain a read-only operation that writes no Sheet row, run record, audit entry, or revision.

#### Scenario: Input change invalidates prior results

- **WHEN** the scheduling input revision changes between two preview requests
- **THEN** the second result reflects the changed inputs without any client freshness action

#### Scenario: Preview stays read-only

- **WHEN** any preview request is served, including cold isolates and concurrent bursts
- **THEN** the workbook's content and control metadata are unchanged, and Sheet read counts remain within the operation's established budget

### Requirement: Measured preview resource envelope on the free topology

The preview computation SHALL pass the campaign record from the accepted feasibility experiment contract, unmodified, when re-measured on the selected free execution topology: warm preview isolate CPU p99 ≤ 3,000 ms with every request including cold within 5,000 ms, preview end-to-end wall p99 ≤ 5,000 ms, four-way concurrent burst workloads completed within the platform's per-request wall cap, zero unexpected failures, and zero unexpected Sheets quota rejections on budgeted runs whose browser probes are paced through the shared read ledger. Measured failures SHALL be recorded as recorded no-go evidence; the thresholds are never adjusted after results.

#### Scenario: Larger-fixture campaign re-measurement

- **WHEN** the preview-only campaign runs against the larger fixture (sequential warm requests and four-way bursts, with genuine cold observations, every attempt retained without retries, within the ≤1,000-attempt campaign budget)
- **THEN** the measured CPU, wall, reliability, and quota dimensions meet the unchanged thresholds, or the change records a dated no-go verdict naming the plateau

#### Scenario: Thresholds are immutable evidence

- **WHEN** any measured dimension fails after optimization
- **THEN** the change records the plateau and routes the decision to a separate product-decision change instead of relaxing the threshold, redefining a fixture, or reattributing samples

### Requirement: One environment-neutral preview computation

The preview computation SHALL remain a single environment-neutral TypeScript implementation shared by every execution runtime (the Apps Script backend and the Workers read path). No runtime SHALL replace parts of the computation with a runtime-specific reimplementation for this change's speedup, and no preview-specific behavior SHALL become observable only in one runtime.

#### Scenario: Runtime-independent results

- **WHEN** the preview computation executes for the same fixture state and clock in the Apps Script runtime and in the Worker native test runtime
- **THEN** the resulting projections match field for field, and existing cross-runtime parity checks continue to pass
