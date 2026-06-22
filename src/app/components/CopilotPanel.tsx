"use client";

import { useState } from "react";

interface CopilotResult {
  answer: string;
  mode: string;
  adjusted: boolean;
  error?: string;
  toolTrace: { tool: string }[];
  safety: { ok: boolean };
}

export function CopilotPanel({ siteName, presets }: { siteName: string; presets: string[] }) {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<CopilotResult | null>(null);

  async function ask(question: string) {
    if (!question.trim()) return;
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/solarops/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      setRes(await r.json());
    } catch (e) {
      setRes({
        answer: `Error: ${(e as Error).message}`,
        mode: "error",
        adjusted: false,
        toolTrace: [],
        safety: { ok: false },
      });
    }
    setLoading(false);
  }

  return (
    <div className="card">
      <div className="section-title">
        <h2>AI Copilot</h2>
        {res ? (
          <span className={res.safety.ok ? "safety-ok" : "safety-warn"} style={{ fontSize: "0.78rem" }}>
            {res.safety.ok ? "✓ grounded" : "⚠ adjusted"}
          </span>
        ) : null}
      </div>
      <div className="chips">
        {presets.map((p) => (
          <span
            key={p}
            className="chip"
            onClick={() => {
              setQ(p);
              ask(p);
            }}
          >
            {p}
          </span>
        ))}
      </div>
      <div className="prompt-row">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Ask about ${siteName}…`}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask(q);
          }}
        />
        <button className="btn" onClick={() => ask(q)} disabled={loading}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </div>
      {res ? (
        <div style={{ marginTop: 16 }}>
          <div className="answer">{res.answer}</div>
          <p style={{ marginTop: 10 }}>
            <small>
              mode: {res.mode}
              {res.adjusted ? " · safety-adjusted" : ""}
              {res.error ? ` · ${res.error}` : ""}
            </small>
          </p>
          {res.toolTrace.length ? (
            <details style={{ marginTop: 6 }}>
              <summary className="muted" style={{ cursor: "pointer" }}>
                Tool trace ({res.toolTrace.length} calls)
              </summary>
              <div className="tool-trace" style={{ marginTop: 8 }}>
                {res.toolTrace.map((t, i) => (
                  <div key={i} className="step">
                    <span className="tool-name">{t.tool}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
