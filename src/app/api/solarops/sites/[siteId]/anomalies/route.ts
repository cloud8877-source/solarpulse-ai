import { jsonError } from "@/lib/http";
import { solarOps } from "@/services/solarops";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const { siteId } = await params;
    return Response.json({ site_id: siteId, anomalies: [solarOps().detectAssetUnderperformance(siteId)] });
  } catch (err) {
    return jsonError(err);
  }
}
