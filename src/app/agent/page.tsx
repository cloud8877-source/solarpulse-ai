import { getLedger } from "@/data/ledger";
import { OpsFeed } from "@/app/components/OpsFeed";
import type { ActionCommitment } from "@/domain/actions";

export const dynamic = "force-dynamic";

export default async function AgentOpsPage() {
  const ledger = getLedger();
  const sweeps = await ledger.listSweeps();
  const actionsBySweep: Record<string, ActionCommitment[]> = {};
  for (const s of sweeps) {
    actionsBySweep[s.id] = await ledger.listActions({ sweepId: s.id });
  }

  return (
    <main className="container">
      <OpsFeed sweeps={sweeps} actionsBySweep={actionsBySweep} />
    </main>
  );
}
