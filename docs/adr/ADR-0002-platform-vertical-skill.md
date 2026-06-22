# ADR-0002 — Platform Architecture: Vertical Skill / Product Module

- **Status:** Accepted
- **Date:** 2026-06-22

## Context

The product may be built inside an existing AI platform/repo or as a standalone app. A standalone app would require new auth, dashboard, agent runtime, observability, and deployment.

## Decision

Implement SolarPulse as a **vertical skill/product module** called `solarops`.

If inside AI Smith, implement as a tenant-scoped, revision-gated skill bundle. If outside AI Smith, preserve the same modular shape:
- data spine,
- deterministic tools,
- agent/copilot interface,
- dashboard/report surface,
- eval pack.

## Rationale

A vertical module keeps the build focused, testable, and reusable. It avoids global prompt hacks and runtime rewrites.

## Consequences

- SolarOps behavior must be explicitly enabled for the demo tenant/module.
- Existing non-SolarOps tenants/features must not change.
- Tools and API contracts become the core integration boundary.
