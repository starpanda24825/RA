# Regnum Aeternum — Backend & Ballistic Calculator Setup

This patch adds a small Node.js backend (`server/`) that serves the existing
static site *and* powers real accounts, the admin panel, the Times of Regnum
newsroom, and the Ballistic Calculator's login gate.

## 1. Install & run

Requires Node.js 18+.

```bash
cd regnum-aeternum/server
npm install
cp .env.example .env
```

Open `.env` and set `SESSION_SECRET` to a long random string:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then start it:

```bash
npm start
```

The whole site (including `/legal/`, `/ballistics/`, etc.) is now served from
`http://localhost:3001` — there is no separate frontend server. A SQLite
database is created automatically at `server/data/regnum.db` on first run.

## 2. Default admin account

On first run a default admin is created:

- **username:** `admin`
- **password:** `admin`

**Sign in at `/admin/` and change this password immediately** (create a new
admin account with a real password, then delete or repurpose the default
one — there's no separate "change password" form yet, so the fastest path is
to create your own admin account via the "Create Account" panel, then delete
`admin`).

## 3. Roles

| Role         | Can do |
|---|---|
| `citizen`    | Nothing special — default for new public accounts, not currently used for anything restricted |
| `ballistics` | Sign in to `/ballistics/` |
| `editor`     | Sign in to `/admin/`, write & publish Times of Regnum articles |
| `admin`      | Everything `editor` can do, plus create/edit/delete accounts and assign roles, plus ballistics access |

Admins manage all of this from `/admin/` → **Accounts** tab. There's no public
signup — every account is created by an admin.

## 4. Things you need to verify / fill in

I built this from the values you gave me, but a few things depend on your
actual live server and I couldn't verify them without access to it:

### DynMap tile URL pattern
`regnum-aeternum/ballistics/assets/shells.json` has a `map` block:

```json
"map": {
  "dynmapBaseUrl": "https://mc.westeroscraft.com",
  "world": "world",
  "mapType": "flat",
  ...
}
```

I built the tile loader against DynMap's standard tile path pattern
(`/tiles/<world>/<maptype>/<zoom-prefix><x>_<y>.png`), but the `world` name
and `mapType` ("flat"/"surface"/whatever you've named it) are placeholders.
To find the real values: open your actual DynMap in a browser, open dev
tools → Network tab, pan the map, and look at the `.png` requests being made
— copy the world/map segment from those URLs into `shells.json`. If your
DynMap blocks cross-origin tile loading, set `"useProxy": true` and the
backend will fetch tiles server-side instead (route is already wired up in
`server/server.js`).

### Ballistics physics — confirm these against in-game testing
The constants you gave me are wired in as-is:
- gravity `0.05` blocks/tick² (downward)
- muzzle velocity `+2` blocks/tick per powder charge (so `velocity = charges × 2`, no base offset — if Create: Big Cannons actually has a base velocity at 0 charges, add it in `ballistics/index.html`'s `VEL_PER_CHARGE`/`simulate()` section)
- drag `0.99`/tick, per-shell in `shells.json` so you can tune individual shells later

One thing I had to *assume* and couldn't get from you: the **order of
operations each tick**. I implemented `position += velocity; velocity *=
drag; velocity.y -= gravity` (drag applied before gravity, both before the
next position update) — this matches common Minecraft projectile-entity
behavior, but if your in-game trajectories don't match the calculator's
predictions, this integration order is the first thing to check (it's all
in one place — the `simulate()` function, clearly commented).

I also assumed no minimum/base muzzle velocity and no pitch limits on the
physical cannon beyond the 0.5°–85° search range. If Create: Big Cannons
caps elevation at some smaller range (e.g. it physically can't point past
60°), narrow the `loLim`/`hiLim` values passed to `solveArc()` in
`runCalc()`.

## 5. What's still a placeholder

- **Banking System** — left as-is (you said this is for later in-game
  ComputerCraft integration; no point building a backend for it yet).
- **Land Registry System** — left as a placeholder page; say the word when
  you want this built out and tell me what a "claim" or "deed" record
  should contain.
- The live websocket (`ws://localhost:3000` in the old `cannon_client`
  config) is not implemented — nobody could confirm what it was for. The
  calculator works entirely without it. If you find out it pushes live
  in-game data (player positions, cannon state, etc.), tell me what it
  sends and I'll wire it in.

## 6. Deploying somewhere real

Since you weren't sure on hosting yet: this is a single Node process, so it
runs anywhere Node does — a cheap VPS, Render, Railway, Fly.io, or even your
own PC with a port forwarded. Whatever you pick, just run `npm install &&
npm start` (with a production `.env`) and point your domain at that port —
no separate static host needed, the same process serves everything.
