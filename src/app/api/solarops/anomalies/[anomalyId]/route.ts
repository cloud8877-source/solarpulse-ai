import { jsonError } from "@/lib/http";
import { solarOps } from "@/services/solarops";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ anomalyId: string }> }) {
  try {
    const { anomalyId } = await params;
    const ops = solarOps();
    const explanation = ops.explainSolarAnomaly(anomalyId);
    const { recommendations } = ops.rankOmActions(anomalyId);
    return Response.json({ anomaly_event_id: anomalyId, ...explanation, recommendations });
  } catch (err) {
    return jsonError(err);
  }
}
