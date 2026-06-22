# PDR-002 — MVP Scope, User Stories, and Acceptance Criteria

## 1. MVP name

**SolarPulse MVP: Portfolio Performance Triage**

## 2. MVP outcome

A judge can open the artifact and understand within 3 minutes:

1. there are multiple solar sites,
2. the system forecasts expected generation,
3. one site is underperforming,
4. the AI explains why using tool evidence,
5. the AI recommends an action,
6. the system quantifies kWh/RM/CO2 impact,
7. a report can be generated.

## 3. Core user stories

### US-001 — Portfolio health

As a solar operator, I want to see which sites are healthy or underperforming so that I can prioritize my day.

Acceptance:
- Display at least 3 sites.
- Each site has status: healthy, watch, anomaly, data issue.
- Show observed vs expected generation for current or latest day.
- Show residual percentage.
- Show latest anomaly reason where available.

### US-002 — Day-ahead forecast

As an operator, I want a day-ahead generation forecast so that I can plan O&M and customer updates.

Acceptance:
- For each site, show expected kWh, lower band, upper band.
- Show model version and data timestamp.
- Provide one forecast metric from backtest or fixture evaluation.

### US-003 — Underperformance triage

As an O&M manager, I want to know whether underperformance is due to weather or equipment so that I do not waste field visits.

Acceptance:
- Select Site B anomaly.
- System shows observed kWh, expected kWh, residual kWh, residual %.
- System gives likely cause and confidence.
- System includes evidence signals.

### US-004 — AI operator question

As an operator, I want to ask the system “Why is Site B down?” and receive a concise, evidence-backed answer.

Acceptance:
- Agent calls deterministic tools.
- Final answer cites observed vs expected values.
- Final answer states likely cause with confidence.
- Final answer recommends next action.
- Final answer includes assumptions.
- No unsupported or fabricated values.

### US-005 — Action ranking

As an O&M manager, I want actions ranked by likely impact so that I can prioritize limited resources.

Acceptance:
- At least 2 possible actions returned for anomaly site.
- Each action includes expected recovery kWh, estimated RM value, estimated CO2 impact, confidence, and rationale.
- If confidence is low, action should be operator review / data check.

### US-006 — Owner/O&M report

As an operator, I want to generate a report for the asset owner so that the issue and recommended action are easy to share.

Acceptance:
- Report includes summary, charts/tables, assumptions, sources, model version.
- Report distinguishes observed data, model estimates, and likely causes.
- Report can be downloaded as Markdown/PDF or displayed in page.

## 4. MVP screens

1. Portfolio dashboard
2. Site detail page
3. AI copilot panel
4. Report preview/export
5. Eval/debug trace page or basic tool trace view

## 5. Required fixture data

- 3 solar sites:
  - Site A: healthy C&I rooftop
  - Site B: seeded inverter/string anomaly
  - Site C: telemetry missing/noisy
- 2-7 days of observations are enough for the first demo if the forecast is deterministic and clearly labeled.
- Weather/irradiance fields can be fixture values if real weather API is not integrated yet.
- Grid demand context can be public Single Buyer data or fixture snapshots labeled as such.

## 6. Non-goals for MVP

- Real-time SCADA integration.
- Autonomous field crew dispatch.
- Inverter control.
- BESS dispatch optimization.
- Energy trading.
- Real customer deployment.
- Complex ML if baseline is not implemented.
- Full billing/subscription workflows.
- Multi-country localization.

## 7. Definition of done

The MVP is done when:

- Dashboard loads with 3 sites.
- Forecast tool returns expected kWh and confidence band.
- Anomaly tool flags Site B.
- Agent answers “Why is Site B down?” with tool evidence.
- Report generator produces a report with assumptions.
- CE1-CE5 evals pass.
- Product summary and deck claims match what the artifact actually shows.
