# PDR-006 — UX, Demo Flow, and Report Requirements

## 1. UX principle

The artifact must be instantly understandable to judges.

Do not make the user hunt through complex menus. The first screen should show:
- portfolio health,
- forecast,
- anomaly,
- AI recommendation.

## 2. Primary demo screens

### Screen 1 — Portfolio Overview

Cards:
- total capacity kWp/MWp,
- expected generation today/tomorrow,
- observed generation,
- lost kWh estimate,
- active anomalies,
- estimated RM at risk,
- estimated CO2 impact.

Table:
- Site
- Region
- Capacity
- Observed kWh
- Expected kWh
- Residual %
- Status
- Top action

### Screen 2 — Site Detail

For selected site:
- generation curve: observed vs expected,
- confidence band,
- irradiance/weather context,
- inverter/string comparison if fixture available,
- anomaly evidence panel,
- action ranking panel.

### Screen 3 — AI Copilot

Input prompt examples:
- “Why is Site B underperforming today?”
- “What should I check first?”
- “Generate an owner report.”
- “What is tomorrow’s forecast?”
- “Is this weather or equipment?”

The agent response should show tool trace if possible:
- site lookup,
- forecast,
- anomaly detection,
- explanation,
- recommendation,
- report generation.

### Screen 4 — Report Preview

Report sections:
1. Executive summary
2. Site and data window
3. Observed vs expected generation
4. Anomaly evidence
5. Likely cause and confidence
6. Recommended action
7. Estimated kWh/RM/CO2 impact
8. Assumptions
9. Source/provenance manifest
10. Caveats and next steps

## 3. Demo script

Target video length: 2:30–3:00.

```text
0:00 — Title
SolarPulse AI: AI Copilot for Solar Asset Performance & Grid Intelligence.

0:10 — Problem
Solar operators see generation, but they do not always know what the site should have generated or what action to take.

0:25 — Portfolio dashboard
Show 3 sites. Site B is flagged as 13.1% below expected output.

0:45 — Forecast
Show day-ahead forecast and confidence band.

1:05 — Ask AI
Type: “Why is Site B underperforming today?”

1:15 — Tool-backed answer
Show tool trace and answer: observed vs expected, likely cause, confidence, recommended action.

1:45 — Impact
Show recoverable kWh/month, RM value, avoided CO2, assumptions.

2:05 — Report
Generate owner/O&M report.

2:30 — Scale
Solar portfolios today; BESS, EV charging, demand response, ESG reporting later.

2:50 — Closing
Recover lost clean energy. Improve grid confidence. Accelerate Malaysia’s clean-energy future.
```

## 4. Report template

```markdown
# SolarPulse Site Performance Report

## Executive Summary

Site {{site_name}} generated {{observed_kwh}} kWh from {{window_start}} to {{window_end}}, compared with an expected {{expected_kwh}} kWh after {{forecast_method}}. The shortfall was {{residual_pct}}%.

## Likely Cause

Likely cause: {{likely_cause}}  
Confidence: {{confidence}}

Evidence:
{{evidence_list}}

## Recommended Action

Top action: {{action}}  
Expected recovery: {{expected_recovery_kwh_month}} kWh/month  
Estimated value: RM {{estimated_rm_value}}  
Estimated avoided CO2: {{estimated_co2_kg}} kg CO2e

## Assumptions

{{assumptions_table}}

## Source Provenance

{{source_manifest}}

## Caveats

This report includes model estimates. Field verification is required before physical maintenance decisions.
```

## 5. Visual design

Use a clean energy operations style:
- dark/white dashboard is fine,
- green/blue accent colors,
- map or site cards,
- line chart for forecast vs actual,
- bar/heatmap for inverter comparison,
- evidence badges for source type and confidence.

## 6. Acceptance criteria

- A judge can understand the product in under 60 seconds.
- The demo can complete without live external dependencies.
- Every number shown in the report is traceable.
- The AI answer and dashboard show consistent values.
- Report caveats are visible, not hidden.
