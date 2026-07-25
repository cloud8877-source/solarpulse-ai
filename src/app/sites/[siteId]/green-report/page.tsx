import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SolarOpsError, solarOps } from "@/services/solarops";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ siteId: string }>;
}): Promise<Metadata> {
  const { siteId } = await params;
  try {
    const report = solarOps().generateGreenPerformanceReport(siteId);
    return { title: report.data.title };
  } catch {
    return { title: "Green Performance Report" };
  }
}

export default async function GreenReportPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;

  let report: ReturnType<ReturnType<typeof solarOps>["generateGreenPerformanceReport"]>;
  try {
    report = solarOps().generateGreenPerformanceReport(siteId);
  } catch (e) {
    if (e instanceof SolarOpsError) notFound();
    throw e;
  }

  const { data } = report;
  const { production: p, incidents: inc, value: v, manifest } = data;

  return (
    <main className="container">
      <p className="no-print" style={{ marginBottom: 6 }}>
        <Link href={`/sites/${siteId}`} className="muted">
          ← Back to site
        </Link>
      </p>

      <div className="card report-print">
        <div className="section-title">
          <h1 style={{ fontSize: "1.25rem" }}>Green Performance Report</h1>
          <span className="muted no-print">{report.report_id}</span>
        </div>

        <p style={{ marginBottom: 4 }}>
          <strong>Site:</strong> {data.siteName} ({data.region}) — {data.capacityKwp} kWp
        </p>
        <p style={{ marginBottom: 4 }}>
          <strong>Reporting period:</strong> {data.windowStart} → {data.windowEnd}
        </p>
        <p className="muted" style={{ marginBottom: 16 }}>
          <strong>Data:</strong>{" "}
          {data.fixtureLabel
            ? "fixture_data (clearly labeled demo dataset — not live telemetry)"
            : "live / partner telemetry"}
        </p>

        <h2>Production Summary</h2>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Observed generation</td>
              <td>
                <strong>{p.observedKwh} kWh</strong>
                {p.coverageNote ? ` (${p.coverageNote})` : ""}
              </td>
            </tr>
            <tr>
              <td>Weather-adjusted expected</td>
              <td>
                <strong>{p.expectedKwh} kWh</strong>
              </td>
            </tr>
            <tr>
              <td>Performance index (observed / expected)</td>
              <td>
                <strong>{p.performanceIndexDisplay}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ marginTop: 12 }}>
          <InlineMarkdown text={p.sentence} />
        </p>

        <h2 style={{ marginTop: 20 }}>Incidents</h2>
        <p style={{ marginBottom: 4 }}>
          <strong>Status:</strong> {inc.severity}
        </p>
        {inc.causePlain != null && (
          <p style={{ marginBottom: 4 }}>
            <strong>Likely cause:</strong> {inc.causePlain}
          </p>
        )}
        {inc.confidence != null && (
          <p style={{ marginBottom: 8 }}>
            <strong>Confidence:</strong> {inc.confidence}
          </p>
        )}
        {inc.evidence.length > 0 && (
          <>
            <p style={{ marginBottom: 4 }}>Evidence:</p>
            <ul className="evidence-list">
              {inc.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </>
        )}
        {inc.footerNote != null && (
          <p style={{ marginTop: 8 }}>
            <InlineMarkdown text={inc.footerNote} />
          </p>
        )}

        <h2 style={{ marginTop: 20 }}>Value &amp; Sustainability</h2>
        <p style={{ marginBottom: 4 }}>
          Energy value of observed production: <strong>RM {v.rmValue}</strong> (at RM{" "}
          {v.tariffRmPerKwh}/kWh tariff assumption).
        </p>
        <p>
          CO₂ avoided from observed production: <strong>{v.co2Kg} kg CO₂e</strong> (at{" "}
          {v.carbonFactor} kgCO₂e/kWh carbon factor).
        </p>

        <h2 style={{ marginTop: 20 }}>Assumptions &amp; Source Provenance</h2>
        <p style={{ marginBottom: 4 }}>
          Run ID: <code>{manifest.runId}</code>
        </p>
        <p style={{ marginBottom: 4 }}>Generated: {manifest.generatedAt}</p>
        <p style={{ marginBottom: 12 }}>
          Model version: <code>{data.modelVersion}</code>
        </p>

        <p style={{ marginBottom: 6 }}>
          <strong>Inputs</strong>
        </p>
        <ul className="evidence-list" style={{ marginBottom: 16 }}>
          {manifest.inputs.map((i) => (
            <li key={i.name}>
              <strong>{i.name}</strong> — <em>{i.sourceType}</em>: {i.sourceName}
              {i.url ? ` — ${i.url}` : ""}
              {i.isFixture ? " (fixture_data)" : ""}
            </li>
          ))}
        </ul>

        <p style={{ marginBottom: 6 }}>
          <strong>Assumptions</strong>
        </p>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {manifest.assumptions.map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td>{a.value}</td>
                <td className="muted">{a.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 style={{ marginTop: 20 }}>Caveats</h2>
        <p className="muted">{data.caveats}</p>
      </div>
    </main>
  );
}

/**
 * Render a small subset of markdown (**bold**, `code`) as safe React nodes.
 * No HTML parsing — only split on known markers from our own engine strings.
 */
function InlineMarkdown({ text }: { text: string }) {
  // Tokenize bold first, then code within non-bold segments.
  const boldParts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {boldParts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        const codeParts = part.split(/(`[^`]+`)/g);
        return codeParts.map((cp, j) => {
          if (cp.startsWith("`") && cp.endsWith("`")) {
            return <code key={`${i}-${j}`}>{cp.slice(1, -1)}</code>;
          }
          return <span key={`${i}-${j}`}>{cp}</span>;
        });
      })}
    </>
  );
}
