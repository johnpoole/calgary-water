const container = document.getElementById("map");
const statusEl = document.getElementById("status");
const tooltipEl = document.getElementById("tooltip");
const inspectorContentEl = document.getElementById("inspectorContent");
const legendDiameterEl = document.getElementById("legendDiameter");
const legendAgeEl = document.getElementById("legendAge");
const legendMaterialEl = document.getElementById("legendMaterial");

const geojsonUrl = "./data/Public_Water_Main_20251231.geojson";
const materialLabelsUrl = "./material_labels.json";

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

function renderLegend(labels) {
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
      const li = document.createElement("li");
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.borderTopWidth = `${it.w}px`;
      sw.style.borderTopColor = "#111827";
      li.appendChild(sw);
      li.appendChild(document.createTextNode(it.label));
      legendDiameterEl.appendChild(li);
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
      const li = document.createElement("li");
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
      li.appendChild(svg);
      li.appendChild(document.createTextNode(it.label));
      legendAgeEl.appendChild(li);
    }
  }

  if (legendMaterialEl) {
    legendMaterialEl.innerHTML = "";
    const mats = [...MATERIAL_ORDER, "Other", "Unknown"];
    for (const m of mats) {
      const li = document.createElement("li");
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.borderTopWidth = "3px";
      sw.style.borderTopColor =
        m === "Other" ? "#9ca3af" : m === "Unknown" ? "#6b7280" : colorForMaterial(m);
      li.appendChild(sw);
      const label =
        m === "Other" || m === "Unknown" ? m : materialLabel(m, labels);
      li.appendChild(document.createTextNode(label));
      legendMaterialEl.appendChild(li);
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

function summarizeProperties(properties, labels) {
  if (!properties || typeof properties !== "object") return "(no properties)";

  const diamMm = parseDiameterMm(properties.diam);
  const material = normalizeMaterial(properties.material);
  const materialName = materialLabel(material, labels);
  const iy = parseInstallYear(properties.year);
  const age = ageYears(iy);

  const lines = [];
  lines.push(`diam: ${diamMm ?? "Unknown"}${diamMm != null ? " mm" : ""}`);
  lines.push(`material: ${materialName}`);
  lines.push(`year: ${iy ?? "Unknown"}`);
  lines.push(`age: ${age ?? "Unknown"}${age != null ? " yrs" : ""}`);

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

  const { width, height } = container.getBoundingClientRect();
  const w = Math.max(320, Math.floor(width));
  const h = Math.max(240, Math.floor(height));

  const svg = createSvg(w, h);

  const projection = d3.geoMercator();
  const path = d3.geoPath(projection);

  // Fit projection to data.
  projection.fitSize([w, h], geojson);

  renderLegend(labels);

  const g = svg.append("g").attr("class", "layer");

  const zoom = d3
    .zoom()
    .scaleExtent([1, 20])
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
      updateSymbology(event.transform.k);
    });

  svg.call(zoom);

  let selectedId = null;

  function featureId(d, i) {
    return d?.id ?? d?.properties?.OBJECTID ?? d?.properties?.ObjectId ?? i;
  }

  function setInspector(feature) {
    if (!inspectorContentEl) return;
    if (!feature) {
      inspectorContentEl.textContent = "Click a feature to view its properties.";
      return;
    }

    const matCode = normalizeMaterial(feature?.properties?.material);
    const matName = materialLabel(matCode, labels);
    const diamMm = parseDiameterMm(feature?.properties?.diam);
    const iy = parseInstallYear(feature?.properties?.year);
    const a = ageYears(iy);

    const payload = {
      id: feature.id ?? null,
      geometryType: feature.geometry?.type ?? null,
      derived: {
        diameterMm: diamMm,
        materialCode: matCode,
        materialName: matName,
        installYear: iy,
        ageYears: a,
        ageBin: ageBin(a),
      },
      properties: feature.properties ?? {},
    };

    inspectorContentEl.textContent = JSON.stringify(payload, null, 2);
  }

  const features =
    geojson.type === "FeatureCollection" ? geojson.features : [geojson];

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

      const id = featureId(d);
      selectedId = id;
      g.selectAll("path").classed(
        "is-selected",
        (dd, ii) => featureId(dd, ii) === selectedId
      );
      setInspector(d);
    });

  function updateSymbology(k) {
    const minDiam = minDiameterForZoomK(k);

    paths
      .attr("stroke", (d) => {
        const mat = normalizeMaterial(d?.properties?.material);
        // Collapse non-top materials to "Other" to keep legend manageable.
        if (mat !== "Unknown" && !MATERIAL_COLORS.has(mat)) return "#9ca3af";
        return colorForMaterial(mat);
      })
      .attr("stroke-linecap", "round")
      .attr("stroke-dasharray", (d) => {
        const iy = parseInstallYear(d?.properties?.year);
        const bin = ageBin(ageYears(iy));
        const dash = dashForAgeBin(bin);
        return dash ?? null;
      })
      .attr("stroke-width", (d) => {
        const diamMm = parseDiameterMm(d?.properties?.diam);
        return strokeWidthPx(diamMm, k);
      })
      .style("display", (d) => {
        const diamMm = parseDiameterMm(d?.properties?.diam);
        if (minDiam <= 0) return null;
        if (diamMm == null) return "none";
        return diamMm >= minDiam ? null : "none";
      });
  }

  // Initial symbology at k=1
  updateSymbology(1);

  svg.on("click", () => {
    selectedId = null;
    g.selectAll("path").classed("is-selected", false);
    setInspector(null);
  });
}

async function main() {
  try {
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
