# PDR-003 — Data Model and Source Manifest

## 1. Data principle

Use a **source-manifest-first** architecture.

Every value shown in the dashboard, agent answer, or report must be traceable to one of:

- public source,
- open benchmark dataset,
- fixture/synthetic dataset,
- partner-provided dataset,
- model estimate,
- manual assumption.

## 2. Initial data sources

### Public Malaysian energy context

- Single Buyer operational demand forecasts.
- OpenDOSM electricity supply and consumption.
- MyEnergyStats / Energy Commission for national energy database context.
- MIDA NETR for national policy context.

### Open PV benchmark

- NREL PVDAQ for public PV performance data, metadata, and environmental sensor references.
- pvlib for PV simulation and physically meaningful modeling if Python is used.

### Fixture data

Use deterministic fixture data for the first MAIC demo:
- clearly labeled as fixture,
- designed to show healthy, anomaly, and data-quality states,
- stored in `sample_data/*.csv`.

### Partner data, later

After a solar partner is available:
- anonymized timestamped generation,
- site capacity,
- inverter/string IDs where available,
- maintenance log,
- weather/irradiance if available,
- permission statement.

## 3. Entities

### solar_sites

Represents site metadata.

Required fields:
- `id`
- `tenant_id`
- `name`
- `region`
- `latitude`
- `longitude`
- `capacity_kwp`
- `inverter_count`
- `commissioning_date`
- `tariff_assumption_rm_per_kwh`
- `carbon_factor_kgco2_per_kwh`
- `source`
- `is_fixture`

### solar_observations

Timestamped generation and optional equipment-level values.

Required fields:
- `site_id`
- `timestamp`
- `generation_kwh`
- `inverter_id`
- `string_id`
- `availability`
- `source`
- `is_fixture`
- `quality_flags_json`

### weather_observations

Weather/irradiance inputs.

Required fields:
- `site_id`
- `timestamp`
- `irradiance_wm2`
- `temperature_c`
- `cloud_cover`
- `rainfall_mm`
- `source`
- `is_fixture`

### grid_demand_snapshots

Demand and forecast context.

Required fields:
- `region`
- `timestamp`
- `demand_mw`
- `forecast_horizon`
- `source`
- `fetched_at`
- `source_url`

### forecast_runs

Model output.

Required fields:
- `site_id`
- `run_at`
- `horizon`
- `expected_kwh`
- `lower_kwh`
- `upper_kwh`
- `model_version`
- `backtest_metric_json`
- `source_manifest_json`

### anomaly_events

Expected-vs-actual underperformance events.

Required fields:
- `site_id`
- `window_start`
- `window_end`
- `observed_kwh`
- `expected_kwh`
- `residual_kwh`
- `residual_pct`
- `severity`
- `likely_cause`
- `confidence`
- `evidence_json`
- `model_version`

### action_recommendations

Ranked operator actions.

Required fields:
- `anomaly_event_id`
- `action`
- `expected_recovery_kwh`
- `estimated_rm_value`
- `estimated_co2_kg`
- `confidence`
- `rationale_json`
- `assumptions_json`

## 4. Source manifest JSON example

```json
{
  "run_id": "forecast_2026_06_22_site_b",
  "inputs": [
    {
      "name": "solar_observations",
      "source_type": "fixture",
      "source_name": "sample_data/solar_observations.csv",
      "license": "internal demo fixture",
      "is_fixture": true
    },
    {
      "name": "grid_demand",
      "source_type": "public",
      "source_name": "Single Buyer demand data",
      "url": "https://www.singlebuyer.com.my/market/market-data/demand",
      "is_fixture": false
    }
  ],
  "assumptions": [
    {
      "name": "tariff_assumption_rm_per_kwh",
      "value": 0.50,
      "note": "Demo-only configurable assumption; not a quoted tariff."
    },
    {
      "name": "carbon_factor_kgco2_per_kwh",
      "value": 0.65,
      "note": "Demo-only configurable factor; replace with approved factor before production."
    }
  ]
}
```

## 5. Data quality flags

Use these strings in `quality_flags_json`:

- `missing_generation`
- `stale_telemetry`
- `weather_unavailable`
- `irradiance_outlier`
- `generation_outlier`
- `inverter_level_missing`
- `fixture_data`
- `public_context_only`
- `partner_data`

## 6. Acceptance checks

- No report or answer can use data without source manifest.
- Fixture data must display `fixture_data` label in debug/report.
- If weather is unavailable, forecast must say weather-adjusted model was not used.
- If telemetry is stale, root-cause must not over-diagnose equipment.
