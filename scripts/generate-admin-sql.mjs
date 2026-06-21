#!/usr/bin/env node
/* ============================================================
   Regnum Aeternum — manual admin account generator
   Produces a ready-to-run .sql file that inserts one admin user
   directly into D1, using the EXACT same PBKDF2 format the Worker's
   worker/lib/passwords.js expects (so you can log in normally
   afterwards through /admin/).

   Usage:
     node generate-admin-sql.mjs <username> <password> > insert-admin.sql
     wrangler d1 execute regnum-aeternum-db --remote --file=insert-admin.sql

   Then sign in at /admin/ with that username/password.
   ============================================================ */

const ITERATIONS = 100000; // must match worker/lib/passwords.js exactly — Workers'
                            // PBKDF2 implementation hard-caps at 100,000 iterations
const HASH_ALG = 'SHA-256';
const KEY_LENGTH_BITS = 256;

function bufToBase64(buf) {
  return Buffer.from(buf).toString('base64');
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

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(password, salt, ITERATIONS);
  return `pbkdf2:${ITERATIONS}:${bufToBase64(salt)}:${bufToBase64(derived)}`;
}

function sqlEscape(str) {
  return String(str).replace(/'/g, "''");
}

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: node generate-admin-sql.mjs <username> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters (the Worker enforces this too).');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const usernameLower = username.toLowerCase();
  const createdAt = new Date().toISOString();

  const sql =
    `INSERT INTO users (username, username_lower, password_hash, role, created_at)\n` +
    `VALUES ('${sqlEscape(username)}', '${sqlEscape(usernameLower)}', '${sqlEscape(passwordHash)}', 'admin', '${createdAt}');\n`;

  process.stdout.write(sql);
}

main();
