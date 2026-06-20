/* ============================================================
   Regnum Aeternum — Worker
   Minimal cookie helpers. No framework — Workers requests/responses
   are plain Fetch API objects, so we parse/build cookies ourselves.
   ============================================================ */

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const {
    maxAge,
    httpOnly = true,
    secure = true,
    sameSite = 'Lax',
    path = '/',
  } = opts;

  let str = `${name}=${encodeURIComponent(value)}; Path=${path}`;
  if (maxAge != null) str += `; Max-Age=${maxAge}`;
  if (httpOnly) str += '; HttpOnly';
  if (secure) str += '; Secure';
  if (sameSite) str += `; SameSite=${sameSite}`;
  return str;
}
