# Hollow Wick: itch.io upload kit

## 1. Build the upload
```bash
npm install        # first time only
npm run itch       # -> release/hollow-wick-web.zip  (~370 KB, index.html at the zip root)
```

## 2. Create the project (itch.io → Dashboard → Create new project)

| Field | Value |
|---|---|
| Title | **Hollow Wick** |
| Project URL | `hollow-wick` |
| Short description / tagline | *Carry the last flame out of the fog.* |
| Classification | Games |
| Kind of project | **HTML** |
| Release status | Released (or *Prototype* if you want early feedback) |
| Pricing | No payments, or *Donate* / *Pay what you want* (min $0) |

### Uploads
1. Upload `release/hollow-wick-web.zip`.
2. Tick **"This file will be played in the browser"**.

### Embed options
| Option | Setting | Why |
|---|---|---|
| Embed in page | **Manually set size: 1280 × 720** | 16:9; the game fills whatever size it gets |
| Mobile friendly | **On**, orientation **Default** | touch joystick + buttons are built in; works portrait or landscape |
| Automatically start on page load | **Off** | players click *Run game*, and that click unlocks sound and fullscreen |
| Fullscreen button | **On** | |
| Enable scrollbars | **Off** | |
| SharedArrayBuffer support | **Off** | not needed |

### Details
- **Genre:** Adventure (secondary: Puzzle)
- **Tags** (up to 10): `Horror`, `Atmospheric`, `ASCII`, `Dark`, `Short`, `Stealth`, `Puzzle`, `Singleplayer`, `3D`, `Low-poly`
- **AI generation disclosure:** itch.io asks whether AI was used. Answer honestly for code / graphics / text / audio.
- **Custom noun:** leave empty. **Community:** Comments on.
- **Visibility:** *Draft* first, check the page, then *Public*.

### Media
- **Cover image:** `itch/cover-630x500.png` (or the sharper `cover-1260x1000.png`; same ratio)
- **Screenshots** (in this order): `scorched-sight.gif`, `screenshot-6-scorched-sight.png`, `screenshot-2-ash-hounds.png`, `screenshot-3-mirror-lake.png`, `screenshot-4-veil-mother.png`, `screenshot-5-shrine.png`, `screenshot-1-wanderer.png`

### Page theme (Edit theme)
Background `#0d100f` · Text `#e8e4da` · Links `#f0a24a` · Buttons `#f0a24a` · Font: a plain sans (e.g. *Lato*), header image: none or the cover.

---

## 3. Page text (paste into *Description*)

> **Carry the last flame out of the fog.**

In a sunken glade drowned in cold fog, fragile shadow-creatures hide from a white sky that burned the world to ash. You are a **Hollow Wick**: a tiny cracked porcelain pilgrim with a single living ember inside, dropped into the basin by accident.

Your lantern is the only warm thing here, and everything in the glade wants it out.

**Cross the meadow, the mirror lake and the dead forest. Open the four old locks. Reach the north gate.** Or let the dark keep you.

### What waits in the fog
- **Ash-Hounds** hunt anything that moves in the tall grass. *Stand still.*
- **The Mire-Mother** is never seen on land, only in the lake's reflection.
- **Veil-Mothers** smother every light they see. Throw a sound and they follow it.
- **Gloom-Moths** drop from the branches to drink your flame.
- **The Bell-Warden** is blind. It hears every step you take.

### Your tools
- **The Shutter-Lantern:** hide your light from the things that hunt it.
- **The Iron Staff:** strike stone and iron to throw a sound across the glade. Turn the old valves.
- **Scorched Sight:** switch the whole world into **living ASCII**. See what the fog hides, and shake the moths off your flame.

### Features
- A short, complete horror journey (roughly 15–30 minutes) with **two endings**
- Every frame can be shown as real 3D or as **ASCII art**, switchable at any moment
- **Muted colour** or pure **monochrome** look
- Plays in the browser on **PC, laptop and phones** (touch controls built in), and on old low-end phones too: it adapts its quality automatically
- Headphones recommended. Every sound is synthesised live.

### Controls
| | Keyboard / mouse | Touch | Gamepad |
|---|---|---|---|
| Move | WASD | left-side stick | left stick |
| Run / sneak | Shift / C | full tilt / light tilt | LB / B |
| Shutter lantern | hold Space or right mouse | hold SHUTTER | RB |
| Iron staff (strike / crank) | E or click (hold to crank) | STAFF | A |
| Scorched Sight (ASCII) | V | [@] ASCII | Y |
| Show the way | H | tap EMBERS | |
| Camera | drag, Q / R, wheel | drag right side, pinch | right stick |
| Fullscreen / settings | F / Esc | ⤢ / ≡ | |

*Lost? Your ember knows the way: tap EMBERS or press H. Progress saves automatically at checkpoints.*

**Content:** atmospheric horror and tension, with a few sudden scares. No gore.

*Made with the PlayCanvas engine · WebGL 2 / WebGPU*

---

## 4. Before you press Publish
- [ ] Open the draft page, click **Run game**: title card → PLAY → the cold open plays.
- [ ] Try the **fullscreen button**, and **Settings (≡) → Colour / Glyph size / Quality**.
- [ ] Open the draft page on your **phone**: itch shows *Run game* → it launches fullscreen; check the joystick and STAFF / SHUTTER.
- [ ] Updating later: run `npm run itch` again and **replace** the zip in the same upload slot. Saves are kept (they live in the player's browser).

### Notes
- Saves use the browser's local storage on itch's game domain, so they survive updates but not a cleared browser.
- iPhone Safari can't hide its UI for web pages; itch's own fullscreen launcher handles this on iOS.
- WebGPU is used automatically on desktop browsers that support it; everything else uses WebGL 2.
