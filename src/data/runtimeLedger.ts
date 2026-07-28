// THE production entry point for the action ledger.
// Routes and request-path pages must NEVER call getLedger() bare — always
// go through getRuntimeLedger() so Workers get env.KREDIT_LEDGER (D1) and
// vitest/local node still fall back to the in-memory demo singleton.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getLedger, type ActionLedger } from "./ledger";

/**
 * Resolve the process/request ledger with Workers env when available.
 *
 * On Cloudflare Workers (OpenNext), pulls `ctx.env` via getCloudflareContext
 * and passes it to getLedger so KREDIT_LEDGER (D1) is used.
 * Outside Workers (vitest, plain node, next dev without context) any failure
 * falls back to getLedger() → in-memory singleton.
 */
export function getRuntimeLedger(): ActionLedger {
  try {
    const ctx = getCloudflareContext();
    return getLedger(ctx.env);
  } catch {
    return getLedger();
  }
}
