// Compiles every Lua program in luatxtfiles/ with fengari's parser, to catch
// syntax errors before they reach a ComputerCraft computer. Compilation only —
// nothing is executed, so the programs' peripherals are not needed.
//
//   node scripts/check-lua.mjs
//
// Exits non-zero if any file fails to compile. fengari is a test-only tool:
//   npm i -D fengari

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let fengari;
try {
  fengari = require('fengari');
} catch {
  console.log('SKIP  fengari is not installed, so Lua cannot be compiled.');
  console.log('      Install it with:  npm i -D fengari');
  process.exit(0);
}
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.txt')) out.push(p);
  }
  return out;
}

const files = walk('luatxtfiles');
let bad = 0;

const V = lauxlib.luaL_newstate();
lualib.luaL_openlibs(V);
lua.lua_getglobal(V, to_luastring('_VERSION'));
console.log(`fengari ${to_jsstring(lua.lua_tostring(V, -1))}\n`);

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const status = lauxlib.luaL_loadstring(L, to_luastring(src));
  const lines = src.split('\n').length;
  if (status === lua.LUA_OK) {
    console.log(`ok    ${String(lines).padStart(5)} lines  ${file}`);
  } else {
    bad++;
    console.log(`FAIL  ${String(lines).padStart(5)} lines  ${file}`);
    console.log(`      ${to_jsstring(lua.lua_tostring(L, -1))}`);
  }
}

console.log(bad === 0 ? `\nAll ${files.length} files compile.` : `\n${bad} file(s) failed.`);
process.exit(bad === 0 ? 0 : 1);
