/* ============================================================
   Regnum Aeternum — Worker
   DynMap proxy routes for the Ballistic Calculator.

   Both routes always target the Worker's own DYNMAP_BASE_URL
   environment variable (set in wrangler.jsonc) — never a URL
   supplied by the client — so neither can be used as an open
   proxy. Keep DYNMAP_BASE_URL in sync with
   regnum-aeternum/ballistics/assets/shells.json's "dynmapBaseUrl"
   so the two agree on which DynMap is being described.

   getConfig: proxies {DYNMAP_BASE_URL}/up/configuration. The
   calculator's auto-detect feature tries a direct cross-origin
   fetch from the browser first; this is the fallback for when
   that's blocked (a server-to-server fetch isn't subject to
   browser CORS at all).

   getTile: proxies {DYNMAP_BASE_URL}{path}. Only used when an
   admin sets shells.json's "useProxy": true — e.g. if the DynMap
   host blocks hotlinked/cross-origin tile requests outright.
   ============================================================ */

function dynmapBase(env) {
  return String((env && env.DYNMAP_BASE_URL) || 'https://mc.westeroscraft.com').replace(/\/$/, '');
}

export async function getConfig(request, env) {
  try {
    const upstream = await fetch(dynmapBase(env) + '/up/configuration', {
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: 'DynMap configuration unavailable.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'DynMap configuration unavailable.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function getTile(request, env) {
  const url = new URL(request.url);
  const tilePath = url.searchParams.get('path');
  if (!tilePath || !tilePath.startsWith('/tiles/')) {
    return new Response('Invalid tile path', { status: 400 });
  }
  try {
    const upstream = await fetch(dynmapBase(env) + tilePath);
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
