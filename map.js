const container = document.getElementById("map");
const statusEl = document.getElementById("status");

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

  svg
    .append("g")
    .selectAll("path")
    .data(
      geojson.type === "FeatureCollection" ? geojson.features : [geojson]
    )
    .join("path")
    .attr("class", "feature")
    .attr("d", path);
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
