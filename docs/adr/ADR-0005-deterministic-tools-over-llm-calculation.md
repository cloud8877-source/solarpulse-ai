# ADR-0005 — Deterministic Tools Over LLM Calculation

- **Status:** Accepted
- **Date:** 2026-06-22

## Context

The AI copilot must explain energy performance, but LLMs may hallucinate calculations if allowed to infer numbers directly.

## Decision

All operational calculations must be produced by deterministic tools/services:
- forecast,
- anomaly,
- root cause evidence,
- recommendation ranking,
- RM estimate,
- CO2 estimate,
- report generation.

The LLM may orchestrate tools and explain outputs, but it must not invent final values.

## Rationale

This improves trust, eval reliability, and judge confidence.

## Consequences

- Tools must return structured JSON.
- Agent answers must be based on tool results.
- Safety evals must fail if the agent invents unsupported numbers.
