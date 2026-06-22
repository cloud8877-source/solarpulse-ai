import type { Horizon } from "@/domain/types";
import { jsonError } from "@/lib/http";
import { solarOps } from "@/services/solarops";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const { siteId } = await params;
    const horizon = (new URL(req.url).searchParams.get("horizon") ?? "day_ahead") as Horizon;
    return Response.json(solarOps().forecast(siteId, horizon));
  } catch (err) {
    return jsonError(err);
  }
}
