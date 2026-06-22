-- SolarOps / SolarPulse MVP schema
-- Adjust UUID/default syntax to your framework conventions.

CREATE TABLE solar_sites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  latitude NUMERIC,
  longitude NUMERIC,
  capacity_kwp NUMERIC NOT NULL,
  inverter_count INTEGER,
  commissioning_date DATE,
  tariff_assumption_rm_per_kwh NUMERIC,
  carbon_factor_kgco2_per_kwh NUMERIC,
  performance_ratio NUMERIC DEFAULT 0.78,
  source TEXT NOT NULL,
  is_fixture BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE solar_observations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES solar_sites(id),
  timestamp TIMESTAMP NOT NULL,
  generation_kwh NUMERIC,
  inverter_id TEXT,
  string_id TEXT,
  availability NUMERIC,
  source TEXT NOT NULL,
  is_fixture BOOLEAN NOT NULL DEFAULT FALSE,
  quality_flags_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_solar_observations_site_ts ON solar_observations(site_id, timestamp);

CREATE TABLE weather_observations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES solar_sites(id),
  timestamp TIMESTAMP NOT NULL,
  irradiance_wm2 NUMERIC,
  temperature_c NUMERIC,
  cloud_cover NUMERIC,
  rainfall_mm NUMERIC,
  source TEXT NOT NULL,
  is_fixture BOOLEAN NOT NULL DEFAULT FALSE,
  quality_flags_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_weather_observations_site_ts ON weather_observations(site_id, timestamp);

CREATE TABLE grid_demand_snapshots (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  demand_mw NUMERIC,
  forecast_horizon TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMP,
  source_url TEXT,
  quality_flags_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE forecast_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES solar_sites(id),
  run_at TIMESTAMP NOT NULL,
  horizon TEXT NOT NULL,
  expected_kwh NUMERIC NOT NULL,
  lower_kwh NUMERIC,
  upper_kwh NUMERIC,
  model_version TEXT NOT NULL,
  baseline_version TEXT,
  backtest_metric_json JSONB NOT NULL DEFAULT '{}',
  source_manifest_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE anomaly_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES solar_sites(id),
  window_start TIMESTAMP NOT NULL,
  window_end TIMESTAMP NOT NULL,
  observed_kwh NUMERIC,
  expected_kwh NUMERIC,
  residual_kwh NUMERIC,
  residual_pct NUMERIC,
  severity TEXT NOT NULL,
  likely_cause TEXT,
  confidence TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '{}',
  model_version TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE action_recommendations (
  id TEXT PRIMARY KEY,
  anomaly_event_id TEXT NOT NULL REFERENCES anomaly_events(id),
  rank INTEGER NOT NULL,
  action TEXT NOT NULL,
  expected_recovery_kwh NUMERIC,
  estimated_rm_value NUMERIC,
  estimated_co2_kg NUMERIC,
  confidence TEXT NOT NULL,
  rationale_json JSONB NOT NULL DEFAULT '{}',
  assumptions_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE solar_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL REFERENCES solar_sites(id),
  anomaly_event_id TEXT REFERENCES anomaly_events(id),
  title TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown',
  content TEXT NOT NULL,
  includes_provenance BOOLEAN NOT NULL DEFAULT TRUE,
  includes_assumptions BOOLEAN NOT NULL DEFAULT TRUE,
  source_manifest_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
