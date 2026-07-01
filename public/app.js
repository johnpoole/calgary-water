const stationGrid = document.querySelector("#stationGrid");
const stationChain = document.querySelector("#stationChain");
const statusStrip = document.querySelector("#statusStrip");
const chart = document.querySelector("#chart");
const flowMap = document.querySelector("#flowMap");
const storageGrid = document.querySelector("#storageGrid");
const storageChart = document.querySelector("#storageChart");
const chartTitle = document.querySelector("#chartTitle");
const sourceText = document.querySelector("#sourceText");
const mapTimeLabel = document.querySelector("#mapTimeLabel");
const storageSourceText = document.querySelector("#storageSourceText");
const rangeSelect = document.querySelector("#rangeSelect");
const metricSelect = document.querySelector("#metricSelect");
const mapTimeSlider = document.querySelector("#mapTimeSlider");
const mapLatestButton = document.querySelector("#mapLatestButton");
const refreshButton = document.querySelector("#refreshButton");
const buildLabel = document.querySelector("#buildLabel");

const metricConfig = {
  flow: { parameter: "47", label: "Flow", unit: "m3/s" },
  level: { parameter: "46", label: "Level", unit: "m" }
};

const SR1_FLOW_TRIGGER_M3S = 160;
const GLENMORE_ACTIVE_FLOOD_STORAGE_DAM3 = 10_000;
const GLENMORE_STALE_HOURS = 2;
// Surveyed low-flow travel time, Bragg Creek (km 0) to Sarcee Bridge (km 28).
// Used as the fallback when the data carries no flood signal to calibrate
// against; otherwise braggToSarceeLagHours() recovers a shorter flood lag.
const BRAGG_TO_SARCEE_LAG_HOURS = 9;
const LAG_MIN_HOURS = 3;
const LAG_MAX_HOURS = 10;
const LAG_STEP_HOURS = 0.25;
// Minimum Sarcee flow range (m3/s) over the window before the cross-correlation
// is trusted. Below this the two gauges are flat and the best-fit lag is noise.
const LAG_SIGNAL_MIN_M3S = 20;
const colors = ["#0f7f8c", "#395f9d", "#7b8b2e", "#c17427", "#8f5542"];
const SARCEE_COLOR = "#395f9d";
const DIVERSION_COLOR = "#7a3aa0";
const RELEASE_COLOR = "#2f8f57";
let latestData = null;
let storageData = null;
let mapTimes = [];
let tooltip;

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatChange(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)}`;
}

function formatTime(value) {
  if (!value) {
    return "No reading";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function hoursSince(value) {
  return (Date.now() - new Date(value).getTime()) / 3_600_000;
}

function storageElevationSlope(records) {
  const points = records
    .filter((row) => Number.isFinite(row.storageDam3) && Number.isFinite(row.elevationM));

  if (points.length < 2) {
    return null;
  }

  const averageStorage = d3.mean(points, (row) => row.storageDam3);
  const averageElevation = d3.mean(points, (row) => row.elevationM);
  const variance = d3.sum(points, (row) => (row.storageDam3 - averageStorage) ** 2);

  if (!variance) {
    return null;
  }

  return d3.sum(points, (row) => (row.storageDam3 - averageStorage) * (row.elevationM - averageElevation)) / variance;
}

function estimateGlenmoreStorage(summary, records, endTimeMs = Infinity) {
  if (!latestData || !summary) {
    return null;
  }

  const startTime = new Date(summary.latestAt).getTime();
  const boundedEndTime = Number.isFinite(endTimeMs) ? endTimeMs : Infinity;
  const inflow = latestData.readings
    .filter((row) => {
      const time = new Date(row.timestamp).getTime();
      return row.stationId === "05BJ010" &&
        row.parameter === metricConfig.flow.parameter &&
        time >= startTime &&
        time <= boundedEndTime;
    })
    .map((row) => [row.timestamp, row.value]);
  const outflow = latestData.readings
    .filter((row) => {
      const time = new Date(row.timestamp).getTime();
      return row.stationId === "05BJ001" &&
        row.parameter === metricConfig.flow.parameter &&
        time >= startTime &&
        time <= boundedEndTime;
    })
    .map((row) => [row.timestamp, row.value]);

  const inflowByTime = new Map(inflow);
  const outflowByTime = new Map(outflow);
  const common = Array.from(inflowByTime.keys())
    .filter((timestamp) => outflowByTime.has(timestamp))
    .sort()
    .map((timestamp) => ({
      timestamp,
      timeMs: new Date(timestamp).getTime(),
      netFlow: inflowByTime.get(timestamp) - outflowByTime.get(timestamp)
    }));

  if (common.length < 2) {
    return null;
  }

  let netVolumeM3 = 0;
  for (let index = 1; index < common.length; index += 1) {
    const previous = common[index - 1];
    const current = common[index];
    const seconds = (current.timeMs - previous.timeMs) / 1000;
    netVolumeM3 += ((previous.netFlow + current.netFlow) / 2) * seconds;
  }

  const netDam3 = netVolumeM3 / 1000;
  const estimatedStorageDam3 = summary.storageDam3 + netDam3;
  const slope = storageElevationSlope(records);
  const estimatedElevationM = slope
    ? summary.elevationM + (estimatedStorageDam3 - summary.storageDam3) * slope
    : null;

  return {
    latestAt: common.at(-1).timestamp,
    hoursEstimated: (common.at(-1).timeMs - startTime) / 3_600_000,
    netDam3,
    estimatedStorageDam3,
    estimatedElevationM
  };
}

function displayStationName(station) {
  return station.name.replace("Clem Gardiner Bridge", "Clem Gardner Bridge");
}

function displayStationShortName(station) {
  return station.shortName.replace("Clem Gardiner Bridge", "Clem Gardner Bridge");
}

function mapLabelLines(station) {
  if (station.id === "05BJ008") {
    return ["Glenmore", "Reservoir"];
  }
  if (station.id === "05BJ001") {
    return ["Below", "Glenmore Dam"];
  }
  return [displayStationShortName(station)];
}

function mapLabelOffset(station, index) {
  if (station.id === "05BJ008") {
    return -46;
  }
  if (station.id === "05BJ001") {
    return 32;
  }
  return index % 2 === 0 ? -22 : 30;
}

async function loadData() {
  const days = rangeSelect.value;
  statusStrip.className = "status-strip";
  statusStrip.textContent = "Loading WaterOffice readings...";
  refreshButton.disabled = true;

  try {
    const response = await fetch(`/api/readings?days=${encodeURIComponent(days)}`);
    const storageResponse = await fetch(`/api/storage?days=${encodeURIComponent(days)}`);
    if (!response.ok) {
      throw new Error(`Monitor API returned HTTP ${response.status}`);
    }
    if (!storageResponse.ok) {
      throw new Error(`Storage API returned HTTP ${storageResponse.status}`);
    }
    latestData = await response.json();
    storageData = await storageResponse.json();
    render();
  } catch (error) {
    statusStrip.className = "status-strip warning";
    statusStrip.textContent = `Unable to load readings: ${error.message}`;
  } finally {
    refreshButton.disabled = false;
  }
}

function render() {
  if (!latestData) {
    return;
  }

  const metric = metricSelect.value;
  const availableCount = latestData.stations.filter((station) => latestData.summaries[station.id]?.[metric]).length;
  statusStrip.className = availableCount ? "status-strip" : "status-strip warning";
  statusStrip.textContent = `${availableCount} of ${latestData.stations.length} downstream stations have ${metricConfig[metric].label.toLowerCase()} data for the selected ${latestData.range.days}-day history. Last checked ${formatTime(latestData.checkedAt)}.`;

  sourceText.textContent = `Alberta River Basins + WaterOffice, freshest per station, ${latestData.range.days} days`;
  chartTitle.textContent = `${metricConfig[metric].label} over time`;

  renderCards(metric);
  prepareFlowMapSlider();
  renderChain();
  renderChart(metric);
  renderFlowMap();
  renderStorage();
}

function renderCards(metric) {
  stationGrid.innerHTML = latestData.stations.map((station) => {
    const summary = latestData.summaries[station.id]?.[metric];
    const level = latestData.summaries[station.id]?.level;
    const flow = latestData.summaries[station.id]?.flow;
    const unavailable = !level && !flow;

    const sarceeForecast = station.id === "05BJ010" && metric === "flow" ? estimateSarceeForecast() : null;
    const sarceeForecastText = sarceeForecast
      ? `<br>Estimated next ${formatTime(sarceeForecast.at)}: ${formatNumber(sarceeForecast.value, 1)} m3/s from Bragg +${formatNumber(braggToSarceeLagHours(), 1)}h`
      : "";

    const provider = latestData.providers?.[station.id]?.[metricConfig[metric].parameter];
    const providerLabel = provider === "alberta"
      ? "Live: Alberta River Basins"
      : provider === "wateroffice"
        ? "Live: WaterOffice"
        : "";

    return `
      <article class="station-card ${unavailable ? "unavailable" : ""}">
        <div class="station-name">
          <div>
            <strong>${displayStationShortName(station)}</strong>
            <div class="station-id">${station.id}</div>
          </div>
          <span class="station-id">${station.downstreamKm} km</span>
        </div>
        ${metricLine("Level", level, "m")}
        ${metricLine("Flow", flow, "m3/s")}
        <p class="metric-change">${summary ? `Latest ${metricConfig[metric].label.toLowerCase()} at ${formatTime(summary.latestAt)} · age ${formatNumber(summary.ageMinutes, 1)} min · range ${formatNumber(summary.min)}-${formatNumber(summary.max)} ${summary.unit}.${sarceeForecastText}` : "No current unit values returned for this station and metric."}</p>
        <p class="station-source">${providerLabel ? `${providerLabel} · ` : ""}<a href="https://wateroffice.ec.gc.ca/report/real_time_e.html?stn=${station.id}" target="_blank" rel="noopener">Verify on WaterOffice ↗</a></p>
      </article>
    `;
  }).join("");
}

function stationFlowSeries(stationId) {
  return latestData.readings
    .filter((row) => row.stationId === stationId && row.parameter === metricConfig.flow.parameter)
    .map((row) => ({ ms: new Date(row.timestamp).getTime(), value: row.value }))
    .sort((a, b) => a.ms - b.ms);
}

// Linear interpolation of a {ms, value} series at an arbitrary instant; null
// outside the series' time span so callers can skip unsupported points.
function interpolateAt(series, ms) {
  if (series.length === 0 || ms < series[0].ms || ms > series.at(-1).ms) {
    return null;
  }
  const index = d3.bisector((row) => row.ms).left(series, ms);
  const right = series[Math.min(series.length - 1, index)];
  const left = series[Math.max(0, index - 1)];
  if (left === right) {
    return left.value;
  }
  const span = right.ms - left.ms;
  return span > 0 ? left.value + (right.value - left.value) * (ms - left.ms) / span : left.value;
}

// The flood (high-flow) lag anchor: the single shift that best lines the two
// gauges up over the window, scored by Pearson correlation of Bragg(t) against
// Sarcee(t+lag). The hydrograph's variance is dominated by the flood, so this
// is the travel time near the peak. With no flood signal — flat flow, where the
// correlation is just noise — fall back to the surveyed low-flow value. Bounded
// to LAG_MIN..LAG_MAX so a bad fit can't produce an absurd lag. Feeds
// computeLagModel as the high-flow end of the lag-vs-flow curve.
function computeBraggSarceeLagHours() {
  const bragg = stationFlowSeries("05BJ004");
  const sarcee = stationFlowSeries("05BJ010");
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
    const lagMs = lag * 3_600_000;
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
// its own discharge rather than one lag for the whole window. The lag-vs-flow
// curve is a power law, lag = lagLow * (Q / qLow)^(-p) — the open-channel form
// where velocity grows as a power of discharge — pinned to two anchors: the
// surveyed low-flow lag at the calm flow qLow (the median of the below-trigger
// flow, i.e. typical non-flood discharge), and the cross-correlated flood lag at
// the peak flow qHigh. With no flood signal (flood lag == low-flow lag) it
// collapses to the constant low-flow lag.
function computeLagModel() {
  const lagLow = BRAGG_TO_SARCEE_LAG_HOURS;
  const lagHigh = computeBraggSarceeLagHours();
  const constantModel = { lagAtFlow: () => lagLow, currentHours: lagLow };

  const bragg = stationFlowSeries("05BJ004");
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

// The lag model is the same for every caller in a render pass; compute once per
// loaded dataset.
let lagModelCacheData = null;
let lagModelCacheValue = null;
function lagModel() {
  if (lagModelCacheData !== latestData) {
    lagModelCacheData = latestData;
    lagModelCacheValue = computeLagModel();
  }
  return lagModelCacheValue;
}

// Representative single lag (at the current Bragg flow) for display, the map
// river speed, the forecast horizon, and the now - lag cutoff.
function braggToSarceeLagHours() {
  return lagModel().currentHours;
}

// Bragg Creek flow routed downstream to Sarcee, each reading shifted by the lag
// for its own flow. With no diversion this is what Sarcee should read; the part
// beyond Sarcee's latest reading is the forward forecast. Sorted by arrival time
// (a faster flood reading can overtake a slower earlier one).
function sarceeProjectedSeries() {
  const { lagAtFlow } = lagModel();
  return latestData.readings
    .filter((row) => row.stationId === "05BJ004" && row.parameter === metricConfig.flow.parameter)
    .map((row) => ({
      date: new Date(new Date(row.timestamp).getTime() + lagAtFlow(row.value) * 3_600_000),
      value: row.value
    }))
    .sort((a, b) => a.date - b.date);
}

function sarceeForecastSeries() {
  const sarceeLatest = latestData?.summaries?.["05BJ010"]?.flow?.latestAt;
  if (!sarceeLatest) {
    return [];
  }

  const sarceeLatestMs = new Date(sarceeLatest).getTime();
  const horizonMs = sarceeLatestMs + braggToSarceeLagHours() * 3_600_000;
  return sarceeProjectedSeries()
    .filter((row) => row.date.getTime() > sarceeLatestMs && row.date.getTime() <= horizonMs)
    .map((row) => ({ stationId: "05BJ010-estimate", date: row.date, value: row.value }));
}

// Align the projected Sarcee (Bragg routed by the travel lag) with actual
// Sarcee readings, interpolating the projection onto each actual timestamp.
// Returns one row per actual reading with the projected and actual values.
function sarceeProjectedVsActual() {
  const projected = sarceeProjectedSeries();
  const sarceeActual = latestData.readings
    .filter((row) => row.stationId === "05BJ010" && row.parameter === metricConfig.flow.parameter)
    .map((row) => ({ date: new Date(row.timestamp), value: row.value }))
    .sort((a, b) => a.date - b.date);

  if (projected.length === 0 || sarceeActual.length === 0) {
    return [];
  }

  const projectStartMs = projected[0].date.getTime();
  const projectEndMs = projected.at(-1).date.getTime();
  const bisect = d3.bisector((row) => row.date).left;
  const aligned = [];

  for (const actual of sarceeActual) {
    const timeMs = actual.date.getTime();
    if (timeMs < projectStartMs || timeMs > projectEndMs) {
      continue;
    }
    const index = bisect(projected, actual.date);
    const right = projected[Math.min(projected.length - 1, index)];
    const left = projected[Math.max(0, index - 1)];
    let projectedValue;
    if (left === right) {
      projectedValue = left.value;
    } else {
      const span = right.date - left.date;
      const fraction = span > 0 ? (actual.date - left.date) / span : 0;
      projectedValue = left.value + (right.value - left.value) * fraction;
    }
    aligned.push({ date: actual.date, projected: projectedValue, actual: actual.value });
  }

  return aligned;
}

// The diversion estimate is blank for the most recent lag-window: water that
// passed Bragg within the last lag hours has not reached Sarcee yet, so there
// is no actual Sarcee reading to compare against and the diversion for that
// window is not yet knowable. Cut the estimate off at now - lag.
function sr1EstimateCutoffMs() {
  return Date.now() - braggToSarceeLagHours() * 3_600_000;
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

// The no-diversion relationship between lagged Bragg and Sarcee:
//   Sarcee_noSR1 = Bragg(t - lag) + b
// Gain is pinned at 1 (downstream flow cannot be a fraction of upstream with
// nothing removed). The gain CANNOT be fit from event data: the only high-flow
// samples available are contaminated by the diversion we are trying to measure,
// and least squares lets those few high-leverage points absorb the diversion
// into the slope. b is the inter-gauge baseline inflow, taken over the calm,
// below-trigger points so the flood limbs do not pull it. A low quantile is used
// rather than the median because an SR1 RELEASE also lands in the calm points:
// returned water raises actual Sarcee above the projection and only ever pushes
// (actual - projected) up, never down. The low envelope of the calm offsets is
// therefore release-free and is the true baseline; the median would be dragged
// upward by a sustained release and blunt the whole estimate. During a flood the
// true inflow grows above b, so this underestimates diversion: it is a floor, not
// an exact figure.
function noDiversionOffset(aligned) {
  const calm = aligned.filter((row) => row.projected <= SR1_FLOW_TRIGGER_M3S);
  const offsets = (calm.length ? calm : aligned).map((row) => row.actual - row.projected);
  return quantile(offsets, 0.25);
}

// Estimated diversion rate at each Sarcee reading: the no-diversion flow minus
// the actual. Near zero when SR1 is off, and rises when actual Sarcee falls
// below the expected no-SR1 flow. Blank for the most recent lag-window, which
// is not yet knowable.
function sarceeDiversionSeries() {
  const cutoffMs = sr1EstimateCutoffMs();
  const aligned = sarceeProjectedVsActual();
  const offset = noDiversionOffset(aligned);
  return aligned
    .filter((row) => row.date.getTime() <= cutoffMs)
    .map((row) => ({ date: row.date, value: (row.projected + offset) - row.actual }));
}

// Insert an interpolated { value: 0 } point wherever the series crosses zero, so
// the diversion line can be split into a positive (into SR1) and a negative
// (released back to the Elbow) segment that meet exactly on the axis instead of
// leaving a gap at the crossing.
function withZeroCrossings(series) {
  const out = [];
  for (let index = 0; index < series.length; index += 1) {
    const current = series[index];
    out.push(current);
    const next = series[index + 1];
    if (next && ((current.value < 0 && next.value > 0) || (current.value > 0 && next.value < 0))) {
      const fraction = current.value / (current.value - next.value);
      const crossMs = current.date.getTime() + (next.date.getTime() - current.date.getTime()) * fraction;
      out.push({ date: new Date(crossMs), value: 0 });
    }
  }
  return out;
}

// Integrate the estimated rate to get the NET volume held in SR1, up to endTimeMs
// (and never past the now - lag cutoff, since the most recent lag-window is not
// yet knowable). Two directions, split at the trigger:
//   - above the trigger (flood) the reservoir FILLS: count the positive part of
//     (no-diversion flow - actual Sarcee), clamped at zero so fit noise and
//     growing tributary inflow do not register as a fill;
//   - below the trigger (post-peak) the reservoir DRAINS as SR1 releases the
//     stored water back into the Elbow: count the negative part (actual Sarcee
//     above the projection is the returned water), clamped at zero the other way
//     so calm noise does not register as a release.
// The running total is floored at zero: the model can never release more than it
// stored. Net volume therefore rises through the flood and draws back down over
// the release, instead of filling and staying full.
function sr1DivertedVolume(capacityM3, endTimeMs = Infinity) {
  const aligned = sarceeProjectedVsActual();
  if (aligned.length < 2) {
    return null;
  }

  const effectiveEndMs = Math.min(endTimeMs, sr1EstimateCutoffMs());
  const offset = noDiversionOffset(aligned);
  const rateOf = (row) => {
    const signed = (row.projected + offset) - row.actual;
    return row.projected > SR1_FLOW_TRIGGER_M3S ? Math.max(0, signed) : Math.min(0, signed);
  };

  let volumeM3 = 0;
  for (let index = 1; index < aligned.length; index += 1) {
    const previous = aligned[index - 1];
    const current = aligned[index];
    if (current.date.getTime() > effectiveEndMs) {
      break;
    }
    const seconds = (current.date.getTime() - previous.date.getTime()) / 1000;
    volumeM3 = Math.max(0, volumeM3 + ((rateOf(previous) + rateOf(current)) / 2) * seconds);
  }

  return {
    volumeM3,
    volumeDam3: volumeM3 / 1000,
    pctFull: capacityM3 ? (volumeM3 / capacityM3) * 100 : null,
    offset
  };
}

// Lag-independent cross-check on the diverted volume. Over a complete flood
// wave the travel lag cancels out of the two flow integrals, so the diverted
// volume is simply (integral of Bragg) - (integral of Sarcee) across the
// window. This is only meaningful once both gauges have settled back toward
// baseline (eventHasSettled); mid-event the window cuts through the wave and
// the integral is biased. Returns dam3, or null if there is no usable overlap.
function sarceeVolumeBalanceDam3() {
  const bragg = stationFlowSeries("05BJ004");
  const sarcee = stationFlowSeries("05BJ010");
  if (bragg.length < 2 || sarcee.length < 2) {
    return null;
  }
  const start = Math.max(bragg[0].ms, sarcee[0].ms);
  const end = Math.min(bragg.at(-1).ms, sarcee.at(-1).ms);
  if (end - start < 3_600_000) {
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

// A flood event has settled once both gauges sit back near their pre-event
// baseline (within 2x the window minimum), after the window saw flow above the
// SR1 trigger. Until then the lag-free volume balance is not yet meaningful.
function eventHasSettled() {
  const bragg = stationFlowSeries("05BJ004");
  const sarcee = stationFlowSeries("05BJ010");
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

function estimateSarceeForecast() {
  const series = sarceeForecastSeries();
  if (series.length === 0) {
    return null;
  }
  const latest = series.at(-1);
  return {
    at: latest.date.toISOString(),
    value: latest.value
  };
}

function metricLine(label, summary, unit) {
  if (!summary) {
    return `
      <div class="metric-row">
        <span class="metric-label">${label}</span>
        <span class="metric-value">n/a</span>
        <span class="metric-change">No recent data</span>
      </div>
    `;
  }

  return `
    <div class="metric-row">
      <span class="metric-label">${label}</span>
      <span class="metric-value">${formatNumber(summary.latest)} ${unit}</span>
      <span class="metric-change">1h ${formatChange(summary.change1h)}, 6h ${formatChange(summary.change6h)}, period ${formatChange(summary.changeRange)}</span>
    </div>
  `;
}

function renderChain() {
  stationChain.innerHTML = latestData.stations.map((station, index) => `
    <div class="chain-item">
      <div class="chain-dot">${index + 1}</div>
      <div>
        <strong>${displayStationName(station)}</strong>
        <div class="chain-meta">${station.id} · ${station.downstreamKm} km downstream · ${formatNumber(station.drainageAreaKm2, 0)} km2 drainage area</div>
      </div>
    </div>
  `).join("");
}

function prepareFlowMapSlider() {
  const currentMax = Number(mapTimeSlider.max);
  const currentValue = Number(mapTimeSlider.value);
  const wasAtLatest = !Number.isFinite(currentMax) || currentMax === 0 || currentValue >= currentMax;
  const flowReadings = latestData.readings
    .filter((row) => row.parameter === metricConfig.flow.parameter)
    .map((row) => row.timestamp);

  mapTimes = Array.from(new Set(flowReadings)).sort();
  mapTimeSlider.max = String(Math.max(0, mapTimes.length - 1));

  if (wasAtLatest || currentValue > mapTimes.length - 1) {
    mapTimeSlider.value = String(Math.max(0, mapTimes.length - 1));
  }

  mapTimeSlider.disabled = mapTimes.length === 0;
  mapLatestButton.disabled = mapTimes.length === 0;
}

function readingsAtSelectedMapTime() {
  if (mapTimes.length === 0) {
    return new Map();
  }

  const selectedTime = mapTimes[Number(mapTimeSlider.value)];
  const readings = latestData.readings
    .filter((row) => row.parameter === metricConfig.flow.parameter && row.timestamp <= selectedTime)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const latestByStation = new Map();
  for (const row of readings) {
    latestByStation.set(row.stationId, row);
  }
  return latestByStation;
}

function upstreamFlowSeries(stationId, selectedTimeMs) {
  return latestData.readings
    .filter((row) => row.stationId === stationId &&
      row.parameter === metricConfig.flow.parameter &&
      Number.isFinite(row.value))
    .map((row) => ({ timeMs: new Date(row.timestamp).getTime(), value: row.value }))
    .filter((row) => row.timeMs <= selectedTimeMs)
    .sort((a, b) => a.timeMs - b.timeMs);
}

function flowAtOrBefore(series, targetMs) {
  let result = null;
  for (const point of series) {
    if (point.timeMs <= targetMs) {
      result = point;
    } else {
      break;
    }
  }
  return result || series[0] || null;
}

function glenmoreStorageAtSelectedMapTime() {
  const glenmore = storageData?.locations?.find((location) => location.id === "glenmore");
  const records = glenmore?.records || [];

  if (records.length === 0 || mapTimes.length === 0) {
    return null;
  }

  const selected = new Date(mapTimes[Number(mapTimeSlider.value)]).getTime();
  const summaryTime = glenmore?.summary ? new Date(glenmore.summary.latestAt).getTime() : null;
  const staleBoundary = summaryTime + GLENMORE_STALE_HOURS * 3_600_000;

  if (summaryTime && selected > staleBoundary) {
    const estimate = estimateGlenmoreStorage(glenmore.summary, records, selected);
    if (estimate) {
      return {
        timestamp: estimate.latestAt,
        elevationM: estimate.estimatedElevationM,
        storageDam3: estimate.estimatedStorageDam3,
        storageM3: estimate.estimatedStorageDam3 * 1000,
        estimated: true
      };
    }
  }

  let nearest = null;
  let nearestDistance = Infinity;

  for (const record of records) {
    const distance = Math.abs(new Date(record.timestamp).getTime() - selected);
    if (distance < nearestDistance) {
      nearest = record;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function renderFlowMap() {
  flowMap.innerHTML = "";

  if (!latestData || mapTimes.length === 0) {
    flowMap.innerHTML = "<p>No flow readings available for the selected range.</p>";
    mapTimeLabel.textContent = "No timestamp";
    return;
  }

  const selectedTime = mapTimes[Number(mapTimeSlider.value)];
  const latestByStation = readingsAtSelectedMapTime();
  const glenmoreStorage = glenmoreStorageAtSelectedMapTime();
  const glenmoreLocation = storageData?.locations?.find((location) => location.id === "glenmore");
  const glenmoreRecords = glenmoreLocation?.records || [];
  const flowValues = Array.from(latestByStation.values()).map((row) => row.value).filter(Number.isFinite);
  const historicalFlowValues = latestData.readings
    .filter((row) => row.parameter === metricConfig.flow.parameter)
    .map((row) => row.value)
    .filter(Number.isFinite);
  const selectedMaxFlow = d3.max(flowValues) || 1;
  const historicalMaxFlow = d3.max(historicalFlowValues) || selectedMaxFlow;
  const flowScaleMax = Math.max(historicalMaxFlow, SR1_FLOW_TRIGGER_M3S);
  const strokeWidth = d3.scaleSqrt().domain([0, flowScaleMax]).range([3, 30]);
  const color = d3.scaleSequential(d3.interpolatePuBuGn).domain([0, flowScaleMax]);
  const storageExtent = d3.extent(glenmoreRecords, (record) => record.storageDam3);
  const storageRadius = d3.scaleSqrt()
    .domain(storageExtent[0] === storageExtent[1] ? [0, storageExtent[1] || 1] : storageExtent)
    .range([15, 44]);

  mapTimeLabel.textContent = `${formatTime(selectedTime)} · current max ${formatNumber(selectedMaxFlow, 1)} m3/s · SR1 trigger ${formatNumber(SR1_FLOW_TRIGGER_M3S, 0)} m3/s`;

  const bounds = flowMap.getBoundingClientRect();
  const width = Math.max(340, bounds.width);
  const height = Math.max(370, bounds.height || 390);
  const margin = { top: 42, right: 42, bottom: 78, left: 42 };
  const stations = latestData.stations;
  const x = d3.scaleLinear()
    .domain(d3.extent(stations, (station) => station.downstreamKm))
    .range([margin.left, width - margin.right]);
  const yBase = height * 0.48;

  const points = stations.map((station, index) => ({
    station,
    x: x(station.downstreamKm),
    y: yBase + Math.sin(index * 1.35) * 38
  }));

  const svg = d3.select(flowMap)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`);

  svg.append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", width)
    .attr("height", height)
    .attr("rx", 8)
    .attr("fill", "#eef7f5");

  const segmentLine = d3.line()
    .curve(d3.curveCatmullRom.alpha(0.65))
    .x((point) => point.x)
    .y((point) => point.y);

  // Travel time is derived from the live Bragg-to-Sarcee lag (km 0 to km 28),
  // giving a river speed we apply to every segment by distance.
  const bragg = stations.find((station) => station.id === "05BJ004");
  const sarcee = stations.find((station) => station.id === "05BJ010");
  const riverSpeedKmPerH = bragg && sarcee && sarcee.downstreamKm > bragg.downstreamKm
    ? (sarcee.downstreamKm - bragg.downstreamKm) / braggToSarceeLagHours()
    : null;
  const selectedTimeMs = new Date(selectedTime).getTime();
  const INCREMENT_HOURS = 0.5;

  for (let i = 0; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const distanceKm = next.station.downstreamKm - current.station.downstreamKm;
    const segmentTravelHours = riverSpeedKmPerH && distanceKm > 0
      ? distanceKm / riverSpeedKmPerH
      : 0;
    const upstreamSeries = upstreamFlowSeries(current.station.id, selectedTimeMs);

    // Sample the segment in 30-minute travel-time increments. At each step the
    // width reflects the upstream reading from that many hours earlier, so the
    // flood wave shows as it propagates downstream.
    const increments = [];
    if (segmentTravelHours > 0) {
      for (let hours = 0; hours < segmentTravelHours; hours += INCREMENT_HOURS) {
        increments.push(hours);
      }
    } else {
      increments.push(0);
    }

    for (let step = 0; step < increments.length; step += 1) {
      const startHours = increments[step];
      const endHours = step + 1 < increments.length ? increments[step + 1] : segmentTravelHours;
      const fractionStart = segmentTravelHours > 0 ? startHours / segmentTravelHours : 0;
      const fractionEnd = segmentTravelHours > 0 ? endHours / segmentTravelHours : 1;
      const from = {
        x: current.x + (next.x - current.x) * fractionStart,
        y: current.y + (next.y - current.y) * fractionStart
      };
      const to = {
        x: current.x + (next.x - current.x) * fractionEnd,
        y: current.y + (next.y - current.y) * fractionEnd
      };

      const upstreamReading = upstreamSeries.length
        ? flowAtOrBefore(upstreamSeries, selectedTimeMs - startHours * 3_600_000)
        : null;
      const value = upstreamReading ? upstreamReading.value : latestByStation.get(next.station.id)?.value;

      svg.append("path")
        .datum([from, to])
        .attr("d", segmentLine)
        .attr("fill", "none")
        .attr("stroke", Number.isFinite(value) ? color(value) : "#bcccca")
        .attr("stroke-width", Number.isFinite(value) ? strokeWidth(value) : 3)
        .attr("stroke-linecap", "round")
        .attr("opacity", Number.isFinite(value) ? 0.82 : 0.45);
    }
  }

  svg.append("path")
    .datum(points)
    .attr("d", segmentLine)
    .attr("fill", "none")
    .attr("stroke", "rgba(7, 94, 104, 0.35)")
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", "4 8")
    .attr("stroke-linecap", "round");

  const stationGroups = svg.selectAll(".map-station")
    .data(points)
    .join("g")
    .attr("class", "map-station")
    .attr("transform", (point) => `translate(${point.x},${point.y})`);

  stationGroups.append("circle")
    .attr("r", 8)
    .attr("fill", (point) => latestByStation.has(point.station.id) ? "#075e68" : "#ffffff")
    .attr("stroke", "#075e68")
    .attr("stroke-width", 2);

  const stationLabel = stationGroups.append("text")
    .attr("class", "flow-map-label")
    .attr("x", 0)
    .attr("y", (point, index) => mapLabelOffset(point.station, index))
    .attr("text-anchor", "middle");

  stationLabel.each(function(point) {
    const text = d3.select(this);
    mapLabelLines(point.station).forEach((line, index) => {
      text.append("tspan")
        .attr("x", 0)
        .attr("dy", index === 0 ? 0 : 13)
        .text(line);
    });
  });

  stationGroups.append("text")
    .attr("class", "flow-map-meta")
    .attr("x", 0)
    .attr("y", (point, index) => mapLabelOffset(point.station, index) + mapLabelLines(point.station).length * 13 + 4)
    .attr("text-anchor", "middle")
    .text((point) => {
      const reading = latestByStation.get(point.station.id);
      return reading ? `${formatNumber(reading.value, 1)} m3/s` : "no flow";
    });

  const aboveDam = points.find((point) => point.station.id === "05BJ001");
  const reservoirPoint = aboveDam ? {
    x: Math.max(margin.left + 24, aboveDam.x - 44),
    y: aboveDam.y - 58
  } : null;

  if (reservoirPoint) {
    const radius = glenmoreStorage ? storageRadius(glenmoreStorage.storageDam3) : 18;

    svg.append("circle")
      .attr("cx", reservoirPoint.x)
      .attr("cy", reservoirPoint.y)
      .attr("r", radius)
      .attr("fill", "#8ed0dc")
      .attr("fill-opacity", 0.42)
      .attr("stroke", "#075e68")
      .attr("stroke-width", 2);

    svg.append("text")
      .attr("class", "flow-map-label")
      .attr("x", reservoirPoint.x)
      .attr("y", reservoirPoint.y - radius - 8)
      .attr("text-anchor", "middle")
      .text(glenmoreStorage?.estimated ? "Glenmore est." : "Glenmore");

    svg.append("text")
      .attr("class", "flow-map-meta")
      .attr("x", reservoirPoint.x)
      .attr("y", reservoirPoint.y + 4)
      .attr("text-anchor", "middle")
      .text(glenmoreStorage ? `${formatNumber(glenmoreStorage.elevationM, 2)} m` : "no level");

    svg.append("text")
      .attr("class", "flow-map-meta")
      .attr("x", reservoirPoint.x)
      .attr("y", reservoirPoint.y + 18)
      .attr("text-anchor", "middle")
      .text(glenmoreStorage ? `${formatNumber(glenmoreStorage.storageDam3, 0)} dam3` : "");
  }

  const sr1Reference = points.find((point) => point.station.id === "05BJ004");
  const sr1Location = storageData?.locations?.find((location) => location.id === "sr1");
  const sr1Point = sr1Reference ? {
    x: sr1Reference.x + 56,
    y: Math.max(margin.top + 58, sr1Reference.y - 78)
  } : null;

  if (sr1Point && sr1Location) {
    const sr1Diversion = sr1DivertedVolume(sr1Location.capacityM3, new Date(selectedTime).getTime());
    const sr1FillFraction = sr1Diversion && Number.isFinite(sr1Diversion.pctFull)
      ? Math.min(1, sr1Diversion.pctFull / 100)
      : 0;

    svg.append("circle")
      .attr("cx", sr1Point.x)
      .attr("cy", sr1Point.y)
      .attr("r", 24)
      .attr("fill", "#d98a3d")
      .attr("fill-opacity", 0.1 + sr1FillFraction * 0.7)
      .attr("stroke", "#b65a18")
      .attr("stroke-width", 2.5)
      .attr("stroke-dasharray", "6 5");

    svg.append("text")
      .attr("class", "flow-map-label")
      .attr("x", sr1Point.x)
      .attr("y", sr1Point.y - 36)
      .attr("text-anchor", "middle")
      .text("SR1");

    svg.append("text")
      .attr("class", "flow-map-meta")
      .attr("x", sr1Point.x)
      .attr("y", sr1Point.y + 4)
      .attr("text-anchor", "middle")
      .text(sr1Diversion ? `${formatNumber(sr1Diversion.volumeDam3, 0)} dam3 net` : "no live level");

    svg.append("text")
      .attr("class", "flow-map-meta")
      .attr("x", sr1Point.x)
      .attr("y", sr1Point.y + 18)
      .attr("text-anchor", "middle")
      .text(sr1Diversion ? `${formatNumber(sr1Diversion.pctFull, 1)}% of cap (est.)` : `${formatNumber(sr1Location.capacityM3 / 1000, 0)} dam3 cap.`);

    // Once the wave has passed both gauges, show the lag-free volume balance as
    // an independent check on the running estimate.
    const balanceDam3 = eventHasSettled() ? sarceeVolumeBalanceDam3() : null;
    if (sr1Diversion && balanceDam3 !== null) {
      svg.append("text")
        .attr("class", "flow-map-meta")
        .attr("x", sr1Point.x)
        .attr("y", sr1Point.y + 32)
        .attr("text-anchor", "middle")
        .text(`balance check ${formatNumber(balanceDam3, 0)} dam3`);
    }
  }

  const legendX = margin.left;
  const legendY = height - 58;
  const legendValues = d3.range(1, 11).map((step) => flowScaleMax * step / 10);

  const legendGroup = svg.append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  legendValues.forEach((value, index) => {
    const xOffset = index * 70;

    legendGroup.append("line")
      .attr("x1", xOffset)
      .attr("x2", xOffset + 42)
      .attr("y1", 0)
      .attr("y2", 0)
      .attr("stroke", color(value))
      .attr("stroke-width", strokeWidth(value))
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.82);

    legendGroup.append("text")
      .attr("class", "flow-map-meta")
      .attr("x", xOffset)
      .attr("y", 30)
      .text(value === SR1_FLOW_TRIGGER_M3S ? `SR1 ${formatNumber(value, 0)}` : formatNumber(value, 0));
  });
}

function renderChart(metric) {
  chart.innerHTML = "";
  const parameter = metricConfig[metric].parameter;
  const readings = latestData.readings
    .filter((row) => row.parameter === parameter)
    .map((row) => ({ ...row, date: new Date(row.timestamp) }));
  const projectedSarcee = metric === "flow" ? sarceeProjectedSeries() : [];
  const diversionValues = metric === "flow" ? sarceeDiversionSeries() : [];
  const chartReadings = readings.concat(projectedSarcee);

  const series = latestData.stations.map((station, index) => ({
    station,
    color: colors[index % colors.length],
    values: readings.filter((row) => row.stationId === station.id)
  })).filter((item) => item.values.length > 0);

  if (series.length === 0) {
    chart.innerHTML = "<p>No data available for this metric in the selected range.</p>";
    return;
  }

  const bounds = chart.getBoundingClientRect();
  const width = Math.max(320, bounds.width);
  const height = Math.max(360, bounds.height || 430);
  const margin = { top: 16, right: 28, bottom: 42, left: 62 };

  const svg = d3.select(chart)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`);

  const x = d3.scaleTime()
    .domain(d3.extent(chartReadings, (row) => row.date))
    .range([margin.left, width - margin.right]);

  const yExtent = d3.extent(chartReadings.concat(diversionValues), (row) => row.value);
  const yDomain = metric === "flow"
    ? [Math.min(yExtent[0], 0), Math.max(yExtent[1], SR1_FLOW_TRIGGER_M3S)]
    : yExtent;
  const y = d3.scaleLinear()
    .domain(yDomain)
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg.append("g")
    .attr("class", "grid")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).tickSize(-(width - margin.left - margin.right)).tickFormat(""));

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.min(8, width / 150)).tickFormat(d3.timeFormat("%b %-d %H:%M")));

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(6));

  svg.append("text")
    .attr("x", margin.left)
    .attr("y", 12)
    .attr("fill", "#60716d")
    .attr("font-size", 12)
    .attr("font-weight", 700)
    .text(`${metricConfig[metric].label} (${metricConfig[metric].unit})`);

  if (metric === "flow") {
    svg.append("line")
      .attr("x1", margin.left)
      .attr("x2", width - margin.right)
      .attr("y1", y(SR1_FLOW_TRIGGER_M3S))
      .attr("y2", y(SR1_FLOW_TRIGGER_M3S))
      .attr("stroke", "#b65a18")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "6 5");

    svg.append("text")
      .attr("x", width - margin.right)
      .attr("y", y(SR1_FLOW_TRIGGER_M3S) - 8)
      .attr("text-anchor", "end")
      .attr("fill", "#b65a18")
      .attr("font-size", 12)
      .attr("font-weight", 800)
      .text(`rough SR1 trigger ${formatNumber(SR1_FLOW_TRIGGER_M3S, 0)} m3/s`);
  }

  const line = d3.line()
    .defined((row) => Number.isFinite(row.value))
    .x((row) => x(row.date))
    .y((row) => y(row.value));

  for (const item of series) {
    svg.append("path")
      .datum(item.values)
      .attr("fill", "none")
      .attr("stroke", item.color)
      .attr("stroke-width", 2)
      .attr("d", line);
  }

  if (projectedSarcee.length > 1) {
    svg.append("path")
      .datum(projectedSarcee)
      .attr("fill", "none")
      .attr("stroke", SARCEE_COLOR)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "7 5")
      .attr("opacity", 0.85)
      .attr("d", line);
  }

  if (diversionValues.length > 1) {
    // Split at the axis: above zero is water diverted into SR1, below zero is
    // SR1 releasing its stored water back into the Elbow (the "unexplained"
    // rise at Sarcee above what Bragg Creek can account for).
    const diversionSplit = withZeroCrossings(diversionValues);
    const diversionLine = d3.line()
      .defined((row) => Number.isFinite(row.value) && row.value >= 0)
      .x((row) => x(row.date))
      .y((row) => y(row.value));
    const releaseLine = d3.line()
      .defined((row) => Number.isFinite(row.value) && row.value <= 0)
      .x((row) => x(row.date))
      .y((row) => y(row.value));

    svg.append("path")
      .datum(diversionSplit)
      .attr("fill", "none")
      .attr("stroke", DIVERSION_COLOR)
      .attr("stroke-width", 2)
      .attr("opacity", 0.9)
      .attr("d", diversionLine);

    svg.append("path")
      .datum(diversionSplit)
      .attr("fill", "none")
      .attr("stroke", RELEASE_COLOR)
      .attr("stroke-width", 2)
      .attr("opacity", 0.9)
      .attr("d", releaseLine);
  }

  const focusLayer = svg.append("g");
  const bisect = d3.bisector((row) => row.date).left;

  svg.append("rect")
    .attr("x", margin.left)
    .attr("y", margin.top)
    .attr("width", width - margin.left - margin.right)
    .attr("height", height - margin.top - margin.bottom)
    .attr("fill", "transparent")
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const date = x.invert(mx);
      const points = series.map((item) => {
        const index = Math.min(item.values.length - 1, Math.max(0, bisect(item.values, date)));
        const left = item.values[Math.max(0, index - 1)];
        const right = item.values[index];
        const point = right && left && date - left.date > right.date - date ? right : left;
        return { ...item, point };
      }).filter((item) => item.point);

      focusLayer.selectAll("*").remove();
      for (const item of points) {
        focusLayer.append("circle")
          .attr("cx", x(item.point.date))
          .attr("cy", y(item.point.value))
          .attr("r", 4)
          .attr("fill", item.color)
          .attr("stroke", "white")
          .attr("stroke-width", 2);
      }

      showTooltip(event, points, metric);
    })
    .on("mouseleave", () => {
      focusLayer.selectAll("*").remove();
      hideTooltip();
    });

  const legend = d3.select(chart).append("div").attr("class", "legend");
  for (const item of series) {
    legend.append("span")
      .attr("class", "legend-item")
      .html(`<span class="legend-swatch" style="background:${item.color}"></span>${displayStationShortName(item.station)}`);
  }
  if (projectedSarcee.length > 1) {
    legend.append("span")
      .attr("class", "legend-item")
      .html(`<span class="legend-swatch" style="background:${SARCEE_COLOR}"></span>Sarcee projected from Bragg +${formatNumber(braggToSarceeLagHours(), 1)}h`);
  }
  if (diversionValues.length > 1) {
    legend.append("span")
      .attr("class", "legend-item")
      .html(`<span class="legend-swatch" style="background:${DIVERSION_COLOR}"></span>Est. SR1 diversion (no-SR1 Sarcee − actual; floor, excl. growing tributary inflow)`);
  }
  if (diversionValues.some((row) => row.value < 0)) {
    legend.append("span")
      .attr("class", "legend-item")
      .html(`<span class="legend-swatch" style="background:${RELEASE_COLOR}"></span>Est. SR1 release (Sarcee above the Bragg projection = stored water returning to the Elbow)`);
  }
}

function renderStorage() {
  if (!storageData) {
    return;
  }

  storageSourceText.innerHTML = `<a href="https://data.calgary.ca/d/5fdg-ifgr" target="_blank" rel="noopener">Open Calgary source ↗</a>, ${storageData.range.days} days`;
  storageGrid.innerHTML = storageData.locations.map((location) => {
    const summary = location.summary;

    if (!summary) {
      return `
        <article class="storage-card">
          <h3>${location.name}</h3>
          <p class="storage-main">${formatNumber(location.capacityM3 / 1000, 0)} dam3</p>
          <p class="storage-meta">${formatNumber(location.capacityM3 / 1_000_000, 1)} million m3 capacity<br>Live level: unavailable<br>Proxy: ${location.proxyStationId || "n/a"}</p>
        </article>
      `;
    }

    const percentFull = location.maxStorageDam3 ? summary.storageDam3 / location.maxStorageDam3 * 100 : null;
    const roughFloodStorageLineDam3 = location.maxStorageDam3
      ? location.maxStorageDam3 - GLENMORE_ACTIVE_FLOOD_STORAGE_DAM3
      : null;
    const storageMarginDam3 = roughFloodStorageLineDam3 ? roughFloodStorageLineDam3 - summary.storageDam3 : null;
    const ageHours = hoursSince(summary.latestAt);
    const estimate = ageHours > GLENMORE_STALE_HOURS
      ? estimateGlenmoreStorage(summary, location.records || [])
      : null;
    const estimateText = estimate
      ? `<br><strong>Estimated now</strong> ${formatNumber(estimate.estimatedElevationM, 3)} m · ${formatNumber(estimate.estimatedStorageDam3, 0)} dam3<br>Net change from Sarcee - Below Dam: ${formatChange(estimate.netDam3)} dam3 over ${formatNumber(estimate.hoursEstimated, 1)} h`
      : "";

    return `
      <article class="storage-card live">
        <h3>${location.name}</h3>
        <p class="storage-main">${formatNumber(summary.storageDam3, 0)} dam3</p>
        <p class="storage-meta">
          ${formatNumber(summary.storageM3 / 1_000_000, 2)} million m3 · ${formatNumber(percentFull, 1)}% of listed max storage<br>
          Elevation ${formatNumber(summary.elevationM, 3)} m · latest ${formatTime(summary.latestAt)} · age ${formatNumber(ageHours, 1)} h${estimateText}<br>
          Change 24h ${formatChange(summary.change24hDam3)} dam3, selected range ${formatChange(summary.changeRangeDam3)} dam3<br>
          Rough flood-storage line ${formatNumber(roughFloodStorageLineDam3, 0)} dam3 · margin ${formatNumber(storageMarginDam3, 0)} dam3
        </p>
      </article>
    `;
  }).join("");

  renderStorageChart();
}

function renderStorageChart() {
  storageChart.innerHTML = "";
  const glenmore = storageData.locations.find((location) => location.id === "glenmore");
  const records = glenmore?.records?.map((row) => ({ ...row, date: new Date(row.timestamp) })) || [];

  if (records.length === 0) {
    storageChart.innerHTML = "<p>No Glenmore storage history available for this range.</p>";
    return;
  }

  const bounds = storageChart.getBoundingClientRect();
  const width = Math.max(320, bounds.width);
  const height = Math.max(260, bounds.height || 290);
  const margin = { top: 18, right: 28, bottom: 40, left: 72 };

  const svg = d3.select(storageChart)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`);

  const x = d3.scaleTime()
    .domain(d3.extent(records, (row) => row.date))
    .range([margin.left, width - margin.right]);

  const roughFloodStorageLineDam3 = glenmore?.maxStorageDam3
    ? glenmore.maxStorageDam3 - GLENMORE_ACTIVE_FLOOD_STORAGE_DAM3
    : null;
  const storageExtent = d3.extent(records, (row) => row.storageDam3);
  const yDomain = roughFloodStorageLineDam3
    ? [Math.min(storageExtent[0], roughFloodStorageLineDam3), Math.max(storageExtent[1], roughFloodStorageLineDam3)]
    : storageExtent;
  const y = d3.scaleLinear()
    .domain(yDomain)
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg.append("g")
    .attr("class", "grid")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).tickSize(-(width - margin.left - margin.right)).tickFormat(""));

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.min(8, width / 120)));

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5));

  svg.append("text")
    .attr("x", margin.left)
    .attr("y", 13)
    .attr("fill", "#60716d")
    .attr("font-size", 12)
    .attr("font-weight", 700)
    .text("Glenmore storage (dam3)");

  if (roughFloodStorageLineDam3) {
    svg.append("line")
      .attr("x1", margin.left)
      .attr("x2", width - margin.right)
      .attr("y1", y(roughFloodStorageLineDam3))
      .attr("y2", y(roughFloodStorageLineDam3))
      .attr("stroke", "#b65a18")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "6 5");

    svg.append("text")
      .attr("x", width - margin.right)
      .attr("y", y(roughFloodStorageLineDam3) - 8)
      .attr("text-anchor", "end")
      .attr("fill", "#b65a18")
      .attr("font-size", 12)
      .attr("font-weight", 800)
      .text(`rough flood-storage line ${formatNumber(roughFloodStorageLineDam3, 0)} dam3`);
  }

  const line = d3.line()
    .x((row) => x(row.date))
    .y((row) => y(row.storageDam3));

  svg.append("path")
    .datum(records)
    .attr("fill", "none")
    .attr("stroke", "#0f7f8c")
    .attr("stroke-width", 2.5)
    .attr("d", line);
}

function showTooltip(event, points, metric) {
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    document.body.appendChild(tooltip);
  }

  const rows = points.map((item) => `
    <div><strong style="color:${item.color}">${displayStationShortName(item.station)}</strong>: ${formatNumber(item.point.value)} ${metricConfig[metric].unit}</div>
  `).join("");
  tooltip.innerHTML = `<div>${formatTime(points[0]?.point?.timestamp)}</div>${rows}`;
  tooltip.style.left = `${Math.min(window.innerWidth - 300, event.clientX + 14)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}

function hideTooltip() {
  if (tooltip) {
    tooltip.remove();
    tooltip = null;
  }
}

rangeSelect.addEventListener("change", loadData);
metricSelect.addEventListener("change", render);
mapTimeSlider.addEventListener("input", renderFlowMap);
mapLatestButton.addEventListener("click", () => {
  mapTimeSlider.value = String(Math.max(0, mapTimes.length - 1));
  renderFlowMap();
});
refreshButton.addEventListener("click", loadData);
window.addEventListener("resize", () => {
  renderChart(metricSelect.value);
  renderFlowMap();
  renderStorageChart();
});

async function loadBuildLabel() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      throw new Error(`health API returned HTTP ${response.status}`);
    }
    const data = await response.json();
    buildLabel.textContent = `build ${data.commit} · checked ${formatTime(data.checkedAt)}`;
  } catch (error) {
    buildLabel.textContent = `build unknown: ${error.message}`;
  }
}

loadBuildLabel();
loadData();
setInterval(loadData, 10 * 60 * 1000);
