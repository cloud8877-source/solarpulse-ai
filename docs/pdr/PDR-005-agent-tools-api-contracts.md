# PDR-005 — Agent Tools and API Contracts

## 1. Principle

The LLM must never calculate final operational numbers from memory or prompt text.

It must call deterministic tools for:
- forecast,
- anomaly detection,
- root-cause evidence,
- action ranking,
- impact estimation,
- report generation.

## 2. Tool list

### Tool: lookup_solar_site

Purpose:
- Return site metadata and latest health.

Input:
```json
{ "site_id": "site_b" }
```

Output:
```json
{
  "site_id": "site_b",
  "name": "Northern Solar Farm",
  "region": "Kedah",
  "capacity_kwp": 2500,
  "latest_status": "anomaly",
  "is_fixture": true
}
```

### Tool: forecast_solar_yield

Input:
```json
{
  "site_id": "site_b",
  "horizon": "day_ahead",
  "run_at": "2026-06-22T08:00:00+08:00"
}
```

Output:
```json
{
  "site_id": "site_b",
  "horizon": "day_ahead",
  "expected_kwh": 2210,
  "lower_kwh": 2030,
  "upper_kwh": 2380,
  "model_version": "solarops-baseline-v1",
  "metric": { "name": "fixture_wape", "value": 0.083 },
  "assumptions": [{ "name": "performance_ratio", "value": 0.78 }],
  "quality_flags": ["fixture_data"]
}
```

### Tool: lookup_grid_demand

Input:
```json
{
  "region": "peninsular_malaysia",
  "horizon": "day_ahead"
}
```

Output:
```json
{
  "region": "peninsular_malaysia",
  "horizon": "day_ahead",
  "snapshots": [
    { "timestamp": "2026-06-22T14:00:00+08:00", "demand_mw": 18500 }
  ],
  "source": "Single Buyer or fixture snapshot",
  "quality_flags": ["public_context_only"]
}
```

### Tool: detect_asset_underperformance

Input:
```json
{
  "site_id": "site_b",
  "window_start": "2026-06-21T00:00:00+08:00",
  "window_end": "2026-06-21T23:59:59+08:00"
}
```

Output:
```json
{
  "site_id": "site_b",
  "observed_kwh": 1920,
  "expected_kwh": 2210,
  "residual_kwh": -290,
  "residual_pct": -0.131,
  "severity": "anomaly",
  "quality_flags": ["fixture_data"],
  "evidence": {
    "weather_normal": true,
    "persistent_intervals": 5,
    "inverter_signal": "inverter_3 lower than peer group"
  }
}
```

### Tool: explain_solar_anomaly

Input:
```json
{ "anomaly_event_id": "anom_site_b_20260621" }
```

Output:
```json
{
  "likely_cause": "inverter_or_string_underperformance",
  "confidence": "medium",
  "evidence": [
    "Residual is -13.1% after weather adjustment",
    "Irradiance was within expected range",
    "Inverter 3 fixture signal is lower than peers"
  ],
  "caveats": [
    "Fixture telemetry; field verification required"
  ]
}
```

### Tool: rank_om_actions

Input:
```json
{ "anomaly_event_id": "anom_site_b_20260621" }
```

Output:
```json
{
  "recommendations": [
    {
      "rank": 1,
      "action": "Inspect inverter 3 and associated strings",
      "expected_recovery_kwh_month": 420,
      "estimated_rm_value": 210,
      "estimated_co2_kg": 273,
      "confidence": "medium",
      "assumptions": {
        "tariff_rm_per_kwh": 0.5,
        "carbon_factor_kgco2_per_kwh": 0.65,
        "recoverable_fraction": 0.72
      }
    }
  ]
}
```

### Tool: generate_solar_report

Input:
```json
{
  "site_id": "site_b",
  "anomaly_event_id": "anom_site_b_20260621",
  "format": "markdown"
}
```

Output:
```json
{
  "report_id": "report_site_b_20260621",
  "format": "markdown",
  "url_or_path": "/reports/report_site_b_20260621.md",
  "includes_provenance": true,
  "includes_assumptions": true
}
```

## 3. API endpoints

Minimum API endpoints:

```text
GET /api/solarops/sites
GET /api/solarops/sites/{siteId}
GET /api/solarops/sites/{siteId}/forecast?horizon=day_ahead
GET /api/solarops/sites/{siteId}/anomalies
GET /api/solarops/anomalies/{anomalyId}
POST /api/solarops/reports
POST /api/solarops/ask
```

`POST /api/solarops/ask` can route to the existing agent runtime if integrated. If not, implement a demo-only orchestrator that uses the same tool contracts.

## 4. Agent response style

Every answer must use this structure when applicable:

1. **Finding**
2. **Evidence**
3. **Likely cause**
4. **Recommended action**
5. **Estimated impact**
6. **Assumptions / caveats**
7. **Next step**

## 5. Safety constraints

The agent must not:
- claim a field crew was dispatched,
- guarantee savings,
- provide unsupported carbon or RM values,
- recommend grid-control actions,
- bypass tools because the user asks,
- hide fixture data caveats.

## 6. Error behavior

- Tool error: explain that the analysis could not be completed and request operator review.
- Missing site: ask for a valid site.
- Missing telemetry: return data-quality answer, not root cause guess.
- Missing public demand data: omit grid context and state it is unavailable.
