/* ============================================================
   Regnum Aeternum — Worker
   BlueMap proxy routes for the Ballistic Calculator and
   Land Registry cadastral map.

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
