# PDR-008 — Implementation Plan for Coding LLM

## 1. Build strategy

Build a narrow vertical slice first:

```text
fixture data -> forecast -> anomaly -> recommendation -> report -> AI answer -> dashboard
```

Do not start with complex integrations or new infrastructure.

## 2. Phase 0 — Read repo and constraints

Tasks:
- Read repo root guidance files first if working inside existing repo.
- Do not run package installs unless explicitly approved.
- Identify existing app structure, API conventions, tests, and UI framework.
- Create a branch.
- Add docs/source manifest if not already present.

Output:
- implementation notes,
- file plan,
- no code changes yet unless asked.

## 3. Phase 1 — Fixtures and schemas

Tasks:
- Add fixture CSVs or seeders for 3 sites.
- Add schema/migrations if persistent DB is needed.
- Add source manifest object.
- Add data loader service.

Acceptance:
- loader returns 3 sites with observations and weather.
- Site B fixture has clear anomaly.
- Site C fixture has data-quality issue.

## 4. Phase 2 — Forecast and anomaly engine

Tasks:
- Implement baseline forecast.
- Implement expected-vs-actual residual.
- Implement severity thresholds.
- Implement root-cause rules.
- Implement recommendation ranker.

Acceptance:
- unit tests pass.
- Site A healthy.
- Site B anomaly.
- Site C data issue.

## 5. Phase 3 — Tool/API contracts

Tasks:
- Implement API endpoints or internal tool functions.
- Ensure all outputs include model version, assumptions, quality flags, and source manifest.
- Add error handling.

Acceptance:
- tool contract examples from PDR-005 work.
- no LLM required for calculations.

## 6. Phase 4 — Agent integration

Tasks:
- Add SolarOps skill/instructions or agent route.
- Ensure LLM calls tools for operator questions.
- Add safety policy to response formatter.
- Add replay/dry-run mode for evals.

Acceptance:
- CE1 works end-to-end.
- CE4 cannot force fake savings/dispatch.

## 7. Phase 5 — Dashboard and report

Tasks:
- Build portfolio dashboard.
- Build site detail.
- Build AI copilot panel.
- Build report preview/generation.

Acceptance:
- demo script can be executed in under 3 minutes.
- report includes sources and assumptions.

## 8. Phase 6 — Evals and demo QA

Tasks:
- Implement CE1-CE5 evals.
- Add deterministic unit tests.
- Record demo video.
- Update deck/project summary.

Acceptance:
- CE1-CE5 pass.
- all visible values consistent.
- artifact accessible without login during judging.

## 9. Build order for LLM

1. Read all PDR and ADR docs.
2. Summarize understanding.
3. Propose file changes.
4. Implement Phase 1 only.
5. Run relevant tests.
6. Ask for review.
7. Continue phase by phase.

## 10. Do not do

- Do not install packages without approval.
- Do not use live external data as a hard dependency for demo.
- Do not rewrite existing chat runtime.
- Do not make global prompt changes.
- Do not create autonomous dispatch/control features.
- Do not hide fixture data.
