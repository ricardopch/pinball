/* Pinball Vintage — "Estrella Fugaz"
 * Mesa electromecánica de estilo años 70 para móvil.
 * Física propia con subpasos fijos, inclinación por acelerómetro, lanzador con las teclas de volumen.
 */
'use strict';
(function () {
  const NATIVE = (typeof window.AndroidPB !== 'undefined') ? window.AndroidPB : null;
  const D2R = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const fmt = (n) => String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  /* =====================================================================
   * Almacenamiento y ajustes
   * ===================================================================== */
  const Store = {
    get(k, def) {
      try {
        const v = NATIVE ? NATIVE.load(k) : localStorage.getItem('pb_' + k);
        if (v === null || v === undefined || v === '') return def;
        return JSON.parse(v);
      } catch (e) { return def; }
    },
    set(k, v) {
      try {
        const s = JSON.stringify(v);
        if (NATIVE) NATIVE.save(k, s); else localStorage.setItem('pb_' + k, s);
      } catch (e) { /* sin almacenamiento */ }
    }
  };
  const settings = Object.assign({ sens: 1, balls: 3, haptics: true, tilt: 'normal', sfx: 1, help: false },
    Store.get('settings', {}));
  const saveSettings = () => Store.set('settings', settings);

  /* =====================================================================
   * Sonido (SoundPool nativo en Android, Web Audio en navegador)
   * ===================================================================== */
  const SOUNDS = ['chime10', 'chime100', 'chime1000', 'flip_up', 'flip_down', 'bumper', 'sling', 'knocker',
    'drop', 'reset', 'standup', 'rollover', 'spinner', 'reel', 'hit', 'rubber', 'saucer_in', 'saucer_kick',
    'pull', 'launch', 'drain', 'tilt', 'warn', 'coin', 'start', 'roll'];
  const Sound = {
    ctx: null, buf: {}, master: null, rollSrc: null, rollGain: null,
    lastV: -1, lastR: -1, lastT: 0,
    init() {
      if (NATIVE) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
      } catch (e) { this.ctx = null; return; }
      for (const n of SOUNDS) {
        fetch('sounds/' + n + '.wav').then(r => r.arrayBuffer())
          .then(b => this.ctx.decodeAudioData(b)).then(d => { this.buf[n] = d; }).catch(() => {});
      }
    },
    unlock() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); },
    stats: {},
    play(name, vol = 1, pan = 0, rate = 1) {
      this.stats[name] = (this.stats[name] || 0) + 1;
      vol *= settings.sfx;
      if (vol < 0.004) return;
      if (NATIVE) { try { NATIVE.play(name, Math.min(1, vol), clamp(pan, -1, 1), rate); } catch (e) {} return; }
      const c = this.ctx, b = this.buf[name];
      if (!c || !b || c.state !== 'running') return;
      const src = c.createBufferSource();
      src.buffer = b; src.playbackRate.value = rate;
      const g = c.createGain(); g.gain.value = Math.min(1, vol);
      src.connect(g);
      if (c.createStereoPanner) {
        const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
        g.connect(p); p.connect(this.master);
      } else g.connect(this.master);
      src.start();
    },
    roll(vol, rate) {
      vol *= settings.sfx;
      const t = performance.now();
      if (Math.abs(vol - this.lastV) < 0.012 && Math.abs(rate - this.lastR) < 0.02 && t - this.lastT < 300) return;
      this.lastV = vol; this.lastR = rate; this.lastT = t;
      if (NATIVE) { try { NATIVE.roll(vol, rate); } catch (e) {} return; }
      const c = this.ctx;
      if (!c || !this.buf.roll || c.state !== 'running') return;
      if (!this.rollSrc) {
        this.rollSrc = c.createBufferSource(); this.rollSrc.buffer = this.buf.roll; this.rollSrc.loop = true;
        this.rollGain = c.createGain(); this.rollGain.gain.value = 0;
        this.rollSrc.connect(this.rollGain); this.rollGain.connect(this.master); this.rollSrc.start();
      }
      this.rollGain.gain.setTargetAtTime(vol, c.currentTime, 0.04);
      this.rollSrc.playbackRate.setTargetAtTime(rate, c.currentTime, 0.06);
    }
  };
  function buzz(ms, amp) {
    if (!settings.haptics) return;
    try { if (NATIVE) NATIVE.vibrate(ms, amp || 0); else if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  /* =====================================================================
   * Constantes físicas y de mesa (unidades de mesa: 520 x 1040, bola r=13 ≈ 27 mm)
   * ===================================================================== */
  const TW = 520, TH = 1040;
  const BALL_R = 13;
  const BASE_G = 1050;          // gravedad sobre el tablero (pendiente ~6,5º)
  const DT = 1 / 600;           // paso de física
  const MAXV = 4200;
  const BUMPER_KICK = 1000;
  const SLING_KICK = 680;
  const LAUNCH_MIN = 520, LAUNCH_MAX = 2650;
  const PULL_TIME = 0.95;       // segundos para tensar el muelle a tope

  /* =====================================================================
   * Sensores: inclinación real y empujones
   * ===================================================================== */
  const Tilt = {
    raw: { x: 0, y: 6.3, z: 7.6 }, neutral: null, has: false,
    nx: 0, ny: 0, nmag: 0, key: { x: 0, y: 0 }, rel: { x: 0, y: 0 },
    init() {
      if (!NATIVE && 'DeviceMotionEvent' in window) {
        window.addEventListener('devicemotion', (e) => {
          const a = e.accelerationIncludingGravity;
          if (!a || a.x === null) return;
          const k = this.has ? 0.15 : 1;
          this.raw.x += (a.x - this.raw.x) * k; this.raw.y += (a.y - this.raw.y) * k; this.raw.z += (a.z - this.raw.z) * k;
          this.has = true;
          const l = e.acceleration;
          if (l && l.x !== null) {
            const m = Math.hypot(l.x, l.y);
            if (m > this.nmag) { this.nmag = m; this.nx = l.x; this.ny = l.y; }
          }
        });
      }
    },
    poll() {
      if (NATIVE) {
        try {
          const p = String(NATIVE.sensors()).split(',');
          if (p.length >= 6) {
            const x = +p[0], y = +p[1], z = +p[2];
            if (isFinite(x) && isFinite(y) && isFinite(z) && (x || y || z)) {
              this.raw.x = x; this.raw.y = y; this.raw.z = z; this.has = true;
            }
            const m = +p[5];
            if (m > this.nmag) { this.nmag = m; this.nx = +p[3]; this.ny = +p[4]; }
          }
        } catch (e) { /* sin sensor */ }
      }
      if (this.has && !this.neutral) this.calibrate();
    },
    calibrate() { this.neutral = { x: this.raw.x, y: this.raw.y, z: this.raw.z }; },
    takeNudge(out) { out.x = this.nx; out.y = this.ny; out.mag = this.nmag; this.nx = this.ny = this.nmag = 0; },
    // Gravedad efectiva en el plano de la pantalla (coordenadas de lienzo, y hacia abajo)
    gravity(out) {
      let dx = this.key.x, dy = this.key.y;
      if (this.has && this.neutral) {
        dx += -(this.raw.x - this.neutral.x);
        dy += (this.raw.y - this.neutral.y);
      }
      this.rel.x = dx; this.rel.y = dy;
      const k = BASE_G * 0.30 * settings.sens;   // ≈ 5 % de g de mesa por grado
      out.x = clamp(dx * k, -1.6 * BASE_G, 1.6 * BASE_G);
      out.y = clamp(BASE_G + dy * k, 0.3 * BASE_G, 2.4 * BASE_G);
    }
  };

  /* =====================================================================
   * Geometría de la mesa
   * ===================================================================== */
  const segs = [], sensors = [], LAMPS = {}, POSTS = [];
  const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
  function mkSeg(ax, ay, bx, by, o) {
    const s = { ax, ay, bx, by, r: 3, e: 0.3, mu: 0.08, kind: 'rail', active: true, draw: true,
      oneWay: null, onHit: null, cool: 0, flash: 0 };
    Object.assign(s, o || {});
    s.ex = bx - ax; s.ey = by - ay; s.len2 = s.ex * s.ex + s.ey * s.ey || 1;
    segs.push(s);
    return s;
  }
  function poly(pts, o) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) out.push(mkSeg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], o));
    return out;
  }
  function arcPts(cx, cy, r, a0, a1, n) {
    const p = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    return p;
  }
  const RAIL = { r: 3, e: 0.28, mu: 0.06, kind: 'rail' };
  const RUB = { r: 4, e: 0.6, mu: 0.12, kind: 'rubber' };
  const GUIDE = { r: 4, e: 0.45, mu: 0.08, kind: 'guide' };

  // Paredes exteriores y bolsillo de las dianas abatibles
  poly([[10, 1040], [10, 618], [56, 572]], RAIL);
  mkSeg(50, 432, 50, 572, { r: 3, e: 0.2, kind: 'back', draw: false });
  poly([[56, 432], [10, 385], [10, 260]], RAIL);
  const ARCH = arcPts(260, 260, 250, Math.PI, 2 * Math.PI, 60);
  poly(ARCH, { r: 3, e: 0.15, mu: 0.02, kind: 'rail', arch: true });
  mkSeg(510, 260, 510, 1040, RAIL);
  mkSeg(470, 345, 470, 1040, RAIL);                       // pared interior del carril de lanzamiento
  const gate = mkSeg(470, 345, 510, 303, { r: 2, e: 0.2, kind: 'gate', oneWay: norm(-42, -40) });

  // Pasillos superiores A-B-C
  for (const x of [180, 240, 300, 360]) { mkSeg(x, 88, x, 150, GUIDE); POSTS.push([x, 88, 'red']); }
  // Guía de la órbita izquierda (spinner)
  mkSeg(66, 210, 66, 360, GUIDE); POSTS.push([66, 210, 'red']);

  // Dianas abatibles (izquierda)
  const DROPS = [[436, 466], [470, 500], [504, 534], [538, 568]].map((yy, i) =>
    mkSeg(56, yy[0], 56, yy[1], { r: 3, e: 0.2, mu: 0.05, kind: 'drop', idx: i, draw: false, onHit: hitDrop }));
  // Dianas fijas (derecha)
  const STANDUPS = [[598, 626], [636, 664], [674, 702]].map((yy, i) =>
    mkSeg(464, yy[0], 464, yy[1], { r: 3, e: 0.3, kind: 'standup', idx: i, draw: false, onHit: hitStandup }));

  // Zona inferior: separadores, guías de inlane y slingshots
  mkSeg(50, 700, 50, 845, RUB); POSTS.push([50, 700, 'white']);
  mkSeg(430, 700, 430, 845, RUB); POSTS.push([430, 700, 'white']);
  mkSeg(50, 840, 138, 884, RAIL);
  mkSeg(430, 840, 342, 884, RAIL);
  const SLINGS = [];
  function sling(ax, ay, bx, by, cx, cy, side) {
    mkSeg(ax, ay, bx, by, { r: 4, e: 0.45, kind: 'rubber', sling: true });
    mkSeg(bx, by, cx, cy, { r: 4, e: 0.45, kind: 'rubber', sling: true });
    const n = norm(cy - ay, -(cx - ax));
    const kn = side < 0 ? n : { x: -n.x, y: -n.y };
    const k = mkSeg(ax, ay, cx, cy, { r: 4, e: 0.55, kind: 'sling', side, kn, onHit: hitSling, tri: [[ax, ay], [bx, by], [cx, cy]] });
    if (k.kn.x * (240 - ax) < 0) { k.kn.x = -k.kn.x; k.kn.y = -k.kn.y; }
    SLINGS.push(k);
    POSTS.push([ax, ay, 'chrome'], [bx, by, 'chrome'], [cx, cy, 'chrome']);
  }
  sling(92, 700, 92, 800, 142, 835, -1);
  sling(388, 700, 388, 800, 338, 835, 1);

  // Bumpers
  const BUMPERS = [{ x: 195, y: 250 }, { x: 325, y: 250 }, { x: 260, y: 345 }]
    .map((b, i) => Object.assign(b, { r: 30, cool: 0, flash: 0, idx: i, color: i === 2 ? '#e8352a' : '#ffc928' }));

  // Sensores (rollovers)
  function sensor(x, y, r, kind, idx, onEnter) {
    const s = { x, y, r, kind, idx, inside: false, onEnter, flash: 0 };
    sensors.push(s); return s;
  }
  [210, 270, 330].forEach((x, i) => sensor(x, 128, 13, 'lane', i, onLane));
  sensor(30, 800, 13, 'outlane', 0, onOutlane);
  sensor(450, 800, 13, 'outlane', 1, onOutlane);
  sensor(71, 785, 13, 'inlane', 0, onInlane);
  sensor(409, 785, 13, 'inlane', 1, onInlane);
  [[130, 610], [350, 610], [240, 470]].forEach(([x, y], i) => sensor(x, y, 12, 'star', i, onStar));

  const spinner = { x1: 13, x2: 63, y: 290, angle: 0, omega: 0, half: 0 };
  const saucer = { x: 428, y: 500, r: 16, held: false, timer: 0, cool: 0 };

  // Flippers
  class Flipper {
    constructor(px, py, side) {
      this.px = px; this.py = py; this.side = side;
      this.len = 72; this.rb = 12; this.rt = 6.5;
      this.rest = side < 0 ? 30 * D2R : Math.PI - 30 * D2R;
      this.up = side < 0 ? -28 * D2R : Math.PI + 28 * D2R;
      this.angle = this.rest; this.omega = 0; this.pressed = false;
      this.tipX = 0; this.tipY = 0; this.place();
    }
    place() { this.tipX = this.px + Math.cos(this.angle) * this.len; this.tipY = this.py + Math.sin(this.angle) * this.len; }
    update(dt, enabled) {
      const on = this.pressed && enabled;
      const target = on ? this.up : this.rest;
      const speed = on ? 27 : 17;
      const prev = this.angle, diff = target - this.angle, step = speed * dt;
      this.angle = Math.abs(diff) <= step ? target : this.angle + Math.sign(diff) * step;
      this.omega = (this.angle - prev) / dt;
      this.place();
    }
  }
  const flipL = new Flipper(155, 900, -1);
  const flipR = new Flipper(325, 900, 1);
  const FLIPPERS = [flipL, flipR];

  // Lanzador
  const plunger = { restY: 985, travel: 46, pull: 0, pulling: false, releasing: false, keys: 0 };
  const plungerSeg = mkSeg(473, 985, 507, 985, { r: 2, e: 0.15, kind: 'plunger', draw: false });
  const plungerY = () => plunger.restY + plunger.pull * plunger.travel;

  // Lámparas (insertos)
  function lamp(id, x, y, o) { LAMPS[id] = Object.assign({ id, x, y, r: 9, color: '#ffcf3a', shape: 'circle', label: '', fs: 9 }, o || {}); }
  lamp('lane0', 210, 104, { label: 'A', color: '#ffd23a', fs: 11 });
  lamp('lane1', 270, 104, { label: 'B', color: '#ffd23a', fs: 11 });
  lamp('lane2', 330, 104, { label: 'C', color: '#ffd23a', fs: 11 });
  lamp('x1', 222, 194, { label: '2X', color: '#ff7a2a', shape: 'oval', r: 8, fs: 8 });
  lamp('x2', 260, 199, { label: '3X', color: '#ff7a2a', shape: 'oval', r: 8, fs: 8 });
  lamp('x3', 298, 194, { label: '5X', color: '#ff7a2a', shape: 'oval', r: 8, fs: 8 });
  lamp('spin', 38, 252, { label: '100', color: '#6fd3ff', shape: 'oval', r: 8, fs: 7 });
  for (let i = 0; i < 4; i++) lamp('d' + i, 84, 451 + i * 34, { color: '#ffd23a', r: 7 });
  lamp('spec0', 30, 742, { label: 'ESP', color: '#ff3b3b', shape: 'oval', r: 9, fs: 7 });
  lamp('spec1', 450, 742, { label: 'ESP', color: '#ff3b3b', shape: 'oval', r: 9, fs: 7 });
  for (let i = 0; i < 3; i++) lamp('s' + i, 442, 612 + i * 38, { color: '#55e070', r: 7 });
  lamp('extra', 390, 500, { label: 'EXTRA', color: '#55e070', shape: 'oval', r: 10, fs: 7 });
  for (let i = 1; i <= 10; i++) {
    const a = (200 + (i - 1) * (140 / 9)) * D2R;
    lamp('b' + i, 240 + Math.cos(a) * 82, 704 + Math.sin(a) * 82, { label: String(i), color: '#ffb43a', r: 9, fs: 9 });
  }
  lamp('again', 240, 905, { label: 'OTRA BOLA', color: '#ff4a3a', shape: 'oval', r: 12, fs: 6.5 });

  /* =====================================================================
   * Estado de la bola y física
   * ===================================================================== */
  const ball = { x: 490, y: 970, vx: 0, vy: 0, r: BALL_R, active: false, held: false, px: 0, py: 0 };
  const grav = { x: 0, y: BASE_G };
  let hitCool = 0;
  const N = { x: 0, y: 0 };

  function collideSeg(b, s) {
    let t = ((b.x - s.ax) * s.ex + (b.y - s.ay) * s.ey) / s.len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = s.ax + s.ex * t, py = s.ay + s.ey * t;
    const dx = b.x - px, dy = b.y - py, rr = b.r + s.r, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 < 1e-10) return -1;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    if (s.oneWay && nx * s.oneWay.x + ny * s.oneWay.y <= 0) return -1;
    b.x += nx * (rr - d); b.y += ny * (rr - d);
    N.x = nx; N.y = ny;
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return 0;
    const e = vn > -35 ? 0 : s.e;
    const jn = -(1 + e) * vn;
    b.vx += jn * nx; b.vy += jn * ny;
    // rozamiento de Coulomb proporcional al impulso normal
    const tx = -ny, ty = nx, vt = b.vx * tx + b.vy * ty;
    const jt = Math.min(Math.abs(vt), s.mu * jn) * Math.sign(vt);
    b.vx -= jt * tx; b.vy -= jt * ty;
    return -vn;
  }

  function collideFlipper(b, f) {
    const ax = f.px, ay = f.py, ex = f.tipX - ax, ey = f.tipY - ay;
    let t = ((b.x - ax) * ex + (b.y - ay) * ey) / (f.len * f.len);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + ex * t, cy = ay + ey * t;
    const fr = f.rb + (f.rt - f.rb) * t;
    const dx = b.x - cx, dy = b.y - cy, rr = b.r + fr, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 < 1e-10) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    b.x += nx * (rr - d); b.y += ny * (rr - d);
    const rx = cx - ax + nx * fr, ry = cy - ay + ny * fr;
    const svx = -f.omega * ry, svy = f.omega * rx;
    const rvx = b.vx - svx, rvy = b.vy - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;
    const e = vn > -40 ? 0 : 0.42;
    const jn = -(1 + e) * vn;
    b.vx += jn * nx; b.vy += jn * ny;
    // la base del flipper no es un equilibrio: la bola que queda encima rueda hacia la punta
    if (t === 0 && Math.abs(b.vx) < 60 && ny < -0.9) b.vx += (f.side < 0 ? 1 : -1) * 6;
    const tx = -ny, ty = nx, vt = rvx * tx + rvy * ty;
    const jt = Math.min(Math.abs(vt), 0.1 * jn) * Math.sign(vt);
    b.vx -= jt * tx; b.vy -= jt * ty;
    if (-vn > 260 && hitCool <= 0 && Math.abs(f.omega) < 1) {
      Sound.play('rubber', clamp(-vn / 2200, 0.08, 0.6), panOf(b.x));
      hitCool = 0.04;
    }
  }

  function collideBumper(b, bp) {
    const dx = b.x - bp.x, dy = b.y - bp.y, rr = b.r + bp.r, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return;
    const d = Math.sqrt(d2) || 1e-6, nx = dx / d, ny = dy / d;
    b.x = bp.x + nx * rr; b.y = bp.y + ny * rr;
    const vn = b.vx * nx + b.vy * ny;
    if (bp.cool <= 0 && G.state === 'play' && !G.tilted) {
      const tx = -ny, ty = nx, vt = b.vx * tx + b.vy * ty;
      const out = BUMPER_KICK + Math.max(0, -vn) * 0.25;
      b.vx = nx * out + tx * vt * 0.55; b.vy = ny * out + ty * vt * 0.55;
      bp.cool = 0.09; bp.flash = 0.16;
      onBumper(bp);
    } else if (vn < 0) {
      b.vx -= 1.5 * vn * nx; b.vy -= 1.5 * vn * ny;
    }
  }

  const panOf = (x) => clamp((x / TW - 0.5) * 1.1, -0.7, 0.7);

  function stepPhysics(dt) {
    const enabled = G.state === 'play' && !G.tilted;
    flipL.update(dt, enabled); flipR.update(dt, enabled);

    // lanzador
    if (plunger.pulling) plunger.pull = Math.min(1, plunger.pull + dt / PULL_TIME);
    else if (plunger.pull > 0) {
      plunger.pull = Math.max(0, plunger.pull - dt / (plunger.releasing ? 0.045 : 0.3));
    }
    if (plunger.pull === 0) plunger.releasing = false;
    const py = plungerY();
    plungerSeg.ay = plungerSeg.by = py;
    plungerSeg.active = !plunger.releasing;

    if (!ball.active || ball.held) return;
    const b = ball;
    b.vx += grav.x * dt; b.vy += grav.y * dt;
    const damp = 1 - 0.06 * dt;
    b.vx *= damp; b.vy *= damp;
    const sp2 = b.vx * b.vx + b.vy * b.vy;
    if (sp2 > MAXV * MAXV) { const k = MAXV / Math.sqrt(sp2); b.vx *= k; b.vy *= k; }
    b.px = b.x; b.py = b.y;
    b.x += b.vx * dt; b.y += b.vy * dt;

    // paredes y elementos
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!s.active) continue;
      const imp = collideSeg(b, s);
      if (imp < 0) continue;
      if (s.onHit) s.onHit(s, imp, N.x, N.y);
      else if (imp > 170 && hitCool <= 0) {
        const soft = s.kind === 'rubber' || s.kind === 'guide';
        Sound.play(soft ? 'rubber' : 'hit', clamp(imp / 2000, 0.06, 0.65), panOf(b.x), rand(0.94, 1.06));
        hitCool = 0.035;
      }
    }
    for (let i = 0; i < BUMPERS.length; i++) collideBumper(b, BUMPERS[i]);
    collideFlipper(b, flipL); collideFlipper(b, flipR);

    // sensores
    for (let i = 0; i < sensors.length; i++) {
      const s = sensors[i];
      const dx = b.x - s.x, dy = b.y - s.y, d2 = dx * dx + dy * dy;
      if (!s.inside && d2 < s.r * s.r) { s.inside = true; s.flash = 0.25; if (s.onEnter) s.onEnter(s); }
      else if (s.inside && d2 > (s.r + 6) * (s.r + 6)) s.inside = false;
    }
    // spinner
    if (b.x > spinner.x1 && b.x < spinner.x2 && ((b.py < spinner.y) !== (b.y < spinner.y))) {
      spinner.omega = Math.max(spinner.omega, Math.min(60, Math.abs(b.vy) * 0.034));
    }
    // agujero (saucer)
    if (saucer.cool <= 0) {
      const dx = saucer.x - b.x, dy = saucer.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 < 22 * 22) {
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (d2 < 10 * 10 && sp < 750) captureSaucer();
        else { b.vx += dx * 40 * dt; b.vy += dy * 40 * dt; }      // pequeña depresión del agujero
      }
    }
    // desagüe y seguridad
    if (b.y > 1012 && b.x < 470) onDrain();
    else if (!(b.x > -30 && b.x < TW + 30 && b.y > -60 && b.y < TH + 60) || !isFinite(b.x + b.y)) {
      G.escapes = (G.escapes || 0) + 1;
      resetBallToLane();
    }
  }

  /* =====================================================================
   * Reglas del juego
   * ===================================================================== */
  const MULTS = [1, 2, 3, 5];
  const REPLAYS = [150000, 300000, 450000];
  const G = {
    state: 'attract',     // attract | starting | play | over
    phase: 'ball',        // ball | bonus | wait
    score: Store.get('last', 0), ballNum: 1, credits: Store.get('credits', 0), hi: Store.get('hi', 0),
    lanes: [false, false, false], lanesFlash: 0, multIdx: 0, bonus: 0, bonusCount: 0,
    dropDone: 0, dropResetT: 0, specialLit: false, standups: [false, false, false], extraLit: false,
    shootAgain: false, tilted: false, warnings: 0, warnCool: 0, warnDecay: 0,
    launched: false, replayIdx: 0, match: -1, msg: '', msgT: 0, timer: 0, newHi: false,
    attractT: 0, hintT: 0, firstBallHint: true,
  };
  const motor = { q: [], t: 0 };
  let reelClickCool = 0;

  function showMsg(m, t) { G.msg = m; G.msgT = t || 2.2; }

  function addScore(v, withChime) {
    G.score += v;
    if (withChime) {
      const name = v >= 1000 ? 'chime1000' : v >= 100 ? 'chime100' : 'chime10';
      Sound.play(name, 0.55, 0, 1);
    }
    while (G.replayIdx < REPLAYS.length && G.score >= REPLAYS[G.replayIdx]) {
      G.replayIdx++;
      freeGame('¡PARTIDA GRATIS!');
    }
  }
  function award(p) {
    if (G.state !== 'play' || G.tilted) return;
    let v = Math.round(p / 10) * 10;
    const add = (u, n) => { for (let i = 0; i < n; i++) motor.q.push(u); };
    add(10000, Math.floor(v / 10000)); v %= 10000;
    add(1000, Math.floor(v / 1000)); v %= 1000;
    add(100, Math.floor(v / 100)); v %= 100;
    add(10, Math.floor(v / 10));
    while (motor.q.length > 45) addScore(motor.q.pop(), false);
  }
  function updateMotor(dt) {
    if (!motor.q.length) { motor.t = 0; return; }
    motor.t -= dt;
    while (motor.t <= 0 && motor.q.length) {
      const u = motor.q.shift();
      addScore(u, true);
      motor.t += u >= 1000 ? 0.09 : 0.065;
    }
  }
  function freeGame(msg) {
    G.credits = Math.min(99, G.credits + 1);
    Store.set('credits', G.credits);
    Sound.play('knocker', 1);
    buzz(70, 255);
    showMsg(msg, 2.6);
  }
  const advanceBonus = (n) => { G.bonus = Math.min(10, G.bonus + n); };

  function onBumper(bp) {
    Sound.play('bumper', 0.95, panOf(bp.x), rand(0.95, 1.05));
    buzz(14, 140);
    award(100);
  }
  function hitSling(s, imp, nx, ny) {
    const dot = nx * s.kn.x + ny * s.kn.y;
    if (imp > 30 && s.cool <= 0 && dot > 0.6 && G.state === 'play' && !G.tilted) {
      ball.vx += s.kn.x * SLING_KICK; ball.vy += s.kn.y * SLING_KICK;
      s.cool = 0.12; s.flash = 0.12;
      Sound.play('sling', 0.9, panOf(ball.x), rand(0.95, 1.05));
      buzz(12, 120);
      award(10);
    } else if (imp > 170 && hitCool <= 0) {
      Sound.play('rubber', clamp(imp / 2000, 0.06, 0.6), panOf(ball.x)); hitCool = 0.035;
    }
  }
  function hitDrop(s, imp, nx) {
    if (nx > 0.4 && imp > 70 && G.state === 'play' && !G.tilted) {
      s.active = false;
      Sound.play('drop', 0.9, panOf(56));
      award(500);
      if (DROPS.every(d => !d.active)) {
        award(5000); advanceBonus(2);
        G.dropDone++;
        if (G.dropDone >= 2 && !G.specialLit) { G.specialLit = true; showMsg('ESPECIAL ENCENDIDO'); }
        else showMsg('DIANAS 5.000');
        G.dropResetT = 1.1;
      }
    } else if (imp > 170 && hitCool <= 0) { Sound.play('hit', clamp(imp / 2000, 0.06, 0.5), panOf(56)); hitCool = 0.035; }
  }
  function hitStandup(s, imp, nx) {
    if (nx < -0.4 && imp > 60 && s.cool <= 0 && G.state === 'play' && !G.tilted) {
      s.cool = 0.2; s.flash = 0.3;
      Sound.play('standup', 0.85, panOf(464));
      award(1000);
      G.standups[s.idx] = true;
      if (G.standups.every(Boolean)) {
        G.standups = [false, false, false];
        if (!G.extraLit && !G.shootAgain) { G.extraLit = true; showMsg('BOLA EXTRA ENCENDIDA'); }
        else award(5000);
      }
    }
  }
  function onLane(s) {
    Sound.play('rollover', 0.7, panOf(s.x));
    if (G.state !== 'play' || G.tilted) return;
    award(1000); advanceBonus(1);
    if (!G.lanes[s.idx] && G.lanesFlash <= 0) {
      G.lanes[s.idx] = true;
      if (G.lanes.every(Boolean)) {
        G.multIdx = Math.min(3, G.multIdx + 1);
        award(5000);
        showMsg('BONO ' + MULTS[G.multIdx] + 'X');
        G.lanesFlash = 1.4;
      }
    }
  }
  function onStar(s) { Sound.play('rollover', 0.6, panOf(s.x)); award(100); }
  function onInlane(s) { Sound.play('rollover', 0.7, panOf(s.x)); award(1000); advanceBonus(1); }
  function onOutlane(s) {
    Sound.play('rollover', 0.7, panOf(s.x));
    if (G.state !== 'play' || G.tilted) return;
    if (G.specialLit) { G.specialLit = false; freeGame('¡ESPECIAL!'); }
    award(5000);
  }
  function captureSaucer() {
    ball.held = true; ball.x = saucer.x; ball.y = saucer.y; ball.vx = ball.vy = 0;
    saucer.timer = 1.6;
    Sound.play('saucer_in', 0.9, panOf(saucer.x));
    award(3000); advanceBonus(1);
    if (G.extraLit && G.state === 'play' && !G.tilted) {
      G.extraLit = false; G.shootAgain = true; showMsg('¡BOLA EXTRA!');
      Sound.play('knocker', 0.7);
    }
  }
  function kickSaucer() {
    ball.held = false;
    ball.x = saucer.x - 4; ball.y = saucer.y - 4;
    ball.vx = rand(-470, -400); ball.vy = rand(-610, -540);
    saucer.cool = 0.6;
    Sound.play('saucer_kick', 0.95, panOf(saucer.x));
    buzz(20, 160);
  }

  function resetBallToLane() {
    ball.x = 490; ball.y = plungerY() - BALL_R - 3; ball.vx = 0; ball.vy = 0;
    ball.active = true; ball.held = false;
  }

  function newBall() {
    G.lanes = [false, false, false]; G.lanesFlash = 0; G.multIdx = 0; G.bonus = 0;
    G.dropDone = 0; G.dropResetT = 0; G.specialLit = false; G.standups = [false, false, false]; G.extraLit = false;
    for (const d of DROPS) d.active = true;
    G.tilted = false; G.warnings = 0; G.warnCool = 0;
    G.launched = false; G.phase = 'ball';
    plunger.pull = 0; plunger.pulling = false; plunger.releasing = false;
    resetBallToLane();
    Sound.play('saucer_kick', 0.35, 0.6, 1.2);
    stuck.t = 0;
  }

  function startGame() {
    if (G.state === 'starting') return;
    if (G.credits > 0) { G.credits--; Store.set('credits', G.credits); }
    Sound.unlock();
    Sound.play('coin', 0.8);
    G.state = 'starting'; G.timer = 1.25;
    setTimeout(() => Sound.play('start', 0.85), 260);
    G.score = 0; G.ballNum = 1; G.replayIdx = 0; G.match = -1; G.shootAgain = false; G.newHi = false;
    motor.q.length = 0; G.msg = ''; G.msgT = 0;
    ball.active = false;
    Tilt.calibrate();
    G.hintT = G.firstBallHint ? 7 : 0;
    G.firstBallHint = false;
    setNativeState('play');
  }

  function onDrain() {
    ball.active = false;
    Sound.play('drain', 0.9, panOf(ball.x));
    Sound.roll(0, 1);
    buzz(35, 90);
    if (G.state !== 'play') return;
    if (!G.launched) { resetBallToLane(); return; }
    motor.q.length = 0;
    G.phase = 'bonus';
    G.bonusCount = G.tilted ? 0 : G.bonus;
    G.timer = 0.9;
  }

  function endOfBall() {
    if (G.shootAgain) {
      G.shootAgain = false;
      showMsg('OTRA BOLA');
      newBall();
      return;
    }
    G.ballNum++;
    if (G.ballNum > settings.balls) gameOver();
    else newBall();
  }

  function gameOver() {
    G.state = 'over'; G.phase = 'wait'; G.timer = 1.4;
    G.match = Math.floor(Math.random() * 10) * 10;
    flipL.pressed = flipR.pressed = false;
    Store.set('last', G.score);
  }
  function finishGameOver() {
    if (G.score % 100 === G.match) freeGame('¡MATCH!');
    if (G.score > G.hi) {
      G.hi = G.score; Store.set('hi', G.hi); G.newHi = true;
      setTimeout(() => { showMsg('¡NUEVO RÉCORD!', 3.5); Sound.play('knocker', 0.9); }, 900);
    }
    G.state = 'attract';
    setNativeState('attract');
  }

  function tiltNow() {
    G.tilted = true;
    flipL.pressed = flipR.pressed = false;
    motor.q.length = 0;
    Sound.play('tilt', 1);
    buzz(400, 255);
    showMsg('TILT', 3);
  }
  const nudge = { x: 0, y: 0, mag: 0 };
  function processNudge(dt) {
    Tilt.takeNudge(nudge);
    G.warnCool -= dt;
    G.warnDecay += dt;
    if (G.warnDecay > 9 && G.warnings > 0) { G.warnings--; G.warnDecay = 0; }
    if (nudge.mag < 4) return;
    if (ball.active && !ball.held) {
      const k = clamp((nudge.mag - 3) * 22, 0, 420) / nudge.mag;
      ball.vx += -nudge.x * k; ball.vy += nudge.y * k;
    }
    if (G.state !== 'play' || G.tilted || settings.tilt === 'off' || !G.launched) return;
    const thr = settings.tilt === 'low' ? 17 : 11.5;
    if (nudge.mag > thr && G.warnCool <= 0) {
      G.warnings++; G.warnCool = 0.6; G.warnDecay = 0;
      if (G.warnings >= 3) tiltNow();
      else { Sound.play('warn', 0.8); buzz(90, 200); showMsg('¡CUIDADO!', 1.2); }
    }
  }

  const stuck = { x: 0, y: 0, t: 0 };
  function updateGame(dt) {
    for (const bp of BUMPERS) { bp.cool -= dt; bp.flash = Math.max(0, bp.flash - dt); }
    for (const s of segs) { if (s.cool > 0) s.cool -= dt; if (s.flash > 0) s.flash -= dt; }
    for (const s of sensors) if (s.flash > 0) s.flash -= dt;
    hitCool -= dt; reelClickCool -= dt;
    if (G.msgT > 0) G.msgT -= dt;
    if (G.hintT > 0) G.hintT -= dt;
    G.attractT += dt;

    // spinner
    if (spinner.omega > 0.4) {
      spinner.angle += spinner.omega * dt;
      spinner.omega *= Math.exp(-1.45 * dt);
      const h = Math.floor(spinner.angle / Math.PI);
      if (h !== spinner.half) {
        spinner.half = h;
        Sound.play('spinner', 0.55, -0.6, rand(0.96, 1.04));
        award(100);
      }
    } else {
      spinner.omega = 0;
      const tgt = Math.round(spinner.angle / Math.PI) * Math.PI;
      spinner.angle += (tgt - spinner.angle) * Math.min(1, dt * 8);
      spinner.half = Math.floor((spinner.angle + 0.01) / Math.PI);
    }
    // agujero
    if (ball.held) { saucer.timer -= dt; if (saucer.timer <= 0) kickSaucer(); }
    else if (saucer.cool > 0) saucer.cool -= dt;
    // dianas
    if (G.dropResetT > 0) {
      G.dropResetT -= dt;
      if (G.dropResetT <= 0) {
        for (const d of DROPS) d.active = true;
        Sound.play('reset', 0.85, -0.5);
      }
    }
    if (G.lanesFlash > 0) { G.lanesFlash -= dt; if (G.lanesFlash <= 0) G.lanes = [false, false, false]; }

    if (G.state === 'starting') {
      G.timer -= dt;
      if (G.timer <= 0) { G.state = 'play'; newBall(); }
    } else if (G.state === 'play') {
      if (ball.active && !G.launched && (ball.x < 466 || ball.y < 285)) G.launched = true;
      if (G.phase === 'bonus') {
        G.timer -= dt;
        if (G.timer <= 0) {
          if (G.bonusCount > 0) {
            G.bonusCount--; G.bonus = G.bonusCount;
            addScore(1000 * MULTS[G.multIdx], false);
            Sound.play('chime1000', 0.6);
            if (MULTS[G.multIdx] > 1) setTimeout(() => Sound.play('chime100', 0.35), 45);
            G.timer = 0.17 + 0.03 * MULTS[G.multIdx];
          } else {
            G.phase = 'wait'; G.timer = 0.7;
          }
        }
      } else if (G.phase === 'wait') {
        G.timer -= dt;
        if (G.timer <= 0) endOfBall();
      }
      // bola atascada (muy raro): pequeño meneo automático
      if (ball.active && !ball.held && G.phase === 'ball') {
        if (Math.hypot(ball.x - stuck.x, ball.y - stuck.y) > 4) { stuck.x = ball.x; stuck.y = ball.y; stuck.t = 0; }
        else stuck.t += dt;
        const inLane = ball.x > 471;
        const cradled = (flipL.pressed || flipR.pressed) && ball.y > 820;
        if (stuck.t > 3 && !inLane && !cradled) { ball.vy -= 320; ball.vx += rand(-200, 200); stuck.t = 0; }
      }
    } else if (G.state === 'over') {
      G.timer -= dt;
      if (G.timer <= 0) finishGameOver();
    }
  }

  // rodillos del marcador
  const reels = { pos: [0, 0, 0, 0, 0, 0], credit: [0, 0] };
  (function initReels() {
    const s = String(G.score % 1000000).padStart(6, '0');
    for (let i = 0; i < 6; i++) reels.pos[i] = +s[i];
  })();
  function updateReels(dt) {
    const s = String(Math.floor(G.score) % 1000000).padStart(6, '0');
    for (let i = 0; i < 6; i++) {
      const target = +s[i];
      let p = reels.pos[i];
      const cur = ((p % 10) + 10) % 10;
      if (Math.abs(cur - target) < 0.001) { reels.pos[i] = target; continue; }
      let dist = target - cur; if (dist < 0) dist += 10;
      const step = Math.min(dist, dt * 22);
      const before = Math.floor(cur + 0.0001);
      p = cur + step; if (p >= 10) p -= 10;
      reels.pos[i] = p;
      if (Math.floor(p + 0.0001) !== before && G.state === 'starting' && reelClickCool <= 0) {
        Sound.play('reel', 0.25, 0, rand(0.95, 1.05)); reelClickCool = 0.03;
      }
    }
  }

  /* =====================================================================
   * Render
   * ===================================================================== */
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const Lay = { W: 0, H: 0, dpr: 1, safeT: 0, bgH: 0, s: 1, ox: 0, oy: 0, btnMenu: null, btnStart: null };
  let bgLayer = null, pfLayer = null, ovLayer = null;

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function starPath(c, x, y, R, r, n, rot) {
    c.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = rot + i * Math.PI / n, rr = i % 2 ? r : R;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.closePath();
  }
  function makeRng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
  function wood(c, x, y, w, h, base, seed, vertical) {
    c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.fillStyle = base; c.fillRect(x, y, w, h);
    const r = makeRng(seed);
    const n = Math.max(30, Math.floor((vertical ? w : h) / 3));
    for (let i = 0; i < n; i++) {
      c.strokeStyle = r() < 0.55 ? 'rgba(25,10,2,' + (0.06 + r() * 0.12) + ')' : 'rgba(255,215,160,' + (0.04 + r() * 0.07) + ')';
      c.lineWidth = 0.4 + r() * 2.2;
      c.beginPath();
      const off = r() * (vertical ? w : h), amp = 1 + r() * 4, fq = 0.004 + r() * 0.02, ph = r() * 6;
      const L = vertical ? h : w;
      for (let k = 0; k <= 40; k++) {
        const u = k / 40 * L;
        const v = off + Math.sin(u * fq + ph) * amp + Math.sin(u * fq * 3.1 + ph) * amp * 0.3;
        if (vertical) { if (k) c.lineTo(x + v, y + u); else c.moveTo(x + v, y + u); }
        else { if (k) c.lineTo(x + u, y + v); else c.moveTo(x + u, y + v); }
      }
      c.stroke();
    }
    c.restore();
  }
  function outlinedText(c, txt, x, y, font, fill, stroke, lw) {
    c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round';
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.strokeText(txt, x, y); }
    c.fillStyle = fill; c.fillText(txt, x, y);
  }

  function readSafeTop() {
    let t = 0;
    if (NATIVE) { try { t = +NATIVE.safeTop() || 0; } catch (e) { t = 0; } }
    if (!t) { const p = document.getElementById('safe-probe'); t = p ? p.getBoundingClientRect().height : 0; }
    return t;
  }

  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const safeT = readSafeTop();
    let s = W / 540;
    let bgH = H - safeT - TH * s;
    const minBg = Math.max(104, H * 0.115);
    if (bgH < minBg) { bgH = minBg; s = (H - safeT - bgH) / TH; }
    Object.assign(Lay, { W, H, dpr, safeT, bgH, s, ox: (W - TW * s) / 2, oy: H - TH * s });
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    buildStatic();
  }

  /* ---------- capas estáticas ---------- */
  function buildStatic() {
    const { W, H, dpr, s } = Lay;
    bgLayer = document.createElement('canvas');
    bgLayer.width = Math.round(W * dpr); bgLayer.height = Math.round(H * dpr);
    const b = bgLayer.getContext('2d');
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCabinet(b);
    drawBackglassStatic(b);

    const pw = Math.ceil(TW * s * dpr), ph = Math.ceil(TH * s * dpr);
    pfLayer = document.createElement('canvas'); pfLayer.width = pw; pfLayer.height = ph;
    const p = pfLayer.getContext('2d');
    p.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    drawPlayfieldStatic(p);

    ovLayer = document.createElement('canvas'); ovLayer.width = pw; ovLayer.height = ph;
    const o = ovLayer.getContext('2d');
    o.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    drawOverlayStatic(o);
  }

  function drawCabinet(c) {
    const { W, H } = Lay;
    wood(c, 0, 0, W, H, '#5a3218', 7, true);
    const g = c.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.08, 'rgba(0,0,0,0)');
    g.addColorStop(0.92, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // moldura cromada alrededor del tablero
    const { ox, oy, s } = Lay;
    c.fillStyle = '#1a0d05';
    c.fillRect(ox - 4, oy - 4, TW * s + 8, TH * s + 8);
    const mg = c.createLinearGradient(ox - 6, 0, ox + TW * s + 6, 0);
    mg.addColorStop(0, '#6b6f75'); mg.addColorStop(0.5, '#e6e8eb'); mg.addColorStop(1, '#6b6f75');
    c.strokeStyle = mg; c.lineWidth = 2;
    c.strokeRect(ox - 3, oy - 3, TW * s + 6, TH * s + 6);
  }

  function bgBox() {
    const { W, safeT, bgH } = Lay;
    return { x: 5, y: safeT + 4, w: W - 10, h: bgH - 9 };
  }

  function drawBackglassStatic(c) {
    const B = bgBox();
    // marco
    c.save();
    rrect(c, B.x - 2, B.y - 2, B.w + 4, B.h + 4, 10);
    const fg = c.createLinearGradient(0, B.y, 0, B.y + B.h);
    fg.addColorStop(0, '#f0f1f3'); fg.addColorStop(0.5, '#8d9298'); fg.addColorStop(1, '#e2e4e7');
    c.fillStyle = fg; c.fill();
    rrect(c, B.x, B.y, B.w, B.h, 9);
    c.clip();
    const g = c.createLinearGradient(0, B.y, 0, B.y + B.h);
    g.addColorStop(0, '#1b0b3a'); g.addColorStop(0.55, '#3a0f4a'); g.addColorStop(1, '#130624');
    c.fillStyle = g; c.fillRect(B.x, B.y, B.w, B.h);
    // rayos de sol setenteros
    const cx = B.x + B.w / 2, cy = B.y + B.h * 1.15;
    for (let i = 0; i < 22; i++) {
      const a0 = Math.PI + i * Math.PI / 22, a1 = a0 + Math.PI / 44;
      c.beginPath(); c.moveTo(cx, cy);
      c.arc(cx, cy, B.w, a0, a1); c.closePath();
      c.fillStyle = i % 2 ? 'rgba(255,120,40,0.10)' : 'rgba(255,200,60,0.07)';
      c.fill();
    }
    // estrellitas
    const r = makeRng(42);
    for (let i = 0; i < 40; i++) {
      c.fillStyle = 'rgba(255,240,200,' + (0.25 + r() * 0.6) + ')';
      const sx = B.x + r() * B.w, sy = B.y + r() * B.h, sr = 0.5 + r() * 1.3;
      c.beginPath(); c.arc(sx, sy, sr, 0, Math.PI * 2); c.fill();
    }
    // franjas inferiores
    const bands = ['#e8352a', '#f08a24', '#f5c242'];
    for (let i = 0; i < 3; i++) {
      c.fillStyle = bands[i];
      c.fillRect(B.x, B.y + B.h - 4 - i * 3.2, B.w, 2.2);
    }
    c.restore();

    // título
    const L = bgLayout();
    const ts = L.titleSize;
    c.save();
    const tg = c.createLinearGradient(0, L.titleY - ts / 2, 0, L.titleY + ts / 2);
    tg.addColorStop(0, '#fff3a0'); tg.addColorStop(0.45, '#ffc12e'); tg.addColorStop(1, '#ff5a1f');
    c.font = ts + 'px Shrikhand, Georgia, serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    c.lineWidth = Math.max(3, ts * 0.22); c.strokeStyle = '#2a0620';
    c.strokeText('Estrella Fugaz', cx, L.titleY + ts * 0.06);
    c.fillStyle = tg; c.fillText('Estrella Fugaz', cx, L.titleY);
    c.restore();
    // estrellitas a ambos lados del título
    c.save();
    c.font = ts + 'px Shrikhand, Georgia, serif';
    const tw = c.measureText('Estrella Fugaz').width;
    for (const side of [-1, 1]) {
      const sx = cx + side * (tw / 2 + ts * 0.45), sy = L.titleY - ts * 0.05;
      if (Math.abs(sx - cx) + ts * 0.35 > B.w / 2 - L.sideW * 0.15) continue;
      starPath(c, sx, sy, ts * 0.3, ts * 0.13, 5, -Math.PI / 2);
      c.fillStyle = '#fff1a8'; c.fill(); c.strokeStyle = '#7a2a00'; c.lineWidth = 1; c.stroke();
    }
    c.restore();

    // ventanas de rodillos
    c.save();
    rrect(c, L.reelX - 5, L.reelY - 4, L.reelW + 10, L.reelH + 8, 5);
    c.fillStyle = '#050208'; c.fill();
    c.strokeStyle = '#c9a24a'; c.lineWidth = 1.5; c.stroke();
    c.restore();
    // créditos
    c.save();
    rrect(c, L.credX - 3, L.rowY - L.rowH * 0.5 - 1, L.credW + 6, L.rowH + 2, 3);
    c.fillStyle = '#050208'; c.fill(); c.strokeStyle = '#c9a24a'; c.lineWidth = 1; c.stroke();
    c.restore();
  }

  function bgLayout() {
    const B = bgBox();
    const titleSize = Math.min(B.h * 0.25, B.w * 0.085);
    const titleY = B.y + B.h * 0.19;
    const reelH = B.h * 0.36;
    const reelDW = reelH * 0.68, gap = Math.max(2, reelH * 0.06);
    const reelW = reelDW * 6 + gap * 5;
    const reelX = B.x + (B.w - reelW) / 2;
    const reelY = B.y + B.h * 0.37;
    const rowH = B.h * 0.15;
    const rowY = B.y + B.h * 0.86;
    const credW = rowH * 1.25;
    const credX = B.x + B.w - credW - B.w * 0.03;
    const sideW = (B.w - reelW) / 2;
    const btn = Math.min(reelH * 1.15, sideW * 0.72);
    return { B, titleSize, titleY, reelH, reelDW, gap, reelW, reelX, reelY, rowH, rowY, credW, credX, sideW, btn };
  }

  function drawPlayfieldStatic(c) {
    // madera bajo el tablero
    wood(c, 0, 0, TW, TH, '#4a2a14', 11, false);
    // forma del tablero
    c.save();
    c.beginPath();
    c.moveTo(10, 1040); c.lineTo(10, 260); c.arc(260, 260, 250, Math.PI, 2 * Math.PI); c.lineTo(510, 1040); c.closePath();
    c.clip();
    const base = c.createLinearGradient(0, 0, 0, TH);
    base.addColorStop(0, '#f6e2b8'); base.addColorStop(0.5, '#f3d9a6'); base.addColorStop(1, '#efcf98');
    c.fillStyle = base; c.fillRect(0, 0, TW, TH);

    // cielo nocturno arriba
    const sky = c.createLinearGradient(0, 0, 0, 230);
    sky.addColorStop(0, '#13234f'); sky.addColorStop(1, '#2a3f7e');
    c.fillStyle = sky; c.fillRect(0, 0, TW, 230);
    c.fillStyle = '#e8352a'; c.fillRect(0, 226, TW, 5);
    c.fillStyle = '#f08a24'; c.fillRect(0, 231, TW, 5);
    c.fillStyle = '#f5c242'; c.fillRect(0, 236, TW, 5);
    const rr = makeRng(99);
    for (let i = 0; i < 70; i++) {
      c.fillStyle = 'rgba(255,245,215,' + (0.3 + rr() * 0.7) + ')';
      c.beginPath(); c.arc(rr() * TW, rr() * 222, 0.4 + rr() * 1.4, 0, 7); c.fill();
    }
    // rayos de sol detrás de los bumpers
    for (let i = 0; i < 28; i++) {
      const a0 = i * Math.PI * 2 / 28, a1 = a0 + Math.PI / 28;
      c.beginPath(); c.moveTo(260, 330); c.arc(260, 330, 330, a0, a1); c.closePath();
      c.fillStyle = i % 2 ? 'rgba(240,130,40,0.13)' : 'rgba(255,200,80,0.10)';
      c.fill();
    }
    c.fillStyle = 'rgba(19,35,79,1)'; c.fillRect(0, 0, TW, 226);
    for (let i = 0; i < 70; i++) {
      c.fillStyle = 'rgba(255,245,215,' + (0.3 + rr() * 0.7) + ')';
      c.beginPath(); c.arc(rr() * TW, rr() * 222, 0.4 + rr() * 1.4, 0, 7); c.fill();
    }
    // gran estrella central (estrella fugaz) con estela
    c.save();
    c.globalAlpha = 0.9;
    const tr = ['#f5c242', '#f08a24', '#e8352a'];
    for (let k = 0; k < 3; k++) {
      c.strokeStyle = tr[k]; c.lineWidth = 9; c.lineCap = 'round';
      c.beginPath(); c.moveTo(212, 455 + k * 12 - 12); c.quadraticCurveTo(150, 420 + k * 12, 92, 470 + k * 14); c.stroke();
    }
    starPath(c, 240, 470, 46, 20, 5, -Math.PI / 2);
    c.fillStyle = '#1f8a8a'; c.fill();
    c.lineWidth = 3; c.strokeStyle = '#fff6dc'; c.stroke();
    c.restore();
    // título pintado
    outlinedText(c, 'Estrella Fugaz', 240, 548, '29px Shrikhand, Georgia, serif', '#e8352a', '#fff3d0', 6);
    outlinedText(c, '— 1 JUGADOR · 3 Ó 5 BOLAS —', 240, 574, '11px Bebas, sans-serif', '#6b2a10', null, 0);
    // arcos setenteros abajo
    const bands = ['#e8352a', '#f08a24', '#f5c242', '#1f8a8a'];
    for (let i = 0; i < 4; i++) {
      c.strokeStyle = bands[i]; c.lineWidth = 12;
      c.beginPath(); c.arc(240, 1180, 296 + i * 14, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
    }
    // carril de lanzamiento (madera)
    wood(c, 470, 300, 40, 740, '#b98a58', 5, true);
    c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(470, 300, 3, 740); c.fillRect(507, 300, 3, 740);
    for (let i = 0; i < 3; i++) {
      c.beginPath(); c.moveTo(490, 620 + i * 60); c.lineTo(481, 638 + i * 60); c.lineTo(499, 638 + i * 60); c.closePath();
      c.fillStyle = i === 0 ? '#e8352a' : i === 1 ? '#f08a24' : '#f5c242'; c.fill();
    }
    // textos del tablero
    outlinedText(c, 'BONO', 240, 662, '13px Bebas, sans-serif', '#6b2a10', null, 0);
    outlinedText(c, 'x 1.000', 240, 676, '10px Bebas, sans-serif', '#6b2a10', null, 0);
    c.save(); c.translate(484, 520); c.rotate(-Math.PI / 2);
    outlinedText(c, '3.000 · BOLA EXTRA', 0, 0, '9px Bebas, sans-serif', '#6b2a10', null, 0);
    c.restore();
    c.save(); c.translate(100, 505); c.rotate(Math.PI / 2);
    outlinedText(c, '500 · 4 = 5.000', 0, 0, '9px Bebas, sans-serif', '#6b2a10', null, 0);
    c.restore();
    outlinedText(c, 'SPINNER', 38, 236, '8px Bebas, sans-serif', '#ffe9b0', null, 0);
    outlinedText(c, '1.000', 71, 760, '8px Bebas, sans-serif', '#6b2a10', null, 0);
    outlinedText(c, '1.000', 409, 760, '8px Bebas, sans-serif', '#6b2a10', null, 0);
    outlinedText(c, '5.000', 30, 772, '8px Bebas, sans-serif', '#6b2a10', null, 0);
    outlinedText(c, '5.000', 450, 772, '8px Bebas, sans-serif', '#6b2a10', null, 0);
    c.restore(); // fin del recorte del tablero

    // ranura de las dianas abatibles
    c.fillStyle = '#1a0f08'; rrect(c, 46, 430, 10, 142, 2); c.fill();
    // agujero
    const sg = c.createRadialGradient(saucer.x, saucer.y, 2, saucer.x, saucer.y, saucer.r);
    sg.addColorStop(0, '#000'); sg.addColorStop(0.75, '#1d1410'); sg.addColorStop(1, '#5b4a3c');
    c.fillStyle = sg; c.beginPath(); c.arc(saucer.x, saucer.y, saucer.r, 0, 7); c.fill();
    c.strokeStyle = '#d7dbe0'; c.lineWidth = 3; c.beginPath(); c.arc(saucer.x, saucer.y, saucer.r + 1, Math.PI * 0.15, Math.PI * 1.85); c.stroke();
    // sensores: estrellas y alambres
    for (const sn of sensors) {
      if (sn.kind === 'star') {
        starPath(c, sn.x, sn.y, 12, 5.5, 5, -Math.PI / 2);
        c.fillStyle = '#fffbe9'; c.fill(); c.strokeStyle = '#8a6a30'; c.lineWidth = 1.2; c.stroke();
        c.fillStyle = '#d9a441'; c.beginPath(); c.arc(sn.x, sn.y, 3, 0, 7); c.fill();
      } else {
        c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 3.5;
        c.beginPath(); c.moveTo(sn.x, sn.y - 11); c.lineTo(sn.x, sn.y + 11); c.stroke();
        c.strokeStyle = '#e9ecef'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(sn.x, sn.y - 12); c.lineTo(sn.x, sn.y + 10); c.stroke();
      }
    }
    // lámparas apagadas
    for (const id in LAMPS) drawLamp(c, LAMPS[id], false);
    // sombras de bumpers
    for (const bp of BUMPERS) {
      c.fillStyle = 'rgba(0,0,0,0.28)'; c.beginPath(); c.arc(bp.x + 4, bp.y + 6, bp.r + 2, 0, 7); c.fill();
    }
    // plásticos de los slingshots
    for (const sl of SLINGS) {
      const t = sl.tri;
      c.beginPath(); c.moveTo(t[0][0], t[0][1]); c.lineTo(t[1][0], t[1][1]); c.lineTo(t[2][0], t[2][1]); c.closePath();
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.save(); c.translate(3, 5); c.fill(); c.restore();
      const pg = c.createLinearGradient(t[0][0], t[0][1], t[2][0], t[2][1]);
      pg.addColorStop(0, '#ff5a2a'); pg.addColorStop(1, '#b81d12');
      c.fillStyle = pg; c.fill();
      c.save(); c.clip();
      c.strokeStyle = '#ffd23a'; c.lineWidth = 6;
      c.beginPath(); c.moveTo((t[0][0] + t[1][0]) / 2, (t[0][1] + t[1][1]) / 2); c.lineTo((t[1][0] + t[2][0]) / 2, (t[1][1] + t[2][1]) / 2); c.stroke();
      c.restore();
    }
    // paredes, guías y gomas
    drawWalls(c);
    // postes
    for (const p of POSTS) drawPost(c, p[0], p[1], p[2]);
    // soporte del spinner
    drawPost(c, spinner.x1 + 2, spinner.y, 'chrome'); drawPost(c, spinner.x2 - 2, spinner.y, 'chrome');
    c.strokeStyle = '#cfd3d8'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(spinner.x1 + 2, spinner.y); c.lineTo(spinner.x2 - 2, spinner.y); c.stroke();
  }

  function drawWalls(c) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    // sombras
    c.save(); c.translate(2.5, 4);
    c.strokeStyle = 'rgba(0,0,0,0.3)';
    for (const s of segs) {
      if (!s.draw || s.kind === 'gate') continue;
      c.lineWidth = s.r * 2 + 1; c.beginPath(); c.moveTo(s.ax, s.ay); c.lineTo(s.bx, s.by); c.stroke();
    }
    c.restore();
    for (const s of segs) {
      if (!s.draw) continue;
      if (s.kind === 'rail' || s.kind === 'guide') {
        c.strokeStyle = '#4a4e55'; c.lineWidth = s.r * 2 + 1.5;
        c.beginPath(); c.moveTo(s.ax, s.ay); c.lineTo(s.bx, s.by); c.stroke();
        c.strokeStyle = s.kind === 'guide' ? '#c8ccd2' : '#b9bec5'; c.lineWidth = s.r * 2 - 1;
        c.beginPath(); c.moveTo(s.ax, s.ay); c.lineTo(s.bx, s.by); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 0.9;
        c.beginPath(); c.moveTo(s.ax - 0.8, s.ay - 0.8); c.lineTo(s.bx - 0.8, s.by - 0.8); c.stroke();
      } else if (s.kind === 'rubber' || s.kind === 'sling') {
        c.strokeStyle = '#2a2a2a'; c.lineWidth = s.r * 2 + 1;
        c.beginPath(); c.moveTo(s.ax, s.ay); c.lineTo(s.bx, s.by); c.stroke();
        c.strokeStyle = '#f6f4ee'; c.lineWidth = s.r * 2 - 1.2;
        c.beginPath(); c.moveTo(s.ax, s.ay); c.lineTo(s.bx, s.by); c.stroke();
      } else if (s.kind === 'gate') {
        c.strokeStyle = '#e0e3e7'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(s.ax, s.ay); c.lineTo(s.bx, s.by); c.stroke();
        c.strokeStyle = 'rgba(80,80,90,0.8)'; c.lineWidth = 1;
        for (let k = 1; k < 5; k++) {
          const t = k / 5, x = s.ax + s.ex * t, y = s.ay + s.ey * t;
          c.beginPath(); c.moveTo(x, y); c.lineTo(x - 3, y - 6); c.stroke();
        }
      }
    }
  }
  function drawPost(c, x, y, kind) {
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.arc(x + 2, y + 3, 6.5, 0, 7); c.fill();
    if (kind === 'red' || kind === 'white') {
      c.fillStyle = kind === 'red' ? '#c62828' : '#f2f0ea';
      c.beginPath(); c.arc(x, y, 6.2, 0, 7); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.8; c.stroke();
    }
    const g = c.createRadialGradient(x - 1.2, y - 1.4, 0.3, x, y, 4);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#c6cbd2'); g.addColorStop(1, '#5e636b');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, kind === 'chrome' ? 4.6 : 3.4, 0, 7); c.fill();
  }

  function drawLamp(c, L, on) {
    const { x, y, r, color } = L;
    const rx = L.shape === 'oval' ? r * 1.65 : r, ry = r;
    if (on) {
      const glow = c.createRadialGradient(x, y, 1, x, y, Math.max(rx, ry) * 2.6);
      glow.addColorStop(0, rgba(color, 0.75)); glow.addColorStop(0.45, rgba(color, 0.28)); glow.addColorStop(1, rgba(color, 0));
      c.fillStyle = glow; c.beginPath(); c.ellipse(x, y, rx * 2.6, ry * 2.6, 0, 0, 7); c.fill();
    }
    c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7);
    if (on) {
      const g = c.createRadialGradient(x - rx * 0.3, y - ry * 0.35, 0.5, x, y, Math.max(rx, ry));
      g.addColorStop(0, '#fffef2'); g.addColorStop(0.35, shade(color, 0.45)); g.addColorStop(1, color);
      c.fillStyle = g;
    } else {
      const g = c.createRadialGradient(x - rx * 0.3, y - ry * 0.35, 0.5, x, y, Math.max(rx, ry));
      g.addColorStop(0, shade(color, -0.35)); g.addColorStop(1, shade(color, -0.68));
      c.fillStyle = g;
    }
    c.fill();
    c.strokeStyle = on ? 'rgba(90,40,0,0.6)' : 'rgba(0,0,0,0.55)'; c.lineWidth = 1; c.stroke();
    if (L.label) {
      c.font = L.fs + 'px Bebas, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = on ? '#3a1200' : 'rgba(255,240,215,0.55)';
      c.fillText(L.label, x, y + 0.6);
    }
  }

  function drawOverlayStatic(c) {
    // delantal (apron)
    c.save();
    c.beginPath();
    c.moveTo(10, 1040); c.lineTo(10, 960); c.lineTo(62, 960); c.lineTo(112, 978);
    c.lineTo(368, 978); c.lineTo(418, 960); c.lineTo(470, 960); c.lineTo(470, 1040); c.closePath();
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.save(); c.translate(0, -3); c.fill(); c.restore();
    const ag = c.createLinearGradient(0, 960, 0, 1040);
    ag.addColorStop(0, '#c0301f'); ag.addColorStop(1, '#7a160c');
    c.fillStyle = ag; c.fill();
    c.strokeStyle = '#f5c242'; c.lineWidth = 2; c.stroke();
    c.clip();
    for (let i = 0; i < 3; i++) {
      c.fillStyle = ['#f5c242', '#f08a24', '#1f8a8a'][i];
      c.fillRect(10, 1028 + i * 4, 460, 2.5);
    }
    // tarjetas
    rrect(c, 22, 986, 120, 36, 3); c.fillStyle = '#fbf1d8'; c.fill();
    rrect(c, 338, 986, 120, 36, 3); c.fillStyle = '#fbf1d8'; c.fill();
    outlinedText(c, 'PARTIDA GRATIS', 82, 995, '9px Bebas, sans-serif', '#7a160c', null, 0);
    outlinedText(c, '150.000 · 300.000 · 450.000', 82, 1006, '7.5px Bebas, sans-serif', '#3a1a08', null, 0);
    outlinedText(c, 'MATCH = PARTIDA GRATIS', 82, 1015, '7px Bebas, sans-serif', '#3a1a08', null, 0);
    outlinedText(c, 'INCLINA EL MÓVIL', 398, 995, '9px Bebas, sans-serif', '#7a160c', null, 0);
    outlinedText(c, 'VOLUMEN = LANZADOR', 398, 1006, '7.5px Bebas, sans-serif', '#3a1a08', null, 0);
    outlinedText(c, 'TILT ANULA LA BOLA', 398, 1015, '7px Bebas, sans-serif', '#3a1a08', null, 0);
    // nivel de burbuja
    c.fillStyle = '#1a1208'; c.beginPath(); c.arc(240, 1006, 21, 0, 7); c.fill();
    c.strokeStyle = '#d7dbe0'; c.lineWidth = 2.5; c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(222, 1006); c.lineTo(258, 1006); c.moveTo(240, 988); c.lineTo(240, 1024); c.stroke();
    c.beginPath(); c.arc(240, 1006, 7, 0, 7); c.stroke();
    c.restore();
    // carcasa del lanzador
    c.fillStyle = '#2b2b30'; rrect(c, 476, 1018, 28, 22, 3); c.fill();
    // brillo del cristal
    const gl = c.createLinearGradient(0, 0, TW, TH);
    gl.addColorStop(0, 'rgba(255,255,255,0.10)'); gl.addColorStop(0.3, 'rgba(255,255,255,0.0)');
    gl.addColorStop(0.55, 'rgba(255,255,255,0.05)'); gl.addColorStop(0.62, 'rgba(255,255,255,0.0)');
    c.fillStyle = gl; c.fillRect(0, 0, TW, TH);
  }

  /* ---------- elementos dinámicos ---------- */
  function lampOn(id) {
    const t = G.attractT;
    if (G.state === 'attract' || G.state === 'over') {
      const L = LAMPS[id];
      const ph = Math.floor(t * 6 + L.x * 0.02 + L.y * 0.013);
      return (ph % 4) === 0;
    }
    if (G.tilted) return false;
    if (id.startsWith('lane')) {
      const i = +id[4];
      if (G.lanesFlash > 0) return Math.floor(G.lanesFlash * 8) % 2 === 0;
      return G.lanes[i];
    }
    if (id === 'x1') return G.multIdx >= 1;
    if (id === 'x2') return G.multIdx >= 2;
    if (id === 'x3') return G.multIdx >= 3;
    if (id === 'spin') return spinner.omega > 1;
    if (id[0] === 'd' && id.length === 2) return !DROPS[+id[1]].active;
    if (id.startsWith('spec')) return G.specialLit && Math.floor(t * 3) % 2 === 0;
    if (id[0] === 's' && id.length === 2) return G.standups[+id[1]];
    if (id === 'extra') return G.extraLit && Math.floor(t * 3) % 2 === 0;
    if (id[0] === 'b') return G.bonus >= +id.slice(1);
    if (id === 'again') return G.shootAgain;
    return false;
  }

  function drawBumper(c, bp) {
    const lit = G.state === 'attract' || G.state === 'over' || !G.tilted;
    const f = bp.flash > 0 ? bp.flash / 0.16 : 0;
    const { x, y } = bp;
    // faldón
    c.fillStyle = '#f4f1ea'; c.beginPath(); c.arc(x, y, bp.r, 0, 7); c.fill();
    c.strokeStyle = '#555'; c.lineWidth = 1; c.stroke();
    c.fillStyle = '#c9c4b8'; c.beginPath(); c.arc(x, y, bp.r - 3, 0, 7); c.fill();
    // cuerpo
    const k = 1 - f * 0.08;
    c.fillStyle = '#7a1a10'; c.beginPath(); c.arc(x + 1, y + 2, 24 * k, 0, 7); c.fill();
    if (lit) {
      const glow = c.createRadialGradient(x, y, 4, x, y, 44 + f * 12);
      glow.addColorStop(0, rgba(bp.color, 0.45 + f * 0.4)); glow.addColorStop(1, rgba(bp.color, 0));
      c.fillStyle = glow; c.beginPath(); c.arc(x, y, 44 + f * 12, 0, 7); c.fill();
    }
    // tapa
    const cg = c.createRadialGradient(x - 6, y - 7, 2, x, y, 22 * k);
    if (lit) { cg.addColorStop(0, '#fffde8'); cg.addColorStop(0.4 - f * 0.2, shade(bp.color, 0.3 + f * 0.4)); cg.addColorStop(1, bp.color); }
    else { cg.addColorStop(0, shade(bp.color, -0.3)); cg.addColorStop(1, shade(bp.color, -0.65)); }
    c.fillStyle = cg; c.beginPath(); c.arc(x, y, 21 * k, 0, 7); c.fill();
    c.strokeStyle = 'rgba(80,20,0,0.6)'; c.lineWidth = 1.2; c.stroke();
    starPath(c, x, y - 1, 11 * k, 4.8 * k, 5, -Math.PI / 2);
    c.fillStyle = lit ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)'; c.fill();
    c.font = '8px Bebas, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#5a1000'; c.fillText('100', x, y + 13 * k);
  }

  function drawFlipper(c, f) {
    const a = f.angle, ca = Math.cos(a), sa = Math.sin(a);
    const nx = -sa, ny = ca;
    const path = (ox, oy) => {
      c.beginPath();
      c.moveTo(f.px + nx * f.rb + ox, f.py + ny * f.rb + oy);
      c.lineTo(f.tipX + nx * f.rt + ox, f.tipY + ny * f.rt + oy);
      c.arc(f.tipX + ox, f.tipY + oy, f.rt, a + Math.PI / 2, a - Math.PI / 2, true);
      c.lineTo(f.px - nx * f.rb + ox, f.py - ny * f.rb + oy);
      c.arc(f.px + ox, f.py + oy, f.rb, a - Math.PI / 2, a + Math.PI / 2, true);
      c.closePath();
    };
    path(3, 5); c.fillStyle = 'rgba(0,0,0,0.32)'; c.fill();
    path(0, 0);
    c.fillStyle = '#c62828'; c.fill();
    c.strokeStyle = '#5a0e0e'; c.lineWidth = 1; c.stroke();
    // cuerpo blanco
    const s = 0.72;
    c.beginPath();
    c.moveTo(f.px + nx * f.rb * s, f.py + ny * f.rb * s);
    c.lineTo(f.tipX + nx * f.rt * s, f.tipY + ny * f.rt * s);
    c.arc(f.tipX, f.tipY, f.rt * s, a + Math.PI / 2, a - Math.PI / 2, true);
    c.lineTo(f.px - nx * f.rb * s, f.py - ny * f.rb * s);
    c.arc(f.px, f.py, f.rb * s, a - Math.PI / 2, a + Math.PI / 2, true);
    c.closePath();
    const g = c.createLinearGradient(f.px + nx * 10, f.py + ny * 10, f.px - nx * 10, f.py - ny * 10);
    g.addColorStop(0, '#d8d4ca'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#cfcac0');
    c.fillStyle = g; c.fill();
    drawPost(c, f.px, f.py, 'chrome');
  }

  function drawBall(c) {
    const { x, y } = ball;
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath(); c.ellipse(x + 3.5, y + 5, BALL_R, BALL_R * 0.9, 0, 0, 7); c.fill();
    const g = c.createRadialGradient(x - 4.5, y - 5.5, 0.8, x, y, BALL_R);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.18, '#e9ecf0'); g.addColorStop(0.55, '#9aa1aa');
    g.addColorStop(0.85, '#4b5058'); g.addColorStop(1, '#2a2d33');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, BALL_R, 0, 7); c.fill();
    // reflejo cálido del tablero
    c.fillStyle = 'rgba(255,190,110,0.25)';
    c.beginPath(); c.ellipse(x + 1, y + 7, 8, 3.5, 0, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.beginPath(); c.ellipse(x - 4.5, y - 5.5, 2.6, 1.8, -0.6, 0, 7); c.fill();
  }

  function drawDynamic(c) {
    // lámparas encendidas
    for (const id in LAMPS) if (lampOn(id)) drawLamp(c, LAMPS[id], true);
    // destello de sensores
    for (const sn of sensors) if (sn.flash > 0 && sn.kind === 'star') {
      c.fillStyle = 'rgba(255,240,150,' + (sn.flash * 2.5) + ')';
      c.beginPath(); c.arc(sn.x, sn.y, 15, 0, 7); c.fill();
    }
    // dianas abatibles
    for (const d of DROPS) {
      if (!d.active) continue;
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(54, d.ay + 3, 9, d.by - d.ay);
      const g = c.createLinearGradient(50, 0, 61, 0);
      g.addColorStop(0, '#b87a00'); g.addColorStop(0.5, '#ffd23a'); g.addColorStop(1, '#c98a10');
      c.fillStyle = g; rrect(c, 51, d.ay, 9, d.by - d.ay, 1.5); c.fill();
      c.strokeStyle = '#5a3a00'; c.lineWidth = 0.8; c.stroke();
      c.fillStyle = '#5a1a00'; c.beginPath(); c.arc(55.5, (d.ay + d.by) / 2, 2.2, 0, 7); c.fill();
    }
    // dianas fijas
    for (const s of STANDUPS) {
      const f = s.flash > 0;
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(463, s.ay + 4, 8, s.by - s.ay);
      c.fillStyle = f ? '#fffbe0' : '#f2efe6'; rrect(c, 459.5, s.ay, 8, s.by - s.ay, 2); c.fill();
      c.fillStyle = f ? '#ff8a3a' : '#2f9e4a'; rrect(c, 460.5, s.ay + 3, 3, s.by - s.ay - 6, 1); c.fill();
    }
    // spinner
    {
      const h = 13 * Math.abs(Math.cos(spinner.angle));
      const g = c.createLinearGradient(0, spinner.y - h, 0, spinner.y + h);
      g.addColorStop(0, '#9aa0a8'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#7c828a');
      c.fillStyle = g; c.fillRect(spinner.x1 + 5, spinner.y - h * 0.5, spinner.x2 - spinner.x1 - 10, Math.max(1.2, h));
      if (h > 3) { c.fillStyle = '#e8352a'; c.fillRect(spinner.x1 + 9, spinner.y - 1, spinner.x2 - spinner.x1 - 18, 2); }
    }
    // destello de slingshots
    for (const sl of SLINGS) if (sl.flash > 0) {
      c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = 7; c.lineCap = 'round';
      const off = 3;
      c.beginPath(); c.moveTo(sl.ax + sl.kn.x * off, sl.ay + sl.kn.y * off); c.lineTo(sl.bx + sl.kn.x * off, sl.by + sl.kn.y * off); c.stroke();
      const t = sl.tri;
      c.fillStyle = 'rgba(255,230,120,0.35)';
      c.beginPath(); c.moveTo(t[0][0], t[0][1]); c.lineTo(t[1][0], t[1][1]); c.lineTo(t[2][0], t[2][1]); c.closePath(); c.fill();
    }
    for (const bp of BUMPERS) drawBumper(c, bp);
    // lanzador
    const py = plungerY();
    c.fillStyle = '#8c9199'; c.fillRect(486, py + 4, 8, 1040 - py);
    c.strokeStyle = '#d0d4da'; c.lineWidth = 1.6;
    c.beginPath();
    const coils = 9, top = py + 10, bot = 1036;
    for (let i = 0; i <= coils * 2; i++) {
      const yy = top + (bot - top) * i / (coils * 2);
      const xx = i % 2 ? 481 : 499;
      if (i) c.lineTo(xx, yy); else c.moveTo(xx, yy);
    }
    c.stroke();
    c.fillStyle = '#1a1a1a'; rrect(c, 476, py - 2, 28, 7, 2); c.fill();
    c.fillStyle = '#e8352a'; rrect(c, 478, py - 1, 24, 4, 1.5); c.fill();
    FLIPPERS.forEach(f => drawFlipper(c, f));
    if (ball.active) drawBall(c);
  }

  function drawOverDynamic(c) {
    // burbuja del nivel (muestra la inclinación relativa)
    const bx = clamp(Tilt.rel.x * 4.2 * Math.max(0.4, settings.sens), -14, 14);
    const by = clamp(Tilt.rel.y * 4.2 * Math.max(0.4, settings.sens), -14, 14);
    const g = c.createRadialGradient(240 + bx - 2, 1006 + by - 2, 0.5, 240 + bx, 1006 + by, 6);
    g.addColorStop(0, '#f6ffe0'); g.addColorStop(1, '#7ad04a');
    c.fillStyle = g; c.beginPath(); c.arc(240 + bx, 1006 + by, 5.5, 0, 7); c.fill();
    // bola en el carril por encima del delantal no hace falta; textos de ayuda
    if (G.hintT > 0 && G.state === 'play') {
      const a = Math.min(1, G.hintT) * 0.85;
      c.save(); c.globalAlpha = a;
      c.fillStyle = 'rgba(20,8,2,0.75)';
      rrect(c, 20, 900, 112, 34, 6); c.fill(); rrect(c, 348, 900, 112, 34, 6); c.fill();
      outlinedText(c, '◀ TOCA AQUÍ', 76, 917, '15px Bebas, sans-serif', '#ffd23a', null, 0);
      outlinedText(c, 'TOCA AQUÍ ▶', 404, 917, '15px Bebas, sans-serif', '#ffd23a', null, 0);
      if (!G.launched) {
        rrect(c, 330, 840, 140, 44, 6); c.fill();
        outlinedText(c, 'MANTÉN UNA TECLA', 400, 853, '13px Bebas, sans-serif', '#ffd23a', null, 0);
        outlinedText(c, 'DE VOLUMEN Y SUELTA', 400, 870, '13px Bebas, sans-serif', '#ffd23a', null, 0);
      }
      c.restore();
    }
  }

  function drawReel(c, x, y, w, h, pos) {
    c.save();
    rrect(c, x, y, w, h, Math.min(3, w * 0.12)); c.clip();
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#6b6250'); g.addColorStop(0.2, '#f3ead2'); g.addColorStop(0.5, '#fffaf0');
    g.addColorStop(0.8, '#f3ead2'); g.addColorStop(1, '#6b6250');
    c.fillStyle = g; c.fillRect(x, y, w, h);
    const d0 = Math.floor(pos) % 10, fr = pos - Math.floor(pos);
    c.font = Math.round(h * 0.72) + 'px AlfaSlab, Georgia, serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#1a1208';
    c.fillText(String(d0), x + w / 2, y + h / 2 - fr * h + h * 0.04);
    c.fillText(String((d0 + 1) % 10), x + w / 2, y + h / 2 + (1 - fr) * h + h * 0.04);
    const sh = c.createLinearGradient(0, y, 0, y + h);
    sh.addColorStop(0, 'rgba(0,0,0,0.55)'); sh.addColorStop(0.25, 'rgba(0,0,0,0)');
    sh.addColorStop(0.75, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.55)');
    c.fillStyle = sh; c.fillRect(x, y, w, h);
    c.restore();
  }

  function glowText(c, txt, x, y, size, on, color, align) {
    c.font = size + 'px Bebas, sans-serif'; c.textAlign = align || 'center'; c.textBaseline = 'middle';
    if (on) {
      c.shadowColor = color; c.shadowBlur = size * 0.8;
      c.fillStyle = shade(color, 0.35); c.fillText(txt, x, y);
      c.shadowBlur = 0;
    } else {
      c.fillStyle = 'rgba(160,140,170,0.28)'; c.fillText(txt, x, y);
    }
  }

  function drawBackglassDynamic(c) {
    const L = bgLayout();
    const B = L.B;
    // rodillos
    for (let i = 0; i < 6; i++) {
      drawReel(c, L.reelX + i * (L.reelDW + L.gap), L.reelY, L.reelDW, L.reelH, reels.pos[i]);
    }
    // créditos
    const cr = String(G.credits).padStart(2, '0');
    c.font = Math.round(L.rowH * 0.95) + 'px AlfaSlab, Georgia, serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#ffcf6a';
    c.fillText(cr, L.credX + L.credW / 2, L.rowY + 1);
    glowText(c, 'CRÉDITOS', L.credX - 4, L.rowY + 1, Math.round(L.rowH * 0.95), true, '#ffb43a', 'right');
    // lámparas de bola
    const fs = Math.round(L.rowH * 0.95);
    let x = B.x + B.w * 0.035;
    c.font = fs + 'px Bebas, sans-serif';
    glowText(c, 'BOLA', x, L.rowY + 1, fs, G.state === 'play' || G.state === 'starting', '#ffb43a', 'left');
    x += c.measureText('BOLA ').width + 2;
    for (let i = 1; i <= settings.balls; i++) {
      const on = (G.state === 'play') && G.ballNum === i;
      glowText(c, String(i), x, L.rowY + 1, fs, on, '#ffe14a', 'left');
      x += fs * 0.62;
    }
    // TILT / GAME OVER / MATCH
    const midX = B.x + B.w * 0.5;
    const blinkOn = Math.floor(G.attractT * 1.6) % 2 === 0;
    glowText(c, 'TILT', midX - fs * 2.6, L.rowY + 1, fs, G.tilted && G.state === 'play', '#ff3b2a');
    glowText(c, 'GAME OVER', midX + fs * 0.4, L.rowY + 1, fs, (G.state === 'attract' || G.state === 'over') && blinkOn, '#ff8a2a');
    if (G.match >= 0 && G.state !== 'play' && G.state !== 'starting') {
      glowText(c, 'MATCH ' + String(G.match).padStart(2, '0'), midX + fs * 3.6, L.rowY + 1, fs, true, '#6fd3ff');
    }
    // mensajes o récord en la franja del título
    if (G.msgT > 0 && G.msg) {
      const on = G.msgT > 0.6 || Math.floor(G.msgT * 8) % 2 === 0;
      if (on) {
        c.save();
        const ts = L.titleSize * 0.95;
        rrect(c, B.x + B.w * 0.12, L.titleY - ts * 0.62, B.w * 0.76, ts * 1.24, ts * 0.3);
        c.fillStyle = 'rgba(15,4,25,0.92)'; c.fill();
        c.strokeStyle = '#ffcf3a'; c.lineWidth = 1.5; c.stroke();
        c.font = Math.round(ts * 0.95) + 'px Bebas, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.shadowColor = '#ff8a2a'; c.shadowBlur = ts * 0.5;
        c.fillStyle = '#fff1b0'; c.fillText(G.msg, B.x + B.w / 2, L.titleY + 1);
        c.restore();
      }
    }
    // récord y próxima partida gratis (pequeño, a los lados del título)
    const small = Math.max(8, Math.round(L.titleSize * 0.36));
    c.font = small + 'px Bebas, sans-serif'; c.textBaseline = 'middle';
    c.fillStyle = 'rgba(255,220,160,0.75)';
    c.textAlign = 'left';
    c.fillText('RÉCORD', B.x + 8, L.titleY - small * 0.55);
    c.fillText(fmt(G.hi), B.x + 8, L.titleY + small * 0.6);
    // botones
    const bs = L.btn, by = L.reelY + L.reelH / 2;
    const mx = B.x + L.sideW / 2, sx = B.x + B.w - L.sideW / 2;
    Lay.btnMenu = { x: mx, y: by, r: bs / 2 };
    Lay.btnStart = { x: sx, y: by, r: bs / 2 };
    // menú
    c.save();
    c.fillStyle = '#2a1a36'; c.beginPath(); c.arc(mx, by, bs / 2, 0, 7); c.fill();
    c.strokeStyle = '#c9a24a'; c.lineWidth = 2; c.stroke();
    c.strokeStyle = '#ffe2a0'; c.lineWidth = Math.max(2, bs * 0.07); c.lineCap = 'round';
    for (let k = -1; k <= 1; k++) { c.beginPath(); c.moveTo(mx - bs * 0.2, by + k * bs * 0.14); c.lineTo(mx + bs * 0.2, by + k * bs * 0.14); c.stroke(); }
    c.restore();
    // jugar
    const attract = G.state === 'attract' || G.state === 'over';
    const pulse = attract ? 0.5 + 0.5 * Math.sin(G.attractT * 5) : 0;
    c.save();
    const sg = c.createRadialGradient(sx - bs * 0.15, by - bs * 0.18, 1, sx, by, bs / 2);
    sg.addColorStop(0, attract ? '#ffd0b0' : '#d08070'); sg.addColorStop(0.5, attract ? '#ff3b20' : '#a8301c'); sg.addColorStop(1, '#6a0e04');
    if (attract) { c.shadowColor = '#ff5a2a'; c.shadowBlur = 6 + pulse * 14; }
    c.fillStyle = sg; c.beginPath(); c.arc(sx, by, bs / 2, 0, 7); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = '#e6e8eb'; c.lineWidth = 2; c.stroke();
    c.font = Math.round(bs * 0.27) + 'px Bebas, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff6e0'; c.fillText('JUGAR', sx, by + 1);
    c.restore();
  }

  function render() {
    const { dpr, s, ox, oy } = Lay;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackglassDynamic(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(pfLayer, Math.round(ox * dpr), Math.round(oy * dpr));
    ctx.setTransform(s * dpr, 0, 0, s * dpr, Math.round(ox * dpr), Math.round(oy * dpr));
    drawDynamic(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(ovLayer, Math.round(ox * dpr), Math.round(oy * dpr));
    ctx.setTransform(s * dpr, 0, 0, s * dpr, Math.round(ox * dpr), Math.round(oy * dpr));
    drawOverDynamic(ctx);
    if (G.tilted && G.state === 'play') {
      ctx.fillStyle = 'rgba(30,0,0,0.25)'; ctx.fillRect(0, 0, TW, TH);
    }
  }

  /* =====================================================================
   * Entrada: táctil, ratón, teclado y teclas de volumen (vía Android)
   * ===================================================================== */
  const touchSide = new Map();
  const pressCount = { L: 0, R: 0 };
  function flipPress(side, down) {
    const f = side === 'L' ? flipL : flipR;
    pressCount[side] = Math.max(0, pressCount[side] + (down ? 1 : -1));
    const want = pressCount[side] > 0;
    if (want === f.pressed) return;
    f.pressed = want;
    if (G.state !== 'play' || G.tilted) return;
    if (want) { Sound.play('flip_up', 0.85, side === 'L' ? -0.45 : 0.45, rand(0.97, 1.03)); buzz(9, 70); }
    else Sound.play('flip_down', 0.6, side === 'L' ? -0.45 : 0.45, rand(0.97, 1.03));
  }
  function plungerInput(down) {
    if (menuOpen) return;
    Sound.unlock();
    if (down) {
      plunger.keys++;
      if (plunger.keys > 1) return;
      if (G.state === 'attract' || G.state === 'over') { startGame(); plunger.keys = 0; return; }
      if (G.state !== 'play') return;
      plunger.pulling = true; plunger.releasing = false;
      Sound.play('pull', 0.6, 0.6);
    } else {
      plunger.keys = Math.max(0, plunger.keys - 1);
      if (plunger.keys > 0 || !plunger.pulling) return;
      plunger.pulling = false;
      const p = plunger.pull;
      const py = plungerY();
      const onPl = ball.active && !ball.held && ball.x > 471 && Math.abs(ball.y + BALL_R + 2 - py) < 7;
      plunger.releasing = true;
      Sound.play('launch', 0.35 + 0.6 * p, 0.6);
      if (onPl) {
        ball.vy = -(LAUNCH_MIN + (LAUNCH_MAX - LAUNCH_MIN) * p) * rand(0.985, 1.015);
        ball.vx = 0;
        ball.y = py - BALL_R - 3;
        buzz(25, Math.round(120 + p * 120));
      }
    }
  }

  function hit(btn, x, y) { return btn && Math.hypot(x - btn.x, y - btn.y) < btn.r * 1.25; }
  function pointerDown(id, x, y) {
    Sound.unlock();
    if (menuOpen || helpOpen) return;
    if (y < Lay.oy && y < Lay.safeT + Lay.bgH) {
      if (hit(Lay.btnMenu, x, y)) openMenu();
      else if (hit(Lay.btnStart, x, y)) startGame();
      return;
    }
    const side = x < Lay.W / 2 ? 'L' : 'R';
    touchSide.set(id, side);
    flipPress(side, true);
  }
  function pointerUp(id) {
    const side = touchSide.get(id);
    if (!side) return;
    touchSide.delete(id);
    flipPress(side, false);
  }
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) pointerDown(t.identifier, t.clientX, t.clientY);
  }, { passive: false });
  const touchEnd = (e) => { e.preventDefault(); for (const t of e.changedTouches) pointerUp(t.identifier); };
  canvas.addEventListener('touchend', touchEnd, { passive: false });
  canvas.addEventListener('touchcancel', touchEnd, { passive: false });
  canvas.addEventListener('mousedown', (e) => { pointerDown('m', e.clientX, e.clientY); });
  window.addEventListener('mouseup', () => pointerUp('m'));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const keyMap = { KeyZ: 'L', ShiftLeft: 'L', ArrowLeft: 'L', Slash: 'R', KeyM: 'R', ShiftRight: 'R', ArrowRight: 'R' };
  const keysDown = new Set();
  window.addEventListener('keydown', (e) => {
    if (keysDown.has(e.code)) return;
    keysDown.add(e.code);
    if (keyMap[e.code]) { flipPress(keyMap[e.code], true); e.preventDefault(); return; }
    switch (e.code) {
      case 'Space': case 'Enter': case 'ArrowDown': plungerInput(true); e.preventDefault(); break;
      case 'KeyS': if (G.state === 'attract' || G.state === 'over') startGame(); break;
      case 'Escape': case 'KeyP': menuOpen ? closeMenu() : openMenu(); break;
      case 'KeyJ': Tilt.key.x = -2.5; break;
      case 'KeyL': Tilt.key.x = 2.5; break;
      case 'KeyI': Tilt.key.y = -2.5; break;
      case 'KeyK': Tilt.key.y = 2.5; break;
      case 'KeyN': Tilt.nx = rand(-9, 9); Tilt.ny = rand(4, 9); Tilt.nmag = Math.hypot(Tilt.nx, Tilt.ny); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    keysDown.delete(e.code);
    if (keyMap[e.code]) { flipPress(keyMap[e.code], false); return; }
    switch (e.code) {
      case 'Space': case 'Enter': case 'ArrowDown': plungerInput(false); break;
      case 'KeyJ': case 'KeyL': Tilt.key.x = 0; break;
      case 'KeyI': case 'KeyK': Tilt.key.y = 0; break;
    }
  });

  /* =====================================================================
   * Menú y ayuda
   * ===================================================================== */
  let menuOpen = false, helpOpen = false;
  const $ = (id) => document.getElementById(id);
  function setNativeState(s) { if (NATIVE) { try { NATIVE.setState(s); } catch (e) {} } }
  function stateName() { return G.state === 'play' || G.state === 'starting' ? 'play' : 'attract'; }
  function releaseAllInputs() {
    touchSide.clear(); pressCount.L = pressCount.R = 0;
    flipL.pressed = flipR.pressed = false;
    if (plunger.pulling) { plunger.pulling = false; plunger.releasing = true; }
    plunger.keys = 0;
  }
  function getVolume() {
    if (NATIVE) { try { return +NATIVE.getVolume(); } catch (e) { return 0.7; } }
    return settings.sfx;
  }
  function setVolume(v) {
    if (NATIVE) { try { NATIVE.setVolume(v); } catch (e) {} }
    else { settings.sfx = v; saveSettings(); }
  }
  function syncMenu() {
    $('mHi').textContent = fmt(G.hi);
    $('mSens').value = settings.sens; $('mSensV').textContent = Math.round(settings.sens * 100) + '%';
    const v = getVolume(); $('mVol').value = v; $('mVolV').textContent = Math.round(v * 100) + '%';
    document.querySelectorAll('[data-balls]').forEach(b => b.classList.toggle('on', +b.dataset.balls === settings.balls));
    document.querySelectorAll('[data-tilt]').forEach(b => b.classList.toggle('on', b.dataset.tilt === settings.tilt));
    document.querySelectorAll('[data-hap]').forEach(b => b.classList.toggle('on', (b.dataset.hap === '1') === settings.haptics));
    $('mResume').style.display = (G.state === 'play' || G.state === 'starting') ? '' : 'none';
  }
  function openMenu() {
    if (menuOpen) return;
    menuOpen = true; releaseAllInputs(); Sound.roll(0, 1);
    syncMenu(); $('menu').classList.remove('hidden');
    setNativeState('menu');
  }
  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false; $('menu').classList.add('hidden');
    Tilt.calibrate();
    lastT = performance.now();
    setNativeState(stateName());
  }
  function openHelp() { helpOpen = true; $('help').classList.remove('hidden'); setNativeState('menu'); }
  function closeHelp() {
    helpOpen = false; $('help').classList.add('hidden');
    settings.help = true; saveSettings();
    setNativeState(menuOpen ? 'menu' : stateName());
  }
  $('mResume').onclick = closeMenu;
  $('mNew').onclick = () => { closeMenu(); G.state = 'attract'; startGame(); };
  $('mCalib').onclick = () => { Tilt.calibrate(); $('mCalib').textContent = 'Inclinación recalibrada ✓'; setTimeout(() => { $('mCalib').textContent = 'Recalibrar inclinación'; }, 1500); };
  $('mSens').oninput = (e) => { settings.sens = +e.target.value; $('mSensV').textContent = Math.round(settings.sens * 100) + '%'; saveSettings(); };
  $('mVol').oninput = (e) => { setVolume(+e.target.value); $('mVolV').textContent = Math.round(+e.target.value * 100) + '%'; };
  $('mVol').onchange = () => Sound.play('chime100', 0.6);
  document.querySelectorAll('[data-balls]').forEach(b => { b.onclick = () => { settings.balls = +b.dataset.balls; saveSettings(); syncMenu(); }; });
  document.querySelectorAll('[data-tilt]').forEach(b => { b.onclick = () => { settings.tilt = b.dataset.tilt; saveSettings(); syncMenu(); }; });
  document.querySelectorAll('[data-hap]').forEach(b => { b.onclick = () => { settings.haptics = b.dataset.hap === '1'; saveSettings(); syncMenu(); buzz(30, 150); }; });
  $('mHelp').onclick = openHelp;
  $('hOk').onclick = closeHelp;
  $('mExit').onclick = () => { if (NATIVE) { try { NATIVE.exit(); } catch (e) {} } else closeMenu(); };

  /* =====================================================================
   * Bucle principal
   * ===================================================================== */
  let lastT = performance.now(), acc = 0;
  const dbg = { freeze: false };
  function update(dt) {
    Tilt.poll();
    Tilt.gravity(grav);
    processNudge(dt);
    acc += dt;
    let n = 0;
    while (acc >= DT && n < 200) { stepPhysics(DT); acc -= DT; n++; }
    if (n >= 200) acc = 0;
    updateGame(dt);
    updateMotor(dt);
    updateReels(dt);
    if (ball.active && !ball.held && G.state === 'play') {
      const sp = Math.hypot(ball.vx, ball.vy);
      const inLaneRest = ball.x > 471 && sp < 30;
      Sound.roll(inLaneRest ? 0 : clamp(sp / 2600, 0, 1) * 0.55, clamp(0.75 + sp / 3500, 0.75, 1.6));
    } else Sound.roll(0, 1);
  }
  function frame(t) {
    requestAnimationFrame(frame);
    let dt = (t - lastT) / 1000; lastT = t;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    if (!menuOpen && !helpOpen && !dbg.freeze) update(dt);
    else Tilt.poll();
    if (bgLayer) render();
  }

  // API para Android y para pruebas
  window.PB = {
    plunger: (down) => plungerInput(!!down),
    onBack: () => {
      if (helpOpen) closeHelp();
      else if (menuOpen) closeMenu();
      else openMenu();
    },
    onAppPause: () => {
      releaseAllInputs();
      Sound.roll(0, 1);
      if ((G.state === 'play' || G.state === 'starting') && !menuOpen) openMenu();
    },
    onAppResume: () => { lastT = performance.now(); layout(); },
    debug: {
      G, ball, flipL, flipR, plunger, stats: Sound.stats, grav, dbg, BUMPERS, DROPS, STANDUPS, sensors, spinner, saucer, Tilt, settings,
      step: (sec) => { const n = Math.round(sec / DT); for (let i = 0; i < n; i++) { stepPhysics(DT); if (i % 10 === 0) { updateGame(DT * 10); updateMotor(DT * 10); } } },
      setBall: (x, y, vx, vy) => { Object.assign(ball, { x, y, vx: vx || 0, vy: vy || 0, active: true, held: false }); },
      start: startGame, newBall, flip: flipPress, plungerInput, layout, render, update,
      launch: (p) => { plunger.pull = p; plunger.pulling = true; plunger.keys = 1; plungerInput(false); },
    }
  };

  function boot() {
    Sound.init();
    Tilt.init();
    layout();
    window.addEventListener('resize', layout);
    if (!settings.help) openHelp();
    else setNativeState('attract');
    requestAnimationFrame((t) => { lastT = t; frame(t); });
    if (NATIVE) setInterval(() => { const st = readSafeTop(); if (Math.abs(st - Lay.safeT) > 0.5) layout(); }, 1500);
  }
  const fontsReady = (document.fonts && document.fonts.load)
    ? Promise.all(['20px Shrikhand', '20px Bebas', '20px AlfaSlab'].map(f => document.fonts.load(f))).catch(() => {})
    : Promise.resolve();
  let booted = false;
  const go = () => { if (!booted) { booted = true; boot(); } };
  fontsReady.then(go);
  setTimeout(go, 1500);
})();
