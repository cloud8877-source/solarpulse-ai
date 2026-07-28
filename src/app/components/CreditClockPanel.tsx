"use client";

import {
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtInt } from "@/app/components/ui";

/** Snake_case ATAP DTO slice used by the credit-clock panel (service return type). */
export type CreditClockDto = {
  site_id: string;
  eligibility: { eligible: boolean; reason?: string | null };
  coverage: {
    period_start: string;
    period_end: string;
    days_in_period: number;
    observed_days: number;
    as_of_date: string;
    days_remaining: number;
  };
  observed_to_date: {
    generation_kwh: number;
    load_kwh: number;
    import_kwh: number;
    export_kwh: number;
    self_consumed_kwh: number;
    self_consumption_ratio: number | null;
  };
  maq_kwh: number;
  projection: {
    method: string;
    observed_days: number;
    export_kwh: number;
    import_kwh: number;
    offsettable_export_kwh: number;
    forfeited_export_kwh: number;
    credit_rm: number;
    forfeited_credit_rm: number;
    energy_charge_rm: number;
    net_energy_charge_rm: number;
    observed_daylight_import_kwh: number;
    projected_daylight_import_kwh: number;
    load_shiftable_export_kwh: number;
  } | null;
  value_leak: {
    smp_spread_rm: number;
    smp_spread_ceiling_rm: number;
    forfeited_credit_rm: number;
    floored_credit_lost_rm: number;
    total_rm: number;
  } | null;
  assumptions: string[];
};

function dayLabel(isoDate: string, offset: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(5, 10); // MM-DD
}

/** Compact burn-down: projected credit accrual vs offsettable ceiling. */
function buildBurnDown(clock: CreditClockDto) {
  const days = Math.max(1, clock.coverage.days_in_period);
  const observed = Math.min(clock.coverage.observed_days, days);
  const creditEnd = clock.projection?.credit_rm ?? 0;
  // Offsettable ceiling = full-period credit on offsettable export (engine credit_rm).
  const ceiling = creditEnd;
  const points: Array<{
    day: string;
    dayIndex: number;
    accrual: number;
    ceiling: number;
  }> = [];
  for (let i = 1; i <= days; i++) {
    points.push({
      day: dayLabel(clock.coverage.period_start, i - 1),
      dayIndex: i,
      // Linear projected accrual across the billing period.
      accrual: Math.round((creditEnd * i) / days * 100) / 100,
      ceiling,
    });
  }
  const todayIndex = Math.max(1, Math.min(observed, days));
  return { points, todayIndex, ceiling, creditEnd };
}

export function CreditClockPanel({ clock }: { clock: CreditClockDto }) {
  if (!clock.eligibility.eligible) {
    return (
      <div className="card">
        <div className="section-title">
          <h2>ATAP credit clock</h2>
          <span className="badge tag">not eligible</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {clock.eligibility.reason ?? "Site is outside ATAP non-domestic capacity cap."}
        </p>
      </div>
    );
  }

  const { points, todayIndex, ceiling } = buildBurnDown(clock);
  const todayLabel = points[todayIndex - 1]?.day;
  const leak = clock.value_leak;
  const proj = clock.projection;

  return (
    <div className="card">
      <div className="section-title">
        <h2>ATAP credit clock</h2>
        <span className="badge action-awaiting">
          {clock.coverage.days_remaining} days left in billing period
        </span>
      </div>

      <p className="muted" style={{ fontSize: "0.84rem", marginTop: 0 }}>
        {clock.coverage.period_start} → {clock.coverage.period_end} · as of{" "}
        {clock.coverage.as_of_date} · {clock.coverage.observed_days}/
        {clock.coverage.days_in_period} days observed
      </p>

      <div className="grid kpi-grid" style={{ marginBottom: 14 }}>
        <div className="kpi">
          <span className="label">Observed export</span>
          <span className="value" style={{ fontSize: "1.15rem" }}>
            {fmtInt(clock.observed_to_date.export_kwh)} kWh
          </span>
        </div>
        <div className="kpi">
          <span className="label">Observed import</span>
          <span className="value" style={{ fontSize: "1.15rem" }}>
            {fmtInt(clock.observed_to_date.import_kwh)} kWh
          </span>
        </div>
        <div className="kpi">
          <span className="label">Projected export</span>
          <span className="value" style={{ fontSize: "1.15rem" }}>
            {proj ? `${fmtInt(proj.export_kwh)} kWh` : "—"}
          </span>
        </div>
        <div className="kpi">
          <span className="label">Projected import</span>
          <span className="value" style={{ fontSize: "1.15rem" }}>
            {proj ? `${fmtInt(proj.import_kwh)} kWh` : "—"}
          </span>
        </div>
        <div className="kpi">
          <span className="label">MAQ</span>
          <span className="value" style={{ fontSize: "1.15rem" }}>
            {fmtInt(clock.maq_kwh)} kWh
          </span>
        </div>
        <div className="kpi">
          <span className="label">Projected credit</span>
          <span className="value" style={{ fontSize: "1.15rem" }}>
            {proj ? `RM ${fmtInt(proj.credit_rm)}` : "—"}
          </span>
        </div>
      </div>

      {proj ? (
        <p className="muted" style={{ fontSize: "0.82rem" }}>
          Daylight import observed {fmtInt(proj.observed_daylight_import_kwh)} kWh · projected{" "}
          {fmtInt(proj.projected_daylight_import_kwh)} kWh · load-shiftable export{" "}
          {fmtInt(proj.load_shiftable_export_kwh)} kWh
        </p>
      ) : null}

      {leak ? (
        <div className="value-leak-block" style={{ marginTop: 12 }}>
          <h3 style={{ marginBottom: 8 }}>Value leak</h3>
          <div className="grid kpi-grid">
            <div className="kpi">
              <span className="label">SMP spread</span>
              <span className="value amber" style={{ fontSize: "1.15rem" }}>
                RM {fmtInt(leak.smp_spread_rm)}
              </span>
            </div>
            <div className="kpi">
              <span className="label">Forfeited credit</span>
              <span className="value red" style={{ fontSize: "1.15rem" }}>
                RM {fmtInt(leak.forfeited_credit_rm)}
              </span>
            </div>
            <div className="kpi">
              <span className="label">Total (engine)</span>
              <span className="value red" style={{ fontSize: "1.15rem" }}>
                RM {fmtInt(leak.total_rm)}
              </span>
            </div>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: "0.78rem", color: "var(--text-faint)" }}>
            Components independently rounded; total computed before rounding
          </p>

          {/* N6: ceiling ONLY with its full label — never bare. */}
          <div
            className="card tight"
            style={{ marginTop: 12, background: "var(--surface-2)" }}
          >
            <span className="label" style={{ display: "block", marginBottom: 4 }}>
              Theoretical ceiling — requires storage or overnight load flexibility; not
              achievable by scheduling alone
            </span>
            <span className="value muted" style={{ fontSize: "1.05rem" }}>
              RM {fmtInt(leak.smp_spread_ceiling_rm)}
            </span>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <div className="section-title">
          <h3 style={{ margin: 0 }}>Credit accrual vs offsettable ceiling</h3>
          <span className="muted" style={{ fontSize: "0.78rem" }}>
            ceiling RM {fmtInt(ceiling)}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -6 }}>
            <XAxis dataKey="day" stroke="#6b7798" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis stroke="#6b7798" tick={{ fontSize: 12 }} width={46} />
            <Tooltip
              contentStyle={{
                background: "#131a30",
                border: "1px solid #283357",
                borderRadius: 8,
                color: "#e9eefb",
              }}
              formatter={(v: unknown, name) => [
                typeof v === "number" ? `RM ${Math.round(v)}` : "—",
                name,
              ]}
            />
            <Line
              dataKey="ceiling"
              stroke="#6b7798"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              name="Offsettable ceiling"
            />
            <Line
              dataKey="accrual"
              stroke="#5b9dff"
              strokeWidth={2}
              dot={false}
              name="Projected credit accrual"
            />
            {todayLabel ? (
              <ReferenceLine
                x={todayLabel}
                stroke="#fbbf24"
                strokeWidth={1.5}
                label={{ value: "today", fill: "#fbbf24", fontSize: 11, position: "insideTopLeft" }}
              />
            ) : null}
            <ReferenceLine
              x={points[points.length - 1]?.day}
              stroke="#f87171"
              strokeDasharray="3 3"
              label={{
                value: "period end",
                fill: "#f87171",
                fontSize: 10,
                position: "insideTopRight",
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {clock.assumptions.length ? (
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: "0.84rem" }}>
            Assumptions ({clock.assumptions.length})
          </summary>
          <ul className="evidence-list" style={{ marginTop: 8 }}>
            {clock.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
