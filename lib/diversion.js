// SR1 diversion / release / travel-lag model.
//
// Pure functions, no I/O and no wall-clock reads: the caller passes the current
// instant (nowMs) so the same inputs always give the same output. This used to
// run in the browser against whatever window the history dropdown had loaded,
// which made the calibration swing with zoom. It now runs once on the server
// against the full retained series, so the baseline (travel lag and the
// no-diversion offset) is stable and a given hour classifies the same regardless
// of the display window.

export const FLOW_PARAM = "47";
export const BRAGG_ID = "05BJ004";
export const SARCEE_ID = "05BJ010";
export const BELOW_DAM_ID = "05BJ001";

export const SR1_FLOW_TRIGGER_M3S = 160;
const BRAGG_TO_SARCEE_LAG_HOURS = 9;
const LAG_MIN_HOURS = 3;
const LAG_MAX_HOURS = 10;
const LAG_STEP_HOURS = 0.25;
// Minimum Sarcee flow range (m3/s) over the window before the cross-correlation
// is trusted. Below this the two gauges are flat and the best-fit lag is noise.
const LAG_SIGNAL_MIN_M3S = 20;
const HOUR_MS = 3_600_000;

// Rain-event detection. A local storm raises Sarcee without any Bragg wave, which
// otherwise reads as an SR1 release. The storm signature is a short-term rise at
// Sarcee that coincides with a rise at another gauge WITHOUT the travel lag routed
// water would need — rain lands on the whole reach at once, routed water arrives
// gauge by gauge, hours apart.
const RAIN_RISE_WINDOW_HOURS = 2; // rise is measured against the value this long ago
const RAIN_RISE_M3S = 1.5; // minimum rise to count as a storm response (gauge noise is ~0.5)
const RAIN_SETTLE_MARGIN_M3S = 0.5; // window ends once Sarcee is back within this of its pre-storm flow
const RAIN_WINDOW_MAX_HOURS = 24; // hard cap so a window can never swallow a sustained real release

function bisectLeftMs(series, ms) {
  let low = 0;
  let high = series.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (series[mid].ms < ms) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// Linear interpolation of a {ms, value} series at an arbitrary instant; null
// outside the series' time span so callers can skip unsupported points.
function interpolateAt(series, ms) {
  if (series.length === 0 || ms < series[0].ms || ms > series.at(-1).ms) {
    return null;
  }
  const index = bisectLeftMs(series, ms);
  const right = series[Math.min(series.length - 1, index)];
  const left = series[Math.max(0, index - 1)];
  if (left === right) {
    return left.value;
  }
  const span = right.ms - left.ms;
  return span > 0 ? left.value + (right.value - left.value) * (ms - left.ms) / span : left.value;
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Linear-interpolated quantile (p in [0, 1]) of a numeric array.
function quantile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = p * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function flowSeries(readings, stationId) {
  return readings
    .filter((row) => row.stationId === stationId && row.parameter === FLOW_PARAM)
    .map((row) => ({ ms: new Date(row.timestamp).getTime(), value: row.value }))
    .sort((a, b) => a.ms - b.ms);
}

// The flood (high-flow) lag anchor: the single shift that best lines the two
// gauges up over the window, scored by Pearson correlation of Bragg(t) against
// Sarcee(t+lag). With no flood signal — flat flow, where the correlation is just
// noise — fall back to the surveyed low-flow value. Bounded to LAG_MIN..LAG_MAX.
function computeBraggSarceeLagHours(bragg, sarcee) {
  if (bragg.length < 2 || sarcee.length < 2) {
    return BRAGG_TO_SARCEE_LAG_HOURS;
  }
  const sarceeValues = sarcee.map((row) => row.value);
  if (Math.max(...sarceeValues) - Math.min(...sarceeValues) < LAG_SIGNAL_MIN_M3S) {
    return BRAGG_TO_SARCEE_LAG_HOURS;
  }

  let bestLag = BRAGG_TO_SARCEE_LAG_HOURS;
  let bestCorr = -Infinity;
  for (let lag = LAG_MIN_HOURS; lag <= LAG_MAX_HOURS + 1e-9; lag += LAG_STEP_HOURS) {
    const lagMs = lag * HOUR_MS;
    let n = 0;
    let sumB = 0;
    let sumS = 0;
    let sumBB = 0;
    let sumSS = 0;
    let sumBS = 0;
    for (const point of sarcee) {
      const braggValue = interpolateAt(bragg, point.ms - lagMs);
      if (braggValue === null) {
        continue;
      }
      n += 1;
      sumB += braggValue;
      sumS += point.value;
      sumBB += braggValue * braggValue;
      sumSS += point.value * point.value;
      sumBS += braggValue * point.value;
    }
    if (n < 3) {
      continue;
    }
    const covariance = sumBS / n - (sumB / n) * (sumS / n);
    const varB = sumBB / n - (sumB / n) ** 2;
    const varS = sumSS / n - (sumS / n) ** 2;
    if (varB <= 0 || varS <= 0) {
      continue;
    }
    const correlation = covariance / Math.sqrt(varB * varS);
    if (correlation > bestCorr) {
      bestCorr = correlation;
      bestLag = lag;
    }
  }
  return bestLag;
}

// Travel time shortens as flow rises, so route each Bragg reading by the lag for
// its own discharge. The lag-vs-flow curve is a power law pinned to two anchors:
// the surveyed low-flow lag at the calm flow qLow (median below-trigger flow) and
// the cross-correlated flood lag at the peak flow qHigh. With no flood signal it
// collapses to the constant low-flow lag.
function computeLagModel(bragg, sarcee) {
  const lagLow = BRAGG_TO_SARCEE_LAG_HOURS;
  const lagHigh = computeBraggSarceeLagHours(bragg, sarcee);
  const constantModel = { lagAtFlow: () => lagLow, currentHours: lagLow };

  if (bragg.length < 2 || !(lagHigh < lagLow)) {
    return constantModel;
  }
  const flows = bragg.map((row) => row.value);
  const calmFlows = flows.filter((value) => value <= SR1_FLOW_TRIGGER_M3S);
  const qLow = median(calmFlows.length ? calmFlows : flows);
  const qHigh = Math.max(...flows);
  if (!(qHigh > qLow) || qLow <= 0) {
    return constantModel;
  }

  const p = Math.log(lagLow / lagHigh) / Math.log(qHigh / qLow);
  const lagAtFlow = (flow) => {
    const lag = lagLow * Math.pow(Math.max(flow, qLow) / qLow, -p);
    return Math.min(LAG_MAX_HOURS, Math.max(LAG_MIN_HOURS, lag));
  };
  return { lagAtFlow, currentHours: lagAtFlow(bragg.at(-1).value) };
}

// Bragg Creek flow routed downstream to Sarcee, each reading shifted by the lag
// for its own flow. Sorted by arrival time (a faster flood reading can overtake a
// slower earlier one).
function projectedSeries(bragg, lagAtFlow) {
  return bragg
    .map((row) => ({ ms: row.ms + lagAtFlow(row.value) * HOUR_MS, value: row.value }))
    .sort((a, b) => a.ms - b.ms);
}

// Align the projected Sarcee onto each actual Sarcee timestamp, interpolating the
// projection. One row per actual reading with projected and actual values.
function alignedProjectedVsActual(projected, sarcee) {
  if (projected.length === 0 || sarcee.length === 0) {
    return [];
  }
  const startMs = projected[0].ms;
  const endMs = projected.at(-1).ms;
  const aligned = [];
  for (const actual of sarcee) {
    if (actual.ms < startMs || actual.ms > endMs) {
      continue;
    }
    const projectedValue = interpolateAt(projected, actual.ms);
    if (projectedValue === null) {
      continue;
    }
    aligned.push({ ms: actual.ms, projected: projectedValue, actual: actual.value });
  }
  return aligned;
}

// The no-diversion baseline offset b in Sarcee_noSR1 = Bragg(t - lag) + b. Taken
// over the calm, below-trigger points so the flood limbs do not pull it, and at a
// low quantile because an SR1 release also lands in the calm points and only ever
// pushes (actual - projected) up. A floor, not an exact figure.
function noDiversionOffset(aligned) {
  const calm = aligned.filter((row) => row.projected <= SR1_FLOW_TRIGGER_M3S);
  const offsets = (calm.length ? calm : aligned).map((row) => row.actual - row.projected);
  return quantile(offsets, 0.25);
}

// Rise of a series over the trailing RAIN_RISE_WINDOW_HOURS at each of its own
// points; null where the lookback falls outside the series.
function trailingRises(series) {
  return series.map((point) => {
    const past = interpolateAt(series, point.ms - RAIN_RISE_WINDOW_HOURS * HOUR_MS);
    return past === null ? null : point.value - past;
  });
}

// Intervals where a Sarcee rise is rain, not release. The rise is measured on the
// RESIDUAL (actual - projected - offset), not raw flow: a routed flood wave moves
// the projection along with the actual, so the residual only rises when water
// shows up that Bragg never saw. To call that rise rain rather than release, a
// companion gauge must rise inside a window no routed wave could satisfy — Bragg
// is ~9 h upstream at calm flows, so a Bragg rise within +-3 h of Sarcee's is
// un-lagged; Below Glenmore Dam is downstream THROUGH the reservoir, so routed
// Sarcee water cannot show there before (or within an hour after) Sarcee's own
// rise. Detection only runs in the calm (below-trigger) regime, the only regime
// where the model books a drain. Each window opens at the rise lookback, so the
// storm's leading creep is inside it, and closes once the residual settles back
// to its pre-storm level (hard-capped in length).
export function detectRainWindows(aligned, offset, bragg, belowDam) {
  if (aligned.length === 0) {
    return [];
  }
  const residual = aligned.map((row) => ({ ms: row.ms, value: row.actual - (row.projected + offset) }));
  const residualRises = trailingRises(residual);
  const companions = [
    { series: bragg, rises: trailingRises(bragg), beforeMs: 3 * HOUR_MS, afterMs: 3 * HOUR_MS },
    { series: belowDam, rises: trailingRises(belowDam), beforeMs: 4 * HOUR_MS, afterMs: 1 * HOUR_MS }
  ];

  const hasUnlaggedCompanionRise = (ms) =>
    companions.some(({ series, rises, beforeMs, afterMs }) => {
      for (let i = bisectLeftMs(series, ms - beforeMs); i < series.length && series[i].ms <= ms + afterMs; i += 1) {
        if (rises[i] !== null && rises[i] >= RAIN_RISE_M3S) {
          return true;
        }
      }
      return false;
    });

  const windows = [];
  for (let i = 0; i < aligned.length; i += 1) {
    if (residualRises[i] === null || residualRises[i] < RAIN_RISE_M3S) {
      continue;
    }
    if (aligned[i].projected > SR1_FLOW_TRIGGER_M3S) {
      continue;
    }
    const last = windows.at(-1);
    if (last && aligned[i].ms <= last.endMs) {
      continue;
    }
    if (!hasUnlaggedCompanionRise(aligned[i].ms)) {
      continue;
    }

    const startMs = aligned[i].ms - RAIN_RISE_WINDOW_HOURS * HOUR_MS;
    const preStormResidual = interpolateAt(residual, startMs);
    let endMs = aligned[i].ms;
    for (let j = i + 1; j < aligned.length; j += 1) {
      if (residual[j].ms - startMs > RAIN_WINDOW_MAX_HOURS * HOUR_MS) {
        break;
      }
      endMs = residual[j].ms;
      if (preStormResidual !== null && residual[j].value <= preStormResidual + RAIN_SETTLE_MARGIN_M3S) {
        break;
      }
    }

    if (last && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
    } else {
      windows.push({ startMs, endMs });
    }
  }
  return windows;
}

// Reservoir fill (inflow) and drain (outflow) rate series plus the running NET
// volume, in one pass up to the cutoff. Two gates keep the rates physical:
//   - Above the trigger the reservoir only FILLS. A receding/rising flood limb
//     makes the lagged projection cross the actual, which would otherwise paint
//     phantom outflow during the flood itself (there is none while it is filling).
//   - Below the trigger it only DRAINS, and only while it actually holds water,
//     so calm noise before the reservoir has filled does not read as release.
//   - Inside a rain window the drain is capped at its rate when the storm began,
//     so local runoff raising Sarcee cannot read as extra release (a release
//     already underway keeps counting at its pre-storm rate).
// The volume is floored at zero, so the model can never release more than stored.
function reservoirSeries(aligned, offset, cutoffMs, capacityM3, rainWindows) {
  const drainRateAt = (row) => Math.max(0, row.actual - (row.projected + offset));
  const cappedWindows = rainWindows.map((window) => {
    const index = bisectLeftMs(aligned, window.startMs);
    const onset = aligned[Math.max(0, index - 1)];
    return { ...window, capRate: onset ? drainRateAt(onset) : 0 };
  });
  const rainCapAt = (ms) => {
    for (const window of cappedWindows) {
      if (ms >= window.startMs && ms <= window.endMs) {
        return window.capRate;
      }
    }
    return Infinity;
  };

  const ratesAt = (row, storedM3) => {
    const signed = (row.projected + offset) - row.actual;
    const aboveTrigger = row.projected > SR1_FLOW_TRIGGER_M3S;
    const fill = aboveTrigger ? Math.max(0, signed) : 0;
    const drain = (!aboveTrigger && storedM3 > 0)
      ? Math.min(Math.max(0, -signed), rainCapAt(row.ms))
      : 0;
    return { fill, drain };
  };

  const usable = aligned.filter((row) => row.ms <= cutoffMs);
  const inflow = [];
  const outflow = [];
  const volume = [];
  if (usable.length < 2) {
    return { inflow, outflow, volume };
  }

  let volumeM3 = 0;
  const firstRates = ratesAt(usable[0], volumeM3);
  inflow.push({ ms: usable[0].ms, value: firstRates.fill });
  outflow.push({ ms: usable[0].ms, value: firstRates.drain });
  volume.push(volumePoint(usable[0].ms, volumeM3, capacityM3));

  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1];
    const current = usable[index];
    const seconds = (current.ms - previous.ms) / 1000;
    // Rates use the volume held at the start of the step, so the drain gate
    // reflects water actually available before this step's integration.
    const previousRates = ratesAt(previous, volumeM3);
    const currentRates = ratesAt(current, volumeM3);
    const netRate = ((previousRates.fill - previousRates.drain) + (currentRates.fill - currentRates.drain)) / 2;
    volumeM3 = Math.max(0, volumeM3 + netRate * seconds);
    inflow.push({ ms: current.ms, value: currentRates.fill });
    outflow.push({ ms: current.ms, value: currentRates.drain });
    volume.push(volumePoint(current.ms, volumeM3, capacityM3));
  }
  return { inflow, outflow, volume };
}

function volumePoint(ms, volumeM3, capacityM3) {
  return {
    ms,
    volumeM3,
    volumeDam3: volumeM3 / 1000,
    pctFull: capacityM3 ? (volumeM3 / capacityM3) * 100 : null
  };
}

// The forward forecast at Sarcee: the projected value at the far end of the
// travel-lag window past Sarcee's latest actual reading. Null when there is no
// projection reaching beyond the latest actual.
function forecastPoint(projected, sarcee, currentHours) {
  if (sarcee.length === 0) {
    return null;
  }
  const latestMs = sarcee.at(-1).ms;
  const horizonMs = latestMs + currentHours * HOUR_MS;
  const ahead = projected.filter((row) => row.ms > latestMs && row.ms <= horizonMs);
  if (ahead.length === 0) {
    return null;
  }
  const last = ahead.at(-1);
  return { atMs: last.ms, value: last.value };
}

// A flood event has settled once both gauges sit back near their pre-event
// baseline (within 2x the window minimum), after the window saw flow above the
// SR1 trigger.
function eventHasSettled(bragg, sarcee) {
  if (bragg.length < 2 || sarcee.length < 2) {
    return false;
  }
  const braggValues = bragg.map((row) => row.value);
  const sarceeValues = sarcee.map((row) => row.value);
  const peaked = Math.max(...braggValues) > SR1_FLOW_TRIGGER_M3S;
  const braggCalm = bragg.at(-1).value <= Math.min(...braggValues) * 2;
  const sarceeCalm = sarcee.at(-1).value <= Math.min(...sarceeValues) * 2;
  return peaked && braggCalm && sarceeCalm;
}

// Lag-independent cross-check on the diverted volume. Over a complete flood wave
// the travel lag cancels out of the two flow integrals, so the diverted volume is
// (integral of Bragg) - (integral of Sarcee) across the overlap. Only meaningful
// once the event has settled. Returns dam3, or null if there is no usable overlap.
function volumeBalanceDam3(bragg, sarcee) {
  if (bragg.length < 2 || sarcee.length < 2) {
    return null;
  }
  const start = Math.max(bragg[0].ms, sarcee[0].ms);
  const end = Math.min(bragg.at(-1).ms, sarcee.at(-1).ms);
  if (end - start < HOUR_MS) {
    return null;
  }
  const stepMs = 15 * 60_000;
  let volumeM3 = 0;
  for (let ms = start; ms < end; ms += stepMs) {
    const mid = ms + stepMs / 2;
    const braggValue = interpolateAt(bragg, mid);
    const sarceeValue = interpolateAt(sarcee, mid);
    if (braggValue === null || sarceeValue === null) {
      continue;
    }
    volumeM3 += (braggValue - sarceeValue) * (stepMs / 1000);
  }
  return volumeM3 / 1000;
}

// Compute the whole SR1 model from a full readings array. nowMs is the current
// instant (for the now - lag cutoff on the not-yet-knowable most recent window).
// Series are returned as {ms, ...}; the caller windows them to the display range
// and converts ms to ISO timestamps.
export function computeSr1Model(readings, nowMs, capacityM3) {
  const bragg = flowSeries(readings, BRAGG_ID);
  const sarcee = flowSeries(readings, SARCEE_ID);
  const belowDam = flowSeries(readings, BELOW_DAM_ID);
  const lag = computeLagModel(bragg, sarcee);
  const projected = projectedSeries(bragg, lag.lagAtFlow);
  const aligned = alignedProjectedVsActual(projected, sarcee);
  const offset = aligned.length ? noDiversionOffset(aligned) : 0;
  const cutoffMs = nowMs - lag.currentHours * HOUR_MS;
  const rainWindows = detectRainWindows(aligned, offset, bragg, belowDam);

  const { inflow, outflow, volume } = reservoirSeries(aligned, offset, cutoffMs, capacityM3, rainWindows);
  const settled = eventHasSettled(bragg, sarcee);

  return {
    lagHours: lag.currentHours,
    offset,
    cutoffMs,
    projected,
    inflow,
    outflow,
    volumeSeries: volume,
    rainWindows,
    forecast: forecastPoint(projected, sarcee, lag.currentHours),
    eventSettled: settled,
    volumeBalanceDam3: settled ? volumeBalanceDam3(bragg, sarcee) : null
  };
}
