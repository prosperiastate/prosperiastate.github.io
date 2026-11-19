/*
 * cog-layers.js
 * Shows Cloud Optimized GeoTIFFs (COGs) from the S3 bucket as Leaflet layers.
 * Needs: Leaflet 1.9, proj4, georaster, georaster-layer-for-leaflet (load them first).
 *
 * Each layer is only opened when it is switched on, so the page does not touch
 * every multi-GB file at load time. The browser reads just the tiles it needs
 * through HTTP range requests.
 */
(function () {
  // Where the COGs live. Override for testing with  ?cog_base=http://localhost:8001/
  var DEFAULT_BASE = 'https://drone-cogs-sourav.s3.us-east-2.amazonaws.com/';
  var params = new URLSearchParams(window.location.search);
  var COG_BASE = params.get('cog_base') || DEFAULT_BASE;
  if (COG_BASE.slice(-1) !== '/') COG_BASE += '/';

  // NAD83(2011) / UTM 15N is used by most of the drone products.
  if (window.proj4) {
    proj4.defs('EPSG:6344', '+proj=utm +zone=15 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
    proj4.defs('EPSG:26915', '+proj=utm +zone=15 +datum=NAD83 +units=m +no_defs');
  }

  function cogUrl(key) {
    return COG_BASE + key.split('/').map(encodeURIComponent).join('/');
  }

  // ---------- colour helpers ----------
  // Elevation ramp (blue-green-yellow-brown-white)
  var DEM_RAMP = [
    [0.00, [ 43,  98, 160]],
    [0.20, [ 72, 168, 140]],
    [0.40, [150, 205, 110]],
    [0.60, [240, 225, 120]],
    [0.80, [190, 120,  70]],
    [1.00, [250, 250, 250]]
  ];
  // Thermal ramp (black-purple-red-yellow-white)
  var HEAT_RAMP = [
    [0.00, [  0,   0,   4]],
    [0.25, [ 87,  16, 110]],
    [0.50, [188,  55,  84]],
    [0.75, [249, 142,   9]],
    [1.00, [252, 255, 164]]
  ];

  function rampColor(ramp, t) {
    if (t <= 0) return ramp[0][1];
    if (t >= 1) return ramp[ramp.length - 1][1];
    for (var i = 1; i < ramp.length; i++) {
      if (t <= ramp[i][0]) {
        var a = ramp[i - 1], b = ramp[i];
        var f = (t - a[0]) / (b[0] - a[0]);
        return [
          Math.round(a[1][0] + f * (b[1][0] - a[1][0])),
          Math.round(a[1][1] + f * (b[1][1] - a[1][1])),
          Math.round(a[1][2] + f * (b[1][2] - a[1][2]))
        ];
      }
    }
  }

  function rampCss(ramp) {
    return 'linear-gradient(to right, ' + ramp.map(function (s) {
      return 'rgb(' + s[1].join(',') + ') ' + Math.round(s[0] * 100) + '%';
    }).join(', ') + ')';
  }

  // ---------- pixel renderers, one per kind of COG ----------
  function makeColorFn(def) {
    var kind = def.kind;
    if (kind === 'rgba') {          // 4-band Byte, band 4 = alpha
      return function (v) {
        if (v[3] === 0) return null;
        return 'rgb(' + v[0] + ',' + v[1] + ',' + v[2] + ')';
      };
    }
    if (kind === 'rgb') {           // 3-band Byte, black = outside
      return function (v) {
        if (v[0] === 0 && v[1] === 0 && v[2] === 0) return null;
        return 'rgb(' + v[0] + ',' + v[1] + ',' + v[2] + ')';
      };
    }
    if (kind === 'hillshade') {     // 1-band Byte, 255 = nodata
      return function (v) {
        var g = v[0];
        if (g === 255 || g === undefined || g === null) return null;
        return 'rgb(' + g + ',' + g + ',' + g + ')';
      };
    }
    if (kind === 'dem' || kind === 'thermal') {
      var lo = def.min, hi = def.max, span = (hi - lo) || 1;
      var ramp = kind === 'dem' ? DEM_RAMP : HEAT_RAMP;
      var nd = def.nodata;
      var maskBand = def.maskBand;   // optional 0-based band holding a 0/1 mask
      return function (v) {
        var x = v[0];
        if (x === undefined || x === null || isNaN(x)) return null;
        if (nd !== undefined && x === nd) return null;
        if (x < -10000) return null;
        if (maskBand !== undefined && !v[maskBand]) return null;
        var c = rampColor(ramp, (x - lo) / span);
        return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      };
    }
    throw new Error('Unknown COG kind: ' + kind);
  }

  // ---------- legend for DEM / thermal layers ----------
  var legendCtl = null;
  var activeLegends = [];
  function refreshLegend(map) {
    if (!legendCtl) {
      legendCtl = L.control({ position: 'bottomright' });
      legendCtl.onAdd = function () {
        this._div = L.DomUtil.create('div', 'ctl cog-legend');
        return this._div;
      };
      legendCtl.addTo(map);
    }
    var div = legendCtl._div;
    if (!activeLegends.length) { div.style.display = 'none'; div.innerHTML = ''; return; }
    div.style.display = 'block';
    div.innerHTML = activeLegends.map(function (d) {
      var ramp = d.kind === 'dem' ? DEM_RAMP : HEAT_RAMP;
      var unit = d.unit || (d.kind === 'dem' ? 'm' : '°C');
      return '<div class="cog-legend-item"><div class="cog-legend-title">' + d.label + '</div>' +
        '<div class="cog-legend-bar" style="background:' + rampCss(ramp) + '"></div>' +
        '<div class="cog-legend-scale"><span>' + d.min.toFixed(1) + ' ' + unit + '</span><span>' +
        d.max.toFixed(1) + ' ' + unit + '</span></div></div>';
    }).join('');
  }

  // ---------- status message (loading / errors) ----------
  var statusCtl = null;
  var pending = {};
  function setStatus(map, id, msg, isError) {
    if (!statusCtl) {
      statusCtl = L.control({ position: 'topleft' });
      statusCtl.onAdd = function () {
        this._div = L.DomUtil.create('div', 'ctl cog-status');
        return this._div;
      };
      statusCtl.addTo(map);
    }
    if (msg) pending[id] = { msg: msg, err: !!isError }; else delete pending[id];
    var keys = Object.keys(pending);
    var div = statusCtl._div;
    div.style.display = keys.length ? 'block' : 'none';
    div.innerHTML = keys.map(function (k) {
      return '<div class="' + (pending[k].err ? 'cog-err' : '') + '">' + pending[k].msg + '</div>';
    }).join('');
  }

  // ---------- the layer ----------
  var georasterCache = {};

  L.cogLayer = function (def) { return new L.CogLayer(def); };

  L.CogLayer = L.Layer.extend({
    initialize: function (def) {
      this.def = def;
      this._inner = null;
      this._active = false;
    },

    getBounds: function () {
      return L.latLngBounds(this.def.bounds);
    },

    onAdd: function (map) {
      var self = this, def = this.def;
      this._active = true;
      if (def.kind === 'dem' || def.kind === 'thermal') {
        activeLegends.push(def);
        refreshLegend(map);
      }
      if (this._inner) { map.addLayer(this._inner); return; }
      setStatus(map, def.key, 'Loading ' + def.label + '…');
      if (this._loading) return;   // already opening; it will be shown when ready
      this._loading = true;
      var url = cogUrl(def.key);
      var p = georasterCache[url] || (georasterCache[url] = Promise.race([
        parseGeoraster(url),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('timed out reading the file header')); }, 45000);
        })
      ]));
      p.then(function (georaster) {
        self._loading = false;
        // Some files store a custom CRS without an EPSG code; use the known equivalent.
        if (def.epsg) georaster.projection = def.epsg;
        self._inner = new GeoRasterLayer({
          georaster: georaster,
          pixelValuesToColorFn: makeColorFn(def),
          resolution: def.resolution || 256,
          opacity: def.opacity === undefined ? 1 : def.opacity,
          keepBuffer: 4,
          updateWhenIdle: true,
          zIndex: 10
        });
        setStatus(map, def.key, null);
        if (self._active && self._map) self._map.addLayer(self._inner);
      }).catch(function (err) {
        self._loading = false;
        delete georasterCache[url];
        console.error('COG failed:', url, err);
        setStatus(map, def.key, 'Could not load ' + def.label + ' (see browser console)', true);
        setTimeout(function () { setStatus(map, def.key, null); }, 8000);
      });
    },

    onRemove: function (map) {
      this._active = false;
      var i = activeLegends.indexOf(this.def);
      if (i >= 0) { activeLegends.splice(i, 1); refreshLegend(map); }
      setStatus(map, this.def.key, null);
      if (this._inner) map.removeLayer(this._inner);
    }
  });

  // Zoom to a site's area when an overlay from a different site is switched on.
  L.cogLayer.fitOnSwitch = function (map, layers, initialSite) {
    var siteBounds = {};
    layers.forEach(function (l) {
      var s = l.def.site;
      siteBounds[s] = siteBounds[s] ? siteBounds[s].extend(l.getBounds()) : L.latLngBounds(l.def.bounds);
    });
    var current = initialSite;
    map.on('overlayadd', function (e) {
      var d = e.layer && e.layer.def;
      if (d && d.site !== current) {
        map.fitBounds(siteBounds[d.site]);
        current = d.site;
      }
    });
    return siteBounds;
  };
  L.cogLayer.base = COG_BASE;
  L.cogLayer.url = cogUrl;
})();
