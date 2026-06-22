# ADR-0006 — Safety: No Control, No Trading, No Guaranteed Savings

- **Status:** Accepted
- **Date:** 2026-06-22

## Context

SolarPulse provides operational recommendations. If over-scoped, it could imply physical control, field dispatch, energy trading, or guaranteed financial outcomes.

## Decision

MVP forbids:
- autonomous maintenance dispatch,
- direct inverter/SCADA/grid/BESS/EV control,
- energy trading recommendations,
- guaranteed savings,
- definitive root cause without deterministic evidence.

The system may recommend operator review or inspection priorities.

## Rationale

The product can deliver value without taking high-liability actions. This is safer and more credible for a competition artifact.

## Consequences

- Reports must say estimates are subject to field verification.
- Agent must refuse fake dispatch and fake savings prompts.
- Future control integrations require a separate ADR.
