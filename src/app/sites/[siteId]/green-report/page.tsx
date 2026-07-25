import Link from "next/link";
import { notFound } from "next/navigation";
import { SolarOpsError, solarOps } from "@/services/solarops";

export const dynamic = "force-dynamic";

export default async function GreenReportPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;

  let report: ReturnType<ReturnType<typeof solarOps>["generateGreenPerformanceReport"]>;
  try {
    report = solarOps().generateGreenPerformanceReport(siteId);
  } catch (e) {
    if (e instanceof SolarOpsError) notFound();
    throw e;
  }

  return (
    <main className="container">
      <p className="no-print" style={{ marginBottom: 6 }}>
        <Link href={`/sites/${siteId}`} className="muted">
          ← Back to site
        </Link>
      </p>
      <div className="card">
        <div className="section-title no-print">
          <h1 style={{ fontSize: "1.25rem" }}>Green Performance Report</h1>
          <span className="muted">{report.report_id}</span>
        </div>
        <div className="report-md report-print">{report.content}</div>
      </div>
    </main>
  );
}
