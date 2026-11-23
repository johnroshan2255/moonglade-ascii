// Device tiering + adaptive quality.
//
// Startup: guess a tier from device memory, core count, screen and GPU renderer string.
// Runtime: watch the real frame time and step the level down quickly when we miss the target,
// up slowly (with hysteresis + cooldown) when there is plenty of headroom.

export const LEVELS = [
  // 0 "potato": old / low-end phones
  { name: 'potato', dpr: 2.0, nd: 0.6, ss: 1, refl: 0, grass: 0.0, fireflies: 40, drawDistance: 34, fog: [8, 32], blur: 0 },
  { name: 'low', dpr: 2.5, nd: 0.8, ss: 1, refl: 0, grass: 0.4, fireflies: 90, drawDistance: 38, fog: [9, 36], blur: 0 },
  { name: 'medium', dpr: 3.0, nd: 1.0, ss: 1, refl: 0.5, grass: 0.7, fireflies: 160, drawDistance: 42, fog: [10, 40], blur: 0.004 },
  { name: 'high', dpr: 3.0, nd: 1.5, ss: 2, refl: 0.5, grass: 1.0, fireflies: 260, drawDistance: 48, fog: [11, 46], blur: 0.006 },
  { name: 'ultra', dpr: 3.0, nd: 2.0, ss: 2, refl: 1.0, grass: 1.0, fireflies: 400, drawDistance: 54, fog: [12, 52], blur: 0.007 },
];

export function isMobile() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Silk|KFAPWI/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

const LOW_GPU = /(Mali-[2-4]\d\d|Mali-T\d|Mali-G(31|51|52|57)\b|Adreno \(TM\) [1-5]\d\d|Adreno [1-5]\d\d|PowerVR|SGX|IMG|Intel\(R\) (HD|UHD) Graphics( [2-6]\d\d)?\b|GMA|SwiftShader|llvmpipe|Software)/i;
const HIGH_GPU = /(RTX|Radeon RX|Radeon Pro|Apple M\d|Apple GPU|GeForce GTX 1[0-9]|Arc|Adreno \(TM\) [7-8]\d\d|Mali-G7[1-9]|Mali-G[7-9]\d\d|Immortalis)/i;

export function detectTier(device) {
  const mobile = isMobile();
  const mem = navigator.deviceMemory || (mobile ? 3 : 8);
  const cores = navigator.hardwareConcurrency || 4;
  let renderer = '';
  try {
    if (device.isWebGPU) {
      renderer = device.gpuAdapter?.info?.description || device.gpuAdapter?.info?.architecture || '';
    } else {
      const gl = device.gl;
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : '');
    }
  } catch { /* ignore */ }

  let tier;
  if (mobile) {
    if (mem <= 2 || cores <= 4 || LOW_GPU.test(renderer)) tier = 0;
    else if (mem <= 4) tier = 1;
    else tier = HIGH_GPU.test(renderer) ? 3 : 2;
  } else {
    if (LOW_GPU.test(renderer) || mem <= 4) tier = 2;
    else tier = HIGH_GPU.test(renderer) ? 4 : 3;
  }
  return { tier, renderer, mobile, mem, cores };
}

export class QualityManager {
  constructor({ startLevel, maxLevel, targetFps, onChange }) {
    this.level = startLevel;
    this.maxLevel = maxLevel;
    this.auto = true;
    this.targetMs = 1000 / targetFps;
    this.onChange = onChange;
    this.acc = 0;
    this.frames = 0;
    this.slowWindows = 0;
    this.fastWindows = 0;
    this.cooldown = 3; // seconds before the first adjustment (shader warm-up)
    this.lastDropAt = -1e9;
    this.clock = 0;
    this.fps = 0;
    this.ms = 0;
  }

  get settings() { return LEVELS[this.level]; }

  setManual(level) {
    if (level === 'auto') {
      this.auto = true;
      return;
    }
    this.auto = false;
    this.set(Number(level));
  }

  set(level) {
    level = Math.max(0, Math.min(LEVELS.length - 1, level));
    if (level === this.level) return;
    this.level = level;
    this.onChange(LEVELS[level], level);
  }

  /** Feed the real (unclamped) frame delta in seconds. */
  sample(dt) {
    this.clock += dt;
    this.acc += dt;
    this.frames++;
    if (this.acc < 1) return;
    const avgMs = (this.acc / this.frames) * 1000;
    this.ms = avgMs;
    this.fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    if (!this.auto) return;
    if (this.cooldown > 0) { this.cooldown -= 1; return; }

    if (avgMs > this.targetMs * 1.2) {
      this.slowWindows++;
      this.fastWindows = 0;
    } else if (avgMs < this.targetMs * 0.75) {
      this.fastWindows++;
      this.slowWindows = 0;
    } else {
      this.slowWindows = 0;
      this.fastWindows = 0;
    }

    if (this.slowWindows >= 2 && this.level > 0) {
      this.set(this.level - 1);
      this.slowWindows = 0;
      this.cooldown = 2;
      this.lastDropAt = this.clock;
    } else if (this.fastWindows >= 6 && this.level < this.maxLevel && this.clock - this.lastDropAt > 20) {
      // only climb if we haven't had to drop recently -> no oscillation
      this.set(this.level + 1);
      this.fastWindows = 0;
      this.cooldown = 3;
    }
  }
}
