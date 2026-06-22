import type { ReportFormat } from "@/domain/types";
import { jsonError } from "@/lib/http";
import { solarOps } from "@/services/solarops";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      site_id?: string;
      anomaly_event_id?: string;
      format?: ReportFormat;
    };
    return Response.json(
      solarOps().generateSolarReport(body.site_id ?? "", body.anomaly_event_id ?? "", body.format ?? "markdown"),
    );
  } catch (err) {
    return jsonError(err);
  }
}
