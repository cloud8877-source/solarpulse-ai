// Maps service-layer errors to HTTP responses (PDR-005 §6 error behavior).

import { SolarOpsError } from "../services/solarops";

export function jsonError(err: unknown): Response {
  if (err instanceof SolarOpsError) {
    const status = err.code.endsWith("not_found") ? 404 : 400;
    return Response.json({ error: err.code, message: err.message }, { status });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: "internal_error", message }, { status: 500 });
}
