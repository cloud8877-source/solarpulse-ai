import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "SolarPulse AI — Solar Asset Performance & Grid Intelligence",
  description:
    "AI copilot for solar asset performance: forecast, detect underperformance, explain causes, and quantify kWh/RM/CO₂ impact.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <Link href="/" className="brand" style={{ color: "var(--text)" }}>
            <span className="dot" />
            <span>
              SolarPulse AI
              <small>Solar Asset Performance &amp; Grid Intelligence</small>
            </span>
          </Link>
          <span className="badge tag">MAIC T1 · demo fixture data</span>
        </header>
        {children}
      </body>
    </html>
  );
}
