"use client";

import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { time: string; observed: number | null; expected: number; lower: number; upper: number };

export function ForecastChart({ data }: { data: Point[] }) {
  const chartData = data.map((p) => ({ ...p, range: [p.lower, p.upper] as [number, number] }));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: -6 }}>
        <XAxis dataKey="time" stroke="#6b7798" tick={{ fontSize: 12 }} />
        <YAxis stroke="#6b7798" tick={{ fontSize: 12 }} width={46} />
        <Tooltip
          contentStyle={{ background: "#131a30", border: "1px solid #283357", borderRadius: 8, color: "#e9eefb" }}
          formatter={(v: unknown, name) => [typeof v === "number" ? `${Math.round(v)} kWh` : "—", name]}
        />
        <Area dataKey="range" stroke="none" fill="#5b9dff" fillOpacity={0.12} name="Confidence band" />
        <Line dataKey="expected" stroke="#5b9dff" strokeWidth={2} dot={false} name="Expected" />
        <Line
          dataKey="observed"
          stroke="#2dd4bf"
          strokeWidth={2.5}
          dot={{ r: 2 }}
          connectNulls={false}
          name="Observed"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
