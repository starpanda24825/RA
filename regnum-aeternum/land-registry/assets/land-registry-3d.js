/* ============================================================
   REGNUM AETERNUM — Land Registry cadastral 3D view

   Registered land is three-dimensional: a claim is a footprint
   between two heights, two claims can share the same footprint at
   different heights, and a claim can sit above or below the
   surface. The 2D map can only ever draw one of a stack, so the
   authoritative view is this one, and it is what the page opens
   on.

   Each claim is drawn as the axis-aligned box its four corners
   describe, extruded from Y Lower to Y Upper — boxes rather than
   the true quadrilateral because a box cannot be misread: it is
   obvious which volume is which, even when four claims occupy the
   same plot of ground at four heights (which is exactly the case
   the 2D view cannot show).

   ── The ground ────────────────────────────────────────────────

   Underneath them the BlueMap basemap is laid over the world as a
   *field* of ground quads: one flat quad per BlueMap low-res tile,
   drawn at whichever level of detail keeps the field within a fixed
   tile budget for the area the camera can actually see.

   That field is the whole reason this module is more than a plane.
   The first version drew a single quad carrying one stitched image,
   sized from the claims' own extent — which meant the ground was
   exactly as big as the register and zooming out shrank it into a
   black void. Filling that void with a world-sized image is not an
   option either: at the finest level of detail a world is thousands
   of tiles, and a renderer that asks for thousands of anything
   shows nothing at all.

   So the ground follows the same ladder the 2D map uses (see
   ../../assets/bluemap-layer.js): every level of detail covers
   lodFactor× more ground per tile, so the level the camera needs is
   the finest one whose tile count for the visible footprint stays
   inside GROUND_TILE_LIMIT. Zoomed in on a claim that is a handful
   of tiles at full resolution; zoomed out to the whole world, a
   handful of large coarse ones. The level only changes when the
   current one no longer fits (and only sharpens again when the
   finer one is comfortably inside budget), so a wheel held at a
   boundary cannot make it flip back and forth.

   The field also makes the plane's height honest: it is measured
   once from the height half of the tiles BlueMap publishes for the
   claims themselves, so the ground sits where the terrain actually
   is rather than at a guess.

   Everything here is in raw world blocks (1 three.js unit = 1
   block, +X east, +Z south, +Y up), matching the 2D map's
   coordinates so the two views cannot disagree about where a plot
   is.
   ============================================================ */

// Resolved by the import map on the page that loads this module (see
// land-registry/map/index.html): Three.js's addons import the bare specifier
// "three", so a bare-specifier map is the only way to load them without a
// bundler. Importing these two URLs directly cannot resolve, and a module
// that cannot resolve *any* import does not run at all — so the cadastral
// map had no map of either kind.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GROUND_TEX_PX = 512;        // most pixels one ground tile's texture may use
const GROUND_TILE_LIMIT = 64;     // most ground tiles on the field at once
const GROUND_LOADS = 6;           // tile fetches in flight at once
// Decoded tile images kept for reuse. A BlueMap tile decodes to about 2 MB, so
// this is the field's working set plus a little: enough that a level of detail
// which was just replaced is free to come back, and not so much that the tab
// is holding a box of tiles it is never going to draw again.
const GROUND_IMAGE_CACHE = 48;
const GROUND_PAD = 1.1;           // visible ground is padded by this much
const GROUND_UPDATE_MS = 120;     // how often the field may be re-reconciled
const GROUND_PLACEHOLDER = 0x252a26; // an untextured quad's colour
const PROBE_TILE_LIMIT = 4;       // tiles the one-off height measurement may read
const PROBE_TILE_CEILING = 16;    // ...or before it gives up and samples one
const HEIGHT_SAMPLES = 7;         // grid of height probes per tile side
const FALLBACK_SURFACE_DROP = 8;  // plane sits this far under the lowest claim
const MIN_RADIUS = 12;            // so a single small plot still frames well
const CLICK_SLOP = 5;             // px of drag that is still a click
const CLICK_MS = 450;             // and how long a click may take

export function createPlotViewer(container, opts) {
  const options = opts || {};
  const onPick = typeof options.onPick === 'function' ? options.onPick : function () {};
  const colorFor = typeof options.colorFor === 'function' ? options.colorFor : function () { return 0x45b3bc; };
  const tileUrlFor = typeof options.tileUrl === 'function' ? options.tileUrl : null;
  const blocksPerTile = typeof options.blocksPerTile === 'function' ? options.blocksPerTile : function () { return 500; };
  // How many levels of detail the host publishes. The ground's tile budget is
  // measured in these, so a new BlueMap source can change it at runtime.
  let lodCount = Math.max(1, Math.round(options.lodCount || 1));

  /* ── scene, camera, renderer ─────────────────────────────── */

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  // A lost context draws nothing at all from then on, which reads as "the map
  // is broken" with nothing on the page to say why; the flags below are how
  // the diagnostic handle on the container reports it.
  let contextLost = 0;
  let contextRestored = 0;
  renderer.domElement.addEventListener('webglcontextlost', function (ev) {
    ev.preventDefault();
    contextLost++;
  });
  renderer.domElement.addEventListener('webglcontextrestored', function () { contextRestored++; });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121113);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 250000);

  scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x2a2930, 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(1, 1.6, 0.7);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  // Never orbit under the ground: the underside of the ground field is just a
  // blank sheet, and it hides every claim above it.
  controls.maxPolarAngle = Math.PI * 0.495;

  const boxesGroup = new THREE.Group();
  const groundGroup = new THREE.Group();
  const gridGroup = new THREE.Group();
  scene.add(boxesGroup, groundGroup, gridGroup);

  /* ── state ───────────────────────────────────────────────── */

  let plots = [];
  let pickable = [];
  let selected = null;
  let bounds = null;
  let active = false;
  let framedOnce = false;
  let tween = null;
  let hoverRaf = 0;
  let pointerDown = null;
  let disposed = false;

  // The reference plane's world height. Null until it is measured, and then
  // refined from the tiles the host publishes for the claims themselves.
  let groundY = null;
  let groundMeasured = false;
  let surfaceVisible = true;

  // The ground field. `lod` is the level of detail currently on the ground and
  // `key` the tile range it covers, so a reconcile that changes neither is a
  // no-op and cannot rebuild anything mid-frame.
  const field = { lod: 0, key: '', bounds: null, tiles: new Map() };
  let lastGroundAt = 0;
  let refHadGround = null;

  const imgCache = new Map();     // tile key -> { img, at }
  const imgPending = new Map();   // tile key -> Promise<HTMLImageElement|null>
  const loadQueue = [];
  let activeLoads = 0;

  /* ── small helpers ───────────────────────────────────────── */

  function disposeTree(node) {
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      disposeTree(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(function (m) {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
      node.remove(child);
    }
  }

  // The 2D view draws each claim as the quadrilateral its corners
  // describe; the 3D view draws the box that quad is bound by, so the
  // corner order never matters here.
  function plotBBox(plot) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    (plot.corners || []).forEach(function (c) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
    });
    if (!isFinite(minX)) { minX = maxX = 0; minZ = maxZ = 0; }
    return { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ };
  }

  function measure(list) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    list.forEach(function (p) {
      const b = plotBBox(p);
      minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
      minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ);
      minY = Math.min(minY, p.yLower); maxY = Math.max(maxY, p.yUpper);
    });
    if (!isFinite(minX)) return null;
    const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
    const spanY = Math.max(1, maxY - minY);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    return {
      minX, maxX, minZ, maxZ, minY, maxY, spanX, spanZ, spanY, cx, cy, cz,
      radius: Math.max(MIN_RADIUS, 0.5 * Math.sqrt(spanX * spanX + spanZ * spanZ + spanY * spanY)),
    };
  }

  function planeY() {
    return groundY == null
      ? (bounds ? bounds.minY - FALLBACK_SURFACE_DROP : 0)
      : groundY;
  }

  /* ── camera framing ──────────────────────────────────────── */

  // Distance at which a sphere of `radius` fills the frame with a
  // little margin, whichever way the viewport is shaped.
  function distanceFor(radius) {
    const fov = (camera.fov * Math.PI) / 180;
    const vertical = radius / Math.sin(fov / 2);
    const horizontal = camera.aspect >= 1
      ? vertical
      : radius / Math.sin(Math.atan(Math.tan(fov / 2) * camera.aspect));
    return horizontal * 1.15;
  }

  function viewFor(centre, radius) {
    const dist = distanceFor(radius);
    return {
      target: new THREE.Vector3(centre.x, centre.y, centre.z),
      // South-east and above: the same way up as the 2D map, so north stays
      // away from the viewer in both.
      position: new THREE.Vector3(
        centre.x + dist * 0.62,
        centre.y + dist * 0.66,
        centre.z + dist * 0.62
      ),
      min: Math.max(6, radius * 0.35),
      // Far enough out to take in the whole ground field, and no further: the
      // field is what the camera is here to look at.
      max: Math.max(60, radius * 24),
    };
  }

  function applyView(view, immediate) {
    controls.minDistance = view.min;
    controls.maxDistance = view.max;
    if (immediate) {
      camera.position.copy(view.position);
      controls.target.copy(view.target);
      controls.update();
      tween = null;
      return;
    }
    tween = {
      fromPos: camera.position.clone(),
      toPos: view.position.clone(),
      fromTarget: controls.target.clone(),
      toTarget: view.target.clone(),
      start: performance.now(),
      duration: 420,
    };
  }

  function frameAll(immediate) {
    const b = bounds || measure(plots);
    if (!b) return;
    applyView(viewFor({ x: b.cx, y: b.cy, z: b.cz }, b.radius), immediate !== false);
  }

  function framePlot(plot, immediate) {
    if (!plot) return;
    const b = measure([plot]);
    if (!b) return;
    applyView(viewFor({ x: b.cx, y: b.cy, z: b.cz }, Math.max(MIN_RADIUS, b.radius * 0.85)), immediate === true);
  }

  /* ── tile fetching ───────────────────────────────────────── */

  function tileKey(lod, tx, tz) {
    return lod + '|' + tx + '|' + tz;
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('tile unavailable')); };
      img.src = url;
    });
  }

  function pruneImages() {
    while (imgCache.size > GROUND_IMAGE_CACHE) {
      let oldestKey = null, oldestAt = Infinity;
      imgCache.forEach(function (entry, key) {
        if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key; }
      });
      if (oldestKey == null) break;
      imgCache.delete(oldestKey);
    }
  }

  function pumpQueue() {
    while (!disposed && activeLoads < GROUND_LOADS && loadQueue.length) {
      const job = loadQueue.shift();
      activeLoads++;
      loadImage(tileUrlFor({ lod: job.lod, x: job.tx, z: job.tz }))
        .then(function (img) {
          imgCache.set(job.key, { img: img, at: performance.now() });
          pruneImages();
          job.resolve(img);
        }, function () {
          // Void and unrendered tiles come back as errors. Remember the miss
          // so a zoom across a mostly-empty world does not re-ask for the same
          // nothing over and over; it is released when the entry ages out.
          imgCache.set(job.key, { img: null, at: performance.now() });
          pruneImages();
          job.resolve(null);
        })
        .then(function () { activeLoads--; pumpQueue(); });
    }
  }

  // One image per tile, at most one request per tile in flight. Resolves with
  // null for a tile the host does not have, which is a legitimate answer.
  function fetchTile(lod, tx, tz) {
    const key = tileKey(lod, tx, tz);
    const cached = imgCache.get(key);
    if (cached) { cached.at = performance.now(); return Promise.resolve(cached.img); }
    const pending = imgPending.get(key);
    if (pending) return pending;
    if (!tileUrlFor) return Promise.resolve(null);
    const promise = new Promise(function (resolve) {
      loadQueue.push({ key: key, lod: lod, tx: tx, tz: tz, resolve: resolve });
      pumpQueue();
    });
    imgPending.set(key, promise);
    promise.then(function () { imgPending.delete(key); });
    return promise;
  }

  /* ── terrain height ──────────────────────────────────────── */

  // Height rides in the bottom half of a BlueMap tile, packed as the low 16
  // bits of each pixel (red = high byte, green = low), sign-extended, and left
  // transparent where nothing has been rendered. One tile's worth of pixels is
  // sampled here and the median returned.
  const heightScratch = document.createElement('canvas');

  function sampleTileHeight(img) {
    const cols = img.naturalWidth;
    const rows = Math.floor(img.naturalHeight / 2);
    if (cols < 2 || rows < 2) return null;
    heightScratch.width = cols;
    heightScratch.height = rows;
    const ctx = heightScratch.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, cols, rows);
    let data;
    try {
      ctx.drawImage(img, 0, rows, cols, rows, 0, 0, cols, rows);
      data = ctx.getImageData(0, 0, cols, rows).data;
    } catch (e) {
      return null; // cross-origin tile without CORS headers: no readback
    }
    const heights = [];
    for (let sy = 0; sy < HEIGHT_SAMPLES; sy++) {
      const y = Math.floor(((sy + 0.5) / HEIGHT_SAMPLES) * rows);
      for (let sx = 0; sx < HEIGHT_SAMPLES; sx++) {
        const x = Math.floor(((sx + 0.5) / HEIGHT_SAMPLES) * cols);
        const o = (y * cols + x) * 4;
        if (!data[o + 3]) continue;
        let h = (data[o] << 8) | data[o + 1];
        if (h > 0x8000) h -= 0x10000;
        heights.push(h);
      }
    }
    if (!heights.length) return null;
    heights.sort(function (a, b) { return a - b; });
    return heights[Math.floor(heights.length / 2)];
  }

  function blocksPerTileLod(lod) {
    return Math.max(1, blocksPerTile(lod));
  }

  function tileCountFor(rect, blocks) {
    const nx = Math.floor(rect.maxX / blocks) - Math.floor(rect.minX / blocks) + 1;
    const nz = Math.floor(rect.maxZ / blocks) - Math.floor(rect.minZ / blocks) + 1;
    return nx * nz;
  }

  // The finest level whose tile count over `rect` fits in `limit`, or the
  // coarsest level when even that cannot (there is nothing better to use).
  function lodWithin(rect, limit) {
    for (let lod = 1; lod <= lodCount; lod++) {
      if (tileCountFor(rect, blocksPerTileLod(lod)) <= limit) return lod;
    }
    return lodCount;
  }

  function setGroundY(y) {
    if (!isFinite(y)) return;
    const previous = groundY;
    groundY = y;
    if (previous != null && Math.abs(previous - y) < 0.5) return;
    field.tiles.forEach(function (entry) { entry.mesh.position.y = groundY; });
    buildReference();
  }

  // Measure the reference plane once, from the tiles that cover the claims
  // themselves — the ground under the register, not a world average.
  function measureGround(b) {
    if (groundMeasured || !tileUrlFor || disposed) return;
    groundMeasured = true;
    const lod = lodWithin(b, PROBE_TILE_LIMIT);
    const blocks = blocksPerTileLod(lod);
    let tx0 = Math.floor(b.minX / blocks), tx1 = Math.floor(b.maxX / blocks);
    let tz0 = Math.floor(b.minZ / blocks), tz1 = Math.floor(b.maxZ / blocks);
    // A register spread across a coarse level could need every tile of it, so
    // fall back to the single tile under the middle of the claims.
    if ((tx1 - tx0 + 1) * (tz1 - tz0 + 1) > PROBE_TILE_CEILING) {
      tx0 = tx1 = Math.floor(b.cx / blocks);
      tz0 = tz1 = Math.floor(b.cz / blocks);
    }
    const jobs = [];
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        jobs.push(fetchTile(lod, tx, tz).then(function (img) {
          return img ? sampleTileHeight(img) : null;
        }));
      }
    }
    Promise.all(jobs).then(function (found) {
      if (disposed) return;
      const heights = found.filter(function (h) { return h != null; });
      if (!heights.length) return;
      heights.sort(function (a, b2) { return a - b2; });
      setGroundY(heights[Math.floor(heights.length / 2)]);
    });
  }

  /* ── the ground field ────────────────────────────────────── */

  function hasGround() { return field.tiles.size > 0; }

  function tileTexture(img, blocks) {
    const px = Math.max(8, Math.min(blocks + 1, GROUND_TEX_PX));
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    // BlueMap writes (tileSize+1) x 2(tileSize+1): the top half is the colour
    // map (1 block = 1 pixel, north at the top) and the bottom half is the
    // height metadata read above. Cropping the top half is what a ground quad
    // shows, and it is drawn whole, scaled to fit the canvas.
    //
    // The source rectangle must be clamped to the image, not to the *block*
    // size the tile covers. Past the finest level those two are not the same:
    // a coarse tile is still only ~500 px across however many thousand blocks
    // it spans, and drawImage clips a source rectangle that runs off the image
    // and shrinks what it drew into the top-left corner of the canvas — the
    // rest staying transparent, which an opaque material paints as black.
    // That is what turned every level coarser than lod 1 into a black sheet.
    const sw = Math.min(img.naturalWidth, blocks + 1);
    const sh = Math.min(Math.floor(img.naturalHeight / 2), blocks + 1);
    if (sw >= 1 && sh >= 1) ctx.drawImage(img, 0, 0, sw, sh, 0, 0, px, px);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    if (renderer.capabilities.getMaxAnisotropy) {
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }
    return texture;
  }

  function removeTile(key) {
    const entry = field.tiles.get(key);
    if (!entry) return;
    field.tiles.delete(key);
    entry.gone = true;
    groundGroup.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    if (entry.mesh.material.map) entry.mesh.material.map.dispose(); // the material owns its tile texture
    entry.mesh.material.dispose();
  }

  function ensureTile(lod, tx, tz) {
    const key = tileKey(lod, tx, tz);
    if (field.tiles.has(key)) return;
    const blocks = blocksPerTileLod(lod);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(blocks, blocks),
      // Textured as soon as its tile arrives; until then the colour says
      // "ground here, tile on its way" instead of leaving a hole in the field.
      new THREE.MeshBasicMaterial({ color: GROUND_PLACEHOLDER })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(tx * blocks + blocks / 2, planeY(), tz * blocks + blocks / 2);
    groundGroup.add(mesh);
    const entry = { lod: lod, tx: tx, tz: tz, mesh: mesh, gone: false };
    field.tiles.set(key, entry);
    fetchTile(lod, tx, tz).then(function (img) {
      if (disposed || entry.gone || !img) return;
      const texture = tileTexture(img, blocks);
      entry.mesh.material.map = texture;
      entry.mesh.material.color.setHex(0xffffff);
      entry.mesh.material.needsUpdate = true;
      refreshReference();
    });
  }

  // Reconcile the field with a tile range at one level of detail. Tiles that
  // fall outside it are dropped; everything inside that is missing is added;
  // and if neither the range nor the level changed, this does nothing at all —
  // which is what makes it safe to call from the render loop.
  function reconcileGround(rect, lod) {
    const blocks = blocksPerTileLod(lod);
    let tx0 = Math.floor(rect.minX / blocks), tx1 = Math.floor(rect.maxX / blocks);
    let tz0 = Math.floor(rect.minZ / blocks), tz1 = Math.floor(rect.maxZ / blocks);
    // Belt and braces: the rect is already bounded so that a level inside the
    // budget covers it, but never let a resize or an odd aspect turn a field
    // into a request storm.
    const nx = tx1 - tx0 + 1, nz = tz1 - tz0 + 1;
    if (nx * nz > GROUND_TILE_LIMIT) {
      const side = Math.max(1, Math.floor(Math.sqrt(GROUND_TILE_LIMIT)));
      const cx = Math.floor((tx0 + tx1) / 2), cz = Math.floor((tz0 + tz1) / 2);
      tx0 = cx - Math.floor((side - 1) / 2); tx1 = tx0 + side - 1;
      tz0 = cz - Math.floor((side - 1) / 2); tz1 = tz0 + side - 1;
    }
    const key = lod + ':' + tx0 + ':' + tx1 + ':' + tz0 + ':' + tz1;
    if (key === field.key) return;

    field.key = key;
    field.lod = lod;
    field.bounds = { minX: tx0 * blocks, maxX: (tx1 + 1) * blocks, minZ: tz0 * blocks, maxZ: (tz1 + 1) * blocks };

    const stale = [];
    field.tiles.forEach(function (entry, tileK) {
      if (entry.lod !== lod || entry.tx < tx0 || entry.tx > tx1 || entry.tz < tz0 || entry.tz > tz1) stale.push(tileK);
    });
    stale.forEach(removeTile);

    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) ensureTile(lod, tx, tz);
    }
    refreshReference();
  }

  // Which level the ground should be at for a visible footprint. Coarsens as
  // soon as the current level stops fitting; sharpens only when the finer one
  // is well inside budget, so a wheel resting on a boundary cannot make the
  // whole field rebuild every frame.
  function chooseGroundLod(rect) {
    const current = field.lod;
    if (current) {
      if (tileCountFor(rect, blocksPerTileLod(current)) <= GROUND_TILE_LIMIT) {
        for (let lod = 1; lod < current; lod++) {
          if (tileCountFor(rect, blocksPerTileLod(lod)) <= Math.floor(GROUND_TILE_LIMIT / 2)) return lod;
        }
        return current;
      }
      for (let lod = current + 1; lod <= lodCount; lod++) {
        if (tileCountFor(rect, blocksPerTileLod(lod)) <= GROUND_TILE_LIMIT) return lod;
      }
      return lodCount;
    }
    return lodWithin(rect, GROUND_TILE_LIMIT);
  }

  // The ground the camera can actually see: where its four corner rays and the
  // point beneath it meet the reference plane. Everything outside that is off
  // screen, so it costs nothing to leave it out — which is what keeps a
  // zoomed-in view sharp while the rest of the world stays coarse.
  //
  // The one thing a ray cannot answer on its own is the far edge. A camera
  // looking along the ground has corner rays that run to the horizon, and a
  // rectangle big enough to hold those would be a whole world of tiles at a
  // level of detail nobody can resolve there — which is exactly the shape of
  // the bug this replaced: the bounds got dragged so far out that the ground
  // under the camera itself fell outside the field, and the view went black
  // from every direction at once. So a ray is allowed to reach only as far as
  // the ground is worth drawing:
  //
  //   height / tan(top of frame)  — far enough to fill the frame all the way
  //                                 up to where the plane meets the horizon,
  //   height × 5                  — or, when that angle is nearly zero,
  //                                 enough ground for the frame's near half,
  //   the coarsest level × 4      — and never more than the field can hold.
  const cornerCoords = [
    new THREE.Vector2(-1, -1), new THREE.Vector2(1, -1),
    new THREE.Vector2(-1, 1), new THREE.Vector2(1, 1),
  ];
  const cornerHits = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let lastRect = null;

  function groundRect() {
    groundPlane.constant = -planeY();
    const dist = camera.position.distanceTo(controls.target) || 1;
    const height = camera.position.y - planeY();

    // Straight down first: the ground the camera stands over anchors the
    // rect, and it is inside the visible ground at any angle above it.
    raycaster.ray.origin.copy(camera.position);
    raycaster.ray.direction.set(0, -1, 0);
    const under = raycaster.ray.intersectPlane(groundPlane, cornerHits[0]);
    let nx, nz;
    if (under) { nx = under.x; nz = under.z; }
    else if (bounds) { nx = bounds.cx; nz = bounds.cz; }
    else return null;

    const fov = (camera.fov * Math.PI) / 180;
    const pitch = Math.asin(Math.min(1, Math.max(-1, (camera.position.y - controls.target.y) / dist)));
    const topAngle = Math.max(0.035, pitch - fov / 2);
    // Half the widest field the coarsest level can hold in the tile budget.
    const cover = Math.max(blocksPerTileLod(1), blocksPerTileLod(lodCount) * 4);
    const cap = height > 1
      ? Math.min(cover, Math.max(height * 5, height / Math.tan(topAngle)))
      : cover;

    let minX = nx, maxX = nx, minZ = nz, maxZ = nz;
    let hits = under ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      raycaster.setFromCamera(cornerCoords[i], camera);
      const hit = raycaster.ray.intersectPlane(groundPlane, cornerHits[i]);
      if (!hit) continue;
      hits++;
      let hx = hit.x, hz = hit.z;
      const dx = hx - nx, dz = hz - nz;
      const far = Math.sqrt(dx * dx + dz * dz);
      if (far > cap) { const k = cap / far; hx = nx + dx * k; hz = nz + dz * k; }
      minX = Math.min(minX, hx); maxX = Math.max(maxX, hx);
      minZ = Math.min(minZ, hz); maxZ = Math.max(maxZ, hz);
    }
    if (!hits) return null; // looking at the sky: keep the field as it is

    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const spanX = Math.max(MIN_RADIUS * 2, (maxX - minX) * GROUND_PAD);
    const spanZ = Math.max(MIN_RADIUS * 2, (maxZ - minZ) * GROUND_PAD);
    lastRect = { minX: cx - spanX / 2, maxX: cx + spanX / 2, minZ: cz - spanZ / 2, maxZ: cz + spanZ / 2 };
    return lastRect;
  }

  function updateGround(force) {
    if (disposed || !active || !surfaceVisible) return;
    const now = performance.now();
    if (!force && now - lastGroundAt < GROUND_UPDATE_MS) return;
    lastGroundAt = now;
    const rect = groundRect();
    if (!rect) return;
    reconcileGround(rect, chooseGroundLod(rect));
  }

  function clearGround() {
    const keys = [];
    field.tiles.forEach(function (entry, key) { keys.push(key); });
    keys.forEach(removeTile);
    field.lod = 0;
    field.key = '';
    field.bounds = null;
  }

  /* ── grid, north marker ──────────────────────────────────── */

  // The grid is the stand-in ground: it is drawn only while the field has no
  // tile to show, and never at the same height as a tile, because two flat
  // surfaces at one height z-fight.
  function buildReference() {
    disposeTree(gridGroup);
    const b = bounds;
    if (!b) return;
    const y = planeY();
    if (!hasGround()) {
      const span = Math.max(b.spanX, b.spanZ, 64);
      const step = span > 4000 ? 256 : span > 1200 ? 128 : span > 300 ? 32 : 16;
      const size = Math.ceil((span * 1.15) / step) * step;
      const grid = new THREE.GridHelper(size, Math.max(4, Math.round(size / step)), 0x4b4f54, 0x2a2930);
      grid.position.set(b.cx, y, b.cz);
      gridGroup.add(grid);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#e3bf4c';
    ctx.fillStyle = '#e3bf4c';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(64, 104);
    ctx.lineTo(64, 40);
    ctx.moveTo(64, 40);
    ctx.lineTo(40, 66);
    ctx.moveTo(64, 40);
    ctx.lineTo(88, 66);
    ctx.stroke();
    ctx.font = '600 40px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 64, 126);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    // North of the register itself, not of the ground field: the field grows
    // with the camera, and a marker pinned to its edge would be off screen in
    // the very view that needs to say which way is north.
    const span = Math.max(60, Math.max(b.spanX, b.spanZ) * 0.18);
    sprite.scale.set(span, span, 1);
    sprite.position.set(b.cx, y + span * 0.25, b.minZ - span * 0.55);
    sprite.renderOrder = 2;
    gridGroup.add(sprite);
  }

  // Only rebuild when the presence of ground actually changed: a tile
  // arriving must not throw away and rebuild the grid on every load.
  function refreshReference() {
    const has = hasGround();
    if (has === refHadGround) return;
    refHadGround = has;
    buildReference();
  }

  /* ── claim boxes ─────────────────────────────────────────── */

  function buildBoxes() {
    disposeTree(boxesGroup);
    pickable = [];
    plots.forEach(function (plot) {
      const bb = plotBBox(plot);
      const w = Math.max(1, bb.maxX - bb.minX);
      const d = Math.max(1, bb.maxZ - bb.minZ);
      const h = Math.max(1, plot.yUpper - plot.yLower);
      const geo = new THREE.BoxGeometry(w, h, d);
      const color = colorFor(plot.status);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: color, transparent: true, opacity: 0.42,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.position.set((bb.minX + bb.maxX) / 2, (plot.yLower + plot.yUpper) / 2, (bb.minZ + bb.maxZ) / 2);
      mesh.userData.plot = plot;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xe3bf4c, transparent: true, opacity: 0.85 })
      );
      edges.position.copy(mesh.position);
      boxesGroup.add(mesh, edges);
      pickable.push(mesh);
    });
    applySelection();
  }

  function applySelection() {
    pickable.forEach(function (mesh) {
      const isSelected = !!selected && mesh.userData.plot === selected;
      mesh.material.opacity = isSelected ? 0.72 : 0.42;
      mesh.material.color.setHex(isSelected ? 0xe3bf4c : colorFor(mesh.userData.plot.status));
    });
  }

  /* ── picking ─────────────────────────────────────────────── */

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function plotAt(clientX, clientY) {
    if (!pickable.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickable, false);
    return hits.length ? hits[0].object.userData.plot : null;
  }

  renderer.domElement.addEventListener('pointerdown', function (ev) {
    pointerDown = { x: ev.clientX, y: ev.clientY, at: performance.now() };
  });

  renderer.domElement.addEventListener('pointerup', function (ev) {
    const start = pointerDown;
    pointerDown = null;
    // Orbiting and panning both end in a click event, so a drag must not be
    // read as a pick — otherwise every rotate selects whatever box the
    // pointer happened to finish over.
    if (!start) return;
    if (Math.abs(ev.clientX - start.x) > CLICK_SLOP || Math.abs(ev.clientY - start.y) > CLICK_SLOP) return;
    if (performance.now() - start.at > CLICK_MS) return;
    const plot = plotAt(ev.clientX, ev.clientY);
    if (plot) onPick(plot);
  });

  renderer.domElement.addEventListener('pointermove', function (ev) {
    if (pointerDown || !pickable.length || hoverRaf) return;
    hoverRaf = requestAnimationFrame(function () {
      hoverRaf = 0;
      renderer.domElement.style.cursor = plotAt(ev.clientX, ev.clientY) ? 'pointer' : '';
    });
  });

  /* ── render loop ─────────────────────────────────────────── */

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render() {
    if (!active) return;
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.start) / tween.duration);
      // easeInOutCubic: gentle at both ends, so a new target never snaps.
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
      if (k >= 1) tween = null;
    }
    controls.update();
    // The ground follows the camera. This is throttled inside updateGround and
    // a no-op unless the visible footprint or the level of detail changed, so
    // a still camera costs nothing.
    updateGround(false);
    renderer.render(scene, camera);
  }

  (function loop() {
    requestAnimationFrame(loop);
    render();
  })();

  /* ── public api ──────────────────────────────────────────── */

  return {
    // Rebuild the claims. `frame` re-frames the camera (used when the
    // visible set changes wholesale, not on a plain re-render).
    setPlots: function (next, frame) {
      plots = (next || []).filter(Boolean);
      selected = selected && plots.indexOf(selected) !== -1 ? selected : null;
      bounds = measure(plots);
      if (!bounds) {
        disposeTree(boxesGroup);
        disposeTree(gridGroup);
        clearGround();
        pickable = [];
        refHadGround = null;
        return;
      }
      buildBoxes();
      if (groundY == null) groundY = bounds.minY - FALLBACK_SURFACE_DROP;
      buildReference();
      refHadGround = hasGround();
      measureGround(bounds);
      if (frame || !framedOnce) {
        framedOnce = true;
        frameAll(true);
      }
      updateGround(true);
    },

    select: function (plot, move) {
      selected = plot || null;
      applySelection();
      if (plot && move) framePlot(plot, false);
    },

    frameAll: function () { frameAll(false); },

    // A different BlueMap can publish a different number of levels of
    // detail, and can be a different size; the ground's ladder and its
    // reference height are both derived from that, so both are re-derived.
    setGeometry: function (nextLodCount) {
      const next = Math.max(1, Math.round(nextLodCount || 1));
      if (next === lodCount) return;
      lodCount = next;
      clearGround();
      refHadGround = null;
      buildReference();
      updateGround(true);
    },

    setSurfaceVisible: function (visible) {
      surfaceVisible = !!visible;
      groundGroup.visible = surfaceVisible;
      // Nothing is loaded while the ground is hidden, so coming back needs a
      // reconcile rather than waiting for the camera to move.
      if (surfaceVisible) updateGround(true);
    },

    // What the ground is doing, for the page and for diagnostics: the level of
    // detail on screen, how many tiles it is made of, the height it sits at,
    // whether it is still loading, and where the camera is looking from.
    stats: function () {
      return {
        lod: field.lod,
        tiles: field.tiles.size,
        textureless: Array.prototype.filter.call(groundGroup.children, function (m) { return !m.material.map; }).length,
        groundY: groundY,
        lodCount: lodCount,
        pending: loadQueue.length + activeLoads,
        bounds: field.bounds,
        rect: lastRect,
        camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        distance: camera.position.distanceTo(controls.target),
        height: camera.position.y - planeY(),
        minDistance: controls.minDistance,
        maxDistance: controls.maxDistance,
        active: active,
        surfaceVisible: surfaceVisible,
        contextLost: contextLost,
        contextRestored: contextRestored,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      };
    },

    setActive: function (isActive) {
      active = !!isActive;
      if (active) {
        resize();
        updateGround(true);
        render();
      }
    },

    resize: resize,
    dispose: function () {
      disposed = true;
      active = false;
      loadQueue.length = 0;
      disposeTree(boxesGroup);
      disposeTree(gridGroup);
      clearGround();
      imgCache.clear();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
