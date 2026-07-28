import { runSweep } from "@/agent/sweep";
import { getLedger } from "@/data/ledger";
import { jsonError } from "@/lib/http";
import { createSolarOpsService } from "@/services/solarops";

export const runtime = "nodejs";

/**
 * POST /api/agent/sweep
 * Body: { as_of_date?: string }
 * Runs KREDIT offline or live based on hasLiveCredentials; returns SweepRun + action ids.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      as_of_date?: string;
      mode?: "offline" | "live" | "auto";
    };
    const ledger = getLedger();
    const svc = createSolarOpsService(undefined, { ledger });
    const result = await runSweep({
      svc,
      ledger,
      ...(body.as_of_date ? { asOfDate: body.as_of_date } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
    });
    return Response.json({
      sweep: result.sweep,
      action_ids: result.actionIds,
      mode: result.mode,
      site_summaries: result.siteSummaries,
    });
  } catch (err) {
    return jsonError(err);
  }
}
