import http from "node:http";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = resolve("public");

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

function parseWaterOfficeCsv(csv) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim().replace(/^\uFEFF/, ""));
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
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

function summarize(station, rows) {
  const byParameter = {};

  for (const parameterId of Object.keys(PARAMETERS)) {
    const values = rows
      .filter((row) => row.stationId === station.id && row.parameter === parameterId)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (values.length === 0) {
      byParameter[PARAMETERS[parameterId].key] = null;
      continue;
    }

    const latest = values.at(-1);
    const first = values[0];
    const min = Math.min(...values.map((row) => row.value));
    const max = Math.max(...values.map((row) => row.value));
    const average = values.reduce((sum, row) => sum + row.value, 0) / values.length;
    const oneHour = nearestPrior(values, latest.timestamp - 60 * 60 * 1000);
    const sixHour = nearestPrior(values, latest.timestamp - 6 * 60 * 60 * 1000);

    byParameter[PARAMETERS[parameterId].key] = {
      parameter: parameterId,
      unit: PARAMETERS[parameterId].unit,
      latest: latest.value,
      latestAt: latest.timestamp.toISOString(),
      ageMinutes: Math.round((Date.now() - latest.timestamp.getTime()) / 6000) / 10,
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

function nearestPrior(values, timestampMs) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i].timestamp.getTime() <= timestampMs) {
      return values[i];
    }
  }
  return null;
}

function parseReadings(csv) {
  return parseWaterOfficeCsv(csv)
    .map((row) => ({
      stationId: row.ID,
      timestamp: new Date(row.Date),
      parameter: row["Parameter/Paramètre"],
      value: Number(row["Value/Valeur"]),
      approval: row["Approval/Approbation"] || ""
    }))
    .filter((row) => row.stationId && Number.isFinite(row.value) && !Number.isNaN(row.timestamp.getTime()));
}

async function fetchGlenmoreStorage(days) {
  const where = encodeURIComponent(`station_number='05BJ008' AND timestamp > '${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()}'`);
  const select = encodeURIComponent("station_number,station_name,timestamp,level,flow");
  const url = `https://data.calgary.ca/resource/5fdg-ifgr.json?$select=${select}&$where=${where}&$order=timestamp ASC&$limit=50000`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open Calgary returned HTTP ${response.status}`);
  }

  const rows = await response.json();
  const records = rows
    .map((row) => ({
      timestamp: new Date(row.timestamp),
      elevationM: Number(row.level),
      storageDam3: Number(row.flow)
    }))
    .filter((row) => !Number.isNaN(row.timestamp.getTime()) && Number.isFinite(row.storageDam3))
    .sort((a, b) => a.timestamp - b.timestamp);

  return { url, records };
}

function storageSummary(records) {
  if (records.length === 0) {
    return null;
  }

  const latest = records.at(-1);
  const first = records[0];
  const prior24h = nearestStoragePrior(records, latest.timestamp.getTime() - 24 * 60 * 60 * 1000);
  const prior7d = nearestStoragePrior(records, latest.timestamp.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    latestAt: latest.timestamp.toISOString(),
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

function nearestStoragePrior(records, timestampMs) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i].timestamp.getTime() <= timestampMs) {
      return records[i];
    }
  }
  return null;
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/stations") {
    sendJson(res, 200, { stations: STATIONS, parameters: PARAMETERS });
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, checkedAt: new Date().toISOString(), commit: COMMIT });
    return;
  }

  if (url.pathname === "/api/readings") {
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 7)));
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const source = buildWaterOfficeUrl({ stationIds: STATIONS.map((station) => station.id), start, end });
    const response = await fetch(source);

    if (!response.ok) {
      sendJson(res, 502, { error: `WaterOffice returned HTTP ${response.status}` });
      return;
    }

    const csv = await response.text();
    const readings = parseReadings(csv);
    const summaries = Object.fromEntries(STATIONS.map((station) => [station.id, summarize(station, readings)]));

    sendJson(res, 200, {
      checkedAt: end.toISOString(),
      range: { start: start.toISOString(), end: end.toISOString(), days },
      stations: STATIONS,
      parameters: PARAMETERS,
      summaries,
      readings: readings.map((row) => ({
        stationId: row.stationId,
        timestamp: row.timestamp.toISOString(),
        parameter: row.parameter,
        value: row.value
      })),
      source
    });
    return;
  }

  if (url.pathname === "/api/storage") {
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 30)));
    const { url: source, records } = await fetchGlenmoreStorage(days);
    const glenmore = STORAGE_LOCATIONS.find((location) => location.id === "glenmore");
    const sr1 = STORAGE_LOCATIONS.find((location) => location.id === "sr1");

    sendJson(res, 200, {
      checkedAt: new Date().toISOString(),
      range: { days },
      locations: [
        {
          ...glenmore,
          summary: storageSummary(records),
          records: records.map((row) => ({
            timestamp: row.timestamp.toISOString(),
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
      source
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
});
