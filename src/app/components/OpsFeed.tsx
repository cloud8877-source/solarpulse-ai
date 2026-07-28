"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  ActionCommitment,
  ActionStatus,
  SweepRun,
} from "@/domain/actions";
import { fmtInt, fmtRm } from "@/app/components/ui";
import type { KreditScoreboard } from "@/services/solarops";

const OPERATOR_KEY = "solarpulse.kredit.operatorName";
/** Fixture June 2026 closed period — default for the demo verify picker. */
const DEFAULT_VERIFY_PERIOD_END = "2026-06-30";

type FeedProps = {
  sweeps: SweepRun[];
  actionsBySweep: Record<string, ActionCommitment[]>;
  scoreboard: KreditScoreboard;
};

/** I7-6: SEED badge keys on data (evidenceRefs), not title prefix. */
function isSeedAction(row: ActionCommitment): boolean {
  return row.evidenceRefs.includes("seed_fixture");
}

/** Status chip from row.status + optional verification outcome. */
function ActionStatusChip({ row }: { row: ActionCommitment }) {
  if (row.verification?.outcome === "verified") {
    return <span className="badge action-verified">VERIFIED</span>;
  }
  if (row.verification?.outcome === "falsified") {
    return <span className="badge action-falsified">FALSIFIED</span>;
  }
  if (row.verification?.outcome === "partial") {
    return <span className="badge action-verified">PARTIAL</span>;
  }
  const map: Record<ActionStatus, { cls: string; label: string }> = {
    awaiting_approval: { cls: "action-awaiting", label: "AWAITING SIGNATURE" },
    issued: { cls: "action-issued", label: "ISSUED" },
    denied_by_policy: { cls: "action-blocked", label: "BLOCKED BY POLICY" },
    expired: { cls: "action-expired", label: "EXPIRED" },
    approved: { cls: "action-issued", label: "APPROVED" },
    proposed: { cls: "action-expired", label: "PROPOSED" },
  };
  const m = map[row.status] ?? { cls: "tag", label: row.status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function ApprovalCard({
  actionId,
  operatorName,
  setOperatorName,
  onDone,
}: {
  actionId: string;
  operatorName: string;
  setOperatorName: (v: string) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canApprove = operatorName.trim().length > 0;

  async function decide(decision: "approve" | "deny") {
    if (!canApprove) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/agent/actions/${encodeURIComponent(actionId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, decided_by: operatorName.trim() }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.message ?? data.error ?? `HTTP ${r.status}`);
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="approval-card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Operator signature</h3>
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          Required non-blank name (ledger invariant)
        </span>
      </div>
      <div className="prompt-row" style={{ marginTop: 0 }}>
        <input
          value={operatorName}
          onChange={(e) => setOperatorName(e.target.value)}
          placeholder="Your name…"
          aria-label="Operator name"
          disabled={busy}
        />
        <button
          className="btn"
          disabled={!canApprove || busy}
          onClick={() => decide("approve")}
        >
          {busy ? "…" : "Approve & issue"}
        </button>
        <button
          className="btn secondary"
          disabled={!canApprove || busy}
          onClick={() => decide("deny")}
        >
          Deny
        </button>
      </div>
      {error ? (
        <p style={{ marginTop: 8, color: "var(--red)", fontSize: "0.85rem" }}>{error}</p>
      ) : null}
    </div>
  );
}

function ActionRow({
  row,
  operatorName,
  setOperatorName,
  onDecided,
}: {
  row: ActionCommitment;
  operatorName: string;
  setOperatorName: (v: string) => void;
  onDecided: () => void;
}) {
  const [open, setOpen] = useState(false);
  const seed = isSeedAction(row);

  return (
    <div className={`action-row ${open ? "open" : ""}`}>
      <button
        type="button"
        className="action-row-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <ActionStatusChip row={row} />
          {seed ? <span className="badge seed-fixture">SEED FIXTURE</span> : null}
          <span className="badge tag">{row.kind.replace(/_/g, " ")}</span>
          <strong style={{ fontSize: "0.92rem" }}>{row.title}</strong>
        </div>
        <div className="muted" style={{ fontSize: "0.82rem", textAlign: "right" }}>
          <Link href={`/sites/${row.siteId}`} onClick={(e) => e.stopPropagation()}>
            {row.siteId}
          </Link>
          {" · "}
          {row.rmImpact != null ? `RM ${fmtInt(row.rmImpact)}` : "—"}
          {" · by "}
          {row.deadline}
        </div>
      </button>

      {open ? (
        <div className="action-evidence">
          <p style={{ marginBottom: 8 }}>
            <strong>Narrative</strong>
          </p>
          <p className="muted" style={{ whiteSpace: "pre-wrap" }}>
            {row.description}
          </p>

          <div className="grid kpi-grid" style={{ margin: "12px 0" }}>
            <div className="kpi">
              <span className="label">RM impact</span>
              <span className="value" style={{ fontSize: "1.1rem" }}>
                {row.rmImpact != null ? `RM ${fmtInt(row.rmImpact)}` : "—"}
              </span>
            </div>
            <div className="kpi">
              <span className="label">kWh impact</span>
              <span className="value" style={{ fontSize: "1.1rem" }}>
                {row.kwhImpact != null ? fmtInt(row.kwhImpact) : "—"}
              </span>
            </div>
            <div className="kpi">
              <span className="label">Deadline</span>
              <span className="value" style={{ fontSize: "1.1rem" }}>
                {row.deadline}
              </span>
            </div>
            <div className="kpi">
              <span className="label">Confidence</span>
              <span className="value" style={{ fontSize: "1.1rem" }}>
                {row.confidence}
              </span>
            </div>
          </div>

          {row.evidenceRefs.length ? (
            <div style={{ marginBottom: 10 }}>
              <span className="confidence">Evidence refs</span>
              <ul className="evidence-list">
                {row.evidenceRefs.map((ref) => (
                  <li key={ref}>
                    <code>{ref}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {row.policyDecisions.length ? (
            <div style={{ marginBottom: 10 }}>
              <span className="confidence">Policy decisions</span>
              <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                {row.policyDecisions.map((pd, i) => (
                  <div
                    key={`${pd.policyId}-${i}`}
                    className={
                      pd.outcome === "deny"
                        ? "policy-card deny"
                        : pd.outcome === "require_approval"
                          ? "policy-card require"
                          : "policy-card allow"
                    }
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <code>{pd.policyId}</code>
                      <span className="badge tag">{pd.outcome}</span>
                    </div>
                    <p style={{ margin: "6px 0 0", fontSize: "0.88rem" }}>{pd.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {row.decidedBy || row.decidedAt ? (
            <p className="muted" style={{ fontSize: "0.84rem" }}>
              Decided by <strong>{row.decidedBy ?? "—"}</strong>
              {row.decidedAt ? ` at ${row.decidedAt}` : ""}
            </p>
          ) : null}

          {row.verification ? (
            <div className="policy-card" style={{ marginTop: 8 }}>
              <div className="section-title" style={{ marginBottom: 4 }}>
                <span className="confidence">Verification</span>
                <ActionStatusChip row={row} />
              </div>
              <p style={{ margin: 0, fontSize: "0.88rem" }}>{row.verification.note}</p>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.8rem" }}>
                measured RM:{" "}
                {row.verification.measuredRm != null
                  ? fmtInt(row.verification.measuredRm)
                  : "—"}{" "}
                · {row.verification.verifiedAt}
              </p>
            </div>
          ) : null}

          {row.status === "awaiting_approval" ? (
            <div style={{ marginTop: 12 }}>
              <ApprovalCard
                actionId={row.id}
                operatorName={operatorName}
                setOperatorName={setOperatorName}
                onDone={onDecided}
              />
            </div>
          ) : null}

          <p className="muted" style={{ marginTop: 10, fontSize: "0.75rem" }}>
            id <code>{row.id}</code> · sweep <code>{row.sweepId}</code> · created {row.createdAt}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SweepCard({
  sweep,
  actions,
  operatorName,
  setOperatorName,
  onDecided,
}: {
  sweep: SweepRun;
  actions: ActionCommitment[];
  operatorName: string;
  setOperatorName: (v: string) => void;
  onDecided: () => void;
}) {
  const [open, setOpen] = useState(true);
  const awaiting = actions.filter((a) => a.status === "awaiting_approval").length;
  const blocked = actions.filter((a) => a.status === "denied_by_policy").length;
  const issued = actions.filter((a) => a.status === "issued").length;

  return (
    <div className="card sweep-card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        type="button"
        className="sweep-card-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <strong>{sweep.id}</strong>
            <span className="badge tag">as of {sweep.asOfDate}</span>
            {sweep.notes.includes("seed_fixture") ? (
              <span className="badge seed-fixture">SEED FIXTURE</span>
            ) : null}
          </div>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.84rem" }}>
            {sweep.siteCount} sites · {actions.length} actions · started {sweep.startedAt}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {awaiting > 0 ? (
            <span className="badge action-awaiting">{awaiting} awaiting</span>
          ) : null}
          {issued > 0 ? <span className="badge action-issued">{issued} issued</span> : null}
          {blocked > 0 ? (
            <span className="badge action-blocked">{blocked} blocked</span>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="sweep-card-body">
          {actions.length === 0 ? (
            <p className="muted" style={{ padding: "12px 16px" }}>
              No actions in this sweep.
            </p>
          ) : (
            actions.map((a) => (
              <ActionRow
                key={a.id}
                row={a}
                operatorName={operatorName}
                setOperatorName={setOperatorName}
                onDecided={onDecided}
              />
            ))
          )}
          {sweep.notes.length ? (
            <details style={{ padding: "10px 16px 14px" }}>
              <summary className="muted" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                Sweep notes ({sweep.notes.length})
              </summary>
              <ul className="evidence-list" style={{ marginTop: 8 }}>
                {sweep.notes.map((n, i) => (
                  <li key={i}>
                    <code>{n}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function OpsFeed({ sweeps, actionsBySweep, scoreboard }: FeedProps) {
  const router = useRouter();
  const [operatorName, setOperatorName] = useState("");
  const [running, setRunning] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [periodEnd, setPeriodEnd] = useState(DEFAULT_VERIFY_PERIOD_END);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(OPERATOR_KEY);
      if (saved) setOperatorName(saved);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      if (operatorName.trim()) localStorage.setItem(OPERATOR_KEY, operatorName.trim());
    } catch {
      /* ignore */
    }
  }, [operatorName]);

  const orderedSweeps = useMemo(
    () =>
      [...sweeps].sort((a, b) =>
        a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
      ),
    [sweeps],
  );

  async function runSweep() {
    setRunning(true);
    setRunMsg(null);
    try {
      const r = await fetch("/api/agent/sweep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) {
        setRunMsg(data.message ?? data.error ?? `HTTP ${r.status}`);
      } else {
        setRunMsg(
          `Sweep ${data.sweep?.id ?? "ok"} · ${data.action_ids?.length ?? 0} actions · mode ${data.mode}`,
        );
        router.refresh();
      }
    } catch (e) {
      setRunMsg((e as Error).message);
    }
    setRunning(false);
  }

  async function runVerify() {
    setVerifying(true);
    setRunMsg(null);
    try {
      const r = await fetch("/api/agent/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period_end: periodEnd }),
      });
      const data = await r.json();
      if (!r.ok) {
        setRunMsg(data.message ?? data.error ?? `HTTP ${r.status}`);
      } else {
        setRunMsg(
          `Verify ${data.period_end}: ${data.graded ?? 0} graded · ${data.expired ?? 0} expired · ${data.skipped ?? 0} skipped` +
            (data.issued_then_graded
              ? ` · ${data.issued_then_graded} stranded-issued`
              : ""),
        );
        router.refresh();
      }
    } catch (e) {
      setRunMsg((e as Error).message);
    }
    setVerifying(false);
  }

  const accuracyLabel =
    scoreboard.action_accuracy != null
      ? `${(scoreboard.action_accuracy * 100).toFixed(0)}% (${scoreboard.verified_count}/${scoreboard.graded_count})`
      : "—";

  return (
    <div>
      <div className="section-title">
        <div>
          <h1>KREDIT ops feed</h1>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            Credit-clock sweep actions · human signature required for load-shift /
            reschedule · SEED rows are labeled fixtures
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <label className="muted" style={{ fontSize: "0.82rem", display: "flex", gap: 6, alignItems: "center" }}>
            Period end
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              disabled={verifying || running}
              aria-label="Verification period end"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "inherit",
                padding: "4px 8px",
              }}
            />
          </label>
          <button className="btn secondary" onClick={runVerify} disabled={verifying || running}>
            {verifying ? "Verifying…" : "Run verification"}
          </button>
          <button className="btn" onClick={runSweep} disabled={running || verifying}>
            {running ? "Running…" : "Run sweep"}
          </button>
        </div>
      </div>

      {/* Lifetime scoreboard — server-derived, engine numbers only (I6 / B6). */}
      <div className="grid kpi-grid" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <span className="label">RM identified</span>
          <span className="value" style={{ fontSize: "1.2rem" }}>
            RM {fmtRm(scoreboard.rm_identified)}
          </span>
          <span className="sub">issued + graded · sum rmImpact</span>
        </div>
        <div className="kpi">
          <span className="label">RM verified</span>
          <span className="value green" style={{ fontSize: "1.2rem" }}>
            RM {fmtRm(scoreboard.rm_verified)}
          </span>
          <span className="sub">verified + partial · sum measuredRm</span>
        </div>
        <div className="kpi">
          <span className="label">Action accuracy</span>
          <span className="value" style={{ fontSize: "1.2rem" }}>
            {accuracyLabel}
          </span>
          <span className="sub">verified / graded</span>
        </div>
      </div>
      {scoreboard.ungraded_insufficient_coverage > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <span className="badge tag" title="Left ungraded — coverage below verifyCoverageFloor">
            {scoreboard.ungraded_insufficient_coverage} ungraded — insufficient coverage
          </span>
        </div>
      ) : null}

      {runMsg ? (
        <p className="muted" style={{ marginBottom: 14, fontSize: "0.86rem" }}>
          {runMsg}
        </p>
      ) : null}

      <div style={{ display: "grid", gap: 14 }}>
        {orderedSweeps.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              No sweeps yet. Click <strong>Run sweep</strong> to propose credit-clock
              actions against the default fixture as-of date.
            </p>
          </div>
        ) : (
          orderedSweeps.map((s) => (
            <SweepCard
              key={s.id}
              sweep={s}
              actions={actionsBySweep[s.id] ?? []}
              operatorName={operatorName}
              setOperatorName={setOperatorName}
              onDecided={() => router.refresh()}
            />
          ))
        )}
      </div>
    </div>
  );
}
