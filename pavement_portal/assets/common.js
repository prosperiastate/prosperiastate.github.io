// Shared header/footer + helpers for IowaPavementData.com (sample site)
(function () {
  const page = document.body.dataset.page || "";
  const qs = new URLSearchParams(location.search);
  const cid = qs.get("id");
  const isActive = (p, id) => (page === p && (!id || id === cid) ? "active" : "");

  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `
    <div class="wrap">
      <a class="brand" href="index.html"><span class="brand-mark">IA</span>IowaPavementData.com</a>
      <button class="nav-toggle" aria-label="Menu">&#9776;</button>
      <nav class="nav">
        <a href="index.html" class="${isActive("home")}">Home</a>
        <a href="county.html?id=56" class="${isActive("county", "56")}">Lee County</a>
        <a href="county.html?id=23" class="${isActive("county", "23")}">Clinton County</a>
        <a href="county.html" class="${page === "county" && cid !== "56" && cid !== "23" ? "active" : ""}">Other County</a>
        <a href="upload.html" class="nav-upload">Upload Your Data</a>
      </nav>
    </div>`;
  document.body.prepend(header);
  header.querySelector(".nav-toggle").onclick = () => header.querySelector(".nav").classList.toggle("open");

  const footer = document.createElement("footer");
  footer.innerHTML = `
    <div class="wrap">
      <div><b style="color:#fff">IowaPavementData.com</b> &middot; sample portal<br>
        IHRB-4415 County Pavement Preservation Data Collection &middot; Iowa State University PROSPER / InTrans</div>
      <div class="small">Performance &amp; traffic: Iowa DOT PMIS shapefile (2025)<br>
        Climate: Iowa Environmental Mesonet ASOS daily temperatures, 2015&ndash;2024<br>
        Construction thickness / year are <b>placeholders</b> for demonstration.</div>
    </div>`;
  document.body.append(footer);
})();

const IPD = {
  iriClass(v) {
    if (v == null) return "na";
    return v < 95 ? "good" : v <= 170 ? "fair" : "poor";
  },
  iriLabel: { good: "Good", fair: "Fair", poor: "Poor", na: "n/a" },
  iriColor(v) {
    return { good: "#2e8b57", fair: "#e0a400", poor: "#c0392b", na: "#9aa3a8" }[IPD.iriClass(v)];
  },
  // sequential palette (light -> dark) for numeric layers
  ramp(t, stops) {
    t = Math.max(0, Math.min(1, t));
    const n = stops.length - 1, i = Math.min(Math.floor(t * n), n - 1), f = t * n - i;
    const a = stops[i], b = stops[i + 1];
    const h = (s) => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
    const [ar, ag, ab] = h(a), [br, bg, bb] = h(b);
    const m = (x, y) => Math.round(x + (y - x) * f).toString(16).padStart(2, "0");
    return "#" + m(ar, br) + m(ag, bg) + m(ab, bb);
  },
  fmt(v, d = 0) {
    return v == null || isNaN(v) ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  },
  basemap(map) {
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
      maxZoom: 16,
    }).addTo(map);
    // keep the map sized correctly if its container was not laid out yet
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer());
  },
  fit(map, bounds, opts = { padding: [10, 10] }) {
    map.fitBounds(bounds, opts);
    const refit = () => { map.invalidateSize(); map.fitBounds(bounds, opts); };
    if (document.readyState === "complete") requestAnimationFrame(refit);
    else window.addEventListener("load", refit, { once: true });
  },
  countyOptions(select, selected) {
    COUNTIES.list.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id; o.textContent = c.name + " County";
      if (String(c.id) === String(selected)) o.selected = true;
      select.append(o);
    });
  },
};
