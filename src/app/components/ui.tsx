import type { Severity } from "@/domain/types";

export const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
/** RM-2dp discipline (engine round) — never erase sub-ringgit discrepancies. */
export const fmtRm = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (frac: number): string => `${(frac * 100).toFixed(1)}%`;

export function StatusBadge({ status }: { status: Severity }) {
  return <span className={`badge ${status}`}>{status.replace(/_/g, " ")}</span>;
}

export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "green" | "red" | "amber";
}) {
  return (
    <div className="card kpi">
      <span className="label">{label}</span>
      <span className={`value ${tone ?? ""}`}>{value}</span>
      {sub ? <span className="sub">{sub}</span> : null}
    </div>
  );
}
