// Tiny entry module: paints the loading screen immediately, then pulls in the engine + game
// (a separate chunk) and drives the real loading steps with a progress bar.
// Nothing here imports PlayCanvas, so this file is a few KB and runs before the engine arrives.

const $ = (id) => document.getElementById(id);
// colour or monochrome title card, matching the player's saved choice
try { if (localStorage.getItem('moonglade.palette') === 'mono') document.body.classList.add('mono'); } catch { /* */ }
const els = {
  boot: $('boot'), bar: $('loadFill'), pct: $('loadPct'), stage: $('stageText'), spin: $('spin'), grain: document.querySelector('#boot .grain'),
  play: $('btnPlay'), tip: $('tip'), info: $('bootInfo'), progress: $('loadProgress'),
};

const TIPS = [
  'Carry the last flame out of the fog.',
  'In the tall grass, stand completely still.',
  'Never let the lake see your light.',
  'Strike stone with the staff to throw a sound.',
  'The tall one at the shrine is blind. Walk softly.',
  'Headphones recommended.',
];

// ------------------------------------------------------------------ progress animation
let shown = 0;
let target = 0;
let downloading = true;
let dlStart = performance.now();
let finished = false;

// film grain: a few noise tiles made once, cycled cheaply
const grainTiles = (() => {
  const tiles = [];
  try {
    for (let n = 0; n < 4; n++) {
      const c = document.createElement('canvas');
      c.width = c.height = 120;
      const x = c.getContext('2d');
      const img = x.createImageData(120, 120);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      tiles.push(`url(${c.toDataURL()})`);
    }
  } catch { /* no canvas: no grain */ }
  return tiles;
})();
let grainI = 0, grainT = 0;

function render(now) {
  if (downloading) {
    // engine download: we can't see bytes of a dynamic import, so ease towards 30%
    const t = (now - dlStart) / 1000;
    target = Math.max(target, 0.3 * (1 - Math.exp(-t / 1.6)));
  }
  shown += (target - shown) * (finished ? 0.3 : 0.12);
  if (target - shown < 0.002) shown = target;
  els.bar.style.width = `${(shown * 100).toFixed(1)}%`;
  const p = Math.round(shown * 100);
  els.pct.textContent = finished ? '' : `${p}%`;
  els.progress.setAttribute('aria-valuenow', String(p));
  if (grainTiles.length && now - grainT > 85) {
    grainT = now;
    grainI = (grainI + 1) % grainTiles.length;
    els.grain.style.backgroundImage = grainTiles[grainI];
    // one noise pixel per device pixel: fine and crisp, never smeared
    if (!els.grain.style.backgroundSize) els.grain.style.backgroundSize = `${120 / (window.devicePixelRatio || 1)}px`;
  }
  if (els.boot.isConnected) requestAnimationFrame(render);
}
requestAnimationFrame(render);

let tipI = 0;
const tipTimer = setInterval(() => {
  tipI = (tipI + 1) % TIPS.length;
  els.tip.textContent = TIPS[tipI];
}, 3800);

const loader = {
  /** label shown to the player; f = 0..1 progress inside the game-setup phase */
  stage(label, f) {
    els.stage.textContent = label;
    target = Math.max(target, 0.3 + Math.min(1, f) * 0.7);
  },
};

function setButton(label) {
  els.play.textContent = label;
  els.play.setAttribute('aria-label', label);
}

// ------------------------------------------------------------------ errors
function fail(message, { offerWebGL = false } = {}) {
  finished = true;
  clearInterval(tipTimer);
  els.boot.classList.add('error');
  els.stage.textContent = message;
  els.play.hidden = false;
  setButton(offerWebGL ? 'RETRY WITH WEBGL 2' : 'RETRY');
  els.play.onclick = () => {
    const url = new URL(location.href);
    if (offerWebGL) url.searchParams.set('gpu', 'webgl2');
    location.replace(url.toString());
  };
}

function gpuSupported() {
  if (navigator.gpu) return true;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      gl.getExtension('WEBGL_lose_context')?.loseContext(); // free the probe context right away
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ------------------------------------------------------------------ boot sequence
async function boot() {
  if (!gpuSupported()) {
    fail('This browser/device has no WebGL 2 or WebGPU. Try an updated Chrome, Safari or Firefox.');
    return;
  }
  els.stage.textContent = 'gathering the fog';

  let mod;
  try {
    // starts the engine + game chunk download; the HTML is already on screen
    [mod] = await Promise.all([import('./game.js'), document.fonts?.ready]);
  } catch (err) {
    console.error(err);
    fail('Could not download the game. Check your connection and retry.');
    return;
  }
  downloading = false;
  target = Math.max(target, 0.3);

  let game;
  try {
    game = await mod.startGame(loader);
  } catch (err) {
    console.error(err);
    const usedWebGPU = new URLSearchParams(location.search).get('gpu') !== 'webgl2';
    fail(err?.message || 'Something went wrong while starting the game.', { offerWebGL: usedWebGPU });
    return;
  }

  // ready
  target = 1;
  finished = true;
  clearInterval(tipTimer);
  els.stage.textContent = '';
  els.info.textContent = game.summary;
  els.boot.classList.add('ready');
  setButton('PLAY');
  els.play.hidden = false;
  els.play.focus({ preventScroll: true });

  let begun = false;
  const begin = (e) => {
    if (begun) return;
    if (e && e.type === 'keydown' && !['Enter', 'Space', 'NumpadEnter'].includes(e.code)) return;
    begun = true;
    if (e) e.preventDefault();
    game.begin(e); // the Play gesture is what lets us go fullscreen
    els.boot.classList.add('fade');
    setTimeout(() => els.boot.remove(), 650);
    window.removeEventListener('keydown', begin);
  };
  // click (not pointerdown): on touch screens only the release counts as a user activation
  els.play.addEventListener('click', begin);
  window.addEventListener('keydown', begin);
  if (new URLSearchParams(location.search).has('autostart')) begin();
}

boot();

// Offline cache + instant repeat loads (production only; dev server must stay uncached)
// Not inside an iframe (itch.io, game portals): their CDN serves each upload fresh, and a cached
// service worker there would keep players on an old build after you upload an update.
const embedded = (() => { try { return window.self !== window.top; } catch { return true; } })();
if (import.meta.env.PROD && !embedded && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* optional */ });
  });
}
