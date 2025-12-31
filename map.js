const container = document.getElementById("map");
const statusEl = document.getElementById("status");
const tooltipEl = document.getElementById("tooltip");
const inspectorContentEl = document.getElementById("inspectorContent");

const geojsonUrl = "./data/Public_Water_Main_20251231.geojson";

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

function summarizeProperties(properties) {
  if (!properties || typeof properties !== "object") return "(no properties)";

  const entries = Object.entries(properties);
  if (entries.length === 0) return "(no properties)";

  return entries
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
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

function render(geojson) {
  container.querySelectorAll("svg").forEach((n) => n.remove());

  const { width, height } = container.getBoundingClientRect();
  const w = Math.max(320, Math.floor(width));
  const h = Math.max(240, Math.floor(height));

  const svg = createSvg(w, h);

  const projection = d3.geoMercator();
  const path = d3.geoPath(projection);

  // Fit projection to data.
  projection.fitSize([w, h], geojson);

  const g = svg.append("g").attr("class", "layer");

  const zoom = d3
    .zoom()
    .scaleExtent([1, 20])
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
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

    const payload = {
      id: feature.id ?? null,
      geometryType: feature.geometry?.type ?? null,
      properties: feature.properties ?? {},
    };

    inspectorContentEl.textContent = JSON.stringify(payload, null, 2);
  }

  const features =
    geojson.type === "FeatureCollection" ? geojson.features : [geojson];

  g.selectAll("path")
    .data(features)
    .join("path")
    .attr("class", "feature")
    .attr("d", path)
    .on("mouseenter", function () {
      d3.select(this).classed("is-hover", true);
    })
    .on("mousemove", function (event, d) {
      const [mx, my] = d3.pointer(event, container);
      const text = summarizeProperties(d?.properties);
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

  svg.on("click", () => {
    selectedId = null;
    g.selectAll("path").classed("is-selected", false);
    setInspector(null);
  });
}

async function main() {
  try {
    const geojson = await d3.json(geojsonUrl);
    clearStatus();
    render(geojson);

    // Re-render on resize to keep it fitting the viewport.
    let resizeRaf = null;
    window.addEventListener("resize", () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => render(geojson));
    });
  } catch (err) {
    showError(err);
  }
}

main();
