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

// The SR1 travel lag, no-diversion offset, projection, diversion/release, and
// volume are all computed on the server now (see lib/diversion.js) and arrive
// precomputed in the /api/monitor payload under `sr1`. The trigger threshold is
// kept here only for the chart trigger line and the flow-map legend.
const SR1_FLOW_TRIGGER_M3S = 160;
const GLENMORE_ACTIVE_FLOOD_STORAGE_DAM3 = 10_000;
const GLENMORE_STALE_HOURS = 2;
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

const NORMAL_REFRESH_MS = 10 * 60 * 1000;
// After a failed load, retry soon rather than waiting a full cycle. The server
// returns 503 while it bootstraps its history on a cold start (a few seconds),
// so a short retry means the page fills in as soon as the server is ready
// instead of staying stuck on the error until the next 10-minute tick.
const RETRY_REFRESH_MS = 8 * 1000;
// Abort a request that hangs (e.g. a Render container still spinning up) so it
// fails into the retry path instead of waiting forever.
const LOAD_TIMEOUT_MS = 30 * 1000;
let refreshTimer = null;

function scheduleNextLoad(delayMs) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(loadData, delayMs);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`request to ${url} timed out after ${LOAD_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function loadData() {
  const days = rangeSelect.value;
  statusStrip.className = "status-strip";
  statusStrip.textContent = "Loading readings...";
  refreshButton.disabled = true;

  try {
    const response = await fetchWithTimeout(`/api/monitor?days=${encodeURIComponent(days)}`);
    const storageResponse = await fetchWithTimeout(`/api/storage?days=${encodeURIComponent(days)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Monitor API returned HTTP ${response.status}`);
    }
    if (!storageResponse.ok) {
      throw new Error(`Storage API returned HTTP ${storageResponse.status}`);
    }
    latestData = await response.json();
    storageData = await storageResponse.json();
    render();
    scheduleNextLoad(NORMAL_REFRESH_MS);
  } catch (error) {
    statusStrip.className = "status-strip warning";
    statusStrip.textContent = `Unable to load readings (retrying in ${RETRY_REFRESH_MS / 1000}s): ${error.message}`;
    scheduleNextLoad(RETRY_REFRESH_MS);
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

// The travel lag, projection, and diversion/release series are computed on the
// server (lib/diversion.js) and arrive precomputed in the /api/monitor payload
// under `sr1`. These readers adapt the payload's {timestamp, value} rows to the
// {date, value} shape the chart and map rendering already expect.
function braggToSarceeLagHours() {
  return latestData.sr1.lagHours;
}

function sarceeProjectedSeries() {
  return (latestData.sr1?.projectedSarcee || []).map((row) => ({ date: new Date(row.timestamp), value: row.value }));
}

// Server-computed SR1 rate series, already gated and non-negative. kind is
// "inflow" (water diverted into the reservoir) or "outflow" (stored water
// released back to the Elbow).
function sr1RateSeries(kind) {
  return (latestData.sr1?.[kind] || []).map((row) => ({ date: new Date(row.timestamp), value: row.value }));
}

// Net volume held in SR1 at a given instant, read from the server-computed
// cumulative series (the last point at or before endTimeMs).
function sr1DivertedVolume(endTimeMs = Infinity) {
  const series = latestData.sr1?.volumeSeries || [];
  let chosen = null;
  for (const point of series) {
    if (new Date(point.timestamp).getTime() <= endTimeMs) {
      chosen = point;
    } else {
      break;
    }
  }
  return chosen ? { volumeM3: chosen.volumeM3, volumeDam3: chosen.volumeDam3, pctFull: chosen.pctFull } : null;
}

// Lag-independent cross-check on the diverted volume, computed server-side; null
// until the event has settled.
function sarceeVolumeBalanceDam3() {
  return latestData.sr1?.volumeBalanceDam3 ?? null;
}

// Whether the flood wave has settled back to baseline (server-computed).
function eventHasSettled() {
  return latestData.sr1?.eventSettled ?? false;
}

function estimateSarceeForecast() {
  return latestData.sr1?.forecast ?? null;
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
    const sr1Diversion = sr1DivertedVolume(new Date(selectedTime).getTime());
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
  const inflowValues = metric === "flow" ? sr1RateSeries("inflow") : [];
  const outflowValues = metric === "flow" ? sr1RateSeries("outflow") : [];
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

  const yExtent = d3.extent(chartReadings.concat(inflowValues, outflowValues), (row) => row.value);
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

  if (inflowValues.length > 1) {
    // SR1 inflow and outflow as two separate lines rising from a zero baseline.
    // Inflow is water diverted into the reservoir; outflow is stored water
    // released back to the Elbow. Both come from the server already gated
    // (no outflow during the flood or before the reservoir holds water) and
    // non-negative, so each is just plotted as its own line.
    const rateLine = d3.line()
      .defined((row) => Number.isFinite(row.value))
      .x((row) => x(row.date))
      .y((row) => y(row.value));

    svg.append("path")
      .datum(inflowValues)
      .attr("fill", "none")
      .attr("stroke", DIVERSION_COLOR)
      .attr("stroke-width", 2)
      .attr("opacity", 0.9)
      .attr("d", rateLine);

    svg.append("path")
      .datum(outflowValues)
      .attr("fill", "none")
      .attr("stroke", RELEASE_COLOR)
      .attr("stroke-width", 2)
      .attr("opacity", 0.9)
      .attr("d", rateLine);
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
  if (inflowValues.length > 1) {
    legend.append("span")
      .attr("class", "legend-item")
      .html(`<span class="legend-swatch" style="background:${DIVERSION_COLOR}"></span>Est. SR1 inflow (Sarcee below the Bragg projection = water diverted into the reservoir)`);
    legend.append("span")
      .attr("class", "legend-item")
      .html(`<span class="legend-swatch" style="background:${RELEASE_COLOR}"></span>Est. SR1 outflow (Sarcee above the Bragg projection = stored water released back to the Elbow)`);
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
// loadData reschedules itself: NORMAL_REFRESH_MS after a success, RETRY_REFRESH_MS
// after a failure. This replaces a fixed interval so a cold-start failure recovers
// within seconds instead of waiting a full cycle.
loadData();
