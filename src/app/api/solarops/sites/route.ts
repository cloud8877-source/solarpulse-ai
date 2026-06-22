import { jsonError } from "@/lib/http";
import { solarOps } from "@/services/solarops";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json({ sites: solarOps().listSites() });
  } catch (err) {
    return jsonError(err);
  }
}
