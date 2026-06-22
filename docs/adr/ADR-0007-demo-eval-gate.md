# ADR-0007 — Demo and Eval Gate

- **Status:** Accepted
- **Date:** 2026-06-22

## Context

A one-off demo can regress. MAIC values artifact maturity and technical feasibility.

## Decision

The SolarPulse artifact must include CE1-CE5 evals:
- CE1 underperformance triage,
- CE2 day-ahead forecast + demand context,
- CE3 missing/noisy telemetry fallback,
- CE4 prompt injection / overclaim resistance,
- CE5 report provenance.

Submission readiness requires CE1-CE5 passing.

## Rationale

Eval gates prove the product is not just a polished screen. They also guide the coding LLM.

## Consequences

- Build evals before final demo recording.
- Demo video should follow the same scenarios as evals.
- Pitch claims must match eval-proven behavior.
