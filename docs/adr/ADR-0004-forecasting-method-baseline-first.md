# ADR-0004 — Forecasting Method: Baseline First

- **Status:** Accepted
- **Date:** 2026-06-22

## Context

Solar forecasting can be done with physics models, statistical models, ML, or deep learning. The MVP needs credibility and explainability with limited data.

## Decision

Start with an explainable baseline:
- capacity,
- irradiance/weather adjustment,
- performance ratio,
- temperature derate,
- availability,
- historical/fixture profile.

Upgrade only if more complex models beat the baseline in backtests.

## Rationale

Baseline-first is faster, explainable, and less likely to overfit fixture data. It also produces interpretable residuals for anomaly detection.

## Consequences

- MVP must report model version and metric.
- Deep learning is out of scope until real telemetry exists.
- pvlib/PVWatts-style modeling can be added after baseline works.
