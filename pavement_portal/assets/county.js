// County view: loads data/county_<id>.js and builds map, tabs, model and table.
(function () {
  const id = new URLSearchParams(location.search).get("id");
  const sel = document.getElementById("countySelect");
  IPD.countyOptions(sel, id);
  sel.onchange = () => sel.value && (location.href = "county.html?id=" + sel.value);

  const county = COUNTIES.list.find((c) => String(c.id) === String(id));
  if (!county) { document.getElementById("noCounty").style.display = "block"; return; }

  document.title = `${county.name} County | IowaPavementData.com`;
  document.getElementById("countyTitle").textContent = `${county.name} County`;
  document.getElementById("eyebrow").textContent = [56, 23].includes(county.id) ? "Pilot county" : "County view";

  const s = document.createElement("script");
  s.src = `data/county_${county.id}.js`;
  s.onload = () => build(window.COUNTY_DATA);
  document.body.append(s);

  function build(D) {
    document.getElementById("countyMain").style.display = "block";
    const feats = D.segments.features;
    const P = feats.map((f) => f.properties);
    const vals = (k) => P.map((p) => p[k]).filter((v) => v != null);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const miles = vals("len").reduce((a, b) => a + b, 0);

    // ---------- KPIs
    const kpi = (label, value, unit) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value} <span class="unit">${unit}</span></div></div>`;
    document.getElementById("kpis").innerHTML =
      kpi("Segments", P.length, `${IPD.fmt(miles, 0)} mi`) +
      kpi("Avg thickness", IPD.fmt(mean(vals("thick")), 1), "in") +
      kpi("Avg IRI", IPD.fmt(mean(vals("iri")), 0), "in/mi") +
      kpi("Avg AADT", IPD.fmt(mean(vals("aadt")), 0), "veh/day") +
      kpi("Freeze-thaw", IPD.fmt(county.ft, 1), "cycles/yr");

    // ---------- layer definitions
    const PURPLE = ["#d6c6ec", "#b79bd6", "#7b5ea7", "#3e2763"];
    const BLUE = ["#c6dcf1", "#8db7e0", "#2f6fb0", "#123c69"];
    const range = (k) => { const a = vals(k); return [Math.min(...a), Math.max(...a)]; };
    const LAYERS = {
      thick: { tab: "construction", name: "Surface thickness", unit: "in", d: 1, ramp: PURPLE },
      cyr: { tab: "construction", name: "Construction year", unit: "", d: 0, ramp: PURPLE, nocomma: true },
      iri: { tab: "performance", name: "IRI", unit: "in/mi", d: 0, iri: true },
      aadt: { tab: "traffic", name: "AADT", unit: "veh/day", d: 0, ramp: BLUE, log: true },
      trucks: { tab: "traffic", name: "Trucks per day", unit: "veh/day", d: 0, ramp: BLUE, log: true },
    };
    const TABS = [
      { key: "construction", label: "Construction", color: "#7b5ea7", layers: ["thick", "cyr"] },
      { key: "performance", label: "Performance", color: "#2e8b57", layers: ["iri"] },
      { key: "traffic", label: "Traffic", color: "#2f6fb0", layers: ["aadt", "trucks"] },
      { key: "climate", label: "Climate", color: "#1d9bb5", layers: [] },
    ];
    function colorOf(k, v) {
      const L_ = LAYERS[k];
      if (v == null) return "#9aa3a8";
      if (L_.iri) return IPD.iriColor(v);
      let [lo, hi] = range(k);
      let t = L_.log ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1) : (v - lo) / (hi - lo || 1);
      return IPD.ramp(t, L_.ramp);
    }
    const fmtV = (k, v) => (LAYERS[k].nocomma ? String(v) : IPD.fmt(v, LAYERS[k].d));

    // ---------- main map
    const map = L.map("countyMap", { scrollWheelZoom: false });
    IPD.basemap(map);
    const boundary = L.geoJSON(D.boundary, { style: { color: "#9b1b30", weight: 2, fill: false, dashArray: "6 4" } }).addTo(map);
    IPD.fit(map, boundary.getBounds());
    let activeLayer = "thick";
    const popup = (p) => `<b>${p.route}</b> &middot; ${p.rid}<br><span class="muted small">${p.desc || ""}</span><br>
      Thickness: <b>${p.thick}</b> in &middot; Built: <b>${p.cyr}</b><br>
      IRI: <b>${IPD.fmt(p.iri, 0)}</b> in/mi &middot; PCI: ${p.pci ?? "–"}<br>
      AADT: <b>${IPD.fmt(p.aadt)}</b> &middot; Trucks: ${IPD.fmt(p.trucks)}<br>
      Predicted IRI ${MODEL.base_year + 10}: <b>${IPD.fmt(p.iri10, 0)}</b> in/mi`;
    const segLayer = L.geoJSON(D.segments, {
      style: (f) => ({ color: colorOf(activeLayer, f.properties[activeLayer]), weight: 5, opacity: .9 }),
      onEachFeature: (f, l) => l.bindPopup(popup(f.properties)),
    }).addTo(map);
    const climateLayer = L.layerGroup();
    const legend = L.control({ position: "bottomright" });
    legend.onAdd = () => (legend._div = L.DomUtil.create("div", "legend"));
    legend.addTo(map);

    function drawLegend(k) {
      if (k === "climate") {
        legend._div.innerHTML = `<b>Weather stations</b><br><i class="sq" style="background:#1d9bb5;border-radius:50%"></i>3 nearest stations<br><i class="sq" style="background:#cfd6da;border-radius:50%"></i>other stations`;
        return;
      }
      const L_ = LAYERS[k];
      if (L_.iri) {
        legend._div.innerHTML = `<b>IRI (in/mi)</b><br><i style="background:#2e8b57"></i>Good &lt; 95<br><i style="background:#e0a400"></i>Fair 95–170<br><i style="background:#c0392b"></i>Poor &gt; 170`;
        return;
      }
      const [lo, hi] = range(k);
      const steps = [0, .33, .66, 1].map((t) => L_.log ? Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo))) : lo + t * (hi - lo));
      legend._div.innerHTML = `<b>${L_.name}${L_.unit ? " (" + L_.unit + ")" : ""}</b><br>` +
        steps.map((v) => `<i style="background:${colorOf(k, v)}"></i>${fmtV(k, Math.round(v * 10) / 10)}`).join("<br>");
    }

    // ---------- climate layer: county centroid + all stations, lines to the 3 nearest
    const cen = boundary.getBounds().getCenter();
    const near = county.stns.map((sid) => STATIONS.find((s) => s.sid === sid)).filter(Boolean);
    STATIONS.forEach((s) => {
      const isNear = county.stns.includes(s.sid);
      L.circleMarker([s.lat, s.lon], { radius: isNear ? 9 : 5, color: "#fff", weight: 1.5, fillColor: isNear ? "#1d9bb5" : "#cfd6da", fillOpacity: 1 })
        .bindTooltip(`<b>${s.sid}</b> ${s.sname}<br>${IPD.fmt(s.ft_avg, 1)} freeze-thaw cycles/yr (${s.n_years} yrs)`)
        .addTo(climateLayer);
    });
    near.forEach((s) => L.polyline([[cen.lat, cen.lng], [s.lat, s.lon]], { color: "#1d9bb5", weight: 2, dashArray: "4 4" }).addTo(climateLayer));
    L.circleMarker(cen, { radius: 6, color: "#9b1b30", fillColor: "#9b1b30", fillOpacity: 1 }).bindTooltip("County centroid").addTo(climateLayer);

    // ---------- histogram (inline SVG)
    function histogram(k, bins = 12) {
      const a = vals(k); if (!a.length) return "";
      const [lo, hi] = [Math.min(...a), Math.max(...a)], w = (hi - lo) / bins || 1;
      const counts = Array(bins).fill(0);
      a.forEach((v) => counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++);
      const max = Math.max(...counts), W = 360, H = 150, bw = W / bins;
      const bars = counts.map((c, i) => {
        const h = (c / max) * (H - 20), mid = lo + (i + .5) * w;
        return `<rect x="${i * bw + 1}" y="${H - h}" width="${bw - 2}" height="${h}" rx="2" fill="${colorOf(k, mid)}"><title>${fmtV(k, lo + i * w)}–${fmtV(k, lo + (i + 1) * w)}: ${c}</title></rect>`;
      }).join("");
      return `<div class="hist"><svg viewBox="0 0 ${W} ${H + 18}">${bars}
        <line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="#c9ced2"/>
        <text x="0" y="${H + 14}" font-size="11" fill="#5d676e">${fmtV(k, lo)}</text>
        <text x="${W}" y="${H + 14}" font-size="11" fill="#5d676e" text-anchor="end">${fmtV(k, hi)}</text></svg></div>`;
    }
    function stat(label, v) { return `<div><div class="muted small">${label}</div><b style="font-size:1.2rem">${v}</b></div>`; }

    // ---------- panel content per tab
    const panel = document.getElementById("panel");
    function renderPanel(tab) {
      const T = TABS.find((t) => t.key === tab);
      const layerPicker = T.layers.length > 1
        ? `<select id="layerPick" style="margin:6px 0 14px">${T.layers.map((k) => `<option value="${k}" ${k === activeLayer ? "selected" : ""}>${LAYERS[k].name}</option>`).join("")}</select>` : "";
      if (tab === "construction") {
        panel.innerHTML = `<h3>Construction data</h3>${layerPicker}
          <div class="grid grid-2" style="gap:10px;margin-bottom:12px">${stat("Median thickness", IPD.fmt(median(vals("thick")), 1) + " in")}${stat("Median build year", median(vals("cyr")))}</div>
          ${histogram(activeLayer)}
          <p class="placeholder-note">Thickness (2–10 in) and construction year (1990–2020) are random placeholders until county construction records are uploaded.</p>`;
      } else if (tab === "performance") {
        const cls = { good: 0, fair: 0, poor: 0 };
        vals("iri").forEach((v) => cls[IPD.iriClass(v)]++);
        panel.innerHTML = `<h3>Performance data: IRI</h3>
          <p class="muted small">International Roughness Index from the Iowa DOT pavement management data (2025). Lower is smoother.</p>
          <div class="grid grid-3" style="gap:10px;margin-bottom:12px">
            ${stat('<span class="pill good">Good</span>', cls.good)}${stat('<span class="pill fair">Fair</span>', cls.fair)}${stat('<span class="pill poor">Poor</span>', cls.poor)}</div>
          ${histogram("iri")}
          <p class="muted small">Average PCI: <b>${IPD.fmt(mean(vals("pci")), 0)}</b>. CyRoads data will be added when available.</p>`;
      } else if (tab === "traffic") {
        panel.innerHTML = `<h3>Traffic data</h3>${layerPicker}
          <div class="grid grid-2" style="gap:10px;margin-bottom:12px">${stat("Median AADT", IPD.fmt(median(vals("aadt"))))}${stat("Median trucks/day", IPD.fmt(median(vals("trucks"))))}</div>
          ${histogram(activeLayer)}
          <p class="muted small">Annual average daily traffic on each segment, from the Iowa DOT pavement data.</p>`;
      } else {
        const allYears = [...new Set(near.flatMap((s) => Object.keys(s.years)))].sort();
        const rows = near.map((s) => `<tr><td><b>${s.sid}</b> ${s.sname}</td>${allYears.map((y) => `<td class="num">${s.years[y] ?? "–"}</td>`).join("")}<td class="num"><b>${IPD.fmt(s.ft_avg, 1)}</b></td></tr>`).join("");
        panel.innerHTML = `<h3>Climate data: freeze-thaw cycles</h3>
          <div style="display:flex;align-items:baseline;gap:10px"><span class="big-pred" style="font-size:2.2rem">${IPD.fmt(county.ft, 1)}</span><span class="muted">cycles per year (county average)</span></div>
          <p class="muted small">A freeze-thaw cycle is a day with max temperature above 32&deg;F and min below 32&deg;F. The county value is the mean of the 3 nearest Iowa ASOS weather stations, 2015–2024.</p>
          <div class="table-wrap" style="max-height:none"><table><thead><tr><th>Station</th>${allYears.map((y) => `<th class="num">${String(y).slice(2)}</th>`).join("")}<th class="num">Avg</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      }
      const lp = document.getElementById("layerPick");
      if (lp) lp.onchange = () => { activeLayer = lp.value; restyle(); renderPanel(tab); };
    }
    function restyle() { segLayer.setStyle((f) => ({ color: colorOf(activeLayer, f.properties[activeLayer]) })); drawLegend(activeLayer); }

    // ---------- tabs
    const tabsEl = document.getElementById("tabs");
    tabsEl.innerHTML = TABS.map((t) => `<button class="tab" data-tab="${t.key}"><span class="dot" style="background:${t.color}"></span>${t.label}</button>`).join("");
    function setTab(key) {
      tabsEl.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === key));
      const T = TABS.find((t) => t.key === key);
      if (key === "climate") {
        map.removeLayer(segLayer); climateLayer.addTo(map);
        const b = L.latLngBounds(near.map((s) => [s.lat, s.lon])).extend(boundary.getBounds());
        map.fitBounds(b, { padding: [30, 30] }); drawLegend("climate");
      } else {
        map.removeLayer(climateLayer); segLayer.addTo(map); map.fitBounds(boundary.getBounds(), { padding: [10, 10] });
        if (!T.layers.includes(activeLayer)) activeLayer = T.layers[0];
        restyle();
      }
      renderPanel(key);
    }
    tabsEl.onclick = (e) => { const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab); };
    setTab("construction");

    // ---------- model
    const M = MODEL;
    const predict = (thick, age, aadtK, ft) => M.intercept + M.coef[0] * thick + M.coef[1] * age + M.coef[2] * aadtK + M.coef[3] * ft;
    const predSel = document.getElementById("predYear");
    predSel.innerHTML = `<option value="iri">Measured IRI (${M.base_year})</option>` +
      M.horizons.map((h) => `<option value="iri${h}" ${h === 10 ? "selected" : ""}>Predicted IRI (${M.base_year + h})</option>`).join("");
    const pmap = L.map("predMap", { scrollWheelZoom: false });
    IPD.basemap(pmap);
    L.geoJSON(D.boundary, { style: { color: "#9b1b30", weight: 2, fill: false, dashArray: "6 4" } }).addTo(pmap);
    IPD.fit(pmap, boundary.getBounds());
    let predKey = predSel.value;
    const predLayer = L.geoJSON(D.segments, {
      style: (f) => ({ color: IPD.iriColor(f.properties[predKey]), weight: 5, opacity: .9 }),
      onEachFeature: (f, l) => l.bindTooltip(() => `<b>${f.properties.route}</b><br>Measured ${M.base_year}: ${IPD.fmt(f.properties.iri, 0)}<br>` +
        M.horizons.map((h) => `Predicted ${M.base_year + h}: ${IPD.fmt(f.properties["iri" + h], 0)}`).join("<br>"), { sticky: true }),
    }).addTo(pmap);
    function predSummary() {
      const cls = { good: 0, fair: 0, poor: 0 };
      P.forEach((p) => p[predKey] != null && cls[IPD.iriClass(p[predKey])]++);
      const label = predSel.options[predSel.selectedIndex].text;
      document.getElementById("predSummary").innerHTML = ["good", "fair", "poor"].map((c) =>
        `<div class="kpi"><div class="label"><span class="pill ${c}">${IPD.iriLabel[c]}</span></div><div class="value">${cls[c]}</div><div class="muted small">${label}</div></div>`).join("");
    }
    predSel.onchange = () => { predKey = predSel.value; predLayer.setStyle((f) => ({ color: IPD.iriColor(f.properties[predKey]) })); predSummary(); };
    predSummary();

    const SL = [
      { k: "thick", label: "Surface thickness", unit: "in", min: 2, max: 10, step: 0.5, v: median(vals("thick")) },
      { k: "age", label: "Pavement age", unit: "yr", min: 0, max: 40, step: 1, v: M.base_year - median(vals("cyr")) },
      { k: "aadt", label: "AADT", unit: "veh/day", min: 100, max: 30000, step: 100, v: Math.round(median(vals("aadt")) / 100) * 100 },
      { k: "ft", label: "Freeze-thaw cycles", unit: "/yr", min: 55, max: 105, step: 0.5, v: county.ft },
      { k: "yrs", label: "Years into the future", unit: "yr", min: 0, max: 20, step: 1, v: 10 },
    ];
    document.getElementById("sliders").innerHTML = SL.map((s) => `
      <div class="slider-row"><div class="top"><span>${s.label}</span><b><span id="v_${s.k}"></span> ${s.unit}</b></div>
      <input type="range" id="s_${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.v}"></div>`).join("");
    function calc() {
      const g = (k) => parseFloat(document.getElementById("s_" + k).value);
      SL.forEach((s) => (document.getElementById("v_" + s.k).textContent = IPD.fmt(g(s.k), s.step < 1 ? 1 : 0)));
      const yrs = g("yrs");
      const out = predict(g("thick"), g("age") + yrs, (g("aadt") / 1000) * Math.pow(1 + M.aadt_growth, yrs), g("ft"));
      document.getElementById("predOut").textContent = IPD.fmt(out, 0);
      const c = IPD.iriClass(out);
      document.getElementById("predPill").innerHTML = `<span class="pill ${c}">${IPD.iriLabel[c]}</span>`;
    }
    SL.forEach((s) => (document.getElementById("s_" + s.k).oninput = calc));
    calc();
    const sgn = (v, d = 3) => (v >= 0 ? "+ " : "− ") + Math.abs(v).toFixed(d);
    document.getElementById("equation").innerHTML =
      `IRI = ${M.intercept.toFixed(2)}<br>&nbsp;&nbsp;${sgn(M.coef[0])} &times; thickness (in)<br>&nbsp;&nbsp;${sgn(M.coef[1])} &times; age (yr)<br>&nbsp;&nbsp;${sgn(M.coef[2])} &times; AADT (1000s)<br>&nbsp;&nbsp;${sgn(M.coef[3])} &times; freeze-thaw (/yr)`;
    document.getElementById("modelNote").innerHTML =
      `<b>Dummy model.</b> Fitted on ${IPD.fmt(M.n)} segments statewide: R&sup2; = ${M.r2.toFixed(3)}, RMSE = ${IPD.fmt(M.rmse, 1)} in/mi. Because thickness and age are random placeholders, the model has almost no predictive skill yet. It will be retrained when real construction and treatment data are added.`;

    // ---------- table
    const COLS = [
      ["route", "Route"], ["rid", "Route ID"], ["len", "Length (mi)", 2], ["thick", "Thickness (in)", 1], ["cyr", "Built", -1],
      ["iri", "IRI", 0], ["pci", "PCI", 0], ["aadt", "AADT", 0], ["trucks", "Trucks", 0], [`iri${M.horizons[1]}`, `IRI ${M.base_year + M.horizons[1]}`, 0],
    ];
    let sortK = "iri", sortDir = -1;
    const table = document.getElementById("segTable");
    const idx = P.map((p, i) => i);
    function drawTable() {
      idx.sort((a, b) => { const x = P[a][sortK], y = P[b][sortK]; return (x == null) - (y == null) || (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
      table.innerHTML = `<thead><tr>${COLS.map(([k, l, d]) => `<th data-k="${k}" class="${d !== undefined ? "num" : ""}">${l}${k === sortK ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
        <tbody>${idx.map((i) => `<tr data-i="${i}">${COLS.map(([k, , d]) => {
          const v = P[i][k];
          if (k === "iri" || k.startsWith("iri")) return `<td class="num">${v == null ? "–" : `<span class="pill ${IPD.iriClass(v)}">${IPD.fmt(v, 0)}</span>`}</td>`;
          return `<td class="${d !== undefined ? "num" : ""}">${d === undefined ? (v ?? "–") : d < 0 ? v : IPD.fmt(v, d)}</td>`;
        }).join("")}</tr>`).join("")}</tbody>`;
    }
    table.onclick = (e) => {
      const th = e.target.closest("th");
      if (th) { const k = th.dataset.k; sortDir = k === sortK ? -sortDir : -1; sortK = k; drawTable(); return; }
      const tr = e.target.closest("tr[data-i]");
      if (tr) {
        const i = +tr.dataset.i; let target;
        segLayer.eachLayer((l) => { if (l.feature === feats[i]) target = l; });
        setTab(TABS.find((t) => t.layers.includes(activeLayer))?.key || "performance");
        if (target) { map.fitBounds(target.getBounds(), { maxZoom: 13 }); target.openPopup(); document.getElementById("countyMap").scrollIntoView({ behavior: "smooth", block: "center" }); }
      }
    };
    drawTable();
  }
})();
