"use client";

import { useState } from "react";

export function ReportPanel({ siteId, anomalyEventId }: { siteId: string; anomalyEventId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      const r = await fetch("/api/solarops/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ site_id: siteId, anomaly_event_id: anomalyEventId, format: "markdown" }),
      });
      const data = await r.json();
      setContent(data.content ?? data.message ?? "Failed to generate report.");
    } catch (e) {
      setContent(`Error: ${(e as Error).message}`);
    }
    setLoading(false);
  }

  function download() {
    if (!content) return;
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${siteId}-report.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <div className="section-title">
        <h2>Owner / O&amp;M report</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn secondary" onClick={generate} disabled={loading}>
            {loading ? "Generating…" : content ? "Regenerate" : "Generate report"}
          </button>
          {content ? (
            <button className="btn" onClick={download}>
              Download .md
            </button>
          ) : null}
        </div>
      </div>
      {content ? (
        <div className="report-md">{content}</div>
      ) : (
        <p className="muted">Generate a shareable report with provenance, assumptions, and caveats.</p>
      )}
    </div>
  );
}
