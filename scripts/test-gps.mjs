// Regression tests for the GPS Network library.
// Source under test: luatxtfiles/Cannon Programs/GPS Network V1.txt
//
// This runs the REAL Lua module under fengari (a Lua VM in JavaScript) with
// ComputerCraft stubs, then drives it through its public API. It covers the
// things that must never break silently:
//
//   * a well-conditioned tower set solves exactly,
//   * a real, only-roughly-layered network is NOT refused (a gate set too high
//     refused one in the field and took the whole network down),
//   * a flat or collinear set is REFUSED rather than guessed at,
//   * a tower that has been moved or mis-keyed is excluded, not averaged in,
//   * an 800-target sweep lands on every target exactly,
//   * the ping never opens the shared channel 65534,
//   * and the GPS Tower program's counters survive a reboot (which is what an
//     unloaded chunk does to a tower).
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
-- A modem that behaves like CC's: the channel list belongs to the MODEM, open
-- on an already-open channel reports false, and isOpen is the truth. Tracking
-- them for real is what lets these tests exercise a channel being closed from
-- under a running engine — the fault that used to leave a receiver permanently
-- deaf with every tower in the world looking silent.
local openChannels = {}
local fakeModem = {
  isWireless = function() return true end,
  open = function(ch)
    if openChannels[ch] then return false end
    openChannels[ch] = true
    return true
  end,
  close = function(ch) openChannels[ch] = nil; return true end,
  closeAll = function() openChannels = {} end,
  isOpen = function(ch) return openChannels[ch] == true end,
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
-- Test hooks: close a channel behind a running engine, and read its state.
function closeChannelBehind(ch) openChannels[ch] = nil end
function isChannelOpen(ch) return openChannels[ch] == true end
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

-- --- a real, only-roughly-layered network must still solve ----------------
-- Five towers from the live world: a ~190 block spread in X/Z, but only 9
-- blocks of height between the lowest and the highest. That set is lopsided
-- (DOP ~20) but NOT degenerate, and CC's distances are exact, so it solves
-- exactly. It must never be refused: refusing a workable network is an outage,
-- and a gate set even slightly too high did exactly that in the field.
local HREAL = {
  { 2711, 319, 28 }, { 2791, 318, 16 }, { 2901, 310, -6 },
  { 2846, 315, -87 }, { 2744, 319, -61 },
}
local eR = newEngine()
local okR = feed(eR, HREAL, { 2748, 64, -3 })
local xR, yR, zR, mR = eR:get()
check("real near-flat network solves exactly", okR and at(xR, yR, zR) == "2748,64,-3",
  (okR and (at(xR, yR, zR) .. " DOP " .. string.format("%.1f", mR.dop)) or tostring(eR.reason)))

-- A single block of height difference makes a layout solvable, so it must be.
local eT = newEngine()
local okT = feed(eT, { { 0, 64, 0 }, { 300, 64, 0 }, { 0, 64, 300 }, { 300, 65, 300 } }, { 137, 70, 88 })
local xT, yT, zT, mT = eT:get()
check("one block off-plane is enough", okT and at(xT, yT, zT) == "137,70,88",
  (okT and (at(xT, yT, zT) .. " DOP " .. string.format("%.1f", mT.dop)) or tostring(eT.reason)))

-- The DOP is the operator-facing number, so it has to rank layouts correctly:
-- a tower on a 136 block mast (the well-spread H4 above) must read far lower
-- than the 9-blocks-over-190 real network, which in turn must read lower than
-- one block over 300. Note all three solve EXACTLY — which is precisely why
-- the DOP is a warning for the operator and not a gate: it measures fragility,
-- not whether a fix is possible.
check("DOP ranks well-spread below lopsided below nearly-flat",
  meta.dop and mR.dop and mT.dop and meta.dop < mR.dop and mR.dop < mT.dop,
  string.format("mast %.1f < real %.1f < near-flat %.1f", meta.dop or 0, mR.dop or 0, mT.dop or 0))

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

-- The same fault on the lopsided real network. A near-flat set leans on every
-- tower being where it says it is, so this is the case most likely to break:
-- the moved tower must still be thrown out and the fix still land exactly.
local eRR = newEngine()
local okRR = false
do
  local actual = {
    { 2711, 319, 28 }, { 2791, 318, 16 }, { 2901, 310, 44 },
    { 2846, 315, -87 }, { 2744, 319, -61 },
  }
  local target = { 2748, 64, -3 }
  eRR:request()
  for i = 1, #HREAL do
    local a = actual[i]
    local dx, dy, dz = a[1] - target[1], a[2] - target[2], a[3] - target[3]
    eRR:onMessage(eRR.side, eRR.channel, { HREAL[i][1], HREAL[i][2], HREAL[i][3] },
      math.sqrt(dx * dx + dy * dy + dz * dz))
  end
  okRR = eRR:attempt()
end
local xRR, yRR, zRR, mRR = eRR:get()
check("moved tower excluded on the near-flat network",
  okRR and at(xRR, yRR, zRR) == "2748,64,-3" and #mRR.excluded == 1,
  (okRR and (at(xRR, yRR, zRR) .. " excluded=[" .. table.concat(mRR.excluded, ";") .. "]")
    or tostring(eRR.reason)))

-- --- tower registry + reporting ---
local tw = e3:towerList()
check("tower registry populated", #tw == 6, #tw .. " towers")
local stats = e3:getStats()
check("stats counted fixes", stats.fixes >= 1 and stats.pings >= 1, "fixes=" .. stats.fixes .. " pings=" .. stats.pings)
check("status() renders", type(e3:status()) == "string" and #e3:status() > 0, e3:status())

-- --- the engine re-opens a channel closed underneath it ----------------
-- A channel belongs to the modem and anything else on the computer can close
-- it (rednet, another program, a modem being broken and replaced). An engine
-- that never checks goes permanently deaf: every tower in the world looks
-- silent, and reloading the towers changes nothing. It must notice and re-open.
local eSC = newEngine()
local okSC = feed(eSC, H4, { 137, 70, 88 })
check("sanity: solves before the channel is closed", okSC and eSC:get() ~= nil, tostring(eSC.reason))
closeChannelBehind(eSC.channel)
check("channel really is closed behind the engine", not isChannelOpen(eSC.channel),
  "ch " .. tostring(eSC.channel))
eSC:update()
check("engine re-opens its own reply channel", isChannelOpen(eSC.channel), "ch " .. tostring(eSC.channel))
local okSC2 = feed(eSC, H4, { 200, 70, 120 })
local scX, scY, scZ = eSC:get()
check("engine still solves after the channel was re-opened",
  okSC2 and scX ~= nil and at(scX, scY, scZ) == "200,70,120",
  okSC2 and at(scX, scY, scZ) or tostring(eSC.reason))
eSC:openChannel(4120)
closeChannelBehind(4120)
eSC:update()
check("engine re-opens an extra channel the program opened", isChannelOpen(4120), "4120")

-- --- a slow tower still counts -----------------------------------------
-- A tower on a loaded chunk can answer after the soft window. Treating that as
-- silence is how a healthy tower gets permanently dropped by a receiver that is
-- simply further behind, so collection carries on until the hard window.
local eSlow = newEngine()
eSlow:request()
local function feedOne(e, h, t)
  local d = math.sqrt((h[1] - t[1]) ^ 2 + (h[2] - t[2]) ^ 2 + (h[3] - t[3]) ^ 2)
  e:onMessage(e.side, e.channel, { h[1], h[2], h[3] }, d)
end
for i = 1, 3 do feedOne(eSlow, H4[i], { 137, 70, 88 }) end
NOW = NOW + 0.7
local pendingBefore = eSlow.pending ~= nil
eSlow:update()
check("3 of 4 towers does not solve at the soft window",
  pendingBefore and eSlow.pending ~= nil and eSlow:get() == nil, tostring(eSlow.reason))
feedOne(eSlow, H4[4], { 137, 70, 88 })
NOW = NOW + 0.35
eSlow:update()
local slowX, slowY, slowZ = eSlow:get()
check("the late tower is counted and the fix lands exactly",
  slowX ~= nil and at(slowX, slowY, slowZ) == "137,70,88",
  (slowX and at(slowX, slowY, slowZ) or "no fix") .. " / " .. tostring(eSlow.reason))

-- --- the common case does not wait out the whole window --------------
-- A fix is taken as soon as the reply set is as complete as the last good one.
local eFast = newEngine()
eFast:request()
for i = 1, #H4 do feedOne(eFast, H4[i], { 137, 70, 88 }) end
NOW = NOW + 0.05
eFast:update()
local fastX, fastY, fastZ = eFast:get()
check("a complete reply set solves well inside the soft window",
  fastX ~= nil and at(fastX, fastY, fastZ) == "137,70,88", tostring(eFast.reason))

-- --- a tower that goes quiet leaves the registry -----------------------
-- The local registry is what the website is told about, so a ghost left in it
-- reads as "still heard" while the network is a tower or two short, and keeps
-- being blamed for fixes it is no longer part of.
local eTTL = newEngine()
feed(eTTL, H4, { 137, 70, 88 })
check("registry holds the towers that answered", #eTTL:towerList() == 4, #eTTL:towerList() .. " towers")
check("live towers carry their age", (eTTL:towerList()[1] or {}).age ~= nil, "age")
NOW = NOW + (eTTL.cfg.towerTtl + 1)
check("pruneTowers drops towers that have gone quiet", eTTL:pruneTowers() == 4, "pruned")
check("registry is empty once its towers have gone quiet", #eTTL:towerList() == 0,
  #eTTL:towerList() .. " towers")

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

-- The same sweep on the LOPSIDED real network. Accepting a flat-ish layout is
-- only safe if it stays exact everywhere the operator might actually be, not
-- just directly under the towers — a badly conditioned solve would drift out
-- towards the edges of the network first.
local eRS = newEngine()
local exactR, wrongR, rejR = 0, 0, 0
for i = 1, 800 do
  local t = { math.random(2000, 3500), math.random(-100, 300), math.random(-1200, 1200) }
  if feed(eRS, HREAL, t) then
    local sx, sy, sz = eRS:get()
    if at(sx, sy, sz) == want(t) then exactR = exactR + 1 else
      wrongR = wrongR + 1
      if wrongR <= 3 then say("      wrong: wanted " .. want(t) .. " got " .. at(sx, sy, sz)) end
    end
  else rejR = rejR + 1 end
end
check("sweep 800 targets on the near-flat real network", wrongR == 0 and exactR == 800,
  exactR .. " exact, " .. wrongR .. " wrong, " .. rejR .. " rejected")

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
      isOpen = function(ch)
        for i = 1, #opened do if opened[i] == ch then return true end end
        return false
      end,
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

-- A receiver cannot tell another computer's tower replies from its own, so two
-- receivers landing on one channel can overwrite each other's distances and one
-- of them can solve its NEIGHBOUR's position and believe it. Two ids that
-- differ by exactly the old span used to collide; the spread must make that
-- impossible for every id in a realistic range, not just unlikely.
local clash, channels = nil, {}
for id = 1, 500 do
  local ch = replyChannel(id)
  if channels[ch] then clash = "ids " .. channels[ch] .. " and " .. id .. " share " .. ch end
  channels[ch] = id
end
check("500 consecutive computer ids get separate reply channels", clash == nil,
  clash or ("500 distinct channels, e.g. " .. replyChannel(1) .. " and " .. replyChannel(500)))
check("ids 1000 apart no longer collide", replyChannel(100) ~= replyChannel(1100),
  replyChannel(100) .. " vs " .. replyChannel(1100))
check("reply channel is private and in band",
  e11.channel ~= 65534 and e11.channel ~= 4120 and e11.channel >= 40000 and e11.channel <= 59999,
  tostring(e11.channel))

-- And the behaviour that follows: a computer on a different channel must not
-- absorb another's replies, however many of them arrive.
local eA, eB = new({ id = 100 }), new({ id = 1100 })
eA:attach(); eB:attach()
eA:request(); eB:request()
for i = 1, #H4 do
  local h = H4[i]
  local dx, dy, dz = h[1] - 137, h[2] - 70, h[3] - 88
  local d = math.sqrt(dx * dx + dy * dy + dz * dz)
  eA:onMessage(eA.side, eA.channel, { h[1], h[2], h[3] }, d)
  eB:onMessage(eB.side, eA.channel, { h[1], h[2], h[3] }, d)   -- wrong channel
end
check("replies arriving on another computer's channel are ignored",
  eA:attempt() == true and eB:attempt() == false and eB:get() == nil,
  "A " .. tostring(eA:get()) .. " / B " .. tostring(eB:get()))

return table.concat(out, "\\n") .. "\\n\\n" .. pass .. " passed, " .. fail .. " failed"
`;

// The tower daemon is a second program, so it gets its own chunk and its own
// stubs (it touches the filesystem). Embedded as a Lua long string at a bracket
// level the source does not use, so no escaping is needed.
const TOWER_SRC = fs.readFileSync('luatxtfiles/Cannon Programs/GPS Tower V1.txt', 'utf8');

function luaLongString(src) {
  let eq = '=';
  while (src.includes(']' + eq + ']')) eq += '=';
  return '[' + eq + '[\n' + src + ']' + eq + ']';
}

const TOWER_TESTS = `
-- === GPS Tower: counters must survive a reboot ===
-- A tower whose chunk unloads is powered off, and boots again from scratch when
-- the chunk is loaded. Anything held only in memory resets, which looks exactly
-- like "the tower is doing nothing", so the served total and the boot count are
-- kept on disk. This proves they round-trip, and that a damaged state file
-- cannot stop a tower from booting.
local tpass, tfail = 0, 0
local tlines = {}
local function tsay(s) tlines[#tlines + 1] = s end
local function tcheck(name, cond, detail)
  if cond then tpass = tpass + 1; tsay("PASS  " .. name .. (detail and ("   -> " .. detail) or ""))
  else tfail = tfail + 1; tsay("FAIL  " .. name .. (detail and ("   -> " .. detail) or "")) end
end

local files = {}
local fakeFs = {
  exists = function(p) return files[p] ~= nil end,
  open = function(p, mode)
    if mode == "r" then
      local data = files[p]
      if data == nil then return nil end
      return { readAll = function() return data end, close = function() end }
    end
    -- Opening for write truncates, exactly like a real filesystem.
    files[p] = ""
    return {
      write = function(s) files[p] = (files[p] or "") .. tostring(s) end,
      close = function() end,
    }
  end,
}
local fakeTextutils = {
  serialize = function(t) return tostring(t.total) .. "," .. tostring(t.boots) end,
  unserialize = function(s)
    local a, b = tostring(s):match("^(%-?%d+),(%-?%d+)$")
    if not a then return nil end
    return { total = tonumber(a), boots = tonumber(b) }
  end,
}

local screen = {}

-- The tower's modem, with real CC semantics: the channel list belongs to the
-- MODEM, open on an already-open channel reports false, and isOpen is the
-- truth. That is what lets a test close a channel out from under a running
-- tower exactly as another program on the computer would.
local towerChannels = {}

local function newModem()
  return {
    isWireless = function() return true end,
    open = function(ch)
      if towerChannels[ch] then return false end
      towerChannels[ch] = true
      return true
    end,
    close = function(ch) towerChannels[ch] = nil; return true end,
    closeAll = function() towerChannels = {} end,
    isOpen = function(ch) return towerChannels[ch] == true end,
    transmit = function() end,
  }
end

-- Boot the tower once against a scripted event list.
--
-- Ordinary CC events are pulled in order. Two pseudo-events let a test act on
-- the world BETWEEN two ticks of a running tower:
--
--   { "close_channel", ch }  — something else closes a channel on the modem
--   { "boom" }               — the loop throws, to prove the tower survives it
--
-- A run ends by running out of events. The tower's own recovery path then tries
-- to sleep, and sleep raises the same "exhausted" error, so the program
-- unwinds with the harness's pcall reporting it — which is what makes the
-- tower's outer recovery loop observable from here, instead of the harness
-- hanging on a tower that never gives up.
local function boot(events)
  towerChannels = {}
  local env = setmetatable({}, { __index = _G })
  env.fs = fakeFs
  env.textutils = fakeTextutils
  env.print = function(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    screen[#screen + 1] = table.concat(parts, " ")
  end
  env.term = {
    clear = function() end, setCursorPos = function() end,
    setTextColor = function() end, setBackgroundColor = function() end,
    getSize = function() return 51, 19 end,
  }
  env.sleep = function(s)
    if #events == 0 then error("event script exhausted", 0) end
  end
  env.peripheral = {
    getNames = function() return { "bottom" } end,
    getType = function() return "modem" end,
    wrap = function() return newModem() end,
  }
  env.os = {
    clock = function() return 100 end,
    startTimer = function() return 1 end,
    pullEvent = function()
      while true do
        local e = table.remove(events, 1)
        if not e then error("event script exhausted", 0) end
        if e[1] == "close_channel" then
          towerChannels[e[2]] = nil
        elseif e[1] == "boom" then
          error("simulated failure", 0)
        else
          return table.unpack(e)
        end
      end
    end,
  }

  local chunk = assert(load(TOWER_SRC, "gpstower", "t", env))
  return pcall(chunk, 2711, 319, 28)
end

-- The tower redraws on every status tick, so the LAST matching line is what is
-- on the screen now; the first is just the boot-time paint.
local function screenLine(prefix)
  local found = nil
  for _, line in ipairs(screen) do if line:find(prefix, 1, true) then found = line end end
  return found
end

local PING = { "modem_message", "bottom", 65534, 52077, "PING", 12 }

screen = {}
local ok1, err1 = boot({ PING, PING, { "timer", 1 } })
tcheck("tower boots and serves", ok1 == false and tostring(err1):find("exhausted") ~= nil, tostring(err1))
tcheck("first boot reports its counts", screenLine("Served:") ~= nil, tostring(screenLine("Served:")))
tcheck("first boot writes state", files["gpstower_state.txt"] == "2,1",
  tostring(files["gpstower_state.txt"]))

screen = {}
local ok2, err2 = boot({ PING, PING, PING, { "timer", 1 } })
tcheck("tower reboots", ok2 == false and tostring(err2):find("exhausted") ~= nil, tostring(err2))
local served = screenLine("Served:") or ""
tcheck("counts are per-boot and cumulative", served:find("3 ping(s) this boot", 1, true) ~= nil
  and served:find("5 total", 1, true) ~= nil, served)
local uptime = screenLine("Uptime:") or ""
tcheck("the reboot is visible as a boot number", uptime:find("boot #2", 1, true) ~= nil, uptime)
tcheck("state carried the total across the reboot", files["gpstower_state.txt"] == "5,2",
  tostring(files["gpstower_state.txt"]))

files["gpstower_state.txt"] = "not,a,state,file"
screen = {}
local ok3, err3 = boot({ { "timer", 1 } })
tcheck("a corrupt state file cannot stop a boot", ok3 == false and tostring(err3):find("exhausted") ~= nil,
  tostring(err3))
tcheck("a corrupt state file restarts cleanly", files["gpstower_state.txt"] == "0,1",
  tostring(files["gpstower_state.txt"]))

-- A channel closed underneath the tower must be re-opened on the next tick.
-- This is the permanent-silence fault: the screen looks healthy, the tower
-- serves nothing, and it never comes back on its own.
screen = {}
local ok4, err4 = boot({ PING, { "close_channel", 65534 }, { "timer", 1 }, PING, { "timer", 1 } })
tcheck("a closed channel does not end the tower",
  ok4 == false and tostring(err4):find("exhausted") ~= nil, tostring(err4))
tcheck("the tower re-opened the channel it lost", towerChannels[65534] == true, tostring(towerChannels[65534]))
tcheck("both pings, either side of the closure, were served",
  (screenLine("Served:") or ""):find("2 ping(s) this boot", 1, true) ~= nil, tostring(screenLine("Served:")))
tcheck("the re-open is counted on screen",
  (screenLine("Recovery:") or ""):find("1 re-open(s)", 1, true) ~= nil, tostring(screenLine("Recovery:")))
tcheck("the re-open is logged on screen",
  (screenLine("Log:") or ""):find("Re-opened", 1, true) ~= nil, tostring(screenLine("Log:")))

-- A tower standing on the block of the computer it is answering measures ZERO.
-- A truthiness test on the distance would have exactly that tower refuse to
-- answer for ever.
screen = {}
boot({ { "modem_message", "bottom", 65534, 52077, "PING", 0 }, { "timer", 1 } })
tcheck("a zero-distance ping is still served",
  (screenLine("Served:") or ""):find("1 ping(s) this boot", 1, true) ~= nil, tostring(screenLine("Served:")))

-- An unexpected error must cost a second and a re-attach, never the tower.
screen = {}
local ok5, err5 = boot({ PING, { "boom" }, PING, { "timer", 1 } })
tcheck("an error is survived rather than ending the tower",
  ok5 == false and tostring(err5):find("exhausted") ~= nil, tostring(err5))
tcheck("the tower served on both sides of the error",
  (screenLine("Served:") or ""):find("2 ping(s) this boot", 1, true) ~= nil, tostring(screenLine("Served:")))
tcheck("the error is counted on screen",
  (screenLine("Recovery:") or ""):find("1 error(s) survived", 1, true) ~= nil, tostring(screenLine("Recovery:")))

-- Traffic on the GPS channel that is not a position ping is counted, never
-- answered: the channel is shared, and a foreign program on it is worth seeing.
screen = {}
boot({ { "modem_message", "bottom", 65534, 52077, "HELLO", 12 }, { "timer", 1 } })
tcheck("foreign traffic is counted, not answered",
  (screenLine("Served:") or ""):find("0 ping(s) this boot", 1, true) ~= nil
    and (screenLine("Ignored:") or ""):find("other message(s)", 1, true) ~= nil,
  tostring(screenLine("Served:")) .. " / " .. tostring(screenLine("Ignored:")))

return table.concat(tlines, "\\n") .. "\\n\\n" .. tpass .. " passed, " .. tfail .. " failed"
`;

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

function runChunk(chunk, label) {
  const status = lauxlib.luaL_dostring(L, to_luastring(chunk));
  if (status !== lua.LUA_OK) {
    const msg = to_jsstring(lua.lua_tostring(L, -1));
    console.error('LUA ERROR in ' + label + ':', msg);
    const m = msg.match(/:(\d+):/);
    if (m) {
      const lines = chunk.split('\n');
      const n = Number(m[1]);
      for (let i = Math.max(0, n - 4); i < Math.min(lines.length, n + 3); i++) {
        console.error(String(i + 1).padStart(5) + (i + 1 === n ? ' >> ' : '    ') + lines[i]);
      }
    }
    process.exit(1);
  }
  return to_jsstring(lua.lua_tostring(L, -1));
}

const summaries = [
  runChunk(STUBS + SRC + TESTS, 'the GPS engine'),
  runChunk('TOWER_SRC = ' + luaLongString(TOWER_SRC) + '\n' + TOWER_TESTS, 'the GPS Tower'),
];
console.log(summaries.join('\n'));

const failed = summaries.reduce(
  (n, s) => n + Number((s.match(/(\d+) failed/) || [])[1] || 0), 0
);
process.exit(failed === 0 ? 0 : 1);
