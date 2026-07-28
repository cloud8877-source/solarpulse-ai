import Link from "next/link";
import { solarOps } from "@/services/solarops";
import { Kpi, StatusBadge, fmtInt, fmtPct } from "@/app/components/ui";

export const dynamic = "force-dynamic";

export default function Home() {
  const ops = solarOps();
  const { rows, kpi } = ops.portfolioSummary();
  const windowDate = ops.latestFixtureDate();

  return (
    <main className="container">
      <div className="section-title">
        <h1>Portfolio Overview</h1>
        <span className="muted">Window {windowDate} · fixture demo data</span>
      </div>

      <div className="grid kpi-grid" style={{ marginBottom: 20 }}>
        <Kpi label="Total capacity" value={`${(kpi.total_capacity_kwp / 1000).toFixed(2)} MWp`} sub={`${rows.length} sites`} />
        <Kpi label="Expected today" value={`${fmtInt(kpi.expected_kwh)} kWh`} />
        <Kpi label="Observed today" value={`${fmtInt(kpi.observed_kwh)} kWh`} />
        <Kpi label="Lost energy" value={`${fmtInt(kpi.lost_kwh)} kWh`} tone={kpi.lost_kwh > 0 ? "red" : "green"} />
        <Kpi label="Active anomalies" value={`${kpi.active_anomalies}`} tone={kpi.active_anomalies > 0 ? "red" : "green"} />
        <Kpi label="RM at risk / mo" value={`RM ${fmtInt(kpi.rm_at_risk)}`} tone={kpi.rm_at_risk > 0 ? "amber" : undefined} sub="recoverable est." />
        <Kpi label="CO₂ at risk / mo" value={`${fmtInt(kpi.co2_at_risk)} kg`} sub="avoidable est." />
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Region</th>
              <th className="num">Capacity</th>
              <th className="num">Observed</th>
              <th className="num">Expected</th>
              <th className="num">Residual</th>
              <th>Status</th>
              <th>Top action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ summary, detect, topAction }) => (
              <tr key={summary.site_id}>
                <td>
                  <Link href={`/sites/${summary.site_id}`}>{summary.name}</Link>
                </td>
                <td className="muted">{summary.region}</td>
                <td className="num">{fmtInt(summary.capacity_kwp)} kWp</td>
                <td className="num">{detect.severity === "data_issue" ? "—" : fmtInt(detect.observed_kwh)}</td>
                <td className="num">{fmtInt(detect.expected_kwh)}</td>
                <td className="num">{detect.severity === "data_issue" ? "—" : fmtPct(detect.residual_pct)}</td>
                <td>
                  <StatusBadge status={detect.severity} />
                </td>
                <td className="muted">{topAction?.action ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ marginTop: 14, fontSize: "0.84rem" }}>
        All values are computed by deterministic tools (model <code>solarops-baseline-v1</code>) on labeled
        fixture data. Click a site for detail, the forecast chart, and the AI copilot.
      </p>
    </main>
  );
}
