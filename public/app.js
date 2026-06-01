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

const metricConfig = {
  flow: { parameter: "47", label: "Flow", unit: "m3/s" },
  level: { parameter: "46", label: "Level", unit: "m" }
};

const colors = ["#0f7f8c", "#395f9d", "#7b8b2e", "#c17427", "#8f5542"];
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

  sourceText.textContent = `WaterOffice real-time CSV, ${latestData.range.days} days`;
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

    return `
      <article class="station-card ${unavailable ? "unavailable" : ""}">
        <div class="station-name">
          <div>
            <strong>${station.shortName}</strong>
            <div class="station-id">${station.id}</div>
          </div>
          <span class="station-id">${station.downstreamKm} km</span>
        </div>
        ${metricLine("Level", level, "m")}
        ${metricLine("Flow", flow, "m3/s")}
        <p class="metric-change">${summary ? `Latest ${metricConfig[metric].label.toLowerCase()} at ${formatTime(summary.latestAt)}. Historical range ${formatNumber(summary.min)}-${formatNumber(summary.max)} ${summary.unit}.` : "No current unit values returned for this station and metric."}</p>
      </article>
    `;
  }).join("");
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
        <strong>${station.name}</strong>
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

function glenmoreStorageAtSelectedMapTime() {
  const glenmore = storageData?.locations?.find((location) => location.id === "glenmore");
  const records = glenmore?.records || [];

  if (records.length === 0 || mapTimes.length === 0) {
    return null;
  }

  const selected = new Date(mapTimes[Number(mapTimeSlider.value)]).getTime();
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
  const strokeWidth = d3.scaleSqrt().domain([0, historicalMaxFlow]).range([3, 30]);
  const color = d3.scaleSequential(d3.interpolatePuBuGn).domain([0, historicalMaxFlow]);
  const storageExtent = d3.extent(glenmoreRecords, (record) => record.storageDam3);
  const storageRadius = d3.scaleSqrt()
    .domain(storageExtent[0] === storageExtent[1] ? [0, storageExtent[1] || 1] : storageExtent)
    .range([15, 44]);

  mapTimeLabel.textContent = `${formatTime(selectedTime)} · current max ${formatNumber(selectedMaxFlow, 1)} m3/s · width scale max ${formatNumber(historicalMaxFlow, 1)} m3/s`;

  const bounds = flowMap.getBoundingClientRect();
  const width = Math.max(340, bounds.width);
  const height = Math.max(330, bounds.height || 360);
  const margin = { top: 42, right: 42, bottom: 58, left: 42 };
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

  for (let i = 0; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const reading = latestByStation.get(current.station.id) || latestByStation.get(next.station.id);
    const value = reading?.value;

    svg.append("path")
      .datum([current, next])
      .attr("d", segmentLine)
      .attr("fill", "none")
      .attr("stroke", Number.isFinite(value) ? color(value) : "#bcccca")
      .attr("stroke-width", Number.isFinite(value) ? strokeWidth(value) : 3)
      .attr("stroke-linecap", "round")
      .attr("opacity", Number.isFinite(value) ? 0.82 : 0.45);
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

  stationGroups.append("text")
    .attr("class", "flow-map-label")
    .attr("x", 0)
    .attr("y", (point, index) => index % 2 === 0 ? -20 : 30)
    .attr("text-anchor", "middle")
    .text((point) => point.station.shortName);

  stationGroups.append("text")
    .attr("class", "flow-map-meta")
    .attr("x", 0)
    .attr("y", (point, index) => index % 2 === 0 ? -6 : 44)
    .attr("text-anchor", "middle")
    .text((point) => {
      const reading = latestByStation.get(point.station.id);
      return reading ? `${formatNumber(reading.value, 1)} m3/s` : "no flow";
    });

  const aboveDam = points.find((point) => point.station.id === "05BJ005");
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
      .text("Glenmore");

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

  const clemGardiner = points.find((point) => point.station.id === "05BJ011");
  const sr1Location = storageData?.locations?.find((location) => location.id === "sr1");
  const sr1Point = clemGardiner ? {
    x: clemGardiner.x,
    y: Math.max(margin.top + 58, clemGardiner.y - 78)
  } : null;

  if (sr1Point && sr1Location) {
    svg.append("circle")
      .attr("cx", sr1Point.x)
      .attr("cy", sr1Point.y)
      .attr("r", 24)
      .attr("fill", "#ffffff")
      .attr("fill-opacity", 0.72)
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
      .text("no live level");

    svg.append("text")
      .attr("class", "flow-map-meta")
      .attr("x", sr1Point.x)
      .attr("y", sr1Point.y + 18)
      .attr("text-anchor", "middle")
      .text(`${formatNumber(sr1Location.capacityM3 / 1000, 0)} dam3 cap.`);
  }

  const legendX = margin.left;
  const legendY = height - 48;
  const legendValues = [historicalMaxFlow * 0.25, historicalMaxFlow * 0.6, historicalMaxFlow]
    .filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > 0.1);

  let cursor = legendX;
  for (const value of legendValues) {
    svg.append("line")
      .attr("x1", cursor)
      .attr("x2", cursor + 42)
      .attr("y1", legendY)
      .attr("y2", legendY)
      .attr("stroke", color(value))
      .attr("stroke-width", strokeWidth(value))
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.82);

    svg.append("text")
      .attr("class", "flow-map-meta")
      .attr("x", cursor + 52)
      .attr("y", legendY + 4)
      .text(`${formatNumber(value, 1)} m3/s`);

    cursor += 150;
  }

  svg.append("text")
    .attr("class", "flow-map-note")
    .attr("x", legendX)
    .attr("y", height - 16)
    .text("Segment width uses the nearest upstream/downstream available station flow at the selected timestamp.");
}

function renderChart(metric) {
  chart.innerHTML = "";
  const parameter = metricConfig[metric].parameter;
  const readings = latestData.readings
    .filter((row) => row.parameter === parameter)
    .map((row) => ({ ...row, date: new Date(row.timestamp) }));

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
    .domain(d3.extent(readings, (row) => row.date))
    .range([margin.left, width - margin.right]);

  const y = d3.scaleLinear()
    .domain(d3.extent(readings, (row) => row.value))
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
    .call(d3.axisLeft(y).ticks(6));

  svg.append("text")
    .attr("x", margin.left)
    .attr("y", 12)
    .attr("fill", "#60716d")
    .attr("font-size", 12)
    .attr("font-weight", 700)
    .text(`${metricConfig[metric].label} (${metricConfig[metric].unit})`);

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
      .html(`<span class="legend-swatch" style="background:${item.color}"></span>${item.station.shortName}`);
  }
}

function renderStorage() {
  if (!storageData) {
    return;
  }

  storageSourceText.textContent = `Open Calgary, ${storageData.range.days} days`;
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

    return `
      <article class="storage-card live">
        <h3>${location.name}</h3>
        <p class="storage-main">${formatNumber(summary.storageDam3, 0)} dam3</p>
        <p class="storage-meta">
          ${formatNumber(summary.storageM3 / 1_000_000, 2)} million m3 · ${formatNumber(percentFull, 1)}% of listed max storage<br>
          Elevation ${formatNumber(summary.elevationM, 3)} m · latest ${formatTime(summary.latestAt)}<br>
          Change 24h ${formatChange(summary.change24hDam3)} dam3, selected range ${formatChange(summary.changeRangeDam3)} dam3
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

  const y = d3.scaleLinear()
    .domain(d3.extent(records, (row) => row.storageDam3))
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
    <div><strong style="color:${item.color}">${item.station.shortName}</strong>: ${formatNumber(item.point.value)} ${metricConfig[metric].unit}</div>
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

loadData();
setInterval(loadData, 10 * 60 * 1000);
