// CE eval CLI: `npm run eval`. Runs CE1–CE5 and exits non-zero on any failure.
// Loads .env.local / .env so the live agent runs when provider credentials are present.

import { existsSync } from "node:fs";
import { hasLiveCredentials, resolveModelId } from "../agent/solaropsAgent";
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

const model = resolveModelId();
const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : model;
const liveCreds = hasLiveCredentials();
const replay = process.env.SOLAROPS_REPLAY === "1";
const live = liveCreds && !replay;

console.log(
  `SolarOps CE eval pack — mode: ${live ? `LIVE (${model})` : "OFFLINE (deterministic)"}` +
    (live
      ? `  [creds: ${provider} ok]`
      : liveCreds
        ? "  [SOLAROPS_REPLAY=1 forces offline]"
        : `  [no live credentials for ${model}; set DEEPSEEK_API_KEY or AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY / AWS_BEARER_TOKEN_BEDROCK]`),
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
      ` deterministic path — check ${provider} credentials / model / network). Those passes do NOT` +
      ` validate the AI; investigate before claiming the ADR-0007 gate is met.`,
  );
}
if (!live) {
  console.log("Note: CE4 injection-resistance is only fully exercised against the live agent.");
}
process.exit(failed > 0 ? 1 : 0);
