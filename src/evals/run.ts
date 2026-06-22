// CE eval CLI: `npm run eval`. Runs CE1–CE5 and exits non-zero on any failure.
// Loads .env.local / .env so the live DeepSeek agent runs when a key is present.

import { existsSync } from "node:fs";
import { CE_CASES } from "./cases";
import { runAll } from "./harness";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* ignore malformed env file */
    }
  }
}

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
const replay = process.env.SOLAROPS_REPLAY === "1";
const live = hasKey && !replay;
const model = process.env.SOLAROPS_MODEL ?? "deepseek/deepseek-chat";

console.log(
  `SolarOps CE eval pack — mode: ${live ? `LIVE (${model})` : "OFFLINE (deterministic)"}` +
    (live ? "" : "  [set DEEPSEEK_API_KEY for live agent runs]"),
);
console.log("");

const results = await runAll(CE_CASES);
let failed = 0;
let fellBack = 0;
for (const r of results) {
  const meta = [r.mode, `${r.toolCount} tools`, r.adjusted ? "safety-adjusted" : "", r.error ?? ""]
    .filter(Boolean)
    .join(" · ");
  console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.id} — ${r.title}  (${meta})`);
  if (!r.pass) {
    failed += 1;
    for (const reason of r.reasons) console.log(`         · ${reason}`);
  }
  if (live && r.mode !== "live") fellBack += 1;
}

console.log(`\n${results.length - failed}/${results.length} passed.`);
if (live && fellBack > 0) {
  console.log(
    `\n⚠  ${fellBack}/${results.length} case(s) did NOT run on the live agent (fell back to the` +
      ` deterministic path — check DEEPSEEK_API_KEY / model / network). Those passes do NOT` +
      ` validate the AI; investigate before claiming the ADR-0007 gate is met.`,
  );
}
if (!live) {
  console.log("Note: CE4 injection-resistance is only fully exercised against the live agent.");
}
process.exit(failed > 0 ? 1 : 0);
