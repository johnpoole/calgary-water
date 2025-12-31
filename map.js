const container = document.getElementById("map");
const statusEl = document.getElementById("status");
const tooltipEl = document.getElementById("tooltip");
const legendOverlayEl = document.getElementById("legendOverlay");
const legendOverlayKeyTitleEl = document.getElementById("legendOverlayKeyTitle");
const legendOverlayKeyEl = document.getElementById("legendOverlayKey");
const legendDiameterEl = document.getElementById("legendDiameter");
const legendAgeEl = document.getElementById("legendAge");
const legendMaterialEl = document.getElementById("legendMaterial");
const legendBasemapEl = document.getElementById("legendBasemap");
const tilesEl = document.getElementById("tiles");
const legendEl = document.getElementById("legend");
const legendToggleEl = document.getElementById("legendToggle");
const legendBodyEl = document.getElementById("legendBody");

const geojsonUrl = "./data/Public_Water_Main_20251231.geojson";
const materialLabelsUrl = "./material_labels.json";

function setLegendCollapsed(isCollapsed) {
  if (!legendEl || !legendToggleEl) return;
  legendEl.classList.toggle("is-collapsed", !!isCollapsed);
  legendToggleEl.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  legendToggleEl.textContent = isCollapsed ? "Show" : "Hide";
  if (legendBodyEl) legendBodyEl.setAttribute("aria-hidden", isCollapsed ? "true" : "false");
}

function initLegendToggle() {
  if (!legendEl || !legendToggleEl) return;

  const isSmall = window.matchMedia?.("(max-width: 640px)")?.matches ?? false;
  // On mobile: start collapsed. On desktop: start expanded.
  setLegendCollapsed(!!isSmall);

  legendToggleEl.addEventListener("click", () => {
    const isCollapsed =
      legendToggleEl.getAttribute("aria-expanded") === "false" ||
      legendEl.classList.contains("is-collapsed");
    setLegendCollapsed(!isCollapsed);
  });
}

// URL state (shareable view): stores zoom/pan + current filters in the query string.
// Example:
//   ?k=2.1&x=-120&y=85&bm=1&dia=%E2%89%A4150,300&age=%3C20,20%E2%80%9350&mat=PVC,Other
const urlState = {
  initialized: false,
  transform: d3.zoomIdentity,
  _pending: false,
};

function parseCsvParam(params, key) {
  const raw = params.get(key);
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readUrlStateIntoFilterState() {
  const params = new URLSearchParams(window.location.search);

  // Zoom transform
  const k = Number(params.get("k"));
  const x = Number(params.get("x"));
  const y = Number(params.get("y"));
  if (Number.isFinite(k) && k > 0 && Number.isFinite(x) && Number.isFinite(y)) {
    urlState.transform = d3.zoomIdentity.translate(x, y).scale(k);
  }

  // Basemap
  const bm = params.get("bm");
  if (bm != null) {
    filterState.basemapEnabled = bm === "1" || bm.toLowerCase() === "true";
  }

  // Overlay
  const ov = (params.get("ov") ?? "").toString().trim().toLowerCase();
  if (ov === "risk" || ov === "consequence" || ov === "none") {
    filterState.overlay = ov;
  }

  // Filters
  const dia = parseCsvParam(params, "dia");
  if (dia != null) {
    filterState.diameterBins = new Set(dia);
  }

  const age = parseCsvParam(params, "age");
  if (age != null) {
    filterState.ageBins = new Set(age);
  }

  const mat = parseCsvParam(params, "mat");
  if (mat != null) {
    filterState.materials = new Set(mat);
  }
}

function writeUrlState(transform) {
  const params = new URLSearchParams(window.location.search);

  // Keep params stable (so sharing URLs is predictable).
  const k = Number(transform?.k);
  const x = Number(transform?.x);
  const y = Number(transform?.y);
  if (Number.isFinite(k) && Number.isFinite(x) && Number.isFinite(y)) {
    params.set("k", k.toFixed(4));
    params.set("x", x.toFixed(2));
    params.set("y", y.toFixed(2));
  } else {
    params.delete("k");
    params.delete("x");
    params.delete("y");
  }

  params.set("bm", filterState.basemapEnabled ? "1" : "0");
  params.set("ov", filterState.overlay ?? "none");
  params.set("dia", [...filterState.diameterBins].join(","));
  params.set("age", [...filterState.ageBins].join(","));
  params.set("mat", [...filterState.materials].join(","));

  const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    history.replaceState(null, "", next);
  }
}

function scheduleUrlWrite(transform) {
  urlState.transform = transform;
  if (urlState._pending) return;
  urlState._pending = true;
  window.requestAnimationFrame(() => {
    urlState._pending = false;
    writeUrlState(urlState.transform);
  });
}

// Online basemap tiles (OpenStreetMap). For production usage, use an approved tile provider.
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_MAX_Z = 19;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function lonToTileX(lon, z) {
  const n = 2 ** z;
  return Math.floor(((lon + 180) / 360) * n);
}

function latToTileY(lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const y =
    (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.floor(y * n);
}

function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function tileUrl(z, x, y) {
  return TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

// This repo's GeoJSON uses these keys (confirmed via profile_geojson.py):
// - diameter: properties.diam (string)
// - material: properties.material (string)
// - install year: properties.year (string)
const CURRENT_YEAR = 2025;

const MATERIAL_ORDER = [
  "PVC",
  "CI",
  "YDI",
  "PDI",
  "ST",
  "PVCG",
  "CON",
  "DI",
  "AC",
  "PE",
  "CU",
];

// Legend toggles (persist across re-renders)
const filterState = {
  basemapEnabled: true,
  overlay: "none", // style mode: 'none' (asset symbology) | 'risk' | 'consequence'
  diameterBins: new Set(["≤150", "200–250", "300", "400", "500–600", "≥750", "Unknown"]),
  ageBins: new Set(["<20", "20–50", "50–80", "≥80", "Unknown"]),
  materials: new Set([...MATERIAL_ORDER, "Other", "Unknown"]),
};

const RISK_LABELS = ["Low", "Medium", "High", "Very High"];

function riskPalette() {
  // Low -> High (green -> red)
  const base =
    d3.schemeRdYlGn?.[5] ?? ["#d73027", "#fc8d59", "#fee08b", "#d9ef8b", "#1a9850"];
  return [base[4], base[3], base[1], base[0]];
}

function consequencePalette() {
  const base =
    d3.schemeBlues?.[5] ?? ["#eff6ff", "#bfdbfe", "#60a5fa", "#2563eb", "#1e3a8a"];
  return [base[1], base[2], base[3], base[4]];
}

function pofScoreFromDerived(derived) {
  // Likelihood / Probability of failure (PoF) proxy from age + material + status.
  // Returns an integer in [1..4].
  const ageBinLabel = derived?.ageBin ?? "Unknown";
  const matCode = derived?.matCode ?? "Unknown";
  const status = (derived?.statusInd ?? "").toString().trim().toUpperCase();

  let score = 2;

  // Age component
  if (ageBinLabel === "<20") score = 1;
  else if (ageBinLabel === "20–50") score = 2;
  else if (ageBinLabel === "50–80") score = 3;
  else if (ageBinLabel === "≥80") score = 4;
  else score = 2;

  // Material adjustment (simple heuristic)
  const matAdj = new Map([
    ["PVC", -1],
    ["PE", -1],
    ["DI", 0],
    ["PDI", 0],
    ["YDI", 0],
    ["ST", 0],
    ["CI", 1],
    ["AC", 1],
    ["ECI", 1],
    ["PCI", 1],
  ]);
  score += matAdj.get(matCode) ?? 0;

  // Status adjustment: if status indicates out-of-service/abandoned/etc, bump PoF.
  // We don't know the coding scheme, so we only match obvious words.
  if (status.includes("ABAND") || status.includes("OUT") || status.includes("INACT")) {
    score += 1;
  }

  return clamp(Math.round(score), 1, 4);
}

function consequenceScoreFromDerived(derived) {
  // Consequence of failure (CoF) proxy from diameter (+ tiny bump for long segments).
  // Returns an integer in [1..4].
  const diamMm = derived?.diamMm;
  const lengthM = derived?.lengthM;

  let score = 2;
  if (diamMm == null) score = 2;
  else if (diamMm <= 150) score = 1;
  else if (diamMm <= 250) score = 2;
  else if (diamMm <= 400) score = 3;
  else score = 4;

  if (typeof lengthM === "number" && Number.isFinite(lengthM)) {
    if (lengthM >= 500) score += 1;
  }

  return clamp(Math.round(score), 1, 4);
}

function riskBinFromScores(pof, cof) {
  const product = (pof ?? 2) * (cof ?? 2); // 1..16
  if (product <= 4) return 1;
  if (product <= 8) return 2;
  if (product <= 12) return 3;
  return 4;
}

function lineWidthForLevel(level, k) {
  // Used for Risk/Consequence styling modes.
  const base = 1.4 + (clamp(level, 1, 4) - 1) * 1.0;
  const boost = Math.max(1.0, Math.min(1.6, 1.0 + 0.25 * Math.log2(k + 1)));
  return base * boost;
}

const MATERIAL_COLORS = new Map(
  MATERIAL_ORDER.map((m, i) => [m, d3.schemeTableau10[i % 10]])
);

function normalizeMaterial(raw) {
  const s = (raw ?? "").toString().trim().toUpperCase();
  if (!s) return "Unknown";
  return s;
}

function materialLabel(code, labels) {
  if (!code) return "Unknown";
  const key = code.toString().trim().toUpperCase();
  const label = labels?.[key];
  return label ?? key;
}

function parseDiameterMm(raw) {
  const n = Number((raw ?? "").toString().trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseInstallYear(raw) {
  const s = (raw ?? "").toString();
  const m = s.match(/\b(18|19|20)\d{2}\b/);
  if (!m) return null;
  const y = Number(m[0]);
  if (!Number.isFinite(y) || y < 1800 || y > CURRENT_YEAR) return null;
  return y;
}

function diameterBin(diamMm) {
  if (diamMm == null) return "Unknown";
  if (diamMm <= 150) return "≤150";
  if (diamMm <= 250) return "200–250";
  if (diamMm <= 300) return "300";
  if (diamMm <= 400) return "400";
  if (diamMm <= 600) return "500–600";
  return "≥750";
}

function materialGroup(matCode) {
  if (!matCode || matCode === "Unknown") return "Unknown";
  return MATERIAL_COLORS.has(matCode) ? matCode : "Other";
}

function ageYears(installYear) {
  if (installYear == null) return null;
  const a = CURRENT_YEAR - installYear;
  return a >= 0 ? a : null;
}

function ageBin(age) {
  if (age == null) return "Unknown";
  if (age < 20) return "<20";
  if (age < 50) return "20–50";
  if (age < 80) return "50–80";
  return "≥80";
}

function dashForAgeBin(bin) {
  // NOTE: The paths use `vector-effect: non-scaling-stroke`, which also prevents
  // stroke dash patterns from scaling with zoom transforms. Therefore we should
  // NOT apply any 1/k scaling here; doing so makes dashes look solid when zoomed in.
  const dash = (a, b) => `${a},${b}`;
  const dashDot = (a, b, c, d) => `${a},${b},${c},${d}`;

  switch (bin) {
    case "<20":
      return null; // solid
    case "20–50":
      return dash(10, 6); // dashed
    case "50–80":
      // Use a very short dash with round linecaps to read as dots.
      return dash(0.8, 6);
    case "≥80":
      // Dash-dot: long dash, gap, dot, gap
      return dashDot(10, 6, 0.8, 6);
    default:
      return dash(2, 10); // sparse dashes for unknown
  }
}

function colorForMaterial(mat) {
  if (MATERIAL_COLORS.has(mat)) return MATERIAL_COLORS.get(mat);
  if (mat === "Unknown") return "#6b7280";
  return "#9ca3af";
}

function baseStrokeWidthForDiameter(diamMm) {
  if (diamMm == null) return 0.8;
  if (diamMm <= 150) return 0.8;
  if (diamMm <= 250) return 1.2;
  if (diamMm <= 300) return 1.6;
  if (diamMm <= 400) return 2.2;
  if (diamMm <= 600) return 3.0;
  return 4.0;
}

function strokeWidthPx(diamMm, k) {
  const base = baseStrokeWidthForDiameter(diamMm);
  // Make differences visible at low zoom without exploding at high zoom.
  const boost = Math.max(0.9, Math.min(1.7, 0.9 + 0.35 * Math.log2(k + 1)));
  return base * boost;
}

function minDiameterForZoomK(k) {
  // Level-of-detail filtering to reduce clutter when zoomed out.
  if (k < 1.5) return 400;
  if (k < 4) return 250;
  if (k < 8) return 150;
  return 0;
}

function renderLegend(labels, onToggle) {
  function makeCheckbox({
    listEl,
    label,
    checked,
    kind,
    value,
    swatchEl,
  }) {
    const li = document.createElement("li");
    const key = document.createElement("div");
    key.className = "key";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    input.dataset.kind = kind;
    if (value != null) input.dataset.value = value;
    input.addEventListener("change", () => onToggle?.(kind, value, input.checked));

    key.appendChild(input);
    if (swatchEl) key.appendChild(swatchEl);
    li.appendChild(key);
    li.appendChild(document.createTextNode(label));
    listEl.appendChild(li);
  }

  function makeKeyItem({ listEl, label, color }) {
    const li = document.createElement("li");
    const key = document.createElement("div");
    key.className = "key";
    const sw = document.createElement("div");
    sw.className = "swatch";
    sw.style.borderTopWidth = "4px";
    sw.style.borderTopColor = color;
    key.appendChild(sw);
    li.appendChild(key);
    li.appendChild(document.createTextNode(label));
    listEl.appendChild(li);
  }

  if (legendOverlayEl) {
    legendOverlayEl.innerHTML = "";
    const swRisk = document.createElement("div");
    swRisk.className = "swatch";
    swRisk.style.borderTopWidth = "4px";
    swRisk.style.borderTopColor = riskPalette()[3];
    makeCheckbox({
      listEl: legendOverlayEl,
      label: "Risk",
      checked: filterState.overlay === "risk",
      kind: "overlay",
      value: "risk",
      swatchEl: swRisk,
    });

    const swCof = document.createElement("div");
    swCof.className = "swatch";
    swCof.style.borderTopWidth = "4px";
    swCof.style.borderTopColor = consequencePalette()[3];
    makeCheckbox({
      listEl: legendOverlayEl,
      label: "Consequence",
      checked: filterState.overlay === "consequence",
      kind: "overlay",
      value: "consequence",
      swatchEl: swCof,
    });
  }

  if (legendOverlayKeyTitleEl) {
    legendOverlayKeyTitleEl.style.display = filterState.overlay === "none" ? "none" : "block";
  }

  if (legendOverlayKeyEl) {
    legendOverlayKeyEl.innerHTML = "";
    if (filterState.overlay !== "none") {
      const palette = filterState.overlay === "risk" ? riskPalette() : consequencePalette();
      for (let i = 0; i < 4; i++) {
        makeKeyItem({ listEl: legendOverlayKeyEl, label: RISK_LABELS[i], color: palette[i] });
      }
    }
  }

  if (legendBasemapEl) {
    legendBasemapEl.innerHTML = "";
    const sw = document.createElement("div");
    sw.className = "swatch";
    sw.style.borderTopWidth = "3px";
    sw.style.borderTopColor = "#9ca3af";
    makeCheckbox({
      listEl: legendBasemapEl,
      label: "OpenStreetMap",
      checked: filterState.basemapEnabled,
      kind: "basemap",
      value: "osm",
      swatchEl: sw,
    });
  }

  if (legendDiameterEl) {
    legendDiameterEl.innerHTML = "";
    const diaItems = [
      { label: "≤150", w: 0.8 },
      { label: "200–250", w: 1.2 },
      { label: "300", w: 1.6 },
      { label: "400", w: 2.2 },
      { label: "500–600", w: 3.0 },
      { label: "≥750", w: 4.0 },
      { label: "Unknown", w: 0.8 },
    ];
    for (const it of diaItems) {
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.borderTopWidth = `${it.w}px`;
      sw.style.borderTopColor = "#111827";
      makeCheckbox({
        listEl: legendDiameterEl,
        label: it.label,
        checked: filterState.diameterBins.has(it.label),
        kind: "diameter",
        value: it.label,
        swatchEl: sw,
      });
    }
  }

  if (legendAgeEl) {
    legendAgeEl.innerHTML = "";
    const ageItems = [
      { label: "<20 years", bin: "<20" },
      { label: "20–50 years", bin: "20–50" },
      { label: "50–80 years", bin: "50–80" },
      { label: "≥80 years", bin: "≥80" },
      { label: "Unknown", bin: "Unknown" },
    ];
    for (const it of ageItems) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "44");
      svg.setAttribute("height", "12");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "2");
      line.setAttribute("x2", "42");
      line.setAttribute("y1", "6");
      line.setAttribute("y2", "6");
      line.setAttribute("stroke", "#111827");
      line.setAttribute("stroke-width", "3");
      line.setAttribute("stroke-linecap", "round");
      const dash = dashForAgeBin(it.bin);
      if (dash) line.setAttribute("stroke-dasharray", dash);
      svg.appendChild(line);
      makeCheckbox({
        listEl: legendAgeEl,
        label: it.label,
        checked: filterState.ageBins.has(it.bin),
        kind: "age",
        value: it.bin,
        swatchEl: svg,
      });
    }
  }

  if (legendMaterialEl) {
    legendMaterialEl.innerHTML = "";
    const mats = [...MATERIAL_ORDER, "Other", "Unknown"];
    for (const m of mats) {
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.borderTopWidth = "3px";
      sw.style.borderTopColor =
        m === "Other" ? "#9ca3af" : m === "Unknown" ? "#6b7280" : colorForMaterial(m);
      const label =
        m === "Other" || m === "Unknown" ? m : materialLabel(m, labels);
      makeCheckbox({
        listEl: legendMaterialEl,
        label,
        checked: filterState.materials.has(m),
        kind: "material",
        value: m,
        swatchEl: sw,
      });
    }
  }
}

function showError(err) {
  if (statusEl) statusEl.remove();
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = `Failed to load/render GeoJSON.\n\n${err?.message ?? err}`;
  container.appendChild(div);
}

function clearStatus() {
  if (statusEl) statusEl.remove();
}

function createSvg(width, height) {
  const svg = d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  return svg;
}

function ensureTileLayer() {
  if (!tilesEl) return null;
  let layer = tilesEl.querySelector(".tile-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "tile-layer";
    tilesEl.appendChild(layer);
  }
  return layer;
}

function summarizeProperties(properties, labels) {
  if (!properties || typeof properties !== "object") return "(no properties)";

  const diamMm = parseDiameterMm(properties.diam);
  const material = normalizeMaterial(properties.material);
  const materialName = materialLabel(material, labels);
  const iy = parseInstallYear(properties.year);
  const age = ageYears(iy);

  const derived = {
    diamMm,
    diamBin: diameterBin(diamMm),
    matCode: normalizeMaterial(properties.material),
    ageBin: ageBin(age),
    statusInd: (properties.status_ind ?? "").toString(),
    lengthM: Number.isFinite(Number(properties.length)) ? Number(properties.length) : null,
  };
  const pof = pofScoreFromDerived(derived);
  const cof = consequenceScoreFromDerived(derived);
  const rbin = riskBinFromScores(pof, cof);

  const lines = [];
  lines.push(`diam: ${diamMm ?? "Unknown"}${diamMm != null ? " mm" : ""}`);
  lines.push(`material: ${materialName}`);
  lines.push(`year: ${iy ?? "Unknown"}`);
  lines.push(`age: ${age ?? "Unknown"}${age != null ? " yrs" : ""}`);
  lines.push(`risk: ${RISK_LABELS[rbin - 1]} (PoF ${pof} × CoF ${cof})`);
  lines.push(`consequence: ${RISK_LABELS[cof - 1]} (${cof})`);

  // Add a couple extra fields if present.
  for (const k of ["status_ind", "p_zone", "length"]) {
    if (properties[k] != null && properties[k] !== "") {
      lines.push(`${k}: ${properties[k]}`);
    }
  }

  return lines.join("\n");
}

function setTooltip(text, x, y) {
  if (!tooltipEl) return;
  if (!text) {
    tooltipEl.style.transform = "translate(-9999px, -9999px)";
    tooltipEl.setAttribute("aria-hidden", "true");
    return;
  }

  tooltipEl.textContent = text;
  tooltipEl.setAttribute("aria-hidden", "false");
  tooltipEl.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
}

function render(geojson, labels) {
  container.querySelectorAll("svg").forEach((n) => n.remove());

  const tileLayer = ensureTileLayer();
  if (tileLayer) tileLayer.innerHTML = "";

  const { width, height } = container.getBoundingClientRect();
  const w = Math.max(320, Math.floor(width));
  const h = Math.max(240, Math.floor(height));

  const svg = createSvg(w, h);

  const projection = d3.geoMercator();
  const path = d3.geoPath(projection);

  // Fit projection to data.
  projection.fitSize([w, h], geojson);

  // On first render, restore URL state (zoom + filters). Subsequent re-renders
  // (e.g., resize) should preserve the in-memory state.
  if (!urlState.initialized) {
    readUrlStateIntoFilterState();
    urlState.initialized = true;
  }

  let currentTransform = urlState.transform ?? d3.zoomIdentity;

  function applyBasemapVisibility() {
    if (!tilesEl) return;
    tilesEl.style.display = filterState.basemapEnabled ? "block" : "none";
  }

  function onToggle(kind, value, checked) {
    if (kind === "overlay") {
      // Mutually exclusive overlays.
      if (checked) filterState.overlay = value;
      else if (filterState.overlay === value) filterState.overlay = "none";

      renderLegend(labels, onToggle);
      updateSymbology(currentTransform.k);
      scheduleUrlWrite(currentTransform);
      return;
    }

    if (kind === "basemap") {
      filterState.basemapEnabled = checked;
      applyBasemapVisibility();
      updateTiles(currentTransform);
      scheduleUrlWrite(currentTransform);
      return;
    }

    if (kind === "diameter") {
      if (checked) filterState.diameterBins.add(value);
      else filterState.diameterBins.delete(value);
    }

    if (kind === "age") {
      if (checked) filterState.ageBins.add(value);
      else filterState.ageBins.delete(value);
    }

    if (kind === "material") {
      if (checked) filterState.materials.add(value);
      else filterState.materials.delete(value);
    }

    updateSymbology(currentTransform.k);
    scheduleUrlWrite(currentTransform);
  }

  renderLegend(labels, onToggle);
  applyBasemapVisibility();

  const g = svg.append("g").attr("class", "layer main-layer");

  const zoom = d3
    .zoom()
    .scaleExtent([1, 20])
    .on("zoom", (event) => {
      currentTransform = event.transform;
      urlState.transform = currentTransform;
      g.attr("transform", event.transform);
      updateSymbology(event.transform.k);
      updateTiles(event.transform);
      scheduleUrlWrite(event.transform);
    });

  svg.call(zoom);

  function featureId(d, i) {
    return d?.id ?? d?.properties?.OBJECTID ?? d?.properties?.ObjectId ?? i;
  }

  const features =
    geojson.type === "FeatureCollection" ? geojson.features : [geojson];

  // Compute derived values once for faster styling + filtering.
  for (const f of features) {
    const props = f?.properties ?? {};
    const diamMm = parseDiameterMm(props.diam);
    const diamBin = diameterBin(diamMm);
    const matCode = normalizeMaterial(props.material);
    const matGroup = materialGroup(matCode);
    const iy = parseInstallYear(props.year);
    const a = ageYears(iy);
    const aBin = ageBin(a);

    const statusInd = (props.status_ind ?? "").toString();
    const lengthN = Number((props.length ?? "").toString().trim());
    const lengthM = Number.isFinite(lengthN) ? lengthN : null;

    const derived = {
      diamMm,
      diamBin,
      matCode,
      matGroup,
      installYear: iy,
      ageYears: a,
      ageBin: aBin,
      statusInd,
      lengthM,
    };

    const pof = pofScoreFromDerived(derived);
    const cof = consequenceScoreFromDerived(derived);
    derived.pof = pof;
    derived.cof = cof;
    derived.riskBin = riskBinFromScores(pof, cof);
    f._derived = derived;
  }

  const paths = g
    .selectAll("path")
    .data(features)
    .join("path")
    .attr("class", "feature")
    .attr("d", path)
    .on("mouseenter", function () {
      d3.select(this).classed("is-hover", true);
    })
    .on("mousemove", function (event, d) {
      const [mx, my] = d3.pointer(event, container);
      const text = summarizeProperties(d?.properties, labels);
      setTooltip(text, mx, my);
    })
    .on("mouseleave", function () {
      d3.select(this).classed("is-hover", false);
      setTooltip(null);
    })
    .on("click", function (event, d) {
      event.preventDefault();
      event.stopPropagation();
    });

  function updateSymbology(k) {
    const minDiam = minDiameterForZoomK(k);

    const styleMode = filterState.overlay ?? "none";

    paths
      .attr("stroke-linecap", "round")
      .attr("stroke", (d) => {
        const derived = d?._derived;
        if (styleMode === "risk") {
          const bin = clamp(Number(derived?.riskBin ?? 2), 1, 4);
          return riskPalette()[bin - 1];
        }
        if (styleMode === "consequence") {
          const cof = clamp(Number(derived?.cof ?? 2), 1, 4);
          return consequencePalette()[cof - 1];
        }

        const matCode = derived?.matCode ?? normalizeMaterial(d?.properties?.material);
        if (matCode !== "Unknown" && !MATERIAL_COLORS.has(matCode)) return "#9ca3af";
        return colorForMaterial(matCode);
      })
      .attr("stroke-dasharray", (d) => {
        if (styleMode === "risk" || styleMode === "consequence") return null;
        const bin = d?._derived?.ageBin ?? ageBin(ageYears(parseInstallYear(d?.properties?.year)));
        const dash = dashForAgeBin(bin);
        return dash ?? null;
      })
      .attr("stroke-width", (d) => {
        const derived = d?._derived;
        if (styleMode === "risk") {
          const bin = clamp(Number(derived?.riskBin ?? 2), 1, 4);
          return lineWidthForLevel(bin, k);
        }
        if (styleMode === "consequence") {
          const cof = clamp(Number(derived?.cof ?? 2), 1, 4);
          return lineWidthForLevel(cof, k);
        }
        const diamMm = derived?.diamMm ?? parseDiameterMm(d?.properties?.diam);
        return strokeWidthPx(diamMm, k);
      })
      .style("display", (d) => {
        const derived = d?._derived;
        const diamMm = derived?.diamMm ?? parseDiameterMm(d?.properties?.diam);
        const diamBin = derived?.diamBin ?? diameterBin(diamMm);
        const matGroup = derived?.matGroup ?? materialGroup(normalizeMaterial(d?.properties?.material));
        const aBin = derived?.ageBin ?? ageBin(ageYears(parseInstallYear(d?.properties?.year)));

        if (!filterState.diameterBins.has(diamBin)) return "none";
        if (!filterState.materials.has(matGroup)) return "none";
        if (!filterState.ageBins.has(aBin)) return "none";

        if (minDiam <= 0) return null;
        if (diamMm == null) return "none";
        return diamMm >= minDiam ? null : "none";
      });
  }

  // Raster tiles: compute visible tiles for the current zoom transform.
  function updateTiles(transform) {
    if (!filterState.basemapEnabled) return;
    if (!tileLayer) return;

    // Apply the same transform to tiles so panning/zooming stays perfectly in sync.
    tileLayer.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;

    // Derive a tile zoom level based on mercator scale.
    const worldPx = projection.scale() * 2 * Math.PI;
    const z0 = Math.log2(worldPx / 256);
    const z = clamp(Math.round(z0 + Math.log2(transform.k)), 0, TILE_MAX_Z);

    // Visible extent in *base* (untransformed) pixels.
    const x0 = (0 - transform.x) / transform.k;
    const y0 = (0 - transform.y) / transform.k;
    const x1 = (w - transform.x) / transform.k;
    const y1 = (h - transform.y) / transform.k;

    const p0 = projection.invert([x0, y0]);
    const p1 = projection.invert([x1, y1]);
    if (!p0 || !p1) return;

    const lonMin = Math.min(p0[0], p1[0]);
    const lonMax = Math.max(p0[0], p1[0]);
    const latMin = Math.min(p0[1], p1[1]);
    const latMax = Math.max(p0[1], p1[1]);

    const n = 2 ** z;
    let xMin = clamp(lonToTileX(lonMin, z) - 1, 0, n - 1);
    let xMax = clamp(lonToTileX(lonMax, z) + 1, 0, n - 1);
    let yMin = clamp(latToTileY(latMax, z) - 1, 0, n - 1); // top
    let yMax = clamp(latToTileY(latMin, z) + 1, 0, n - 1); // bottom

    // Guard against pathological inversions.
    if (xMax < xMin || yMax < yMin) return;

    const tiles = [];
    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) {
        tiles.push({ z, x: tx, y: ty, key: `${z}/${tx}/${ty}` });
      }
    }

    const join = d3
      .select(tileLayer)
      .selectAll("img")
      .data(tiles, (d) => d.key);

    join.exit().remove();

    join
      .enter()
      .append("img")
      .attr("alt", "")
      .attr("loading", "lazy")
      .attr("referrerpolicy", "no-referrer")
      .attr("src", (d) => tileUrl(d.z, d.x, d.y))
      .merge(join)
      .each(function (d) {
        // Project tile bounds to our base pixel coordinate space.
        const lonL = tileXToLon(d.x, d.z);
        const lonR = tileXToLon(d.x + 1, d.z);
        const latT = tileYToLat(d.y, d.z);
        const latB = tileYToLat(d.y + 1, d.z);

        const pTL = projection([lonL, latT]);
        const pBR = projection([lonR, latB]);
        if (!pTL || !pBR) return;

        const left = pTL[0];
        const top = pTL[1];
        const widthPx = pBR[0] - pTL[0];
        const heightPx = pBR[1] - pTL[1];

        const img = this;
        img.style.left = `${left}px`;
        img.style.top = `${top}px`;
        img.style.width = `${widthPx}px`;
        img.style.height = `${heightPx}px`;
      });
  }

  // Apply initial/restore transform (triggers zoom handler, symbology, tiles).
  svg.call(zoom.transform, currentTransform);

  // Ensure URL reflects the current state even if the page loads with defaults.
  scheduleUrlWrite(currentTransform);

  svg.on("click", () => {
    // no-op (selection/inspector removed)
  });
}

async function main() {
  try {
    initLegendToggle();
    const [geojson, labels] = await Promise.all([
      d3.json(geojsonUrl),
      d3.json(materialLabelsUrl).catch(() => ({})),
    ]);
    clearStatus();
    render(geojson, labels);

    // Re-render on resize to keep it fitting the viewport.
    let resizeRaf = null;
    window.addEventListener("resize", () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => render(geojson, labels));
    });
  } catch (err) {
    showError(err);
  }
}

main();
