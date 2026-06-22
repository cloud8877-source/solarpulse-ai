# PDR-004 — Forecast, Anomaly, Root-Cause, and Recommendation Engine

## 1. Modeling principle

Use a transparent baseline first. Upgrade to complex ML only after the baseline works and backtests show improvement.

The goal is a credible contest artifact, not a research paper.

## 2. Forecast engine v1

### Inputs

- site capacity kWp,
- timestamp,
- historical/fixture generation profile,
- irradiance W/m2,
- temperature C,
- weather quality flags,
- availability if present.

### Output

```json
{
  "site_id": "site_b",
  "horizon": "day_ahead",
  "expected_kwh": 2210.0,
  "lower_kwh": 2030.0,
  "upper_kwh": 2380.0,
  "model_version": "solarops-baseline-v1",
  "metric": {
    "name": "fixture_wape",
    "value": 0.083
  },
  "source_manifest_id": "manifest_..."
}
```

### Baseline formula

For MVP fixtures, use a simplified expected-yield baseline:

```text
expected_kwh_interval =
  capacity_kwp
  * interval_hours
  * irradiance_factor
  * performance_ratio
  * availability_factor
  * temperature_derate
```

Where:

```text
irradiance_factor = clamp(irradiance_wm2 / 1000, 0, 1.2)
performance_ratio = site_config.performance_ratio, default 0.78
availability_factor = observation.availability or 1.0
temperature_derate = 1 + gamma * max(temperature_c - 25, 0)
gamma default = -0.004 per C
```

If irradiance is unavailable:
- fallback to median profile baseline,
- set `weather_unavailable` flag,
- lower confidence.

## 3. Anomaly detector v1

### Residual

```text
residual_kwh = observed_kwh - expected_kwh
residual_pct = residual_kwh / expected_kwh
```

### Severity

- `healthy`: residual_pct >= -5%
- `watch`: -10% <= residual_pct < -5%
- `anomaly`: -20% <= residual_pct < -10%
- `critical`: residual_pct < -20%
- `data_issue`: telemetry missing/stale/noisy

Thresholds should be config values, not hardcoded deep inside logic.

### Persistence

For hourly data:
- flag anomaly if residual_pct < -10% for 2+ consecutive daylight intervals,
- or daily residual_pct < -10%.

For daily fixture:
- flag based on daily residual_pct and quality flags.

## 4. Root-cause classifier v1

Use rule-based evidence first.

### Cause: weather explained

Signals:
- low irradiance or high cloud/rain,
- expected generation already low,
- observed within confidence band.

Output:
- likely_cause: `weather_explained`
- confidence: high if observed within band, medium otherwise.

### Cause: inverter/string underperformance

Signals:
- weather normal,
- one inverter/string low while others normal,
- residual is persistent,
- generation curve has step-down or flatline.

Output:
- likely_cause: `inverter_or_string_underperformance`
- confidence: medium/high depending on inverter telemetry availability.

### Cause: soiling/degradation

Signals:
- gradual decline over multiple days,
- affects site broadly,
- not explained by weather,
- no sudden inverter-level drop.

Output:
- likely_cause: `soiling_or_degradation`
- confidence: medium.

### Cause: telemetry/data issue

Signals:
- stale values,
- missing records,
- impossible generation,
- no inverter data.

Output:
- likely_cause: `telemetry_data_quality_issue`
- confidence: high for data issue, low for equipment cause.

### Cause: unknown

Signals:
- residual exists but evidence weak.

Output:
- likely_cause: `unknown_operator_review_required`
- confidence: low.

## 5. Recommendation ranker v1

### Candidate actions

- Inspect inverter/string group.
- Check data logger/telemetry.
- Schedule cleaning/soiling inspection.
- Review shading or vegetation.
- Check curtailment/grid constraint records.
- Continue monitoring.
- Request operator review.

### Impact estimate

```text
expected_recovery_kwh_month =
  abs(residual_kwh_day)
  * recurrence_days_per_month
  * recoverable_fraction
```

Default:
- recurrence_days_per_month = 20 for persistent anomaly,
- recoverable_fraction = 0.5 to 0.9 depending on confidence/cause.

```text
estimated_rm_value = expected_recovery_kwh_month * tariff_assumption_rm_per_kwh
estimated_co2_kg = expected_recovery_kwh_month * carbon_factor_kgco2_per_kwh
```

All assumptions must be returned.

### Ranking score

```text
score =
  severity_weight
  * confidence_weight
  * normalized_recovery
  - cost_proxy
  - uncertainty_penalty
```

## 6. Reporting requirements

Every engine output must include:

- model_version,
- input window,
- source manifest,
- assumptions,
- confidence,
- quality flags,
- generated_at.

## 7. Metrics

Minimum MVP metrics:

- Forecast WAPE/MAPE on fixture backtest.
- Anomaly hit rate on seeded scenarios.
- Number of false overclaims in CE4 safety eval = 0.
- Report provenance presence = 100%.

## 8. Upgrade path

After MVP:
1. Use real partner telemetry.
2. Add pvlib/PVWatts-style physical model.
3. Add gradient boosting with weather + calendar features.
4. Add inverter/string embeddings or pattern classifiers.
5. Add O&M outcome feedback learning.
