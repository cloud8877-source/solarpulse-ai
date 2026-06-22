// CE eval CLI: `npm run eval`. Runs CE1–CE5 and exits non-zero on any failure.

import { CE_CASES } from "./cases";
import { runAll } from "./harness";

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
const replay = process.env.SOLAROPS_REPLAY === "1";
const live = hasKey && !replay;

console.log(
  `SolarOps CE eval pack — mode: ${live ? "LIVE (DeepSeek)" : "OFFLINE (deterministic)"}` +
    (live ? "" : "  [set DEEPSEEK_API_KEY for live agent runs]"),
);
console.log("");

const results = await runAll(CE_CASES);
let failed = 0;
for (const r of results) {
  console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.id} — ${r.title} (${r.mode})`);
  if (!r.pass) {
    failed += 1;
    for (const reason of r.reasons) console.log(`         · ${reason}`);
  }
}

console.log(`\n${results.length - failed}/${results.length} passed.`);
if (!live) {
  console.log("Note: CE4 injection-resistance is only fully exercised against the live agent.");
}
process.exit(failed > 0 ? 1 : 0);
