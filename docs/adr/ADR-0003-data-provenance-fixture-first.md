# ADR-0003 — Data Provenance and Fixture-First Strategy

- **Status:** Accepted
- **Date:** 2026-06-22

## Context

Real solar telemetry may not be available before MAIC submission. Public Malaysian data supports grid/energy context, but not necessarily inverter-level asset performance.

## Decision

Use a source-manifest-first and fixture-first strategy:
1. deterministic fixture solar data for demo,
2. public Malaysian energy/demand data for context,
3. NREL PVDAQ or similar open PV benchmark data for credibility,
4. anonymized partner data after permission.

## Rationale

The artifact must be demoable without waiting for partner integration. Transparent fixture labeling is more credible than pretending synthetic data is real.

## Consequences

- Every output must label data source type.
- Reports must include source provenance.
- Partner data integration remains a later phase.
