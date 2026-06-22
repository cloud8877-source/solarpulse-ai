// CE eval harness. Runs each case through the copilot. With DEEPSEEK_API_KEY set it
// exercises the LIVE agent (the real CE evaluation, esp. CE4 injection resistance);
// otherwise it runs the deterministic offline path as a key-free CI gate.

import { askCopilot, type CopilotResult } from "../agent/copilot";

export interface CheckResult {
  pass: boolean;
  reasons: string[];
}

export interface CECase {
  id: string;
  title: string;
  prompt: string;
  check: (res: CopilotResult) => CheckResult;
}

export interface CEOutcome {
  id: string;
  title: string;
  pass: boolean;
  mode: string;
  reasons: string[];
}

export async function runCase(c: CECase, mode?: "auto" | "live" | "offline"): Promise<CEOutcome> {
  const res = await askCopilot(c.prompt, mode ? { mode } : {});
  const { pass, reasons } = c.check(res);
  return { id: c.id, title: c.title, pass, mode: res.mode, reasons };
}

export async function runAll(cases: CECase[], mode?: "auto" | "live" | "offline"): Promise<CEOutcome[]> {
  const out: CEOutcome[] = [];
  for (const c of cases) out.push(await runCase(c, mode));
  return out;
}
