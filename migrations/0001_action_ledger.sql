-- KREDIT action commitment ledger (I4).
-- JSON columns store stringified arrays/objects; timestamps are ISO-8601 TEXT.

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY NOT NULL,
  siteId TEXT NOT NULL,
  sweepId TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  rmImpact REAL,
  kwhImpact REAL,
  confidence TEXT NOT NULL,
  evidenceRefs TEXT NOT NULL,
  deadline TEXT NOT NULL,
  approvalClass TEXT NOT NULL,
  status TEXT NOT NULL,
  policyDecisions TEXT NOT NULL,
  verification TEXT,
  createdAt TEXT NOT NULL,
  decidedAt TEXT,
  decidedBy TEXT
);

CREATE INDEX IF NOT EXISTS idx_actions_site_status ON actions (siteId, status);
CREATE INDEX IF NOT EXISTS idx_actions_sweepId ON actions (sweepId);
CREATE INDEX IF NOT EXISTS idx_actions_createdAt ON actions (createdAt);

CREATE TABLE IF NOT EXISTS sweeps (
  id TEXT PRIMARY KEY NOT NULL,
  asOfDate TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  siteCount INTEGER NOT NULL,
  proposedActions INTEGER NOT NULL,
  blockedActions INTEGER NOT NULL,
  notes TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sweeps_startedAt ON sweeps (startedAt);
