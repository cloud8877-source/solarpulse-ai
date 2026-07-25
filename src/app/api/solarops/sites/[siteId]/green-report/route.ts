import { jsonError } from "@/lib/http";
import { solarOps } from "@/services/solarops";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const { siteId } = await params;
    return Response.json(solarOps().generateGreenPerformanceReport(siteId));
  } catch (err) {
    return jsonError(err);
  }
}
