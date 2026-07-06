import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSr1Model, detectRainWindows, FLOW_PARAM, BRAGG_ID, SARCEE_ID, BELOW_DAM_ID } from "../lib/diversion.js";

const HOUR_MS = 3_600_000;
const STEP_MS = 15 * 60_000;
const BASE_MS = Date.UTC(2026, 0, 1);

function series(hours, valueAtHour) {
  const points = [];
  for (let ms = 0; ms <= hours * HOUR_MS; ms += STEP_MS) {
    points.push({ ms: BASE_MS + ms, value: valueAtHour(ms / HOUR_MS) });
  }
  return points;
}

// Linear rise over upHours to amplitude, then linear decay over downHours.
function bump(hour, startHour, amplitude, upHours, downHours) {
  if (hour <= startHour || hour >= startHour + upHours + downHours) {
    return 0;
  }
  if (hour <= startHour + upHours) {
    return amplitude * (hour - startHour) / upHours;
  }
  return amplitude * (1 - (hour - startHour - upHours) / downHours);
}

function alignedFrom(projectedSeries, residualAtHour) {
  return projectedSeries.map((point) => ({
    ms: point.ms,
    projected: point.value,
    actual: point.value + residualAtHour((point.ms - BASE_MS) / HOUR_MS)
  }));
}

test("rain window opens when a residual rise coincides with an un-lagged below-dam rise", () => {
  const projected = series(48, () => 50);
  const aligned = alignedFrom(projected, (h) => bump(h, 24, 8, 2, 8));
  const bragg = series(48, () => 50);
  const belowDam = series(48, (h) => 60 + bump(h, 22.5, 5, 2, 6));

  const windows = detectRainWindows(aligned, 0, bragg, belowDam);
  assert.equal(windows.length, 1);
  const stormStartMs = BASE_MS + 24 * HOUR_MS;
  const stormEndMs = BASE_MS + 34 * HOUR_MS;
  assert.ok(windows[0].startMs <= stormStartMs + HOUR_MS, "window starts at or before the storm rise");
  assert.ok(windows[0].endMs >= stormEndMs - HOUR_MS, "window lasts until the residual settles");
  assert.ok(windows[0].endMs <= stormEndMs + 2 * HOUR_MS, "window does not run far past settling");
});

test("no rain window when the residual rises alone (a real release)", () => {
  const projected = series(48, () => 50);
  const aligned = alignedFrom(projected, (h) => (h >= 24 && h <= 40 ? 10 : 0));
  const bragg = series(48, () => 50);
  const belowDam = series(48, () => 60);

  assert.deepEqual(detectRainWindows(aligned, 0, bragg, belowDam), []);
});

test("a coincident Bragg rise also marks the residual rise as rain", () => {
  const projected = series(48, () => 50);
  const aligned = alignedFrom(projected, (h) => bump(h, 24, 8, 2, 8));
  const bragg = series(48, (h) => 50 + bump(h, 23, 4, 2, 6));
  const belowDam = series(48, () => 60);

  const windows = detectRainWindows(aligned, 0, bragg, belowDam);
  assert.equal(windows.length, 1);
});

test("computeSr1Model caps the drain at its pre-storm rate inside a rain window", () => {
  // Bragg: calm 50, flood day 2 (rises above the 160 trigger, fills the
  // reservoir), calm again. Sarcee: Bragg routed 9 h later, capped at 165 during
  // the flood (the diversion), +5 baseline offset. Storm bump on day 6.
  const braggAt = (h) => {
    if (h < 24 || h > 54) return 50;
    if (h <= 30) return 50 + (h - 24) * (250 / 6);
    if (h <= 42) return 300;
    return 300 - (h - 42) * (250 / 12);
  };
  const routedAt = (h) => Math.min(braggAt(h - 9), 160) + 5;
  const stormAt = (h) => bump(h, 144, 8, 2, 8);

  const buildReadings = (withCompanionBump) => {
    const readings = [];
    for (let ms = 0; ms <= 192 * HOUR_MS; ms += STEP_MS) {
      const h = ms / HOUR_MS;
      readings.push({ stationId: BRAGG_ID, parameter: FLOW_PARAM, timestamp: BASE_MS + ms, value: braggAt(h) });
      readings.push({ stationId: SARCEE_ID, parameter: FLOW_PARAM, timestamp: BASE_MS + ms, value: routedAt(h) + stormAt(h) });
      readings.push({
        stationId: BELOW_DAM_ID,
        parameter: FLOW_PARAM,
        timestamp: BASE_MS + ms,
        value: 60 + (withCompanionBump ? bump(h, 142.5, 5, 2, 6) : 0)
      });
    }
    return readings;
  };

  const nowMs = BASE_MS + 192 * HOUR_MS;
  const stormStartMs = BASE_MS + 144 * HOUR_MS;
  const stormEndMs = BASE_MS + 154 * HOUR_MS;
  const maxOutflowInStorm = (model) => Math.max(
    ...model.outflow.filter((p) => p.ms >= stormStartMs && p.ms <= stormEndMs).map((p) => p.value)
  );

  const withRain = computeSr1Model(buildReadings(true), nowMs, 70_200_000);
  const withoutCompanion = computeSr1Model(buildReadings(false), nowMs, 70_200_000);

  assert.ok(withoutCompanion.rainWindows.length === 0, "no rain windows without a companion rise");
  assert.ok(maxOutflowInStorm(withoutCompanion) > 5, "an unexplained rise without companions books as release");

  assert.ok(withRain.rainWindows.some((w) => w.startMs <= stormStartMs && w.endMs >= stormEndMs - HOUR_MS),
    "a rain window covers the storm");
  assert.ok(maxOutflowInStorm(withRain) < 1, "drain stays at its pre-storm rate through the storm");

  // The flood fill itself is untouched by the filter.
  const fillVolume = (model) => model.volumeSeries.reduce((max, p) => Math.max(max, p.volumeM3), 0);
  assert.ok(Math.abs(fillVolume(withRain) - fillVolume(withoutCompanion)) < 1, "flood fill is identical");
});
