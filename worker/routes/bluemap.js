/* ============================================================
   Regnum Aeternum — Worker
   BlueMap proxy routes for the Ballistic Calculator, the Land
   Registry cadastral map and the ComputerCraft live map monitor.

   Both routes always target the Worker's own BLUEMAP_BASE_URL
   environment variable (set in wrangler.jsonc) — never a URL
   supplied by the client — so neither can be used as an open
   proxy. Keep BLUEMAP_BASE_URL in sync with
   regnum-aeternum/ballistics/assets/shells.json's "bluemapBaseUrl"
   and regnum-aeternum/land-registry/assets/mapconfig.json so the
   three agree on which BlueMap is being described.

   getConfig: fetches {base}/settings.json, then each map's
   {base}/maps/{id}/settings.json, and returns a single {maps:[...]}
   payload describing every map (id, name, start position, and
   low-res tile geometry). The map pages try a direct cross-origin
   fetch first; this is the fallback for when that is blocked
   (mixed content or CORS).

   getTile: proxies {base}{path} for the low-res PNG tiles. Used
   when the frontends have "useProxy": true — which is the default
   because the BlueMap host is plain HTTP, so tiles must be fetched
   server-side to avoid mixed-content blocking on the HTTPS site.

   getView: renders the map window around a point as a compact
   palette-indexed bitmap for ComputerCraft monitors. BlueMap only
   publishes low-res tiles as PNG, which a CC computer cannot decode
   inside its memory and CPU budget, so the tiles are decoded here,
   box-averaged down to a small pixel grid and ordered-dithered onto
   VIEW_PALETTE. The response is one hex digit per
   pixel, each digit indexing that palette in ComputerCraft's own
   colour order (0 = the white slot, 15 = the black slot), so the
   client can set it with setPaletteColour(2^i, rgb) and blit the
   digits straight to the monitor. Decoded tiles are cached in the
   isolate; the upstream tiles are cached at the edge.
   ============================================================ */

function bluemapBase(env) {
  return String((env && env.BLUEMAP_BASE_URL) || 'http://regnumaeternum.enderman.cloud:50500').replace(/\/$/, '');
}

function normalizeMap(id, m) {
  const lowres = (m && m.lowres) || {};
  const startPos = Array.isArray(m && m.startPos)
    ? { x: Number(m.startPos[0]) || 0, z: Number(m.startPos[1]) || 0 }
    : { x: 0, z: 0 };
  return {
    id,
    name: (m && m.name) || id,
    startPos,
    tileSize: (Array.isArray(lowres.tileSize) && lowres.tileSize[0]) || 500,
    lodFactor: lowres.lodFactor || 5,
    lodCount: lowres.lodCount || 3,
  };
}

export async function getConfig(request, env) {
  try {
    const base = bluemapBase(env);
    const settingsRes = await fetch(base + '/settings.json', { headers: { Accept: 'application/json' } });
    if (!settingsRes.ok) throw new Error('settings.json unavailable');
    const settings = await settingsRes.json();

    const ids = Array.isArray(settings.maps) ? settings.maps : [];
    const maps = [];
    for (const id of ids) {
      try {
        const r = await fetch(base + '/maps/' + encodeURIComponent(id) + '/settings.json', {
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) continue;
        maps.push(normalizeMap(id, await r.json()));
      } catch (e) { /* skip this map */ }
    }

    return new Response(JSON.stringify({ maps }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'BlueMap configuration unavailable.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── ComputerCraft live map view ───────────────────────────────
// 16 colours is all a ComputerCraft terminal can show at once, and
// the map owns every slot: index 0 sits in CC's white slot and 15 in
// its black slot (so plain write() calls stay legible), with the
// terrain ramp between them. The quantiser below uses all of them.
const VIEW_PALETTE = [
  0xffffff, 0xd8dee6, 0xa6a6a6, 0x6f6f6f,
  0xa88f63, 0x7b5f3f, 0x6b7a3a, 0x506231,
  0x425c38, 0x33412a, 0x26331f, 0x5c7fb0,
  0x3f5a8c, 0x24365e, 0x8c3b2e, 0x000000,
];

const VIEW_PALETTE_HEX = VIEW_PALETTE.map((c) => c.toString(16).padStart(6, '0')).join('');

// Ordered dithering rather than error diffusion: the client re-centres on
// the player every frame, and an error-diffused pattern re-phases on every
// pan (the whole map would shimmer). A fixed threshold matrix moves with
// the terrain instead, so the picture is stable while the player walks.
const VIEW_DITHER = 16;
const VIEW_BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];
const VIEW_PIXEL_LIMIT = 128;    // per axis — monitors never get near this
const VIEW_SAMPLE_LIMIT = 600000; // block samples per request, to bound CPU
const VIEW_TILE_LIMIT = 9;        // 3x3 low-res tiles per window
const TILE_CACHE_LIMIT = 12;
const TILE_CACHE_TTL = 120000;
const PNG_HEX = '0123456789abcdef';

// Decoded tiles live for the life of the isolate: a monitor poll keeps
// asking for the same handful of tiles, and re-inflating them on every
// frame would be the most expensive thing this route does.
const tileCache = new Map();

function viewJson(success, response, status = 200) {
  return new Response(JSON.stringify({ success, response }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function viewNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function viewClamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// BlueMap splits tile coordinates digit by digit into sub-paths, with a
// '-' prefix for negatives: tile (12, -3) -> "x1/2/z-3".
function tilePath(tx, tz) {
  function split(n) {
    let s = '';
    if (n < 0) { n = -n; s = '-'; }
    const digits = String(n);
    for (let i = 0; i < digits.length; i++) s += digits.charAt(i) + '/';
    return s;
  }
  const path = 'x' + split(tx) + 'z' + split(tz);
  return path.substring(0, path.length - 1);
}

// The low-res PNGs are 501 x 2*(tileSize+1): the top half is the colour
// map (1 block = 1 pixel) and the bottom half is height metadata we
// don't need, so only the colour half is unfiltered.
async function decodeTile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) return null;

  const rows = Math.floor(height / 2);
  const stride = width * 4;
  if (width < 2 || rows < 2) return null;

  const parts = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (name === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    else if (name === 'IEND') break;
    offset += 12 + length;
  }
  if (!parts.length) return null;

  // Only the colour half is ever sampled, so stop inflating once those
  // rows are in hand instead of decoding the height half behind them.
  const wanted = rows * (stride + 1);
  let raw;
  try {
    const reader = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const chunks = [];
    let have = 0;
    while (have < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value.length) continue;
      chunks.push(have + value.length > wanted ? value.subarray(0, wanted - have) : value);
      have += value.length;
    }
    try { await reader.cancel(); } catch (err) { /* already closed */ }
    if (have < wanted) return null;
    raw = new Uint8Array(wanted);
    let at = 0;
    for (const chunk of chunks) { raw.set(chunk, at); at += chunk.length; }
  } catch (err) {
    return null;
  }

  const data = new Uint8Array(rows * stride);
  const prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < rows; y++) {
    const filter = raw[pos++];
    const line = data.subarray(y * stride, (y + 1) * stride);
    line.set(raw.subarray(pos, pos + stride));
    pos += stride;

    if (filter === 1) {
      for (let i = 4; i < stride; i++) line[i] = (line[i] + line[i - 4]) & 255;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + ((prev[i] + (i >= 4 ? line[i - 4] : 0)) >> 1)) & 255;
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? line[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
      }
    } else if (filter !== 0) {
      return null;
    }
    prev.set(line);
  }

  return { width, rows, data };
}

async function loadTile(env, map, tx, tz) {
  const key = map + '|' + tx + '|' + tz;
  const cached = tileCache.get(key);
  if (cached && Date.now() - cached.at < TILE_CACHE_TTL) {
    cached.at = Date.now();
    return { ok: true, tile: cached.tile };
  }

  let ok = false;
  let tile = null;
  try {
    const res = await fetch(
      bluemapBase(env) + '/maps/' + encodeURIComponent(map) + '/tiles/1/' + tilePath(tx, tz) + '.png',
      { cf: { cacheTtl: 300, cacheEverything: true } }
    );
    if (res.status === 204 || res.status === 404) {
      ok = true;
    } else if (res.ok) {
      tile = await decodeTile(await res.arrayBuffer());
      ok = !!tile;
    }
  } catch (err) {
    ok = false;
  }

  if (ok) {
    if (tileCache.size >= TILE_CACHE_LIMIT) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of tileCache) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      }
      if (oldestKey) tileCache.delete(oldestKey);
    }
    tileCache.set(key, { at: Date.now(), tile });
  }
  return { ok, tile };
}

function renderWindow(opt) {
  const { grid, nx, tx0, tz0, w, h, left, top, bx, by, marker } = opt;
  const colors = new Float32Array(w * h * 3);
  const cover = new Float32Array(w * h);

  // Resolve which tile and which pixel of it every sample row and column
  // of the window falls on, so the averaging loop below is pure integer
  // indexing instead of per-sample string keyed lookups.
  const cols = w * bx;
  const lines = h * by;
  const colTile = new Int32Array(cols);
  const colX = new Int32Array(cols);
  for (let c = 0; c < cols; c++) {
    const x = left + c;
    const tx = Math.floor(x / 500);
    colTile[c] = tx - tx0;
    colX[c] = x - tx * 500;
  }
  const lineTile = new Int32Array(lines);
  const lineZ = new Int32Array(lines);
  for (let l = 0; l < lines; l++) {
    const z = top + l;
    const tz = Math.floor(z / 500);
    lineTile[l] = (tz - tz0) * nx;
    lineZ[l] = z - tz * 500;
  }

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let r = 0, g = 0, b = 0, alpha = 0, samples = 0;

      for (let sy = 0; sy < by; sy++) {
        const l = j * by + sy;
        const ti = lineTile[l];
        const lz = lineZ[l];
        for (let sx = 0; sx < bx; sx++) {
          const c = i * bx + sx;
          const tile = grid[ti + colTile[c]];
          samples++;
          if (!tile) continue;
          const lx = colX[c];
          if (lx >= tile.width || lz >= tile.rows) continue;
          const o = (lz * tile.width + lx) * 4;
          const a = tile.data[o + 3];
          if (!a) continue;
          r += tile.data[o];
          g += tile.data[o + 1];
          b += tile.data[o + 2];
          alpha += a;
        }
      }

      const k = j * w + i;
      if (!alpha || !samples) continue;
      const weight = alpha / 255;
      colors[k * 3] = r / weight;
      colors[k * 3 + 1] = g / weight;
      colors[k * 3 + 2] = b / weight;
      cover[k] = weight / samples;
    }
  }

  const out = new Uint8Array(w * h);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const c = cover[k];
      if (!c) { out[k] = 15; continue; }

      // Unrendered parts of the map fade to the palette's black slot,
      // which is how BlueMap's own viewer shows them (its void colour).
      // Keyed to the world block so the pattern travels with the terrain,
      // not with the window: panning never re-phases the texture.
      const bias = ((VIEW_BAYER[((top + j * by) & 7) * 8 + ((left + i * bx) & 7)] + 0.5) / 64 - 0.5) * VIEW_DITHER;
      const r = colors[k * 3] * c + bias;
      const g = colors[k * 3 + 1] * c + bias;
      const b = colors[k * 3 + 2] * c + bias;

      let best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < VIEW_PALETTE.length; p++) {
        const rgb = VIEW_PALETTE[p];
        const dr = ((rgb >> 16) & 255) - r;
        const dg = ((rgb >> 8) & 255) - g;
        const db = (rgb & 255) - b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      out[k] = best;
    }
  }

  if (marker) {
    const paint = (i, j, value) => {
      if (i < 0 || j < 0 || i >= w || j >= h) return;
      out[j * w + i] = value;
    };
    const centre = marker.j * w + marker.i;
    // Choose the marker ink from what is underneath it, so the reticle
    // stays visible over both pale builds and dark forest.
    const under = cover[centre]
      ? colors[centre * 3] * 0.299 + colors[centre * 3 + 1] * 0.587 + colors[centre * 3 + 2] * 0.114
      : 0;
    const ink = under > 140 ? 15 : 0;
    const edge = 15 - ink;

    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) === 2) paint(marker.i + di, marker.j + dj, edge);
      }
    }
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) paint(marker.i + di, marker.j + dj, ink);
    }
    if (marker.dir) {
      for (let step = 2; step <= 4; step++) {
        paint(marker.i + marker.dir[0] * step, marker.j + marker.dir[1] * step, ink);
      }
    }
  }

  let pixels = '';
  for (let k = 0; k < out.length; k++) pixels += PNG_HEX.charAt(out[k]);
  return pixels;
}

// Minecraft yaw (0 = south, 90 = west) to an 8-way screen direction,
// where screen x grows east and screen y grows south.
function yawDirection(yaw) {
  const rad = (yaw * Math.PI) / 180;
  const dx = -Math.sin(rad);
  const dz = Math.cos(rad);
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  if (az > ax * 2.414) return [0, dz > 0 ? 1 : -1];
  if (ax > az * 2.414) return [dx > 0 ? 1 : -1, 0];
  return [dx > 0 ? 1 : -1, dz > 0 ? 1 : -1];
}

// GET /api/mapview?map=world&x=0&z=0&w=28&h=36&zoom=2&yaw=90
// w/h are the monitor's pixel grid (one digit per pixel, two pixels per
// character cell). Omitting them returns the palette and metadata only.
export async function getView(request, env) {
  const params = new URL(request.url).searchParams;
  const map = (params.get('map') || 'world').replace(/[^A-Za-z0-9_-]/g, '') || 'world';

  let w = viewClamp(Math.round(viewNumber(params.get('w'), 0)), 0, VIEW_PIXEL_LIMIT);
  let h = viewClamp(Math.round(viewNumber(params.get('h'), 0)), 0, VIEW_PIXEL_LIMIT);
  h -= h % 2;

  let zoom = viewClamp(Math.round(viewNumber(params.get('zoom'), 2)), 1, 8);
  while (zoom > 1 && w * h * (zoom * 4) * (zoom * 3) > VIEW_SAMPLE_LIMIT) zoom--;

  const bx = zoom * 4; // each cell pixel is 6x4.5 screen pixels, so the
  const by = zoom * 3; // world window has to be sampled 4:3 to look square

  if (!w || !h) {
    return viewJson(true, { map, zoom, bx, by, w: 0, h: 0, palette: VIEW_PALETTE_HEX, px: '' });
  }

  const x = viewNumber(params.get('x'), 0);
  const z = viewNumber(params.get('z'), 0);
  const yaw = viewNumber(params.get('yaw'), 0);

  const left = Math.floor(x - (w * bx) / 2);
  const top = Math.floor(z - (h * by) / 2);
  const tx0 = Math.floor(left / 500);
  const tx1 = Math.floor((left + w * bx - 1) / 500);
  const tz0 = Math.floor(top / 500);
  const tz1 = Math.floor((top + h * by - 1) / 500);
  if ((tx1 - tx0 + 1) * (tz1 - tz0 + 1) > VIEW_TILE_LIMIT) {
    return viewJson(false, 'Requested map window is too large.', 400);
  }

  const requested = [];
  for (let tz = tz0; tz <= tz1; tz++) {
    for (let tx = tx0; tx <= tx1; tx++) requested.push([tx, tz]);
  }
  const loaded = await Promise.all(requested.map(([tx, tz]) => loadTile(env, map, tx, tz)));
  if (!loaded.some((entry) => entry.ok)) {
    return viewJson(false, 'BlueMap tiles are unavailable.', 502);
  }

  const nx = tx1 - tx0 + 1;
  const grid = new Array(nx * (tz1 - tz0 + 1)).fill(null);
  requested.forEach(([tx, tz], index) => {
    if (loaded[index].ok && loaded[index].tile) grid[(tz - tz0) * nx + (tx - tx0)] = loaded[index].tile;
  });

  const i = Math.round((x - left) / bx - 0.5);
  const j = Math.round((z - top) / by - 0.5);
  const px = renderWindow({
    grid, nx, tx0, tz0,
    w, h, left, top, bx, by,
    marker: i >= 0 && j >= 0 && i < w && j < h ? { i, j, dir: yawDirection(yaw) } : null,
  });

  return viewJson(true, {
    map, zoom, bx, by, w, h,
    x, z,
    left, top,
    palette: VIEW_PALETTE_HEX,
    px,
  });
}

export async function getTile(request, env) {
  const url = new URL(request.url);
  const tilePath = url.searchParams.get('path');
  if (!tilePath || !tilePath.startsWith('/maps/')) {
    return new Response('Invalid tile path', { status: 400 });
  }
  try {
    const upstream = await fetch(bluemapBase(env) + tilePath);
    // BlueMap returns 204/404 for empty or unrendered tiles — pass that
    // through so the client renders them as blank rather than an error.
    if (upstream.status === 204 || upstream.status === 404) {
      return new Response(null, { status: upstream.status });
    }
    if (!upstream.ok || !upstream.body) {
      return new Response('Tile unavailable', { status: 502 });
    }
    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'image/png');
    headers.set('Cache-Control', 'public, max-age=60');
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return new Response('Tile unavailable', { status: 502 });
  }
}
