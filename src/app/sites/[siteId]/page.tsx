import Link from "next/link";
import { notFound } from "next/navigation";
import { CopilotPanel } from "@/app/components/CopilotPanel";
import { ForecastChart } from "@/app/components/ForecastChart";
import { ReportPanel } from "@/app/components/ReportPanel";
import { StatusBadge, fmtInt, fmtPct } from "@/app/components/ui";
import { SolarOpsError, solarOps } from "@/services/solarops";

export const dynamic = "force-dynamic";

export default async function SiteDetail({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;

  let detail: ReturnType<ReturnType<typeof solarOps>["siteDetail"]>;
  try {
    detail = solarOps().siteDetail(siteId);
  } catch (e) {
    if (e instanceof SolarOpsError) notFound();
    throw e;
  }

  const { site, forecast, detect, explanation, recommendations, series } = detail;
  const isData = detect.severity === "data_issue";

  return (
    <main className="container">
      <p style={{ marginBottom: 6 }}>
        <Link href="/" className="muted">
          ← Portfolio
        </Link>
      </p>
      <div className="section-title">
        <h1 style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {site.name} <StatusBadge status={site.latest_status} />
        </h1>
        <span className="muted" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {site.region} · {fmtInt(site.capacity_kwp)} kWp
          <Link href={`/sites/${site.site_id}/green-report`}>Green Performance Report →</Link>
        </span>
      </div>

      <div className="grid two-col">
        <div className="card">
          <div className="section-title">
            <h2>Forecast vs actual</h2>
            <span className="muted">
              expected {fmtInt(forecast.expected_kwh)} kWh · band {fmtInt(forecast.lower_kwh)}–
              {fmtInt(forecast.upper_kwh)}
            </span>
          </div>
          <ForecastChart data={series} />
          <p>
            <small>
              Observed (teal) vs expected (blue) with ±8% band. Backtest metric{" "}
              <code>fixture_wape</code> = {forecast.metric.value ?? "n/a"}
              {forecast.quality_flags.includes("metric_from_reference") ? " (model reference)" : ""}.
            </small>
          </p>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div className="card">
            <h2>Performance</h2>
            <div className="grid kpi-grid">
              <div className="kpi">
                <span className="label">Observed</span>
                <span className="value">{isData ? "—" : fmtInt(detect.observed_kwh)}</span>
              </div>
              <div className="kpi">
                <span className="label">Expected</span>
                <span className="value">{fmtInt(detect.expected_kwh)}</span>
              </div>
              <div className="kpi">
                <span className="label">Residual</span>
                <span className={`value ${!isData && detect.residual_pct < -0.05 ? "red" : "green"}`}>
                  {isData ? "—" : fmtPct(detect.residual_pct)}
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="section-title">
              <h2>Likely cause</h2>
              <span className="confidence">confidence: {explanation.confidence}</span>
            </div>
            <p>
              <strong>{explanation.likely_cause.replace(/_/g, " ")}</strong>
            </p>
            <ul className="evidence-list">
              {explanation.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px 4px" }}>
          <h2>Recommended actions</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Action</th>
              <th className="num">Recovery / mo</th>
              <th className="num">RM / mo</th>
              <th className="num">CO₂ / mo</th>
              <th>Conf.</th>
            </tr>
          </thead>
          <tbody>
            {recommendations.map((r) => (
              <tr key={r.rank} style={{ cursor: "default" }}>
                <td>{r.rank}</td>
                <td>{r.action}</td>
                <td className="num">
                  {r.expected_recovery_kwh_month > 0 ? `${fmtInt(r.expected_recovery_kwh_month)} kWh` : "—"}
                </td>
                <td className="num">{r.estimated_rm_value > 0 ? `RM ${fmtInt(r.estimated_rm_value)}` : "—"}</td>
                <td className="num">{r.estimated_co2_kg > 0 ? `${fmtInt(r.estimated_co2_kg)} kg` : "—"}</td>
                <td>
                  <span className="confidence">{r.confidence}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid two-col" style={{ marginTop: 16 }}>
        <CopilotPanel
          siteName={site.name}
          presets={[
            `Why is ${site.name} underperforming today?`,
            "What should I check first?",
            "Is this weather or equipment?",
          ]}
        />
        <ReportPanel siteId={site.site_id} anomalyEventId={detect.anomaly_event_id} />
      </div>
    </main>
  );
}
