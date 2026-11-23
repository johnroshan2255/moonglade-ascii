// Procedural audio: every sound is synthesised with WebAudio at runtime (zero downloads,
// tiny CPU cost). Sounds are spatialised with distance attenuation + stereo pan relative to
// the camera, and share one convolution reverb for the foggy, hollow space.

let ctx = null;
let master, sfxBus, reverbSend, ambBus;
let noiseBuf = null;
const listener = { x: 0, z: 0, yaw: 0 };

function makeNoise(seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function makeImpulse(seconds = 2.8, decay = 2.2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/** Must be called from a user gesture (Play button). */
export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC({ latencyHint: 'interactive' });
  master = ctx.createGain();
  master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.connect(master);
  ambBus = ctx.createGain();
  ambBus.gain.value = 0.0;
  ambBus.connect(master);
  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse();
  reverbSend = ctx.createGain();
  reverbSend.gain.value = 0.35;
  reverbSend.connect(reverb).connect(master);
  noiseBuf = makeNoise(2);
  startAmbience();
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });
}

export function setListener(x, z, yaw) {
  listener.x = x;
  listener.z = z;
  listener.yaw = yaw;
}

export function setMasterVolume(v) {
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.4);
}

// ------------------------------------------------------------------ building blocks
/** Output node for a sound at world (x,z) (or non-positional when x is undefined). */
function out(pos, vol = 1, maxDist = 40, wet = 0.6) {
  const g = ctx.createGain();
  let gain = vol;
  let pan = 0;
  if (pos && pos.x !== undefined) {
    const dx = pos.x - listener.x, dz = pos.z - listener.z;
    const d = Math.hypot(dx, dz);
    gain *= Math.max(0, 1 - d / maxDist) ** 1.6;
    // camera right vector = (cos yaw, -sin yaw) in x/z
    const right = (dx * Math.cos(listener.yaw) - dz * Math.sin(listener.yaw)) / Math.max(d, 1);
    pan = Math.max(-1, Math.min(1, right)) * 0.8;
  }
  g.gain.value = gain;
  let node = g;
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    node = p;
  }
  node.connect(sfxBus);
  if (wet > 0) {
    const s = ctx.createGain();
    s.gain.value = wet;
    node.connect(s).connect(reverbSend);
  }
  return g;
}

function noise(dest, t0, dur, { type = 'bandpass', freq = 1000, q = 1, attack = 0.005, peak = 1, release, freqEnd } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + (release ?? dur));
  src.connect(f).connect(g).connect(dest);
  src.start(t0, Math.random());
  src.stop(t0 + dur + 0.1);
}

function tone(dest, t0, dur, { freq = 440, type = 'sine', attack = 0.004, peak = 0.5, freqEnd, detune = 0 } = {}) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  o.detune.value = detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(dest);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// ------------------------------------------------------------------ the sound list
const SFX = {
  shutter(d, t) {
    noise(d, t, 0.06, { type: 'highpass', freq: 3000, peak: 0.6 });
    tone(d, t, 0.12, { freq: 2300, peak: 0.12, type: 'triangle' });
    tone(d, t + 0.03, 0.1, { freq: 1700, peak: 0.08, type: 'triangle' });
  },
  flash(d, t) {
    noise(d, t, 0.7, { type: 'bandpass', freq: 400, freqEnd: 2400, q: 0.7, attack: 0.05, peak: 0.5 });
  },
  staff(d, t) {
    noise(d, t, 0.18, { type: 'bandpass', freq: 900, q: 3, peak: 0.9 });
    tone(d, t, 0.9, { freq: 1430, peak: 0.12, type: 'triangle' });
    tone(d, t, 0.5, { freq: 610, peak: 0.1, type: 'sine' });
  },
  staffMetal(d, t) {
    noise(d, t, 0.12, { type: 'highpass', freq: 1500, peak: 0.6 });
    tone(d, t, 2.0, { freq: 980, peak: 0.16 });
    tone(d, t, 1.6, { freq: 2650, peak: 0.07 });
  },
  chime(d, t, opt) {
    const f = opt.freq || 440;
    tone(d, t, 2.8, { freq: f, peak: 0.28 });
    tone(d, t, 1.8, { freq: f * 2.76, peak: 0.09 });
    tone(d, t, 1.1, { freq: f * 5.4, peak: 0.04 });
  },
  chimeWrong(d, t) {
    tone(d, t, 0.5, { freq: 180, peak: 0.25, type: 'square' });
    noise(d, t, 0.25, { type: 'lowpass', freq: 600, peak: 0.4 });
  },
  valve(d, t) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(260, t);
    o.frequency.linearRampToValueAtTime(330 + Math.random() * 60, t + 0.45);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(f).connect(g).connect(d);
    o.start(t);
    o.stop(t + 0.55);
    noise(d, t, 0.6, { type: 'lowpass', freq: 500, peak: 0.25, attack: 0.1 });
  },
  gate(d, t) {
    noise(d, t, 5.5, { type: 'lowpass', freq: 220, q: 0.8, attack: 0.4, peak: 0.9, release: 5.4 });
    tone(d, t, 5.5, { freq: 38, peak: 0.35, attack: 0.5, type: 'triangle' });
    for (let i = 0; i < 6; i++) noise(d, t + 0.4 + i * 0.8, 0.3, { type: 'bandpass', freq: 300 + Math.random() * 200, q: 2, peak: 0.4 });
  },
  sigh(d, t) {
    noise(d, t, 2.4, { type: 'bandpass', freq: 650, freqEnd: 240, q: 4, attack: 0.6, peak: 0.55, release: 2.3 });
    noise(d, t + 0.2, 2.0, { type: 'bandpass', freq: 1150, freqEnd: 500, q: 6, attack: 0.5, peak: 0.25 });
  },
  churn(d, t) {
    noise(d, t, 2.2, { type: 'lowpass', freq: 140, q: 1.5, attack: 0.3, peak: 1.0 });
    for (let i = 0; i < 7; i++) tone(d, t + Math.random() * 1.6, 0.12, { freq: 120 + Math.random() * 220, freqEnd: 400 + Math.random() * 300, peak: 0.12 });
  },
  skitter(d, t) {
    for (let i = 0; i < 12; i++) noise(d, t + i * 0.045 + Math.random() * 0.02, 0.02, { type: 'highpass', freq: 4000, peak: 0.35 });
    noise(d, t, 0.7, { type: 'bandpass', freq: 2500, q: 0.6, attack: 0.05, peak: 0.25 });
  },
  growl(d, t) {
    tone(d, t, 0.9, { freq: 70, freqEnd: 55, type: 'sawtooth', peak: 0.12, attack: 0.1 });
    noise(d, t, 0.9, { type: 'lowpass', freq: 300, peak: 0.3, attack: 0.1 });
  },
  bite(d, t) {
    noise(d, t, 0.15, { type: 'bandpass', freq: 1800, q: 1, peak: 0.8 });
    tone(d, t, 0.25, { freq: 140, freqEnd: 60, type: 'square', peak: 0.2 });
  },
  flutter(d, t) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1300;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 22;
    const lg = ctx.createGain();
    lg.gain.value = 0.25;
    lfo.connect(lg).connect(g.gain);
    src.connect(f).connect(g).connect(d);
    src.start(t);
    lfo.start(t);
    src.stop(t + 0.9);
    lfo.stop(t + 0.9);
    noise(d, t + 0.1, 0.8, { type: 'highpass', freq: 5000, peak: 0.15, attack: 0.2 });
  },
  toll(d, t) {
    const base = 98;
    [[1, 0.35, 6], [2.0, 0.2, 4.5], [2.42, 0.14, 4], [3.0, 0.1, 3], [4.16, 0.08, 2.5], [5.43, 0.05, 2]].forEach(([m, p, dur]) => {
      tone(d, t, dur, { freq: base * m, peak: p, attack: 0.002, detune: (Math.random() - 0.5) * 8 });
    });
    noise(d, t, 0.15, { type: 'bandpass', freq: 600, peak: 0.5 });
  },
  scrape(d, t) {
    noise(d, t, 1.3, { type: 'bandpass', freq: 2200, freqEnd: 1600, q: 8, attack: 0.1, peak: 0.3 });
    noise(d, t, 1.3, { type: 'lowpass', freq: 400, peak: 0.2, attack: 0.1 });
  },
  wardenStep(d, t) {
    tone(d, t, 0.4, { freq: 55, freqEnd: 38, type: 'sine', peak: 0.5 });
    noise(d, t, 0.2, { type: 'lowpass', freq: 220, peak: 0.4 });
  },
  step(d, t) {
    noise(d, t, 0.09, { type: 'lowpass', freq: 700 + Math.random() * 300, peak: 0.25 });
  },
  splash(d, t) {
    noise(d, t, 0.35, { type: 'bandpass', freq: 1400, q: 0.8, peak: 0.35, attack: 0.02 });
  },
  snuff(d, t) {
    noise(d, t, 1.6, { type: 'highpass', freq: 2800, attack: 0.05, peak: 0.6, release: 1.5 });
  },
  death(d, t) {
    tone(d, t, 2.5, { freq: 60, freqEnd: 28, peak: 0.6, type: 'sine', attack: 0.02 });
    noise(d, t, 2.0, { type: 'highpass', freq: 2000, peak: 0.5, attack: 0.02 });
  },
  pickupSpark(d, t) {
    [523, 659, 784].forEach((f, i) => tone(d, t + i * 0.07, 1.2, { freq: f, peak: 0.1 }));
  },
  pickupCore(d, t) {
    [196, 247, 294, 392].forEach((f, i) => tone(d, t + i * 0.09, 2.0, { freq: f, peak: 0.13, type: 'triangle' }));
  },
  ignite(d, t) {
    noise(d, t, 2.0, { type: 'bandpass', freq: 300, freqEnd: 1600, q: 0.8, attack: 0.08, peak: 0.8, release: 1.9 });
    tone(d, t, 2.4, { freq: 82, peak: 0.25, type: 'triangle' });
  },
  heartbeat(d, t) {
    tone(d, t, 0.25, { freq: 55, freqEnd: 40, peak: 0.45 });
    tone(d, t + 0.28, 0.25, { freq: 50, freqEnd: 38, peak: 0.35 });
  },
  sting(d, t) {
    [233, 247, 349].forEach((f) => tone(d, t, 3.5, { freq: f, peak: 0.07, type: 'sawtooth', attack: 0.02 }));
    noise(d, t, 2.0, { type: 'highpass', freq: 3500, peak: 0.12, attack: 0.02 });
  },
};

/**
 * Plays a sound. pos = {x, z} for positional sounds (omit for UI / player-attached).
 * opt: { vol, maxDist, wet, freq }
 */
export function play(name, pos, opt = {}) {
  if (!ctx || ctx.state !== 'running') return;
  const fn = SFX[name];
  if (!fn) return;
  const d = out(pos, opt.vol ?? 1, opt.maxDist ?? 40, opt.wet ?? 0.5);
  fn(d, ctx.currentTime + 0.005, opt);
  setTimeout(() => { try { d.disconnect(); } catch { /* gone */ } }, 9000);
}

// ------------------------------------------------------------------ ambience
let wind, drone, droneGain;
function startAmbience() {
  // wind: looping noise through a slowly wandering band-pass
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 420;
  f.Q.value = 0.7;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  const lg = ctx.createGain();
  lg.gain.value = 260;
  lfo.connect(lg).connect(f.frequency);
  const g = ctx.createGain();
  g.gain.value = 0.22;
  const lfo2 = ctx.createOscillator();
  lfo2.frequency.value = 0.11;
  const lg2 = ctx.createGain();
  lg2.gain.value = 0.1;
  lfo2.connect(lg2).connect(g.gain);
  src.connect(f).connect(g).connect(ambBus);
  src.start();
  lfo.start();
  lfo2.start();
  wind = g;
  // low drone: two detuned sines, felt more than heard
  droneGain = ctx.createGain();
  droneGain.gain.value = 0.07;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 180;
  for (const fr of [55, 55.6, 82.4]) {
    const o = ctx.createOscillator();
    o.frequency.value = fr;
    o.type = 'triangle';
    o.connect(lp);
    o.start();
  }
  lp.connect(droneGain).connect(ambBus);
  drone = lp;
  ambBus.gain.setTargetAtTime(1, ctx.currentTime, 2.5);
  // distant creaks now and then
  const creak = () => {
    if (ctx.state === 'running') {
      const a = Math.random() * Math.PI * 2;
      play(Math.random() < 0.6 ? 'scrape' : 'valve', { x: listener.x + Math.cos(a) * 25, z: listener.z + Math.sin(a) * 25 }, { vol: 0.25, maxDist: 60, wet: 1 });
    }
    setTimeout(creak, 9000 + Math.random() * 14000);
  };
  setTimeout(creak, 8000);
}

/** 0 = calm, 1 = something is right next to you. */
export function setTension(v) {
  if (!droneGain) return;
  droneGain.gain.setTargetAtTime(0.07 + v * 0.22, ctx.currentTime, 0.5);
  if (wind) wind.gain.setTargetAtTime(0.22 - v * 0.1, ctx.currentTime, 0.8);
}

/** Muffles everything (shutter closed / snuffed). */
export function setMuffle(v) {
  if (!sfxBus) return;
  sfxBus.gain.setTargetAtTime(1 - v * 0.5, ctx.currentTime, 0.2);
}
