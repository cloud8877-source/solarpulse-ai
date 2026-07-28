import {
  createSolarOpsService,
  fetchLiveWeather,
} from "@/services/solarops";

/**
 * Display-only live weather badge.
 * Constructs the service WITH liveWeatherFetcher opt-in and calls getWeatherMerged
 * for today's local (+08) calendar day. Does NOT feed any engine/report/manifest path.
 * Fail-closed: any fetch/merge miss → "fixture conditions" (never an error UI).
 */
export async function WeatherBadge({ siteId = "site_a" }: { siteId?: string }) {
  // Wall-clock "now" in MYT for the badge label (display provenance only).
  const now = new Date();
  // Format HH:MM MYT without relying on ICU timezone data quirks.
  const mytMs = now.getTime() + 8 * 60 * 60 * 1000;
  const myt = new Date(mytMs);
  const hh = String(myt.getUTCHours()).padStart(2, "0");
  const mm = String(myt.getUTCMinutes()).padStart(2, "0");
  const y = myt.getUTCFullYear();
  const mo = String(myt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(myt.getUTCDate()).padStart(2, "0");
  const asOfDate = `${y}-${mo}-${d}`;
  const nowIso = `${asOfDate}T${hh}:${mm}:00+08:00`;

  let live = false;
  let ghi: number | null = null;
  let cloudPct: number | null = null;

  try {
    const svc = createSolarOpsService(undefined, {
      liveWeatherFetcher: fetchLiveWeather,
    });
    const rows = await svc.getWeatherMerged(siteId, asOfDate, { now: nowIso });
    // Prefer a live Open-Meteo row near "now"; else any live row; else fall back.
    const liveRows = rows.filter((w) => w.source === "open-meteo" || !w.isFixture);
    const pick =
      liveRows.find((w) => w.timestamp.slice(11, 13) === hh) ??
      liveRows.find((w) => {
        const h = Number(w.timestamp.slice(11, 13));
        return h >= 10 && h <= 14;
      }) ??
      liveRows[0] ??
      null;

    if (pick && (pick.source === "open-meteo" || !pick.isFixture)) {
      live = true;
      ghi = pick.irradianceWm2;
      cloudPct =
        pick.cloudCover != null && Number.isFinite(pick.cloudCover)
          ? Math.round(pick.cloudCover * 100)
          : null;
    }
  } catch {
    live = false;
  }

  if (!live) {
    return (
      <span className="badge tag weather-badge" title="Weather badge (display-only)">
        fixture conditions
      </span>
    );
  }

  const ghiLabel = ghi != null ? `${Math.round(ghi)} W/m²` : "— W/m²";
  const cloudLabel = cloudPct != null ? `${cloudPct}% cloud` : "— cloud";

  return (
    <span
      className="badge weather-badge weather-live"
      title={`Live weather for ${siteId} (display-only; not wired into engine)`}
    >
      LIVE · Open-Meteo · retrieved {hh}:{mm} MYT · GHI {ghiLabel} · {cloudLabel}
    </span>
  );
}
