import { OpsFeed } from "@/app/components/OpsFeed";
import { getRuntimeLedger } from "@/data/runtimeLedger";
import { createSolarOpsService } from "@/services/solarops";
import type { ActionCommitment } from "@/domain/actions";

export const dynamic = "force-dynamic";

/**
 * KREDIT ops feed page.
 * I7-3: reads ONLY through the service ActionReads surface — never getLedger bare.
 * I7-7: listSweepFeed bound (limit 10); per-sweep actions also bound.
 * I8: ledger via getRuntimeLedger so production uses D1, not per-isolate memory.
 */
export default async function AgentOpsPage() {
  const svc = createSolarOpsService(undefined, { ledger: getRuntimeLedger() });
  const sweeps = await svc.listSweepFeed(10);
  const actionsBySweep: Record<string, ActionCommitment[]> = {};
  for (const s of sweeps) {
    actionsBySweep[s.id] = await svc.listSweepActions(s.id, 50);
  }
  const scoreboard = await svc.getKreditScoreboard();

  return (
    <main className="container">
      <OpsFeed
        sweeps={sweeps}
        actionsBySweep={actionsBySweep}
        scoreboard={scoreboard}
      />
    </main>
  );
}
