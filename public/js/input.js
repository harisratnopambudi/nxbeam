/*
 * Controller input from this device: a gamepad (Gamepad API), the keyboard,
 * and an on-screen touch controller. Produces the Switch pad state
 * {buttons, lx, ly, rx, ry} (sticks -32767..32767, up is +y).
 */
export const B = { A: 0, B: 1, X: 2, Y: 3, LS: 4, RS: 5, L: 6, R: 7, ZL: 8, ZR: 9, PLUS: 10, MINUS: 11, LEFT: 12, UP: 13, RIGHT: 14, DOWN: 15, HOME: 18, CAPTURE: 19 };

/* standard gamepad layout -> Switch, by position (bottom face button = Switch B) */
const PAD_MAP = [B.B, B.A, B.Y, B.X, B.L, B.R, B.ZL, B.ZR, B.MINUS, B.PLUS, B.LS, B.RS, B.UP, B.DOWN, B.LEFT, B.RIGHT, B.HOME, B.CAPTURE];

export const KEY_MAP = {
  KeyK: B.A, KeyJ: B.B, KeyI: B.X, KeyU: B.Y,
  KeyQ: B.L, KeyE: B.R, Digit1: B.ZL, Digit3: B.ZR,
  Enter: B.PLUS, Backspace: B.MINUS, KeyH: B.HOME, KeyC: B.CAPTURE, KeyF: B.LS, KeyG: B.RS,
  ArrowUp: B.UP, ArrowDown: B.DOWN, ArrowLeft: B.LEFT, ArrowRight: B.RIGHT,
};
const KEY_STICK = { KeyW: ['l', 0, 1], KeyS: ['l', 0, -1], KeyA: ['l', -1, 0], KeyD: ['l', 1, 0],
  Numpad8: ['r', 0, 1], Numpad5: ['r', 0, -1], Numpad4: ['r', -1, 0], Numpad6: ['r', 1, 0] };

export const KEY_HELP = [
  ['W A S D', 'Stik kiri / Left stick'], ['Numpad 8 4 5 6', 'Stik kanan / Right stick'],
  ['K J I U', 'A B X Y'], ['Panah / Arrows', 'D-pad'], ['Q E', 'L R'], ['1 3', 'ZL ZR'],
  ['Enter / Backspace', '+ / −'], ['F G', 'L3 R3'], ['H', 'HOME'], ['C', 'Capture'],
];

const DEAD = 0.12;
const axis = (v) => {
  if (Math.abs(v) < DEAD) return 0;
  const s = (Math.abs(v) - DEAD) / (1 - DEAD);
  return Math.round(Math.sign(v) * Math.min(1, s) * 32767);
};

export class InputManager {
  constructor(onState) {
    this.onState = onState;
    this.active = false;
    this.keys = new Set();
    this.touch = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
    this.last = [];
    this.lastSent = [];
    this.multi = false;   // the console takes players 2-4 too: each extra gamepad is one of them
    this.padName = '';
    this.keyTarget = null;
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => { this.padName = e.gamepad.id; });
    window.addEventListener('gamepaddisconnected', () => { this.padName = this._firstPad()?.id || ''; });
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  setActive(on) { this.active = on; this.keys.clear(); this.last = []; this.lastSent = []; }

  _key(e, down) {
    if (!this.active) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!(e.code in KEY_MAP) && !(e.code in KEY_STICK)) return;
    e.preventDefault();
    if (down) this.keys.add(e.code); else this.keys.delete(e.code);
  }

  _pads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return [...pads].filter((p) => p && p.connected);
  }

  _firstPad() { return this._pads()[0] || null; }

  /* the gamepads plugged in now, player 1 first (as the browser numbers them) */
  padCount() { return this._pads().length; }

  static padState(p) {
    let buttons = 0;
    p.buttons.forEach((b, i) => { if ((b.pressed || b.value > 0.5) && PAD_MAP[i] !== undefined) buttons |= 1 << PAD_MAP[i]; });
    return { buttons, lx: axis(p.axes[0] || 0), ly: -axis(p.axes[1] || 0), rx: axis(p.axes[2] || 0), ry: -axis(p.axes[3] || 0) };
  }

  /* players 2-4: the second, third and fourth gamepad */
  readExtra() {
    return this._pads().slice(1, 4).map((p) => {
      const s = InputManager.padState(p);
      return { buttons: s.buttons >>> 0, lx: s.lx, ly: s.ly, rx: s.rx, ry: s.ry };
    });
  }

  read() {
    let buttons = 0, lx = 0, ly = 0, rx = 0, ry = 0;
    const p = this._firstPad();
    if (p) ({ buttons, lx, ly, rx, ry } = InputManager.padState(p));
    let kl = [0, 0], kr = [0, 0];
    for (const k of this.keys) {
      if (k in KEY_MAP) buttons |= 1 << KEY_MAP[k];
      const s = KEY_STICK[k];
      if (s) { const t = s[0] === 'l' ? kl : kr; t[0] += s[1]; t[1] += s[2]; }
    }
    const norm = (v) => { const m = Math.hypot(v[0], v[1]); return m ? [v[0] / m * 32767, v[1] / m * 32767] : [0, 0]; };
    if (kl[0] || kl[1]) [lx, ly] = norm(kl);
    if (kr[0] || kr[1]) [rx, ry] = norm(kr);
    buttons |= this.touch.buttons;
    if (this.touch.lx || this.touch.ly) { lx = this.touch.lx; ly = this.touch.ly; }
    if (this.touch.rx || this.touch.ry) { rx = this.touch.rx; ry = this.touch.ry; }
    return { buttons: buttons >>> 0, lx: Math.round(lx), ly: Math.round(ly), rx: Math.round(rx), ry: Math.round(ry) };
  }

  _tick() {
    requestAnimationFrame(this._tick);
    if (!this.active) return;
    const all = [this.read(), ...(this.multi ? this.readExtra() : [])];
    const now = performance.now();
    all.forEach((s, i) => {
      const sig = `${s.buttons},${s.lx},${s.ly},${s.rx},${s.ry}`;
      if (sig !== this.last[i] || now - (this.lastSent[i] || 0) > 500) {
        this.last[i] = sig;
        this.lastSent[i] = now;
        this.onState(s, i);
      }
    });
    // a gamepad unplugged: let go of that player on the console
    for (let i = all.length; i < this.last.length; i++) {
      if (this.last[i] !== undefined) { this.last[i] = undefined; this.onState(null, i); }
    }
  }

  /* ------------------------------------------------ touch controller */
  bindTouch(root) {
    const pointers = new Map(); // pointerId -> {el, stick?}
    const press = () => {
      let b = 0;
      for (const p of pointers.values()) if (p.bit !== undefined) b |= 1 << p.bit;
      this.touch.buttons = b;
      root.querySelectorAll('[data-btn]').forEach((el) => {
        el.classList.toggle('down', [...pointers.values()].some((p) => p.el === el));
      });
    };
    const stickMove = (p, e) => {
      const r = p.el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width / 2;
      let dx = (e.clientX - cx) / rad, dy = (e.clientY - cy) / rad;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      const knob = p.el.querySelector('.knob');
      if (knob) knob.style.transform = `translate(${dx * 38}%, ${dy * 38}%)`;
      const side = p.el.dataset.stick;
      this.touch[side + 'x'] = Math.round(dx * 32767);
      this.touch[side + 'y'] = Math.round(-dy * 32767);
    };
    root.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('[data-btn],[data-stick]');
      if (!el) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const p = { el, bit: el.dataset.btn !== undefined ? B[el.dataset.btn] : undefined };
      pointers.set(e.pointerId, p);
      if (el.dataset.stick) stickMove(p, e);
      if (navigator.vibrate && p.bit !== undefined) navigator.vibrate(8);
      press();
    });
    root.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (p && p.el.dataset.stick) stickMove(p, e);
    });
    const up = (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      pointers.delete(e.pointerId);
      if (p.el.dataset.stick) {
        const side = p.el.dataset.stick;
        this.touch[side + 'x'] = 0; this.touch[side + 'y'] = 0;
        const knob = p.el.querySelector('.knob'); if (knob) knob.style.transform = '';
      }
      press();
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
