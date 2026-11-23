// Unified input: keyboard, mouse, touch (dynamic joystick + camera drag + pinch), gamepad.
// All state lives in one object that the game reads once per frame; no per-frame allocation.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.move = { x: 0, y: 0 };
    this.run = false;
    this.yawDelta = 0; // radians accumulated since last frame
    this.zoomDelta = 0; // >0 = zoom out
    this.keys = new Set();
    this.touchMode = false;
    this.anyInput = false;
    // story actions
    this.shutter = false; // held: lantern shuttered
    this.staffHeld = false; // held: cranking
    this.staffPressed = false; // edge: strike (true for exactly one poll)
    this.sightPressed = false; // edge: toggle Scorched Sight
    this.sneak = false;
    this.touchStick = false;
    this._staffQueue = false;
    this._sightQueue = false;
    this._rmb = false;
    this._touchStaff = false;
    this._touchShutter = false;
    this._padPrev = [];
    this._mouseDown = null;

    this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.look = new Map(); // pointerId -> {x, y}
    this.pinchDist = 0;

    this.stickEl = document.getElementById('stick');
    this.knobEl = document.getElementById('stickKnob');

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLSelectElement) return;
      if (!e.repeat && (e.code === 'KeyE' || e.code === 'Enter' || e.code === 'NumpadEnter')) this._staffQueue = true;
      if (!e.repeat && e.code === 'KeyH') this._guideQueue = true;
      this.keys.add(e.code);
      this.anyInput = true;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this._rmb = this._touchStaff = this._touchShutter = false;
      this.releaseStick();
      this.look.clear();
    });

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e), { passive: true });
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomDelta += Math.sign(e.deltaY) * 0.12;
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // on-screen action buttons (touch)
    const hold = (id, on) => {
      const el = document.getElementById(id);
      if (!el) return;
      const down = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('down'); on(true); try { el.setPointerCapture(e.pointerId); } catch { /* */ } };
      const up = (e) => { e.preventDefault(); el.classList.remove('down'); on(false); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold('btnStaff', (d) => { this._touchStaff = d; if (d) this._staffQueue = true; });
    hold('btnShutter', (d) => { this._touchShutter = d; });
    document.getElementById('status')?.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._guideQueue = true; });
  }

  onDown(e) {
    this.anyInput = true;
    this.canvas.focus();
    if (e.pointerType === 'mouse') {
      if (e.button === 2) { this._rmb = true; return; }
      if (e.button === 0) this._mouseDown = { t: performance.now(), x: e.clientX, y: e.clientY };
    }
    if (e.pointerType === 'touch') {
      this.touchMode = true;
      if (e.clientX < window.innerWidth * 0.45 && this.stick.id === -1) {
        this.stick.id = e.pointerId;
        this.stick.ox = e.clientX;
        this.stick.oy = e.clientY;
        this.stick.x = this.stick.y = 0;
        this.stickEl.hidden = false;
        this.stickEl.style.left = `${e.clientX}px`;
        this.stickEl.style.top = `${e.clientY}px`;
        this.knobEl.style.transform = 'translate(0px, 0px)';
        return;
      }
    }
    this.look.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.look.size === 2) this.pinchDist = this.lookSpread();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  onMove(e) {
    if (e.pointerId === this.stick.id) {
      const R = 52;
      let dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      this.stick.x = dx / R;
      this.stick.y = -dy / R;
      this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      return;
    }
    const p = this.look.get(e.pointerId);
    if (!p) return;
    if (this.look.size === 1) {
      const sens = e.pointerType === 'touch' ? 0.009 : 0.006;
      this.yawDelta -= (e.clientX - p.x) * sens;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.look.size === 2) {
      const d = this.lookSpread();
      if (this.pinchDist > 0) this.zoomDelta += (this.pinchDist - d) * 0.006;
      this.pinchDist = d;
    }
  }

  onUp(e) {
    if (e.pointerType === 'mouse') {
      if (e.button === 2) this._rmb = false;
      const m = this._mouseDown;
      // a quick click without dragging = staff strike (a drag turns the camera)
      if (e.button === 0 && m && performance.now() - m.t < 250 && Math.hypot(e.clientX - m.x, e.clientY - m.y) < 6) this._staffQueue = true;
      this._mouseDown = null;
    }
    if (e.pointerId === this.stick.id) this.releaseStick();
    this.look.delete(e.pointerId);
    if (this.look.size < 2) this.pinchDist = 0;
  }

  releaseStick() {
    this.stick.id = -1;
    this.stick.x = this.stick.y = 0;
    this.stickEl.hidden = true;
  }

  lookSpread() {
    const it = this.look.values();
    const a = it.next().value, b = it.next().value;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Call once per frame before reading. */
  poll(dt) {
    const k = this.keys;
    let x = 0, y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (x || y) {
      const l = Math.hypot(x, y);
      x /= l;
      y /= l;
    }
    let run = k.has('ShiftLeft') || k.has('ShiftRight');
    if (k.has('KeyQ')) this.yawDelta += dt * 2.2;
    if (k.has('KeyR')) this.yawDelta -= dt * 2.2;
    if (k.has('Equal') || k.has('NumpadAdd')) this.zoomDelta -= dt * 1.5;
    if (k.has('Minus') || k.has('NumpadSubtract')) this.zoomDelta += dt * 1.5;

    this.touchStick = this.stick.id !== -1;
    let analog = this.touchStick;
    if (this.touchStick) {
      x = this.stick.x;
      y = this.stick.y;
    }
    let shutter = k.has('Space') || this._rmb || this._touchShutter;
    let staff = k.has('KeyE') || k.has('Enter') || this._touchStaff;
    let sneak = k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight');

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (pads) {
      for (const gp of pads) {
        if (!gp || !gp.connected) continue;
        const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
        const gx = dz(gp.axes[0] || 0), gy = dz(gp.axes[1] || 0);
        if (gx || gy) { x = gx; y = -gy; this.anyInput = true; analog = true; }
        const rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
        this.yawDelta -= rx * dt * 2.6;
        this.zoomDelta += ry * dt * 1.2;
        const b = (i) => !!gp.buttons[i]?.pressed;
        if (b(4) || b(10)) run = true;
        if (b(5) || b(7) || (gp.buttons[7]?.value ?? 0) > 0.4) shutter = true;
        if (b(1)) sneak = true;
        if (b(0)) { staff = true; if (!this._padPrev[0]) this._staffQueue = true; }
        if (b(3) && !this._padPrev[3]) this._sightQueue = true;
        this._padPrev[0] = b(0);
        this._padPrev[3] = b(3);
        break;
      }
    }

    this.move.x = x;
    this.move.y = y;
    this.run = run;
    this.analog = analog; // only analog sticks run on full tilt; keyboard W walks, Shift runs
    this.shutter = shutter;
    this.staffHeld = staff;
    this.sneak = sneak;
    this.staffPressed = this._staffQueue;
    this._staffQueue = false;
    this.sightPressed = this._sightQueue;
    this._sightQueue = false;
    this.guidePressed = this._guideQueue;
    this._guideQueue = false;
  }

  consumeLook() {
    const v = this.yawDelta;
    this.yawDelta = 0;
    return v;
  }

  consumeZoom() {
    const v = this.zoomDelta;
    this.zoomDelta = 0;
    return v;
  }
}
