# HOLLOW WICK

A fog-drowned sanctuary hides fragile shadow-creatures from a lethal white sky. You are a Hollow
Wick: a tiny cracked porcelain pilgrim carrying the last living ember. Cross the haunted lake,
open the old locks and the north-west stone gate, or let the dark keep you.

Built on the **PlayCanvas engine** (v2), with **WebGL 2 and WebGPU** backends. It's tuned to run on
old phones as well as laptops and PCs, and has a switchable **ASCII "Scorched Sight"** view.

```bash
npm install
npm run dev        # http://localhost:5199
npm run build      # static files in dist/
npm run preview    # serve the build (http://localhost:4173)
npm run itch       # itch.io upload: release/hollow-wick-web.zip (see itch/PAGE.md)
```

URL flags: `?gpu=webgl2|webgpu`, `?stats`, `?autostart`. Progress auto-saves at checkpoints;
Settings → *Restart journey* wipes the save.

## Controls
| Action | Keyboard / mouse | Touch | Gamepad |
|---|---|---|---|
| Move / run / sneak | WASD, Shift, C or Ctrl | left-side stick (light tilt = sneak, full tilt = run) | left stick, LB, B |
| Shutter-Lantern (hold; release = heat flash) | Space / right mouse | SHUTTER | RB / RT |
| Iron Staff (tap = strike / throw sound, hold = crank) | E / click | STAFF | A |
| Scorched Sight (ASCII view) | V | [@] ASCII | Y |
| Show the way (guiding spark) | H | tap EMBERS | |
| Camera / zoom | drag, Q R, wheel | drag right side, pinch | right stick |

## The glade (story → code)
| Region | Threat | Puzzle |
|---|---|---|
| South meadow | **Ash-Hounds**: hunt movement in the tall grass, so stand still | **Three chimes**: strike low → mid → high (tally notches; numbers in Scorched Sight) |
| The lake | **Mire-Mother**: seen only in the reflection, wakes to light, cranking and being watched | **Two valves**: crank in bursts, shutter, keep still; the causeway rises |
| Central forest | **Veil-Mothers** hunt light and follow sound; **Gloom-Moths** drain the lantern | **Pressure plates**: lure two Veil-Mothers with staff sounds; the arch lifts |
| North woods + shrine | **Bell-Warden**: blind, hunts by sound; **sunbeams** burn as the fog thins | **Four beacons**: place the 4 ember cores, then run for the rising gate |

Endings: **The White Burn** (escape through the gate) and **The Smothered Flame** (secret: holding
3+ cores, shutter your lantern and stand still beside a Veil-Mother for 12 s).

Code map: `story.js` (layout, texts, items), `gameplay.js` (rules, flame, puzzles, save, endings,
Scorched Sight marks), `monsters.js`, `props.js`, `audio.js` (all sound is synthesised in the
browser: no audio files), `world.js`, `shaders.js`, `ascii.js`.

## Loading and fullscreen

* `src/loader.js` is the page entry (~2.6 KB gzipped). It paints the loading screen at once,
  checks for WebGL 2 / WebGPU, and downloads the engine + game as a separate chunk
  (`game.js`, ~313 KB gzipped). It then runs the real setup steps with a progress bar:
  graphics device, terrain, pond, forest, grass, shrine, fireflies, player. Next it
  **pre-renders frames with culling off** so every shader / GPU pipeline compiles behind the
  loading screen instead of stuttering mid-game. Then it shows **PLAY**.
* **Fullscreen**: browsers only let a page hide their UI from a user gesture, so the PLAY
  tap requests fullscreen (with `navigationUI: 'hide'`). On touch devices, any later tap re-enters
  it if the player swiped out. Desktop has a ⤢ button and the **F** key.
* **Installable app**: `manifest.webmanifest` uses `display: fullscreen`, so "Add to Home Screen"
  / "Install app" launches with no browser bar at all. This is the only way on iPhone Safari,
  which has no page fullscreen API (the game shows a hint there).
* `sw.js` (production only) caches the hashed assets, so repeat visits load instantly and work
  offline.

## How the ASCII look works

```
reflectCam ─► reflectRT  (low-res, mirrored camera, only props near the pond)
sceneCam   ─► sceneRT    (cols×rows, or 2× when supersampling)  rgb = lit colour, a = glyph class
cellCam    ─► cellRT     one fragment per glyph cell: picks the glyph + colour, edge detection
asciiCam   ─► screen     full res: 2 texel fetches per pixel (cell + glyph atlas)
```

* **Glyph classes.** Every vertex colour's alpha packs `class*32 + sway`. The scene pass writes
  `class*32 + sub` into the alpha channel, so the cell pass knows that a cell is *grass*
  (wind strokes `\ | /` that lean with the gusts), *foliage* (`oadbQ08@`), *stone* (`x#HBWM`),
  *water* (`.-~=oO`), the *player*, or a *glow*.
* **Edges.** A luminance gradient across neighbouring cells picks `| - / \` outlines for
  stone, foliage and the character.
* **Water.** The reflection camera is the main camera mirrored about the water plane, built as a
  rigid transform. That gives the true mirror image flipped horizontally, so the water samples at
  `(1-u, v)`. Ripples (around the player plus random "rain drops") distort it.
  **The sky is faked:** a procedural moon and stars are placed relative to the camera, so the
  moon always shows up in the pond.
* **The glyph atlas** is drawn with Canvas2D at exactly the cell size in device pixels, so it
  needs no filtering or mipmaps and stays crisp at any DPR.

## Performance and optimisation

| Technique | Where |
|---|---|
| The 3D scene renders at glyph-grid resolution (e.g. 130×170 on a phone) instead of the native ~3M pixels | `ascii.js` |
| Glyph selection runs once per cell, not per pixel; the full-res pass is 2 texel fetches | `shaders.js` |
| Spatial clusters (terrain 32 m, props 32 m, grass 16 m), each one mesh instance with a tight AABB, so the engine **frustum-culls** whole clusters | `world.js` |
| **Distance culling** per frame against the camera focus, hidden by fog; far plane follows fog | `world.js`, `main.js` |
| **Hardware instancing** for trees, rocks, grass, fireflies, with a compact 32-byte instance format instead of 64-byte matrices | `world.js`, `shaders.js` |
| **Grass LOD**: instances are pre-shuffled, so drawing the first N is an even thinning; N drops with distance and quality | `world.js` |
| Wind, grass push-away, and firefly flight are animated in the **vertex shader** (zero CPU) | `shaders.js` |
| One vertex-coloured mesh per prop (trunk + canopy share a draw call); no textures except the atlas | `meshes.js` |
| The reflection pass is **skipped** when the pond isn't in the frustum, and on low tiers | `main.js`, `ascii.js` |
| Cheap custom lighting (moon + hemisphere + one point light + blob shadow); no shadow maps, no PBR, no MSAA, no backbuffer depth | `shaders.js`, `main.js` |
| **Device tiering** from GPU string, memory, cores, and mobile detection | `quality.js` |
| **Adaptive quality**: steps down fast when frames miss the target, up slowly with a cooldown (no oscillation). It changes DPR cap, supersampling, reflections, grass, fireflies, and draw distance | `quality.js` |
| `AppBase` with only the render and camera systems, so the bundle is ~313 KB gzipped with no other assets | `main.js` |
| Native WGSL alongside GLSL, so WebGPU needs no runtime transpiler download | `shaders.js` |
| Pauses when the tab is hidden; no per-frame allocations in hot paths | `main.js` |

Renderer **Auto** = WebGPU on desktop browsers that have it, WebGL 2 on mobile (more mature
drivers). It can be overridden in Settings or with `?gpu=`.
