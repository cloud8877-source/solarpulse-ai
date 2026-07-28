import { runVerification } from "@/agent/verify";
import { getLedger } from "@/data/ledger";
import { jsonError } from "@/lib/http";
import { createSolarOpsService } from "@/services/solarops";

export const runtime = "nodejs";

/**
 * POST /api/agent/verify
 * Body: { period_end: string }  // YYYY-MM-DD, last day of closed billing period
 *
 * Thin route over runVerification (I6). Deterministic; no LLM.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      period_end?: string;
      now?: string;
    };
    const periodEnd =
      typeof body.period_end === "string" ? body.period_end.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return Response.json(
        {
          error: "bad_request",
          message: "Body must include period_end as YYYY-MM-DD.",
        },
        { status: 400 },
      );
    }

    const ledger = getLedger();
    const svc = createSolarOpsService(undefined, { ledger });
    // Optional now override for tests/demo; default wall-clock.
    const now =
      typeof body.now === "string" && body.now.trim()
        ? body.now.trim()
        : new Date().toISOString();

    const result = await runVerification({
      periodEnd,
      now,
      svc,
      ledger,
    });
    return Response.json(result);
  } catch (err) {
    return jsonError(err);
  }
}
