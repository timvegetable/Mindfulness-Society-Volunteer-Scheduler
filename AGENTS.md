# AGENTS.md

## Execution Guardrails

- **Surgical scope**: Modify only lines directly required by the request. Match existing idioms and styles. Clean up only orphans created by your changes.
- **Simplicity**: Implement the minimal viable solution for requested scope. Defer abstractions, unrequested configurability, and speculative error handling.
- **Pre-flight alignment**: When ambiguities or multiple viable approaches exist, state trade-offs and confirm direction before writing code.
- **Goal-driven verification**: Anchor changes to verifiable criteria. Write or run reproducing tests for bug fixes and assertions for new functionality before declaring completion.

## Pointers & Reference

- **Issues**: Track work via `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Triage**: When applying workflow labels, consult `docs/agents/triage-labels.md`.
- **Domain docs**: For domain architecture, use the single-context layout in `docs/agents/domain.md`.
- **Integrations**: Read `docs/agents/validation.md` when working with integrations.
- **UI & Browser**: For UI changes, consult `PRODUCT.md` and `docs/agents/browser-validation.md`. Point design tools to concrete targets (e.g., `src/client/app.ts`).
- **Code review**: Review changes against `docs/CODING_STANDARDS.md`, spec, and user requirements.
