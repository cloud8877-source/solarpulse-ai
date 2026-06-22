// In-memory data store seeded from the fixtures, behind a SQLite-ready interface.
// A future SqliteStore (better-sqlite3) can implement SolarStore without changing callers.

import type { GridSnapshot, Observation, Report, Site, Weather } from "../domain/types";
import { loadGridSnapshots, loadObservations, loadSites, loadWeather } from "./loader";

export interface SolarStore {
  listSites(): Site[];
  getSite(id: string): Site | undefined;
  getObservations(siteId: string): Observation[];
  getWeather(siteId: string): Weather[];
  getGridSnapshots(region: string): GridSnapshot[];
  saveReport(report: Report): void;
  getReport(id: string): Report | undefined;
  listReports(siteId?: string): Report[];
}

export interface StoreSeed {
  sites?: Site[];
  observations?: Observation[];
  weather?: Weather[];
  grid?: GridSnapshot[];
}

const byTimestamp = (a: { timestamp: string }, b: { timestamp: string }) =>
  a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;

export class InMemoryStore implements SolarStore {
  private readonly sites: Site[];
  private readonly obsBySite = new Map<string, Observation[]>();
  private readonly wxBySite = new Map<string, Weather[]>();
  private readonly grid: GridSnapshot[];
  private readonly reports = new Map<string, Report>();

  constructor(seed: StoreSeed = {}) {
    this.sites = seed.sites ?? loadSites();
    this.grid = seed.grid ?? loadGridSnapshots();

    for (const o of seed.observations ?? loadObservations()) {
      const list = this.obsBySite.get(o.siteId) ?? [];
      list.push(o);
      this.obsBySite.set(o.siteId, list);
    }
    for (const w of seed.weather ?? loadWeather()) {
      const list = this.wxBySite.get(w.siteId) ?? [];
      list.push(w);
      this.wxBySite.set(w.siteId, list);
    }
    for (const list of this.obsBySite.values()) list.sort(byTimestamp);
    for (const list of this.wxBySite.values()) list.sort(byTimestamp);
  }

  listSites(): Site[] {
    return [...this.sites];
  }

  getSite(id: string): Site | undefined {
    return this.sites.find((s) => s.id === id);
  }

  getObservations(siteId: string): Observation[] {
    return [...(this.obsBySite.get(siteId) ?? [])];
  }

  getWeather(siteId: string): Weather[] {
    return [...(this.wxBySite.get(siteId) ?? [])];
  }

  getGridSnapshots(region: string): GridSnapshot[] {
    return this.grid.filter((g) => g.region === region).sort(byTimestamp);
  }

  saveReport(report: Report): void {
    this.reports.set(report.reportId, report);
  }

  getReport(id: string): Report | undefined {
    return this.reports.get(id);
  }

  listReports(siteId?: string): Report[] {
    const all = [...this.reports.values()];
    return siteId ? all.filter((r) => r.siteId === siteId) : all;
  }
}

let singleton: InMemoryStore | null = null;

/** Process-wide store singleton seeded from the fixtures. */
export function getStore(): SolarStore {
  if (!singleton) singleton = new InMemoryStore();
  return singleton;
}
