import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiveWeather,
  mergeWeatherPreferFixture,
} from "../data/liveWeather";
import { InMemoryStore } from "../data/store";
import type { Site, Weather } from "../domain/types";
import { createSolarOpsService } from "../services/solarops";

function baseSite(overrides: Partial<Site> = {}): Site {
  return {
    id: "site_a",
    tenantId: "t",
    name: "Test",
    region: "Selangor",
    latitude: 3.0738,
    longitude: 101.5183,
    capacityKwp: 850,
    inverterCount: 6,
    commissioningDate: "2024-04-01",
    tariffAssumptionRmPerKwh: 0.27,
    carbonFactorKgco2PerKwh: 0.652,
    performanceRatio: 0.78,
    tariffCategory: "lv_general",
    source: "demo_fixture",
    isFixture: true,
    ...overrides,
  };
}

function openMeteoBody(overrides: Record<string, unknown> = {}) {
  return {
    utc_offset_seconds: 28800,
    timezone: "Asia/Kuala_Lumpur",
    hourly: {
      time: ["2026-07-28T00:00", "2026-07-28T12:00"],
      shortwave_radiation: [0, 708],
      temperature_2m: [26.1, 30.3],
      cloud_cover: [20, 100],
      ...(overrides.hourly as object | undefined),
    },
    ...overrides,
    // re-apply hourly after spread if caller passed it
    ...(overrides.hourly
      ? {
          hourly: {
            time: ["2026-07-28T00:00", "2026-07-28T12:00"],
            shortwave_radiation: [0, 708],
            temperature_2m: [26.1, 30.3],
            cloud_cover: [20, 100],
            ...(overrides.hourly as object),
          },
        }
      : {}),
  };
}

function mockFetchOk(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchLiveWeather (Open-Meteo)", () => {
  it("maps a successful response to Weather[] with 0–1 cloudCover", async () => {
    const fetchMock = mockFetchOk(openMeteoBody());
    vi.stubGlobal("fetch", fetchMock);

    const rows = await fetchLiveWeather(baseSite());
    expect(rows).not.toBeNull();
    expect(rows!).toHaveLength(2);

    const noon = rows!.find((w) => w.timestamp.includes("T12:00"));
    expect(noon).toBeDefined();
    expect(noon!.id).toBe("live_site_a_2026072812");
    expect(noon!.siteId).toBe("site_a");
    expect(noon!.irradianceWm2).toBe(708);
    expect(noon!.temperatureC).toBe(30.3);
    // Open-Meteo 100% → fixture convention 1.0
    expect(noon!.cloudCover).toBe(1);
    expect(noon!.rainfallMm).toBeNull();
    expect(noon!.source).toBe("open-meteo");
    expect(noon!.isFixture).toBe(false);
    expect(noon!.qualityFlags).toEqual([]);
    // Naive local wall-clock → +08:00 with seconds
    expect(noon!.timestamp).toBe("2026-07-28T12:00:00+08:00");

    const midnight = rows![0]!;
    expect(midnight.cloudCover).toBeCloseTo(0.2, 5); // 20% → 0.2
    expect(midnight.irradianceWm2).toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("api.open-meteo.com/v1/forecast");
    expect(url).toContain("latitude=3.0738");
    expect(url).toContain("longitude=101.5183");
    expect(url).toContain("shortwave_radiation");
  });

  it("returns null on non-200 without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", mockFetchOk({}, 500));
    await expect(fetchLiveWeather(baseSite())).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("returns null on network/rejected fetch without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetchLiveWeather(baseSite())).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("returns null on malformed/missing hourly JSON without throwing", async () => {
    vi.stubGlobal("fetch", mockFetchOk({ hourly: { time: [] } }));
    await expect(fetchLiveWeather(baseSite())).resolves.toBeNull();

    vi.stubGlobal("fetch", mockFetchOk({ not_hourly: true }));
    await expect(fetchLiveWeather(baseSite())).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        hourly: {
          time: ["2026-07-28T00:00"],
          // length mismatch → malformed
          shortwave_radiation: [0, 1],
          temperature_2m: [26],
          cloud_cover: [10],
        },
      }),
    );
    await expect(fetchLiveWeather(baseSite())).resolves.toBeNull();
  });

  it("returns null for null lat/lon without attempting a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchLiveWeather(baseSite({ latitude: null, longitude: null })),
    ).resolves.toBeNull();
    await expect(
      fetchLiveWeather(baseSite({ latitude: 3.0, longitude: null })),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // N7+N8: Malaysia-only offset guard — non-+08 responses must not produce rows
  // that silently fail string-key matching in the engine.
  it("returns null when utc_offset_seconds is not +08:00 (28800)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", mockFetchOk(openMeteoBody({ utc_offset_seconds: 0 })));
    await expect(fetchLiveWeather(baseSite())).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("returns null when a normalized timestamp has Z suffix (not +08:00)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockFetchOk(
        openMeteoBody({
          hourly: {
            time: ["2026-07-28T00:00:00Z", "2026-07-28T12:00:00Z"],
          },
        }),
      ),
    );
    await expect(fetchLiveWeather(baseSite())).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("mergeWeatherPreferFixture", () => {
  it("never mutates or duplicates fixture rows for demo days 2026-06-18..21", () => {
    const store = new InMemoryStore();
    const fixture = store.getWeather("site_a");
    expect(fixture.length).toBeGreaterThan(0);

    // Live rows that collide with fixture hours + one novel hour outside demo days.
    const colliding: Weather = {
      ...fixture[0]!,
      id: "live_collide",
      irradianceWm2: 9999,
      source: "open-meteo",
      isFixture: false,
      qualityFlags: [],
    };
    const novel: Weather = {
      id: "live_site_a_2026072812",
      siteId: "site_a",
      timestamp: "2026-07-28T12:00:00+08:00",
      irradianceWm2: 700,
      temperatureC: 31,
      cloudCover: 0.4,
      rainfallMm: null,
      source: "open-meteo",
      isFixture: false,
      qualityFlags: [],
    };

    const fixtureSnapshot = fixture.map((w) => ({ ...w }));
    const merged = mergeWeatherPreferFixture(fixture, [colliding, novel]);

    // Original fixture array untouched.
    expect(fixture).toEqual(fixtureSnapshot);
    // Demo-day fixture rows preserved (same count, same irradiance — not 9999).
    const demoDays = ["2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"];
    for (const day of demoDays) {
      const before = fixture.filter((w) => w.timestamp.startsWith(day));
      const after = merged.filter((w) => w.timestamp.startsWith(day));
      expect(after).toHaveLength(before.length);
      expect(after.every((w) => w.isFixture && w.source === "demo_fixture")).toBe(true);
      expect(after.some((w) => w.irradianceWm2 === 9999)).toBe(false);
    }
    // Novel live hour is added once.
    const liveAdded = merged.filter((w) => w.source === "open-meteo");
    expect(liveAdded).toHaveLength(1);
    expect(liveAdded[0]!.timestamp).toBe("2026-07-28T12:00:00+08:00");
    expect(liveAdded[0]!.isFixture).toBe(false);
  });

  // N10c: two live rows same hour-key → one addition (first wins).
  it("dedupes live rows that share the same hour key (keeps first)", () => {
    const live: Weather[] = [
      {
        id: "live_a",
        siteId: "site_a",
        timestamp: "2026-07-28T12:00:00+08:00",
        irradianceWm2: 700,
        temperatureC: 30,
        cloudCover: 0.5,
        rainfallMm: null,
        source: "open-meteo",
        isFixture: false,
        qualityFlags: [],
      },
      {
        id: "live_b",
        siteId: "site_a",
        // same hour key (YYYY-MM-DDTHH = 2026-07-28T12) as live_a
        timestamp: "2026-07-28T12:30:00+08:00",
        irradianceWm2: 999,
        temperatureC: 31,
        cloudCover: 0.6,
        rainfallMm: null,
        source: "open-meteo",
        isFixture: false,
        qualityFlags: [],
      },
    ];
    const merged = mergeWeatherPreferFixture([], live);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("live_a");
    expect(merged[0]!.irradianceWm2).toBe(700);
  });
});

describe("SolarOps getWeatherMerged (opt-in live path)", () => {
  // N9: suite-level guard — default construction is fail-closed (no network).
  it("default-constructed service never triggers network fetch", async () => {
    const spy = vi.fn(() => {
      throw new Error("fetch must not be called on default SolarOpsService");
    });
    vi.stubGlobal("fetch", spy);
    // No liveWeatherFetcher option → must default to null, not the real fetcher.
    const svc = createSolarOpsService(new InMemoryStore());
    await svc.getWeatherMerged("site_a", "2026-07-28", {
      now: "2026-07-28T12:00:00+08:00",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not call the fetcher when now is omitted (default hot path stays offline)", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const svc = createSolarOpsService(new InMemoryStore(), {
      liveWeatherFetcher: fetcher,
    });
    const rows = await svc.getWeatherMerged("site_a", "2026-06-21");
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows.every((w) => w.isFixture)).toBe(true);
  });

  it("does not call the fetcher when asOfDate is not today relative to now", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const svc = createSolarOpsService(new InMemoryStore(), {
      liveWeatherFetcher: fetcher,
    });
    // "today" is 2026-07-28, asOfDate is a fixture demo day
    const rows = await svc.getWeatherMerged("site_a", "2026-06-21", {
      now: "2026-07-28T10:00:00+08:00",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows.every((w) => w.isFixture)).toBe(true);
  });

  it("merges live rows for today without mutating fixture demo days", async () => {
    const liveRows: Weather[] = [
      {
        id: "live_site_a_2026072800",
        siteId: "site_a",
        timestamp: "2026-07-28T00:00:00+08:00",
        irradianceWm2: 0,
        temperatureC: 26,
        cloudCover: 0.3,
        rainfallMm: null,
        source: "open-meteo",
        isFixture: false,
        qualityFlags: [],
      },
      {
        id: "live_site_a_2026072812",
        siteId: "site_a",
        timestamp: "2026-07-28T12:00:00+08:00",
        irradianceWm2: 650,
        temperatureC: 31,
        cloudCover: 0.5,
        rainfallMm: null,
        source: "open-meteo",
        isFixture: false,
        qualityFlags: [],
      },
    ];
    const fetcher = vi.fn().mockResolvedValue(liveRows);
    const store = new InMemoryStore();
    const fixtureBefore = store.getWeather("site_a");
    const svc = createSolarOpsService(store, { liveWeatherFetcher: fetcher });

    const merged = await svc.getWeatherMerged("site_a", "2026-07-28", {
      now: "2026-07-28T15:00:00+08:00",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(merged).toHaveLength(2);
    expect(merged.every((w) => w.source === "open-meteo" && !w.isFixture)).toBe(true);

    // Store fixtures for demo days are unchanged.
    const fixtureAfter = store.getWeather("site_a");
    expect(fixtureAfter).toEqual(fixtureBefore);
    expect(
      fixtureAfter.filter((w) => w.timestamp.startsWith("2026-06-")).length,
    ).toBe(fixtureBefore.filter((w) => w.timestamp.startsWith("2026-06-")).length);
  });

  // N10b: null fetcher → fixture-only for both empty day and demo day with real rows.
  it("falls back to fixture-only when fetcher returns null (empty day and demo day)", async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const store = new InMemoryStore();
    const svc = createSolarOpsService(store, { liveWeatherFetcher: fetcher });

    // Empty day (no fixture coverage for "today") → empty array after filter.
    const empty = await svc.getWeatherMerged("site_a", "2026-07-28", {
      now: "2026-07-28T12:00:00+08:00",
    });
    expect(empty).toEqual([]);

    // Demo day with genuine fixture rows — must return them, not empty.
    const demo = await svc.getWeatherMerged("site_a", "2026-06-21", {
      now: "2026-06-21T12:00:00+08:00",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(demo.length).toBeGreaterThan(0);
    expect(demo.every((w) => w.isFixture)).toBe(true);
  });

  // N10a: throwing fetcher must not propagate — try/catch returns fixture-only.
  it("survives a throwing fetcher and returns fixture-only", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const store = new InMemoryStore();
    const svc = createSolarOpsService(store, { liveWeatherFetcher: fetcher });

    // Empty day (no fixture coverage)
    const empty = await svc.getWeatherMerged("site_a", "2026-07-28", {
      now: "2026-07-28T12:00:00+08:00",
    });
    expect(fetcher).toHaveBeenCalled();
    expect(empty).toEqual([]);

    // Demo day still returns fixture rows after throw
    const demo = await svc.getWeatherMerged("site_a", "2026-06-21", {
      now: "2026-06-21T12:00:00+08:00",
    });
    expect(demo.length).toBeGreaterThan(0);
    expect(demo.every((w) => w.isFixture)).toBe(true);
  });

  it("null liveWeatherFetcher never fetches even when now marks today", async () => {
    const realFetch = vi.fn();
    vi.stubGlobal("fetch", realFetch);
    const svc = createSolarOpsService(new InMemoryStore(), {
      liveWeatherFetcher: null,
    });
    await svc.getWeatherMerged("site_a", "2026-07-28", {
      now: "2026-07-28T12:00:00+08:00",
    });
    expect(realFetch).not.toHaveBeenCalled();
  });
});
