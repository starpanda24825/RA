// Regression tests for the GPS Network library.
// Source under test: luatxtfiles/Cannon Programs/GPS Network V1.txt
//
// This runs the REAL Lua module under fengari (a Lua VM in JavaScript) with
// ComputerCraft stubs, then drives it through its public API. It covers the
// things that must never break silently:
//
//   * a well-conditioned tower set solves exactly,
//   * a flat or collinear set is REFUSED rather than guessed at,
//   * a tower that has been moved or mis-keyed is excluded, not averaged in,
//   * an 800-target sweep lands on every target exactly,
//   * the ping never opens the shared channel 65534.
//
//   node scripts/test-gps.mjs
//
// fengari is a test-only tool. If it is missing:
//   npm i -D fengari

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let fengari;
try {
  fengari = require('fengari');
} catch {
  console.log('SKIP  fengari is not installed, so the Lua tests cannot run.');
  console.log('      Install it with:  npm i -D fengari');
  process.exit(0);
}
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const SRC = fs.readFileSync('luatxtfiles/Cannon Programs/GPS Network V1.txt', 'utf8');

const STUBS = `
-- === ComputerCraft stubs ===
local NOW = 0
local COMPUTER_ID = 77
local fakeModem = {
  isWireless = function() return true end,
  open = function(ch) return true end,
  close = function(ch) return true end,
  closeAll = function() end,
  transmit = function(ch, reply, payload) return true end,
}
os.getComputerID = function() return COMPUTER_ID end
os.clock = function() return NOW end
sleep = function(s) NOW = NOW + (s or 0) end
peripheral = {
  getNames = function() return { "top" } end,
  getType = function(side) if side == "top" then return "modem" end return nil end,
  wrap = function(side) return fakeModem end,
}
`;

const TESTS = `
-- === tests ===
local out, pass, fail = {}, 0, 0
local function say(s) out[#out + 1] = s end
local function check(name, cond, detail)
  if cond then pass = pass + 1; say("PASS  " .. name .. (detail and ("   -> " .. detail) or ""))
  else fail = fail + 1; say("FAIL  " .. name .. (detail and ("   -> " .. detail) or "")) end
end

local function newEngine()
  NOW = 0
  local e = new({ id = 77 })
  if not e:attach() then error("engine attach failed: " .. tostring(e.reason)) end
  return e
end

-- Feed one ping's worth of replies and try to solve it.
local function feed(e, hosts, target, tweak)
  e:request()
  for i = 1, #hosts do
    local h = hosts[i]
    local dx, dy, dz = h[1] - target[1], h[2] - target[2], h[3] - target[3]
    local d = math.sqrt(dx * dx + dy * dy + dz * dz)
    if tweak then d = tweak(i, d) end
    e:onMessage(e.side, e.channel, { h[1], h[2], h[3] }, d)
  end
  return e:attempt()
end

local function round(v) if type(v) ~= "number" then return "?" end return math.floor(v + 0.5) end
local function at(x, y, z) return tostring(round(x)) .. "," .. tostring(round(y)) .. "," .. tostring(round(z)) end
local function want(t) return t[1] .. "," .. t[2] .. "," .. t[3] end

-- --- well-conditioned networks must be exact ---
local H4 = { { 0, 64, 0 }, { 300, 64, 0 }, { 0, 64, 300 }, { 0, 200, 0 } }
local e = newEngine()
local ok = feed(e, H4, { 137, 70, 88 })
local x, y, z, meta = e:get()
check("4 towers, one off-plane", ok and at(x, y, z) == "137,70,88" and meta.quality == "exact",
  (ok and (at(x, y, z) .. " [" .. meta.quality .. ", " .. meta.towers .. " towers, rms " .. string.format("%.1e", meta.rms) .. "]") or tostring(e.reason)))

local e2 = newEngine()
local ok2 = feed(e2, H4, { -2200, 80, 1900 })
local x2, y2, z2 = e2:get()
check("4 towers, far target", ok2 and at(x2, y2, z2) == "-2200,80,1900", at(x2, y2, z2))

local H6 = { { 0, 64, 0 }, { 500, 64, 0 }, { 0, 64, 500 }, { 500, 64, 500 }, { 250, 150, 250 }, { 100, 90, 400 } }
local e3 = newEngine()
local ok3 = feed(e3, H6, { 2748, 64, -3 })
local x3, y3, z3 = e3:get()
check("6 towers, mixed heights", ok3 and at(x3, y3, z3) == "2748,64,-3", at(x3, y3, z3))

-- --- degenerate geometry must be refused, never silently wrong ---
local HCO = { { 0, 64, 0 }, { 300, 64, 0 }, { 0, 64, 300 }, { 300, 64, 300 } }
local e4 = newEngine()
local ok4 = feed(e4, HCO, { 137, 70, 88 })
local got4 = e4:get()
check("coplanar 4 towers refused", (not ok4) and got4 == nil, tostring(e4.reason))

local e5 = newEngine()
feed(e5, H4, { 137, 70, 88 })
local ok5 = feed(e5, HCO, { 140, 70, 90 })
local x5, y5, z5, m5 = e5:get()
check("coplanar + known height -> pinned-y", ok5 and m5 and m5.quality == "pinned-y" and at(x5, y5, z5) == "140,70,90",
  tostring(m5 and m5.quality) .. " " .. at(x5, y5, z5))

local e6 = newEngine()
local ok6 = feed(e6, { { 0, 64, 0 }, { 100, 64, 0 }, { 200, 64, 0 }, { 300, 64, 0 } }, { 137, 70, 88 })
check("4 collinear towers refused", (not ok6) and e6:get() == nil, tostring(e6.reason))

local e7 = newEngine()
local ok7 = feed(e7, { { 0, 64, 0 }, { 300, 64, 0 } }, { 137, 70, 88 })
check("2 towers refused", (not ok7) and e7:get() == nil, tostring(e7.reason))

-- --- a moved / mis-keyed / spoofed tower must be excluded ---
local H5L = { { 0, 64, 0 }, { 300, 64, 0 }, { 0, 64, 300 }, { 0, 200, 0 }, { 400, 64, -400 } }
local e8 = newEngine()
local ok8 = feed(e8, H5L, { 137, 70, 88 }, function(i, d) if i == 5 then return d + 40 end return d end)
local x8, y8, z8, m8 = e8:get()
check("counting tower 5 as 40 blocks away", ok8 and at(x8, y8, z8) == "137,70,88" and #m8.excluded == 1,
  (ok8 and (at(x8, y8, z8) .. " excluded=[" .. table.concat(m8.excluded, ";") .. "]") or tostring(e8.reason)))

-- A tower that has physically MOVED but still reports its registry position:
-- its coordinates are a lie, so its measurement must be discarded.
local e9 = newEngine()
local ok9 = false
do
  local reported = { { 0, 64, 0 }, { 300, 64, 0 }, { 0, 64, 300 }, { 0, 200, 0 }, { 400, 64, -400 } }
  local actual   = { { 0, 64, 0 }, { 300, 64, 0 }, { 0, 64, 300 }, { 0, 200, 0 }, { 440, 104, -440 } }
  local target = { 137, 70, 88 }
  e9:request()
  for i = 1, #reported do
    local a = actual[i]
    local dx, dy, dz = a[1] - target[1], a[2] - target[2], a[3] - target[3]
    e9:onMessage(e9.side, e9.channel, { reported[i][1], reported[i][2], reported[i][3] },
      math.sqrt(dx * dx + dy * dy + dz * dz))
  end
  ok9 = e9:attempt()
end
local x9, y9, z9, m9 = e9:get()
check("moved tower excluded", ok9 and at(x9, y9, z9) == "137,70,88" and #m9.excluded == 1,
  (ok9 and (at(x9, y9, z9) .. " excluded=[" .. table.concat(m9.excluded, ";") .. "]") or tostring(e9.reason)))

-- --- tower registry + reporting ---
local tw = e3:towerList()
check("tower registry populated", #tw == 6, #tw .. " towers")
local stats = e3:getStats()
check("stats counted fixes", stats.fixes >= 1 and stats.pings >= 1, "fixes=" .. stats.fixes .. " pings=" .. stats.pings)
check("status() renders", type(e3:status()) == "string" and #e3:status() > 0, e3:status())

-- --- stale + age bookkeeping ---
local sa = e3:get()
NOW = NOW + 10
local _, _, _, staleMeta = e3:get()
if staleMeta then
  check("fix reported stale after maxAge", staleMeta.stale == true and staleMeta.age > 9, "age " .. string.format("%.1f", staleMeta.age))
else
  check("fix reported stale after maxAge", false, "engine 3 never produced a fix")
end

-- --- diagnostics must not error ---
local e10 = newEngine()
local lines, okD = diagnose(e10)
check("diagnose() runs", type(lines) == "table" and #lines > 0, tostring(lines[1]))
-- In this harness no tower ever answers, so diagnose must say so clearly.
local txt = table.concat(lines, " | ")
check("diagnose() explains silence", okD == false and txt:find("No tower answered") ~= nil, tostring(lines[2]))

-- --- sweep: 800 random targets on an 8-tower network ---
math.randomseed(4242)
local NET = { { 0, 64, 0 }, { 500, 64, 0 }, { 0, 64, 500 }, { 500, 64, 500 },
              { 250, 150, 250 }, { 100, 90, 400 }, { 420, 120, 90 }, { 60, 180, 210 } }
local es = newEngine()
local exact, wrong, rej = 0, 0, 0
for i = 1, 800 do
  local t = { math.random(-3000, 3000), math.random(50, 150), math.random(-3000, 3000) }
  if feed(es, NET, t) then
    local sx, sy, sz = es:get()
    if at(sx, sy, sz) == want(t) then exact = exact + 1 else
      wrong = wrong + 1
      if wrong <= 3 then say("      wrong: wanted " .. want(t) .. " got " .. at(sx, sy, sz)) end
    end
  else rej = rej + 1 end
end
check("sweep 800 targets, 8-tower net", wrong == 0 and exact == 800,
  exact .. " exact, " .. wrong .. " wrong, " .. rej .. " rejected")

-- --- the ping must never open the shared GPS channel ---
local opened = {}
local realPeripheral = peripheral
peripheral = {
  getNames = function() return { "top" } end,
  getType = function() return "modem" end,
  wrap = function()
    return {
      isWireless = function() return true end,
      open = function(ch) opened[#opened + 1] = ch end,
      close = function() end,
      closeAll = function() end,
      transmit = function(ch, reply, payload)
        opened[#opened + 1] = "tx:" .. tostring(ch) .. ":" .. tostring(reply)
      end,
    }
  end,
}
local e11 = new({ id = 77 })
e11:attach()
e11:request()
local bad = nil
for i = 1, #opened do if opened[i] == 65534 then bad = "opened 65534" end end
check("never opens the shared GPS channel", bad == nil,
  table.concat(opened, " | ") .. " (reply channel " .. e11.channel .. ")")
check("reply channel is private", e11.channel == 52000 + (77 % 1000), tostring(e11.channel))

return table.concat(out, "\\n") .. "\\n\\n" .. pass .. " passed, " .. fail .. " failed"
`;

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

const CHUNK = STUBS + SRC + TESTS;
const status = lauxlib.luaL_dostring(L, to_luastring(CHUNK));
if (status !== lua.LUA_OK) {
  const msg = to_jsstring(lua.lua_tostring(L, -1));
  console.error('LUA ERROR:', msg);
  const m = msg.match(/:(\d+):/);
  if (m) {
    const lines = CHUNK.split('\n');
    const n = Number(m[1]);
    for (let i = Math.max(0, n - 4); i < Math.min(lines.length, n + 3); i++) {
      console.error(String(i + 1).padStart(5) + (i + 1 === n ? ' >> ' : '    ') + lines[i]);
    }
  }
  process.exit(1);
}
const summary = to_jsstring(lua.lua_tostring(L, -1));
console.log(summary);

const failed = Number((summary.match(/(\d+) failed/) || [])[1] || 0);
process.exit(failed === 0 ? 0 : 1);
