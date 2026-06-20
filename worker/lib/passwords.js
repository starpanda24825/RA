/* ============================================================
   Regnum Aeternum — Worker
   Password hashing using the Workers-native Web Crypto API
   (PBKDF2-SHA256). Deliberately NOT bcrypt/bcryptjs: bcryptjs is
   a pure-JS loop with no native acceleration, and at a safe cost
   factor (>=10) it can burn through Workers' per-request CPU time
   budget. crypto.subtle.deriveBits runs as optimized native code,
   so even a high iteration count costs only a few ms of CPU.

   Stored format: "pbkdf2:<iterations>:<base64 salt>:<base64 hash>"
   ============================================================ */

const ITERATIONS = 120000;
const HASH_ALG = 'SHA-256';
const KEY_LENGTH_BITS = 256;

function bufToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveBits(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: HASH_ALG },
    keyMaterial,
    KEY_LENGTH_BITS
  );
  return new Uint8Array(bits);
}

export async function hash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(password, salt, ITERATIONS);
  return `pbkdf2:${ITERATIONS}:${bufToBase64(salt)}:${bufToBase64(derived)}`;
}

export async function compare(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const salt = base64ToBytes(parts[2]);
  const expected = base64ToBytes(parts[3]);
  const actual = await deriveBits(password, salt, iterations);

  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
