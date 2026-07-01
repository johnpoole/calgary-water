import http from "node:http";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { computeSr1Model } from "./lib/diversion.js";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = resolve("public");

const DAY_MS = 24 * 60 * 60 * 1000;
// How much history the server keeps and serves. Covers the largest display window
// and gives the SR1 model a window that always includes calm, no-diversion flow
// so the travel-lag and offset calibration is stable. Kept to 30 days so the
// stored series and its transient CSV parse fit comfortably in a 512 MB instance
// (90 days peaked over the limit and the instance was OOM-killed).
const RETENTION_DAYS = 30;
// Background refresh cadence and how far back each incremental fetch reaches. The
// overlap re-pulls the last few hours so late-arriving or revised points land.
const REFRESH_MS = 10 * 60 * 1000;
const REFRESH_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const STORAGE_REFRESH_DAYS = 2;

function resolveCommit() {
  if (process.env.RENDER_GIT_COMMIT) {
    return process.env.RENDER_GIT_COMMIT.slice(0, 7);
  }
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

const COMMIT = resolveCommit();

const PARAMETERS = {
  "46": { key: "level", label: "Level", unit: "m" },
  "47": { key: "flow", label: "Flow", unit: "m3/s" }
};

const STATIONS = [
  {
    id: "05BJ004",
    name: "Elbow River at Bragg Creek",
    shortName: "Bragg Creek",
    downstreamKm: 0,
    latitude: 50.94833,
    longitude: -114.56972,
    drainageAreaKm2: 794,
    current: true
  },
  {
    id: "05BJ010",
    name: "Elbow River at Sarcee Bridge",
    shortName: "Sarcee Bridge",
    downstreamKm: 28,
    latitude: 50.99333,
    longitude: -114.16972,
    drainageAreaKm2: 1190,
    current: true
  },
  {
    id: "05BJ008",
    name: "Glenmore Reservoir at Calgary",
    shortName: "Glenmore Reservoir",
    downstreamKm: 34,
    latitude: 51.00056,
    longitude: -114.0975,
    drainageAreaKm2: 1230,
    current: false
  },
  {
    id: "05BJ001",
    name: "Elbow River below Glenmore Dam",
    shortName: "Below Glenmore Dam",
    downstreamKm: 37,
    latitude: 51.01278,
    longitude: -114.09306,
    drainageAreaKm2: 1240,
    current: true
  }
];

const STORAGE_LOCATIONS = [
  {
    id: "sr1",
    name: "Springbank Off-stream Reservoir (SR1)",
    source: "Alberta Springbank Off-stream Reservoir public project information",
    proxyStationId: "05BJ011",
    proxyStationName: "Elbow River at Clem Gardner Bridge",
    capacityM3: 70_200_000,
    status: "No public live storage or diversion feed found",
    note: "The Clem Gardiner Bridge gauge is at the SR1 reach and would be a useful intake-area flow proxy if data are published. It is not, by itself, measured diverted flow into the reservoir."
  },
  {
    id: "glenmore",
    stationId: "05BJ008",
    name: "Glenmore Reservoir",
    source: "Open Calgary River Levels and Flows dataset",
    maxStorageDam3: 23_502,
    status: "Direct storage values available",
    note: "For station 05BJ008, Calgary's dataset exposes a storage-like value in the flow field. Values align with Alberta's reservoir storage summary in dam3."
  }
];

const SR1_CAPACITY_M3 = STORAGE_LOCATIONS.find((location) => location.id === "sr1").capacityM3;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function stationParams(stationId) {
  return `stations[]=${encodeURIComponent(stationId)}`;
}

function parameterParams(parameterId) {
  return `parameters[]=${encodeURIComponent(parameterId)}`;
}

function buildWaterOfficeUrl({ stationIds, start, end }) {
  const stationQuery = stationIds.map(stationParams).join("&");
  const parameterQuery = Object.keys(PARAMETERS).map(parameterParams).join("&");
  const startDate = encodeURIComponent(formatWaterOfficeDate(start));
  const endDate = encodeURIComponent(formatWaterOfficeDate(end));
  return `https://wateroffice.ec.gc.ca/services/real_time_data/csv/inline?${stationQuery}&${parameterQuery}&start_date=${startDate}&end_date=${endDate}`;
}

function formatWaterOfficeDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    "-",
    pad(date.getUTCMonth() + 1),
    "-",
    pad(date.getUTCDate()),
    " ",
    pad(date.getUTCHours()),
    ":",
    pad(date.getUTCMinutes()),
    ":",
    pad(date.getUTCSeconds())
  ].join("");
}

// Parse a WaterOffice CSV directly into reading rows, pulling only the columns we
// need by index. Building a full header-keyed object per row (and then re-mapping
// it) was a large transient allocation on a multi-week fetch; this keeps startup
// memory well within the instance limit.
function parseReadings(csv) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length < 2) {
    return [];
  }
  const header = parseCsvLine(lines[0]).map((name) => name.trim().replace(/^\uFEFF/, ""));
  const idxId = header.indexOf("ID");
  const idxDate = header.indexOf("Date");
  const idxParam = header.indexOf("Parameter/Paramètre");
  const idxValue = header.indexOf("Value/Valeur");
  const idxApproval = header.indexOf("Approval/Approbation");
  if (idxId < 0 || idxDate < 0 || idxParam < 0 || idxValue < 0) {
    throw new Error(`WaterOffice CSV missing expected columns; header was: ${header.join(",")}`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) {
      continue;
    }
    const cols = parseCsvLine(lines[i]);
    const stationId = cols[idxId];
    const value = Number(cols[idxValue]);
    const timestamp = new Date(cols[idxDate]);
    if (!stationId || !Number.isFinite(value) || Number.isNaN(timestamp.getTime())) {
      continue;
    }
    rows.push({
      stationId,
      timestamp,
      parameter: cols[idxParam],
      value,
      approval: idxApproval >= 0 ? (cols[idxApproval] || "") : ""
    });
  }
  return rows;
}

// Alberta River Basins (rivers.alberta.ca) reads the provincial WISKI telemetry
// directly and often posts a gauge sooner than the federal WaterOffice mirror.
// There is no documented public API; these timeseries IDs come from the station
// manifest layer and may change if Alberta changes their site.
const ALBERTA_TIMESERIES = {
  "05BJ004": { flow: "345370042", level: "480552042" },
  "05BJ010": { flow: "345371042", level: "480553042" },
  "05BJ001": { flow: "345368042", level: "479270042" }
};
const ALBERTA_PARAMETER_BY_KEY = { flow: "47", level: "46" };
const ALBERTA_TIME_ZONE = "America/Edmonton";
const ALBERTA_HEADERS = {
  // The download service rejects requests without a rivers.alberta.ca referer.
  Referer: "https://rivers.alberta.ca/",
  "User-Agent": "Mozilla/5.0 (compatible; ElbowRiverMonitor)"
};

function albertaZoneParts(timeZone, instant) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return parts;
}

// Alberta's CSV timestamps are local wall-clock time with no zone marker. Convert
// them to a UTC instant using the Edmonton zone offset at that moment, refining
// once so days that cross a daylight-saving change resolve correctly.
function mountainToUtc(year, month, day, hour, minute, second) {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = mountainOffsetMs(wallClockAsUtc);
  let utc = wallClockAsUtc - offset;
  offset = mountainOffsetMs(utc);
  return new Date(wallClockAsUtc - offset);
}

function mountainOffsetMs(instantMs) {
  const parts = albertaZoneParts(ALBERTA_TIME_ZONE, new Date(instantMs));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instantMs;
}

function albertaDate(date) {
  const parts = albertaZoneParts(ALBERTA_TIME_ZONE, date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseAlbertaCsv(csv, stationId, parameterId) {
  const rows = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [timestampText, valueText] = line.split(";");
    if (!timestampText || valueText === undefined || valueText.trim() === "") {
      continue;
    }
    const match = timestampText.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!match) {
      continue;
    }
    const value = Number(valueText);
    if (!Number.isFinite(value)) {
      continue;
    }
    const timestamp = mountainToUtc(
      Number(match[1]), Number(match[2]), Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6])
    );
    rows.push({ stationId, timestamp, parameter: parameterId, value, approval: "Provisional" });
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchAlbertaSeries(stationId, parameterId, tsId, start, end) {
  const from = albertaDate(start);
  const to = albertaDate(new Date(end.getTime() + DAY_MS));
  const url = `https://rivers.alberta.ca/WiskiLiveDataService/Download?tsId=${encodeURIComponent(tsId)}&from=${from}&to=${to}&filename=arb&zip=false`;
  const response = await fetch(url, { headers: ALBERTA_HEADERS });

  if (!response.ok) {
    throw new Error(`Alberta WISKI returned HTTP ${response.status} for tsId ${tsId} (station ${stationId}, parameter ${parameterId})`);
  }

  const csv = await response.text();
  return parseAlbertaCsv(csv, stationId, parameterId)
    .filter((row) => row.timestamp >= start && row.timestamp <= end);
}

// Fetch every mapped Alberta series; a failure for one series is logged and
// returns empty so the per-series WaterOffice fallback can take over.
async function fetchAlbertaReadings(start, end) {
  const tasks = [];
  for (const [stationId, timeseries] of Object.entries(ALBERTA_TIMESERIES)) {
    for (const [key, tsId] of Object.entries(timeseries)) {
      const parameterId = ALBERTA_PARAMETER_BY_KEY[key];
      tasks.push(
        fetchAlbertaSeries(stationId, parameterId, tsId, start, end)
          .then((rows) => ({ stationId, parameterId, rows }))
          .catch((error) => {
            console.warn(`Alberta fetch failed for ${stationId}/${parameterId}: ${error.message}`);
            return { stationId, parameterId, rows: [] };
          })
      );
    }
  }
  const results = await Promise.all(tasks);
  const byKey = new Map();
  for (const result of results) {
    byKey.set(`${result.stationId}:${result.parameterId}`, result.rows);
  }
  return byKey;
}

async function fetchWaterOfficeReadings(start, end) {
  const waterOfficeUrl = buildWaterOfficeUrl({ stationIds: STATIONS.map((station) => station.id), start, end });
  const response = await fetch(waterOfficeUrl);
  if (!response.ok) {
    console.warn(`WaterOffice returned HTTP ${response.status}`);
    return { rows: [], url: waterOfficeUrl };
  }
  return { rows: parseReadings(await response.text()), url: waterOfficeUrl };
}

async function fetchGlenmoreStorage(days) {
  const where = encodeURIComponent(`station_number='05BJ008' AND timestamp > '${new Date(Date.now() - days * DAY_MS).toISOString()}'`);
  const select = encodeURIComponent("station_number,station_name,timestamp,level,flow");
  const url = `https://data.calgary.ca/resource/5fdg-ifgr.json?$select=${select}&$where=${where}&$order=timestamp ASC&$limit=50000`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open Calgary returned HTTP ${response.status}`);
  }

  const rows = await response.json();
  const records = rows
    .map((row) => ({
      ms: new Date(row.timestamp).getTime(),
      elevationM: Number(row.level),
      storageDam3: Number(row.flow)
    }))
    .filter((row) => Number.isFinite(row.ms) && Number.isFinite(row.storageDam3));

  return { url, records };
}

// --- In-memory time-series store ---------------------------------------------
// Both upstream sources are kept separately per station/parameter; the freshest
// is chosen at read time (chooseFreshest) exactly as before. Each entry is a
// sorted array of { ms, value, approval }, de-duplicated by ms so a revised
// value overwrites, and pruned to the retention window on every merge.
const readingStore = new Map();
let storageStore = [];
let storageSource = null;
const state = {
  bootstrapped: false,
  lastRefreshOkMs: null,
  lastRefreshError: null
};

function storeKey(stationId, parameterId, source) {
  return `${stationId}:${parameterId}:${source}`;
}

function mergeSeries(key, incoming, retentionCutoffMs) {
  const byMs = new Map((readingStore.get(key) || []).map((row) => [row.ms, row]));
  for (const row of incoming) {
    byMs.set(row.ms, { ms: row.ms, value: row.value, approval: row.approval });
  }
  const merged = [...byMs.values()]
    .filter((row) => row.ms >= retentionCutoffMs)
    .sort((a, b) => a.ms - b.ms);
  readingStore.set(key, merged);
}

function ingestReadings(albertaByKey, waterOfficeRows) {
  const retentionCutoffMs = Date.now() - RETENTION_DAYS * DAY_MS;

  for (const [stationParam, rows] of albertaByKey.entries()) {
    const [stationId, parameterId] = stationParam.split(":");
    mergeSeries(
      storeKey(stationId, parameterId, "alberta"),
      rows.map((row) => ({ ms: row.timestamp.getTime(), value: row.value, approval: row.approval })),
      retentionCutoffMs
    );
  }

  const byStationParam = new Map();
  for (const row of waterOfficeRows) {
    const key = `${row.stationId}:${row.parameter}`;
    if (!byStationParam.has(key)) {
      byStationParam.set(key, []);
    }
    byStationParam.get(key).push({ ms: row.timestamp.getTime(), value: row.value, approval: row.approval });
  }
  for (const [stationParam, rows] of byStationParam.entries()) {
    const [stationId, parameterId] = stationParam.split(":");
    mergeSeries(storeKey(stationId, parameterId, "wateroffice"), rows, retentionCutoffMs);
  }
}

function latestMs(rows) {
  return rows.length ? rows.at(-1).ms : -Infinity;
}

// Blend the stored sources into one series per station/parameter over [startMs,
// endMs]. Each series stays entirely from one source (the one with the more
// recent latest reading), so the line never mixes values mid-stream.
function blendReadings(startMs, endMs) {
  const rows = [];
  const providers = {};

  for (const station of STATIONS) {
    providers[station.id] = {};
    for (const parameterId of Object.keys(PARAMETERS)) {
      const inWindow = (row) => row.ms >= startMs && row.ms <= endMs;
      const alberta = (readingStore.get(storeKey(station.id, parameterId, "alberta")) || []).filter(inWindow);
      const waterOffice = (readingStore.get(storeKey(station.id, parameterId, "wateroffice")) || []).filter(inWindow);

      let chosen = [];
      let provider = null;
      if (alberta.length && waterOffice.length) {
        if (latestMs(alberta) >= latestMs(waterOffice)) {
          chosen = alberta;
          provider = "alberta";
        } else {
          chosen = waterOffice;
          provider = "wateroffice";
        }
      } else if (alberta.length) {
        chosen = alberta;
        provider = "alberta";
      } else if (waterOffice.length) {
        chosen = waterOffice;
        provider = "wateroffice";
      }

      for (const row of chosen) {
        rows.push({ stationId: station.id, parameter: parameterId, ms: row.ms, value: row.value, approval: row.approval });
      }
      if (provider) {
        providers[station.id][parameterId] = provider;
      }
    }
  }

  return { rows, providers };
}

function summarizeStation(stationId, rows, nowMs) {
  const byParameter = {};

  for (const parameterId of Object.keys(PARAMETERS)) {
    const values = rows
      .filter((row) => row.stationId === stationId && row.parameter === parameterId)
      .sort((a, b) => a.ms - b.ms);

    if (values.length === 0) {
      byParameter[PARAMETERS[parameterId].key] = null;
      continue;
    }

    const latest = values.at(-1);
    const first = values[0];
    const min = Math.min(...values.map((row) => row.value));
    const max = Math.max(...values.map((row) => row.value));
    const average = values.reduce((sum, row) => sum + row.value, 0) / values.length;
    const oneHour = nearestPrior(values, latest.ms - 60 * 60 * 1000);
    const sixHour = nearestPrior(values, latest.ms - 6 * 60 * 60 * 1000);

    byParameter[PARAMETERS[parameterId].key] = {
      parameter: parameterId,
      unit: PARAMETERS[parameterId].unit,
      latest: latest.value,
      latestAt: new Date(latest.ms).toISOString(),
      ageMinutes: Math.round((nowMs - latest.ms) / 6000) / 10,
      change1h: oneHour ? latest.value - oneHour.value : null,
      change6h: sixHour ? latest.value - sixHour.value : null,
      changeRange: latest.value - first.value,
      min,
      max,
      average,
      count: values.length,
      approval: latest.approval
    };
  }

  return byParameter;
}

function nearestPrior(values, targetMs) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i].ms <= targetMs) {
      return values[i];
    }
  }
  return null;
}

function storageSummary(records) {
  if (records.length === 0) {
    return null;
  }

  const latest = records.at(-1);
  const first = records[0];
  const prior24h = nearestStoragePrior(records, latest.ms - 24 * 60 * 60 * 1000);
  const prior7d = nearestStoragePrior(records, latest.ms - 7 * 24 * 60 * 60 * 1000);

  return {
    latestAt: new Date(latest.ms).toISOString(),
    storageDam3: latest.storageDam3,
    storageM3: latest.storageDam3 * 1000,
    elevationM: Number.isFinite(latest.elevationM) ? latest.elevationM : null,
    change24hDam3: prior24h ? latest.storageDam3 - prior24h.storageDam3 : null,
    change7dDam3: prior7d ? latest.storageDam3 - prior7d.storageDam3 : null,
    changeRangeDam3: latest.storageDam3 - first.storageDam3,
    minDam3: Math.min(...records.map((row) => row.storageDam3)),
    maxDam3: Math.max(...records.map((row) => row.storageDam3)),
    count: records.length
  };
}

function nearestStoragePrior(records, targetMs) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i].ms <= targetMs) {
      return records[i];
    }
  }
  return null;
}

// --- Data refresh loop --------------------------------------------------------
async function ingestWindow(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const [albertaByKey, waterOffice] = await Promise.all([
    fetchAlbertaReadings(start, end),
    fetchWaterOfficeReadings(start, end)
  ]);

  const totalRows = [...albertaByKey.values()].reduce((sum, rows) => sum + rows.length, 0) + waterOffice.rows.length;
  if (totalRows === 0) {
    throw new Error(`No readings returned by Alberta River Basins or WaterOffice for ${start.toISOString()}..${end.toISOString()}`);
  }

  ingestReadings(albertaByKey, waterOffice.rows);
}

async function refreshStorage(days) {
  const { url, records } = await fetchGlenmoreStorage(days);
  storageSource = url;
  const retentionCutoffMs = Date.now() - RETENTION_DAYS * DAY_MS;
  const byMs = new Map(storageStore.map((row) => [row.ms, row]));
  for (const row of records) {
    byMs.set(row.ms, row);
  }
  storageStore = [...byMs.values()]
    .filter((row) => row.ms >= retentionCutoffMs)
    .sort((a, b) => a.ms - b.ms);
}

async function bootstrap() {
  const now = Date.now();
  await ingestWindow(now - RETENTION_DAYS * DAY_MS, now);
  await refreshStorage(RETENTION_DAYS);
  state.bootstrapped = true;
  console.log(`[${new Date().toISOString()}] bootstrap complete: ${countStoredReadings()} readings, ${storageStore.length} storage records`);
}

async function refreshIncremental() {
  const now = Date.now();
  await ingestWindow(now - REFRESH_LOOKBACK_MS, now);
  await refreshStorage(STORAGE_REFRESH_DAYS);
}

function countStoredReadings() {
  let total = 0;
  for (const rows of readingStore.values()) {
    total += rows.length;
  }
  return total;
}

// One tick of the background loop. Bootstraps if the store is empty, otherwise
// pulls the recent window. A failure keeps the last-good store in place and is
// surfaced loudly (console.error and state.lastRefreshError, exposed in the API);
// it does not wipe data or crash the process.
async function tick() {
  try {
    if (!state.bootstrapped) {
      await bootstrap();
    } else {
      await refreshIncremental();
    }
    state.lastRefreshOkMs = Date.now();
    state.lastRefreshError = null;
  } catch (error) {
    state.lastRefreshError = error.message;
    console.error(`[${new Date().toISOString()}] data refresh failed: ${error.message}`);
  }
}

// --- SR1 model + windowing ----------------------------------------------------
function windowSeries(series, startMs) {
  return series.filter((point) => point.ms >= startMs);
}

function buildMonitorPayload(days) {
  const nowMs = Date.now();
  const displayStartMs = nowMs - days * DAY_MS;
  const retentionStartMs = nowMs - RETENTION_DAYS * DAY_MS;

  // Calibrate and compute over the full retained series so the baseline is
  // stable, then slice the model output to the requested display window.
  const full = blendReadings(retentionStartMs, nowMs);
  const displayRows = full.rows.filter((row) => row.ms >= displayStartMs);

  const summaries = Object.fromEntries(
    STATIONS.map((station) => [station.id, summarizeStation(station.id, displayRows, nowMs)])
  );

  const model = computeSr1Model(
    full.rows.map((row) => ({ stationId: row.stationId, parameter: row.parameter, value: row.value, timestamp: row.ms })),
    nowMs,
    SR1_CAPACITY_M3
  );

  const toStamped = (point) => ({ timestamp: new Date(point.ms).toISOString(), ...pointWithoutMs(point) });

  return {
    checkedAt: new Date(state.lastRefreshOkMs || nowMs).toISOString(),
    range: { start: new Date(displayStartMs).toISOString(), end: new Date(nowMs).toISOString(), days },
    stations: STATIONS,
    parameters: PARAMETERS,
    summaries,
    providers: full.providers,
    readings: displayRows.map((row) => ({
      stationId: row.stationId,
      timestamp: new Date(row.ms).toISOString(),
      parameter: row.parameter,
      value: row.value
    })),
    sr1: {
      lagHours: model.lagHours,
      offset: model.offset,
      capacityM3: SR1_CAPACITY_M3,
      projectedSarcee: windowSeries(model.projected, displayStartMs).map(toStamped),
      inflow: windowSeries(model.inflow, displayStartMs).map(toStamped),
      outflow: windowSeries(model.outflow, displayStartMs).map(toStamped),
      volumeSeries: windowSeries(model.volumeSeries, displayStartMs).map(toStamped),
      forecast: model.forecast
        ? { at: new Date(model.forecast.atMs).toISOString(), value: model.forecast.value }
        : null,
      eventSettled: model.eventSettled,
      volumeBalanceDam3: model.volumeBalanceDam3
    },
    dataStatus: {
      lastRefreshAt: state.lastRefreshOkMs ? new Date(state.lastRefreshOkMs).toISOString() : null,
      lastRefreshError: state.lastRefreshError,
      retentionDays: RETENTION_DAYS
    },
    source: "Alberta River Basins (WISKI) with WaterOffice fallback, freshest per station, server-maintained"
  };
}

function pointWithoutMs(point) {
  const { ms, ...rest } = point;
  return rest;
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/stations") {
    sendJson(res, 200, { stations: STATIONS, parameters: PARAMETERS });
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: state.bootstrapped,
      checkedAt: new Date().toISOString(),
      commit: COMMIT,
      bootstrapped: state.bootstrapped,
      lastRefreshAt: state.lastRefreshOkMs ? new Date(state.lastRefreshOkMs).toISOString() : null,
      lastRefreshError: state.lastRefreshError
    });
    return;
  }

  if (url.pathname === "/api/monitor" || url.pathname === "/api/readings") {
    if (!state.bootstrapped) {
      sendJson(res, 503, { error: "Monitor is still loading its initial history; retry shortly.", lastRefreshError: state.lastRefreshError });
      return;
    }
    const days = Math.max(1, Math.min(RETENTION_DAYS, Number(url.searchParams.get("days") || 7)));
    sendJson(res, 200, buildMonitorPayload(days));
    return;
  }

  if (url.pathname === "/api/storage") {
    if (!state.bootstrapped) {
      sendJson(res, 503, { error: "Monitor is still loading its initial history; retry shortly." });
      return;
    }
    const days = Math.max(1, Math.min(RETENTION_DAYS, Number(url.searchParams.get("days") || 30)));
    const startMs = Date.now() - days * DAY_MS;
    const windowed = storageStore.filter((row) => row.ms >= startMs);
    const glenmore = STORAGE_LOCATIONS.find((location) => location.id === "glenmore");
    const sr1 = STORAGE_LOCATIONS.find((location) => location.id === "sr1");

    sendJson(res, 200, {
      checkedAt: new Date().toISOString(),
      range: { days },
      locations: [
        {
          ...glenmore,
          summary: storageSummary(windowed),
          records: windowed.map((row) => ({
            timestamp: new Date(row.ms).toISOString(),
            elevationM: row.elevationM,
            storageDam3: row.storageDam3,
            storageM3: row.storageDam3 * 1000
          }))
        },
        {
          ...sr1,
          summary: null,
          records: []
        }
      ],
      source: storageSource
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Elbow River monitor running on ${HOST}:${PORT} (commit ${COMMIT})`);
  tick();
  setInterval(tick, REFRESH_MS);
});
