/* ============================================================
   REGNUM AETERNUM — BlueMap basemap for the site's Leaflet maps

   The Ballistic Calculator's live map and the Land Registry's
   cadastral map both draw the same BlueMap tiles over an
   L.CRS.Simple plane, so the tile plumbing lives here once instead
   of being copied into each page (where the two copies drifted).

   ── Why this file exists ─────────────────────────────────────

   BlueMap publishes its top-down map as a pyramid of "low-res"
   tiles: /maps/{id}/tiles/{lod}/x{digits}/z{digits}.png. Every tile
   is the same picture size (tileSize+1 by 2×(tileSize+1) pixels —
   the top half is colour, the bottom half is height/light
   metadata), but each level up the pyramid covers
   lodFactor× more ground:

     lod 1 → tileSize blocks a tile (1 block = 1 pixel)
     lod 2 → tileSize × lodFactor        (5 blocks = 1 pixel)
     lod 3 → tileSize × lodFactor²       (25 blocks = 1 pixel)

   With the stock 500 / 5 that is 500, 2 500 and 12 500 blocks.

   Leaflet's GridLayer asks for every tile that touches the
   viewport *in tile-space*, so the number of PNGs it wants is

     (viewport_px / (tileSize × 2^(zoom − nativeZoom(lod))))²

   — i.e. it explodes whenever the zoom level a person is looking
   at sits far below the level of detail being requested. Pinning
   every zoom to lod 1 meant a zoomed-out view asked for tens of
   thousands of PNGs at once; the browser finished a few, the rest
   sat queued, and the map looked like a black rectangle until you
   zoomed back in and the request count collapsed. That is the
   "have to zoom in for the map to appear" behaviour.

   Two things fix it, and both live here:

   1. Ask each zoom level for the level of detail that lands a tile
      at a sane size on screen (MIN_TILE_PX…MAX_TILE_PX). Because
      the levels are spaced lodFactor apart, that band tiles the
      zoom axis almost exactly, so every zoom asks for a handful of
      tiles — sharp where it can be, coarse where it must be.

   2. Clamp minZoom to the coarsest level that exists, instead of
      letting someone scroll out past the pyramid, where the only
      way to fill the screen is a request storm. Zooming all the
      way out now shows a filled map.

   ── Public API (plain script; both pages load it before their own) ──

     RABlueMap.limits(geometry)          → { minZoom, maxZoom, coarsest }
     RABlueMap.lodForZoom(zoom, geometry) → which lod a zoom should use
     RABlueMap.tileUrl(opts)              → one tile's URL
     RABlueMap.probeLodCount({...})       → which lods the server really has
     RABlueMap.attach(map, L, {...})      → keeps the right lod on screen

   `geometry` is { tileSize, lodFactor, lodCount }, `source` is
   { mapId, baseUrl, useProxy }.
   ============================================================ */

(function (global) {
  'use strict';

  /* ── Level-of-detail geometry ─────────────────────────────── */

  function clampNumber(value, fallback, lo, hi) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) n = fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function geometry(raw) {
    var g = raw || {};
    return {
      tileSize: clampNumber(g.tileSize, 500, 16, 4096),
      lodFactor: clampNumber(g.lodFactor, 5, 2, 16),
      // Never invent levels: if the config doesn't say the server
      // publishes lod 2/3, ask for them only if the probe below
      // proves they exist. A missing level means blank tiles, and
      // blank tiles are the exact failure this file exists to stop.
      lodCount: Math.round(clampNumber(g.lodCount, 1, 1, 8)),
    };
  }

  function blocksPerTile(tileSize, lodFactor, lod) {
    return tileSize * Math.pow(lodFactor, Math.max(1, lod) - 1);
  }

  // The zoom at which one tile of this lod is exactly tileSize
  // screen pixels. Leaflet derives a layer's whole tile grid from
  // this, so a layer is only ever asked for the tiles that are
  // actually on screen when its native zoom matches the zoom being
  // viewed.
  function nativeZoom(tileSize, lodFactor, lod) {
    return Math.log2(tileSize / blocksPerTile(tileSize, lodFactor, lod));
  }

  // A tile stretched past MAX_TILE_PX is blurry and we are paying
  // for pixels nobody can resolve; a tile squeezed under MIN_TILE_PX
  // is the request storm described above. Between the two is the
  // band where a level of detail is worth using.
  var MAX_TILE_PX = 1800;
  var MIN_TILE_PX = 400;

  function tileScreenPx(tileSize, lodFactor, lod, zoom) {
    return tileSize * Math.pow(2, zoom - nativeZoom(tileSize, lodFactor, lod));
  }

  // The coarsest level whose tile still fits inside MAX_TILE_PX at
  // this zoom — coarsest because fewer, larger tiles is always the
  // cheaper ask, and the band above keeps "larger" from meaning
  // "unreadable".
  function lodForZoom(zoom, raw) {
    var g = geometry(raw);
    for (var lod = g.lodCount; lod > 1; lod--) {
      if (tileScreenPx(g.tileSize, g.lodFactor, lod, zoom) <= MAX_TILE_PX) return lod;
    }
    return 1;
  }

  // The zoom range that every level in the band can cover. maxZoom
  // is where lod 1 would be stretched past MAX_TILE_PX (past that,
  // zooming in adds pixels, not detail); minZoom is where the
  // coarsest available level would be squeezed under MIN_TILE_PX.
  function limits(raw, maxZoomCap) {
    var g = geometry(raw);
    var coarsest = g.lodCount;
    var min = nativeZoom(g.tileSize, g.lodFactor, coarsest) + Math.log2(MIN_TILE_PX / g.tileSize);
    var max = nativeZoom(g.tileSize, g.lodFactor, 1) + Math.log2(MAX_TILE_PX / g.tileSize);
    if (isFinite(maxZoomCap)) max = Math.min(max, maxZoomCap);
    return { minZoom: Math.round(min * 100) / 100, maxZoom: Math.round(max * 100) / 100, coarsest: coarsest };
  }

  /* ── Tile URLs ────────────────────────────────────────────── */

  // BlueMap splits tile coordinates digit by digit into a sub-path,
  // with a '-' prefix for negatives: tile (12, -3) → "x1/2/z-3".
  function splitDigits(n) {
    var s = '';
    if (n < 0) { n = -n; s = '-'; }
    var digits = String(n);
    for (var i = 0; i < digits.length; i++) s += digits.charAt(i) + '/';
    return s;
  }

  function tilePath(tx, tz) {
    var t = 'x' + splitDigits(tx) + 'z' + splitDigits(tz);
    return t.substring(0, t.length - 1);
  }

  // `useProxy` sends the request through our own Worker (/api/maptile)
  // because the BlueMap host is plain HTTP and the site is HTTPS —
  // a direct tile fetch would be blocked as mixed content.
  function tileUrl(opts) {
    var o = opts || {};
    var path = '/maps/' + encodeURIComponent(o.mapId) + '/tiles/' + Math.max(1, Math.round(o.lod))
      + '/' + tilePath(o.x, o.z) + '.png';
    if (o.useProxy) return '/api/maptile?path=' + encodeURIComponent(path);
    return String(o.baseUrl || '').replace(/\/$/, '') + path;
  }

  // Which tile of which lod holds a block coordinate, assuming the
  // pyramid is anchored at the origin (BlueMap's default; the maps
  // this site draws are all anchored there).
  function tileIndex(block, blocks) {
    return Math.floor(block / blocks);
  }

  /* ── Lod availability ─────────────────────────────────────── */

  // Configuration says how many levels the server *intends* to
  // publish; reality can differ (a smaller lodCount, or an older
  // BlueMap). Asking for a level that isn't there is worse than not
  // using it — every tile of it comes back blank, which is the black
  // rectangle again — so the level the map is allowed to zoom out to
  // is checked once at boot with one small request per level.
  //
  // The check is deliberately conservative: it only ever *lowers*
  // the count. If the probe itself fails, the area at `at` was never
  // rendered (BlueMap has no lod-1 tile there either, so nothing can
  // be concluded), or the map's config says there is only one level
  // anyway, the configured count stands.
  function probeLodCount(opts) {
    var o = opts || {};
    var g = geometry(o.geometry);
    var src = o.source || {};
    var at = o.at || { x: 0, z: 0 };
    var timeout = isFinite(o.timeoutMs) ? o.timeoutMs : 4000;

    if (g.lodCount <= 1) return Promise.resolve(1);

    var lods = [];
    for (var lod = 1; lod <= g.lodCount; lod++) lods.push(lod);

    function withTimeout(promise) {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, timeout);
        promise.then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        });
      });
    }

    var probes = lods.map(function (lod) {
      var blocks = blocksPerTile(g.tileSize, g.lodFactor, lod);
      var url = tileUrl({
        mapId: src.mapId, baseUrl: src.baseUrl, useProxy: src.useProxy,
        lod: lod, x: tileIndex(at.x, blocks), z: tileIndex(at.z, blocks),
      });
      return withTimeout(fetch(url, { credentials: 'omit' })
        .then(function (res) { return res.status; }, function () { return null; }));
    });

    return Promise.all(probes).then(function (statuses) {
      // No answer for lod 1 at all → nothing was proven, keep the config.
      if (statuses[0] !== 200) return g.lodCount;
      var deepest = 1;
      for (var i = 1; i < statuses.length; i++) {
        if (statuses[i] === 200) deepest = lods[i];
        else if (statuses[i] === 404) break; // this level and every one above it is missing
        else break;                          // 204 / no answer — cannot tell, stop guessing
      }
      return deepest;
    });
  }

  /* ── The Leaflet layer ────────────────────────────────────── */

  function makeLayer(L, lod, geom, getSource) {
    var native = nativeZoom(geom.tileSize, geom.lodFactor, lod);

    var Layer = L.GridLayer.extend({
      options: {
        tileSize: geom.tileSize,
        // Keep a tile's worth of margin so a short pan reuses what is
        // already decoded instead of asking for it again.
        keepBuffer: 1,
        updateWhenIdle: false,
        attribution: 'Map data: BlueMap',

        // Leaflet's GridLayer defaults to minZoom: 0, and its tiling maths
        // silently *drops* any view whose whole zoom round is below that —
        // no tiles, no requests, no error, just an empty pane. Every zoom
        // this site's maps use to look at a world is negative, so that
        // default was why a zoomed-out map was black and only appeared
        // again once you zoomed back in. There is no floor for a tile
        // layer here: how far out is *allowed* is the map's minZoom, which
        // the ladder sets, and this must never be narrower than that.
        minZoom: -Infinity,
      },

      createTile: function (coords, done) {
        var size = this.getTileSize().x;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        var source = getSource();
        var img = new Image();
        img.onload = function () {
          // BlueMap low-res tiles are (tileSize+1) wide and
          // 2×(tileSize+1) tall: the top half is the colour map, the
          // bottom half is height/light metadata. Crop the colour half
          // so it renders 1 block = 1 pixel.
          var ctx = canvas.getContext('2d');
          var sw = Math.min(img.naturalWidth, size);
          var sh = Math.min(Math.floor(img.naturalHeight / 2), size);
          ctx.drawImage(img, 0, 0, sw, sh, 0, 0, size, size);
          done(null, true);
        };
        // Unrendered tiles come back 204/404 — leave them blank rather
        // than reporting an error, which Leaflet would surface as a
        // broken-tile flash on perfectly normal void.
        img.onerror = function () { done(null, true); };
        img.src = tileUrl({
          mapId: source.mapId, baseUrl: source.baseUrl, useProxy: source.useProxy,
          lod: lod, x: coords.x, z: coords.y,
        });
        return canvas;
      },
    });

    return new Layer({ minNativeZoom: native, maxNativeZoom: native });
  }

  // Keeps exactly one level of detail on the map, swapping as the zoom
  // crosses between bands. The incoming level is added *before* the
  // outgoing one is retired, so a swap never flashes an empty map;
  // tiles that arrive late are simply drawn over the old ones.
  function attach(map, L, opts) {
    var o = opts || {};
    var getGeometry = o.geometry || function () { return {}; };
    var getSource = o.source || function () { return {}; };
    var layers = {};
    var active = null;

    function layerFor(lod, geom) {
      if (!layers[lod]) layers[lod] = makeLayer(L, lod, geom, getSource);
      return layers[lod];
    }

    function drop(key) {
      var layer = layers[key];
      if (!layer) return;
      if (map.hasLayer(layer)) map.removeLayer(layer);
      delete layers[key];
    }

    function apply() {
      var geom = geometry(getGeometry());
      var want = lodForZoom(map.getZoom(), geom);
      if (want === active && layers[want]) return;

      var next = layerFor(want, geom);
      var previous = active === null ? null : layers[active];
      var retired = false;
      function retire() {
        if (retired) return;
        retired = true;
        // Unless the zoom has already come back to this level, in
        // which case `previous` is the level on screen again.
        if (previous && previous !== layers[active] && map.hasLayer(previous)) map.removeLayer(previous);
      }
      next.once('load', retire);
      next.addTo(map);
      active = want;
      if (previous) setTimeout(retire, 2500);
    }


    // Geometry or map changed: every cached level now points at the
    // wrong tiles (URLs embed the map id, and native zooms move with
    // the tile size), so drop them and start the new source clean.
    function refresh() {
      Object.keys(layers).forEach(function (key) { drop(key); });
      active = null;
      if (typeof o.onLimits === 'function') o.onLimits(limits(getGeometry(), o.maxZoomCap));
      apply();
    }

    if (typeof o.onLimits === 'function') o.onLimits(limits(getGeometry(), o.maxZoomCap));
    apply();

    return {
      apply: apply,
      refresh: refresh,
      activeLod: function () { return active; },
      layer: function (lod) { return layers[lod] || null; },
    };
  }

  global.RABlueMap = {
    blocksPerTile: blocksPerTile,
    nativeZoom: nativeZoom,
    lodForZoom: lodForZoom,
    limits: limits,
    tileScreenPx: tileScreenPx,
    tilePath: tilePath,
    tileUrl: tileUrl,
    probeLodCount: probeLodCount,
    attach: attach,
    MAX_TILE_PX: MAX_TILE_PX,
    MIN_TILE_PX: MIN_TILE_PX,
  };
})(window);
