import { askCopilot } from "@/agent/copilot";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { question?: string };
    const question = (body.question ?? "").trim();
    if (!question) {
      return Response.json({ error: "bad_request", message: "Missing 'question'." }, { status: 400 });
    }
    return Response.json(await askCopilot(question));
  } catch (err) {
    return jsonError(err);
  }
}
