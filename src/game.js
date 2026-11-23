import * as pc from 'playcanvas';
import { AsciiRenderer } from './ascii.js';
import { World, WORLD, SUN_DIR } from './world.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { QualityManager, LEVELS, detectTier, isMobile } from './quality.js';
import { clamp } from './noise.js';
import { setupFullscreen, enterFullscreen, fullscreenSupported, isInstalledApp } from './fullscreen.js';
import { Props } from './props.js';
import { Gameplay } from './gameplay.js';
import { LINES, LAYOUT } from './story.js';
import * as sfx from './audio.js';
import { emberCoreMesh } from './meshes.js';
import { worldMaterial } from './shaders.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(`moonglade.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`moonglade.${k}`, v); } catch { /* private mode */ } },
};

// yields to the browser so the loading screen can repaint (setTimeout fallback for hidden tabs)
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(go);
  setTimeout(go, 60);
});

// ------------------------------------------------------------------ graphics device
async function createDevice(canvas) {
  const params = new URLSearchParams(location.search);
  const pref = params.get('gpu') || store.get('renderer', 'auto');
  const hasWebGPU = !!navigator.gpu;
  let order;
  if (pref === 'webgpu') order = [pc.DEVICETYPE_WEBGPU, pc.DEVICETYPE_WEBGL2];
  else if (pref === 'webgl2') order = [pc.DEVICETYPE_WEBGL2];
  else {
    // Auto: WebGPU on desktop where it's available (lower CPU overhead), WebGL2 on mobile
    // where drivers are far more battle-tested. Both run the exact same shaders (GLSL + WGSL).
    order = hasWebGPU && !isMobile() ? [pc.DEVICETYPE_WEBGPU, pc.DEVICETYPE_WEBGL2] : [pc.DEVICETYPE_WEBGL2];
  }
  const mobile = isMobile();
  return pc.createGraphicsDevice(canvas, {
    deviceTypes: order,
    antialias: false, // MSAA is pointless: the final image is made of glyphs
    alpha: false,
    depth: false, // only the low-res scene target needs depth
    stencil: false,
    powerPreference: mobile ? 'default' : 'high-performance',
    preserveDrawingBuffer: false,
  });
}

// ------------------------------------------------------------------ entry (called by loader.js)
/**
 * Builds everything behind the loading screen, reporting progress through
 * loader.stage(label, 0..1), and resolves once shaders are compiled and frames are flowing.
 * Returns { begin(event), summary } — begin() is called from the Play gesture.
 */
export async function startGame(loader) {
  const canvas = $('app');
  loader.stage('starting the graphics device', 0);
  let device;
  try {
    device = await createDevice(canvas);
  } catch (err) {
    console.error(err);
    throw new Error('This browser could not start WebGL 2 or WebGPU.');
  }

  const info = detectTier(device);
  const tier = info.tier;

  const opts = new pc.AppOptions();
  opts.graphicsDevice = device;
  // only the systems we use -> smaller bundle, less per-frame work
  opts.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem];
  opts.resourceHandlers = [];
  const app = new pc.AppBase(canvas);
  app.init(opts);
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);

  const quality = new QualityManager({
    startLevel: tier,
    maxLevel: tier,
    targetFps: info.mobile ? 50 : 55,
    onChange: (q) => applyQuality(q),
  });
  const savedQ = store.get('quality', 'auto');
  let glyph = store.get('glyphSize', 's');
  let asciiOn = store.get('ascii', '0') === '1'; // the painted view is the default; Scorched Sight is a toggle
  let palette = store.get('palette', 'color');

  const ascii = new AsciiRenderer(app);
  const layers = { world: ascii.layerWorld, reflect: ascii.layerReflect };
  const world = new World(app, layers, tier);
  const steps = world.steps();
  for (let i = 0; i < steps.length; i++) {
    loader.stage(steps[i][0], 0.1 + (i / steps.length) * 0.55);
    await nextFrame();
    steps[i][1]();
  }
  loader.stage('dressing the wanderer', 0.64);
  await nextFrame();
  const player = new Player(app, world, layers);
  const input = new Input(canvas);
  loader.stage('setting the old locks', 0.66);
  await nextFrame();
  const props = new Props(app, world, layers);
  const touchUI = info.mobile || navigator.maxTouchPoints > 0;
  document.body.classList.toggle('touch', touchUI);

  // subtitles: one line at a time, queued so nothing important is overwritten
  let toastTimer = 0;
  let shownFor = 0;
  const toastQueue = [];
  function showLine(msg, secs) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth; // restart the fade-in for each new line
    el.style.animation = '';
    toastTimer = secs;
    shownFor = 0;
  }
  function toast(msg, secs = 3) {
    if (toastTimer > 0 && shownFor < 2.2) {
      if (!toastQueue.some((q) => q[0] === msg)) toastQueue.push([msg, secs]);
      return;
    }
    showLine(msg, secs);
  }


  // 1x1 stand-in so the water shader always has a bound texture when reflections are off
  const dummy = new pc.Texture(device, { width: 1, height: 1, format: pc.PIXELFORMAT_RGBA8, mipmaps: false });
  const waterMat = world.mats.water;

  // ---------------------------------------------------------------- global uniforms
  const scope = device.scope;
  const U = (name) => scope.resolve(name);
  const u = {
    time: U('uTime'), moonDir: U('uMoonDir'), moonCol: U('uMoonCol'), skyAmb: U('uSkyAmb'), groundAmb: U('uGroundAmb'),
    lantern: U('uLantern'), lanternCol: U('uLanternCol'), player: U('uPlayer'), fog: U('uFog'), moonSky: U('uMoonSky'),
    wet: U('uWet'), pond: U('uPond'), sway: U('uSway'), emissive: U('uEmissive'), haze: U('uHaze'),
  };
  const moonDir = new Float32Array(SUN_DIR); // the low autumn sun (uniform keeps its old name)
  const v3 = { lantern: new Float32Array(4), lanternCol: new Float32Array(3), player: new Float32Array(3), fog: new Float32Array(4), moonSky: new Float32Array(3) };
  u.moonDir.setValue(moonDir);
  // Mood: late-afternoon autumn. A low warm sun behind the trees, cool blue-teal mist in the
  // distance and the shadows, and the lantern as the warmest light of all.
  const HAZE = [0.4, 0.5, 0.53];
  u.moonCol.setValue(new Float32Array([1.0, 0.74, 0.46]));
  u.skyAmb.setValue(new Float32Array([0.24, 0.31, 0.34]));
  u.groundAmb.setValue(new Float32Array([0.09, 0.075, 0.05]));
  u.haze.setValue(new Float32Array(HAZE));
  const monoU = U('uMono');
  monoU.setValue(palette === 'mono' ? 1 : 0);
  U('uNearFade').setValue(5.0); // metres: closer than this, geometry dithers away
  ascii.sceneCam.camera.clearColor = new pc.Color(HAZE[0], HAZE[1], HAZE[2], 0);
  u.pond.setValue(new Float32Array([WORLD.pond.x, WORLD.pond.z, WORLD.pond.r]));
  u.sway.setValue(0);
  u.emissive.setValue(0);

  // ---------------------------------------------------------------- quality
  let q = LEVELS[tier];
  function applyQuality(next) {
    q = next;
    device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, q.dpr);
    app.resizeCanvas();
    ascii.setOptions({ ss: q.ss, reflScale: q.refl, glyphSize: glyph, normalScale: q.nd, ascii: asciiOn });
    world.setQuality(q);
    ascii.sceneCam.camera.farClip = q.fog[1] + 4;
    v3.fog[0] = q.fog[0];
    v3.fog[1] = q.fog[1];
    v3.fog[2] = 0.6; // ground-mist density
    v3.fog[3] = 0.75; // ground-mist height falloff
    ascii.blitMat.setParameter('uBlur', q.blur);
    resized();
  }
  function resized() {
    if (!ascii.resize()) return;
    ascii.updateFov();
    waterMat.setParameter('uRtSize', new Float32Array(ascii.sceneSize));
    waterMat.setParameter('uRefl', ascii.reflectRT ? ascii.reflectRT.colorBuffer : dummy);
    waterMat.setParameter('uReflOn', ascii.reflectRT ? 1 : 0);
  }
  if (savedQ !== 'auto') quality.setManual(savedQ);
  applyQuality(quality.settings);
  window.addEventListener('resize', () => { app.resizeCanvas(); });
  setupFullscreen({
    button: $('btnFull'),
    canvas,
    touchDevice: info.mobile || navigator.maxTouchPoints > 0,
    onChange: () => app.resizeCanvas(),
  });

  // ---------------------------------------------------------------- camera rig
  const cam = { yaw: 0.35, pitch: info.mobile ? 0.66 : 0.52, dist: info.mobile ? 13 : 11, targetDist: info.mobile ? 13 : 11, t: 0 };
  const camPos = new pc.Vec3();
  const camTarget = new pc.Vec3().copy(player.pos);
  const tmpV = new pc.Vec3();
  const lanternPos = new pc.Vec3();
  const glowScr = new pc.Vec3();
  const glow = new Float32Array(4);

  function updateCamera(dt) {
    cam.yaw += input.consumeLook();
    cam.targetDist = clamp(cam.targetDist * (1 + input.consumeZoom()), 6, 22);
    cam.t += dt;
    // the death moment: push in on the wanderer as the ember dies
    const want = gameplay.dying > 0 ? Math.min(cam.targetDist, 6.5) : cam.targetDist;
    cam.dist += (want - cam.dist) * Math.min(1, dt * (gameplay.dying > 0 ? 2 : 8));
    const follow = 1 - Math.exp(-dt * 6);
    camTarget.x += (player.pos.x - camTarget.x) * follow;
    camTarget.y += (player.pos.y + 0.8 - camTarget.y) * follow;
    camTarget.z += (player.pos.z - camTarget.z) * follow;
    // slow handheld drift: the camera breathes a little, like someone is watching
    const sway = Math.sin(cam.t * 0.37) * 0.012 + Math.sin(cam.t * 0.83 + 1.3) * 0.006;
    let pitch = cam.pitch - (22 - cam.dist) * 0.006 + Math.sin(cam.t * 0.51) * 0.008;
    if (introT > 0) {
      // descend from high above the fog to the usual shoulder view
      const k = ease(Math.min(1, Math.max(0, (INTRO - introT - 3.2) / (INTRO - 3.2))));
      pitch = 1.32 + (pitch - 1.32) * k;
      cam.dist = 24 + (cam.targetDist - 24) * k;
    }
    const yaw = cam.yaw + sway;
    const cp = Math.cos(pitch);
    camPos.set(
      camTarget.x + Math.sin(yaw) * cp * cam.dist,
      camTarget.y + Math.sin(pitch) * cam.dist,
      camTarget.z + Math.cos(yaw) * cp * cam.dist,
    );
    const minY = world.height(camPos.x, camPos.z) + 1.5;
    if (camPos.y < minY) camPos.y = minY;
    ascii.sceneCam.setPosition(camPos);
    ascii.sceneCam.lookAt(camTarget);

    // faked sky: keep the moon where the water can show it — slightly off the view axis
    const az = cam.yaw + Math.PI + 0.32;
    const el = Math.max(0.2, pitch - 0.14); // reflects into the far half of the pond
    v3.moonSky[0] = Math.sin(az) * Math.cos(el);
    v3.moonSky[1] = Math.sin(el);
    v3.moonSky[2] = Math.cos(az) * Math.cos(el);

    // reflection camera only when the pond is actually on screen
    const pondVisible = ascii.sceneCam.camera.frustum.containsSphere(world.water.sphere) > 0;
    ascii.updateReflection(camPos, camTarget, WORLD.waterY, pondVisible && q.refl > 0);
  }

  // ---------------------------------------------------------------- the story
  loader.stage('waking the wardens', 0.69);
  await nextFrame();
  const gameplay = new Gameplay({ app, world, player, props, layers, cam, ascii, toast, isTouch: touchUI });
  camTarget.copy(player.pos);
  const lantern = gameplay.lanternPos;
  // ---------------------------------------------------------------- cold open (first start only)
  const INTRO = 7.2;
  let introT = 0;
  const fallen = new pc.Entity('fallingEmber');
  fallen.addComponent('render', { meshInstances: [new pc.MeshInstance(emberCoreMesh(device), worldMaterial({ emissive: 4 }))], layers: [layers.world.id], castShadows: false, receiveShadows: false });
  fallen.enabled = false;
  app.root.addChild(fallen);
  const skipIntro = () => { if (introT > 0.6) introT = 0.6; };
  window.addEventListener('keydown', skipIntro);
  canvas.addEventListener('pointerdown', skipIntro);
  const ease = (k) => k * k * (3 - 2 * k);
  const ringU = [U('uRing0'), U('uRing1'), U('uRing2')];
  const ringV = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
  const pushU = [U('uPush0'), U('uPush1')];
  const pushV = [new Float32Array(3), new Float32Array(3)];
  const mireU = U('uMire');
  const mireV = new Float32Array([WORLD.pond.x, WORLD.pond.z, 6, 0]);
  const ringGainU = U('uRingGain');
  const hazeColor = new pc.Color();
  for (const v of ringV) v[3] = 0;
  ringU.forEach((r, i) => r.setValue(ringV[i]));
  pushU.forEach((r, i) => r.setValue(pushV[i]));
  mireU.setValue(mireV);
  ringGainU.setValue(1);
  $('btnRestart').addEventListener('click', () => { Gameplay.clearSave(); location.reload(); });
  $('btnAgain').addEventListener('click', () => { Gameplay.clearSave(); location.reload(); });

  // ---------------------------------------------------------------- HUD / settings
  const statsEl = $('stats');
  let showStats = store.get('stats', '0') === '1' || new URLSearchParams(location.search).has('stats');
  statsEl.hidden = !showStats;
  $('optStats').checked = showStats;
  $('optQuality').value = savedQ;
  $('optGlyph').value = glyph;
  $('optPalette').value = palette;
  $('optPalette').addEventListener('change', (e) => {
    palette = e.target.value;
    store.set('palette', palette);
    monoU.setValue(palette === 'mono' ? 1 : 0);
    document.body.classList.toggle('mono', palette === 'mono');
  });
  document.body.classList.toggle('mono', palette === 'mono');
  $('optRenderer').value = store.get('renderer', 'auto');
  let paused = false;
  const openSettings = (open) => { $('settings').hidden = !open; paused = open; };
  $('btnSettings').addEventListener('click', () => openSettings(true));
  $('btnClose').addEventListener('click', () => openSettings(false));
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape') openSettings($('settings').hidden); });
  $('optQuality').addEventListener('change', (e) => {
    store.set('quality', e.target.value);
    quality.setManual(e.target.value);
    if (e.target.value === 'auto') quality.maxLevel = tier;
  });
  $('optGlyph').addEventListener('change', (e) => {
    glyph = e.target.value;
    store.set('glyphSize', glyph);
    ascii.setOptions({ glyphSize: glyph });
    resized();
  });
  $('optRenderer').addEventListener('change', (e) => {
    store.set('renderer', e.target.value);
    const url = new URL(location.href);
    url.searchParams.delete('gpu');
    location.replace(url.toString());
  });
  $('optStats').addEventListener('change', (e) => {
    showStats = e.target.checked;
    statsEl.hidden = !showStats;
    store.set('stats', showStats ? '1' : '0');
  });
  // ASCII filter toggle (top-right): same world, glyphs on/off
  const btnAscii = $('btnAscii');
  const syncAsciiBtn = () => {
    btnAscii.classList.toggle('on', asciiOn);
    btnAscii.setAttribute('aria-pressed', String(asciiOn));
    btnAscii.textContent = asciiOn ? '[ @ ]' : '[ I ]';
  };
  const setAscii = (on) => {
    asciiOn = on;
    gameplay.onSight(); // Scorched Sight: the heat pulse shocks moths off the lantern
    store.set('ascii', on ? '1' : '0');
    ascii.setOptions({ ascii: on });
    resized();
    syncAsciiBtn();
  };
  btnAscii.addEventListener('click', (e) => { e.stopPropagation(); setAscii(!asciiOn); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyV' && !(e.target instanceof HTMLSelectElement)) setAscii(!asciiOn);
  });
  syncAsciiBtn();
  document.addEventListener('visibilitychange', () => { app.timeScale = document.hidden ? 0 : 1; });

  // ---------------------------------------------------------------- frame loop
  let time = 0;
  let statsTimer = 0;
  let started = false;
  const WARM_PER_VIEW = 3;
  let warmFrames = 0; // > 0 while the loading screen pre-renders everything
  let onWarm = null;
  app.on('update', (rawDt) => {
    if (started) quality.sample(rawDt);
    const dt = Math.min(rawDt, 1 / 20); // avoid tunnelling after hitches
    if (device.width && device.height) resized();
    if (!paused) time += dt;

    input.poll(dt);
    if (input.sightPressed) setAscii(!asciiOn);
    player.lanternWorldPos(lantern);
    // an open note on a standing stone pauses the world (monsters too) until it is folded
    if (started && !paused && gameplay.reading) gameplay.readingFrame(dt, input);
    const playing = started && !paused && !gameplay.reading;
    if (introT > 0 && playing) {
      introT = Math.max(0, introT - dt);
      const e = INTRO - introT;
      // the ember falls from the white sky onto the crumpled wanderer, who rises
      const fallK = Math.min(1, e / 3.4);
      fallen.enabled = fallK < 1;
      if (fallen.enabled) {
        const s = 0.5 + fallK * 0.3;
        fallen.setPosition(player.pos.x + (1 - fallK) * 3, player.pos.y + 1.2 + (1 - fallK * fallK) * 34, player.pos.z - (1 - fallK) * 6);
        fallen.setLocalScale(s, s, s);
      }
      if (e > 3.4 && !gameplay.introFlash) { gameplay.introFlash = true; sfx.play('ignite', player.pos, { vol: 0.8 }); }
      player.dead = Math.max(0, 1 - Math.max(0, e - 3.6) / 2.4);
      input.move.x = input.move.y = 0;
      input.staffPressed = input.shutter = input.staffHeld = false;
      if (introT === 0) {
        player.dead = 0;
        toast(LINES.start, 4);
        if (touchUI) setTimeout(() => toast(LINES.tools, 5), 4500); // keyboard players have the keycap hint bar
      }
    }
    if (playing) {
      gameplay.update(dt, input, asciiOn);
      player.update(dt, input, cam.yaw, time, {
        slow: gameplay.slow,
        locked: gameplay.dying > 0 || !!gameplay.ending || player.crankT > 0,
        playRadius: props.exitGate.open > 0.5 ? 70 : WORLD.playRadius,
        shutter: input.shutter,
      });
    }
    updateCamera(dt);
    world.update(camTarget.x, camTarget.z, camPos.x, camPos.z);
    if (warmFrames > 0) {
      // loading screen: draw every cluster + reflections so every shader/pipeline compiles now
      world.showEverything();
      ascii.sceneCam.camera.frustumCulling = false;
      ascii.updateReflection(camPos, camTarget, WORLD.waterY, true);
      --warmFrames;
      if (warmFrames === WARM_PER_VIEW) {
        // first half compiled the other view; now compile the one the player will start in
        loader.stage(`compiling shaders (${asciiOn ? 'ASCII' : 'normal'} view)`, 0.84);
        ascii.setOptions({ ascii: asciiOn });
        resized();
      }
      for (const b of props.beams) b.e.enabled = warmFrames > 0;
      if (warmFrames === 0) {
        ascii.sceneCam.camera.frustumCulling = true;
        onWarm();
      }
    }

    // per-frame shared uniforms (set once, read by every material)
    const flicker = 0.92 + Math.sin(time * 13.1) * 0.04 + Math.sin(time * 7.3) * 0.04;
    const fl = 0.35 + 0.65 * gameplay.flame;
    v3.lantern[0] = lantern.x; v3.lantern[1] = lantern.y; v3.lantern[2] = lantern.z; v3.lantern[3] = Math.max(0.01, gameplay.lightRadius);
    if (gameplay.lightWarm) {
      v3.lanternCol[0] = 0.95 * flicker * fl; v3.lanternCol[1] = 0.55 * flicker * fl; v3.lanternCol[2] = 0.2 * flicker * fl;
    } else {
      // a moth on the glass: the flame shrinks to a tiny blue spark
      v3.lanternCol[0] = 0.25 * flicker; v3.lanternCol[1] = 0.4 * flicker; v3.lanternCol[2] = 0.9 * flicker;
    }
    const shut = gameplay.g.lightOpen === false;
    player.lanternMat.setParameter('uEmissive', shut ? 0.12 : gameplay.lightWarm ? 2.2 * fl : 0.6);
    player.faceMat.setParameter('uEmissive', gameplay.dying ? 0 : 1.2 + gameplay.flame);
    // fog / haze from quality x story progress (the white sky breaking through)
    v3.fog[0] = q.fog[0] * gameplay.fogScale;
    v3.fog[1] = q.fog[1] * gameplay.fogScale;
    ascii.sceneCam.camera.farClip = v3.fog[1] + 4;
    u.haze.setValue(gameplay.haze);
    hazeColor.set(gameplay.haze[0], gameplay.haze[1], gameplay.haze[2], 0);
    ascii.sceneCam.camera.clearColor = hazeColor;
    gameplay.rings.forEach((R, i) => { const v = ringV[i]; v[0] = R.x; v[1] = R.z; v[2] = R.r; v[3] = R.a; ringU[i].setValue(v); });
    ringGainU.setValue(gameplay.ringGain);
    gameplay.hounds.forEach((h, i) => { const v = pushV[i]; v[0] = h.x; v[1] = 0; v[2] = h.z; pushU[i].setValue(v); });
    const m = gameplay.mire;
    mireV[0] = m.x; mireV[1] = m.z; mireV[2] = 6 + m.alert * 3; mireV[3] = Math.min(1, Math.max(0, (m.alert - 0.12) / 0.6));
    mireU.setValue(mireV);
    sfx.setListener(player.pos.x, player.pos.z, cam.yaw);
    v3.player[0] = player.pos.x; v3.player[1] = player.pos.y; v3.player[2] = player.pos.z;
    u.time.setValue(time);
    u.lantern.setValue(v3.lantern);
    u.lanternCol.setValue(v3.lanternCol);
    u.player.setValue(v3.player);
    u.fog.setValue(v3.fog);
    u.moonSky.setValue(v3.moonSky);
    u.wet.setValue(player.wet);
    // warm halo around the lantern (normal view)
    if (!asciiOn) {
      ascii.sceneCam.camera.worldToScreen(lantern, glowScr);
      const cw = canvas.clientWidth || 1, chh = canvas.clientHeight || 1;
      glow[0] = glowScr.x / cw;
      glow[1] = 1 - glowScr.y / chh;
      glow[2] = 0.09 + 0.08 * (11 / cam.dist) * 0.5;
      glow[3] = glowScr.z > 0 && gameplay.lightRadius > 1 ? 0.2 * flicker * fl * (gameplay.lightWarm ? 1 : 0.3) : 0;
      ascii.blitMat.setParameter('uGlow', glow);
    }
    ascii.cellMat.setParameter('uTime', time);

    if (toastTimer > 0) {
      toastTimer -= dt;
      shownFor += dt;
      // a waiting line takes over once the current one has been readable for a moment
      if (toastQueue.length && shownFor > 2.2) { const [m, t] = toastQueue.shift(); showLine(m, t); }
      else if (toastTimer <= 0) $('toast').hidden = true;
    } else if (toastQueue.length) { const [m, t] = toastQueue.shift(); showLine(m, t); }

    statsTimer -= rawDt;
    if (showStats && statsTimer <= 0) {
      statsTimer = 0.5;
      statsEl.textContent =
        `${quality.fps.toFixed(0)} fps  ${quality.ms.toFixed(1)} ms\n` +
        `${device.isWebGPU ? 'WebGPU' : 'WebGL2'}  tier ${tier}  q ${LEVELS[quality.level].name}${quality.auto ? ' (auto)' : ''}\n` +
        (asciiOn ? `grid ${ascii.cols}x${ascii.rows}  scene ${ascii.sceneSize[0]}x${ascii.sceneSize[1]}\n` : `normal view  3D ${ascii.sceneSize[0]}x${ascii.sceneSize[1]}\n`) +
        `canvas ${device.width}x${device.height} @${device.maxPixelRatio.toFixed(2)}\n` +
        `clusters ${world.visibleClusters}/${world.clusters.length}  refl ${ascii.reflectCam.enabled ? 'on' : 'off'}\n` +
        `flame ${gameplay.flame.toFixed(2)}  mire ${gameplay.mire.alert.toFixed(2)}  cp ${gameplay.s.cp}\n` +
        `${info.renderer.slice(0, 42)}`;
    }
  });

  window.__moonglade = { app, ascii, world, player, quality, device, cam, gameplay, props, layout: LAYOUT };

  // ---------------------------------------------------------------- shader warm-up
  // Both views are warmed: a few frames in the view the player is NOT starting in, then a few
  // in the one they are, so toggling the ASCII filter later never stalls on shader compiles.
  loader.stage(`compiling shaders (${asciiOn ? 'normal' : 'ASCII'} view)`, 0.72);
  await nextFrame();
  const warmed = new Promise((resolve) => { onWarm = resolve; });
  ascii.setOptions({ ascii: !asciiOn });
  resized();
  warmFrames = WARM_PER_VIEW * 2;
  app.start(); // first frames compile every shader variant behind the loading screen
  await warmed;
  loader.stage('settling in', 0.92);
  await nextFrame();
  await nextFrame(); // a couple of normal frames so the first visible one is already smooth

  return {
    summary: `${device.isWebGPU ? 'WebGPU' : 'WebGL 2'} · ${LEVELS[quality.level].name} quality`,
    begin(e) {
      if (started) return;
      started = true;
      quality.cooldown = 3;
      sfx.initAudio(); // audio may only start inside the Play gesture
      $('actions').hidden = !touchUI;
      // must run synchronously inside the user gesture or the browser refuses fullscreen
      if (e) enterFullscreen();
      $('hud').hidden = false;
      canvas.focus();
      if (info.mobile && !fullscreenSupported && !isInstalledApp()) {
        // iPhone Safari: no fullscreen API for pages; the home-screen app has no browser bar
        toast('For true fullscreen: Share → Add to Home Screen', 6);
      } else if (gameplay.hasSave || new URLSearchParams(location.search).has('autostart')) {
        toast(gameplay.hasSave ? 'The ember remembers where it was.' : LINES.start, 4);
        if (touchUI) setTimeout(() => toast(LINES.tools, 5), 4500);
      } else {
        introT = INTRO;
        player.dead = 1;
        toast('An ember fell from the scorched white cliffs...', 3.4);
        setTimeout(() => { if (introT > 0) toast('...into a basin of fog that was never meant for light.', 3.6); }, 3500);
      }
    },
  };
}
