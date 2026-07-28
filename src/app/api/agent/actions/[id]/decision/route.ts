import { getLedger } from "@/data/ledger";
import { jsonError } from "@/lib/http";
import { createSolarOpsService, SolarOpsError } from "@/services/solarops";

export const runtime = "nodejs";

/**
 * POST /api/agent/actions/[id]/decision
 * Body: { decision: 'approve' | 'deny', decided_by: string, reason?: string }
 *
 * approve → approveAction (decidedBy) THEN issueAction (demo tap: amber→green).
 * deny    → denyAction (human_rejected policyDecision; decidedBy required).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!id?.trim()) {
      return Response.json(
        { error: "bad_request", message: "Missing action id." },
        { status: 400 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      decision?: string;
      decided_by?: string;
      reason?: string;
    };

    const decision = body.decision;
    if (decision !== "approve" && decision !== "deny") {
      return Response.json(
        {
          error: "bad_request",
          message: "Body must include decision: 'approve' | 'deny'.",
        },
        { status: 400 },
      );
    }

    const decidedBy = typeof body.decided_by === "string" ? body.decided_by.trim() : "";
    if (!decidedBy) {
      throw new SolarOpsError(
        "illegal_field",
        "decision requires non-blank decided_by (human operator signature)",
      );
    }

    const ledger = getLedger();
    const svc = createSolarOpsService(undefined, { ledger });
    const now = new Date().toISOString();

    if (decision === "approve") {
      await svc.approveAction(id, { decidedBy, decidedAt: now });
      const issued = await svc.issueAction(id);
      return Response.json({ action: issued });
    }

    const denied = await svc.denyAction(id, {
      decidedBy,
      decidedAt: now,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return Response.json({ action: denied });
  } catch (err) {
    return jsonError(err);
  }
}
