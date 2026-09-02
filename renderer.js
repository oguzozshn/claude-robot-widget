'use strict';
/*
 * Claude Robot — animasyon motoru
 *
 * Her durum bir "hedef poz" tanımlar; her karede mevcut değerler bu hedefe
 * doğru lerp'lenir. Böylece durum geçişleri sıçramadan, yumuşak olur.
 *
 * working durumu özel: gövde hareketi durur (odaklanma), ama widget'ın
 * donduğu sanılmasın diye dört mikro sinyal canlı kalır —
 *   1) gözlerin yavaş yatay taraması   2) seyrek göz kırpma
 *   3) anten LED'inin nabzı            4) ekrandaki tarama çizgisi
 */

const $ = (id) => document.getElementById(id);

const eyeL = $('eyeL'), eyeR = $('eyeR'), eyes = $('eyes');
const armL = $('armL'), armR = $('armR'), head = $('head'), floatG = $('float');
const ball = $('ball'), stalk = $('stalk');
const txtEl = $('screenText'), scan = $('scan'), dot = $('dot');
const thrust = $('thrust'), shadow = $('shadow');

/* ------------------------------------------------------------- ayarlanabilir */

const SQUINT = 0.50;          // working'de göz açıklığı (1 = tam açık)
const WORKING_LED = '#a78bfa'; // odak rengi (mor)
const MICRO_BREATH = true;     // working'de 0.7px'lik nefes salınımı

/* ------------------------------------------------------------------ durumlar */
/* orbit: anten topunun dönme yarıçapı çarpanı (0 = tepede sabit)
   scanEye: gözlerin yatay tarama genliği (px)
   arm: kolların dinlenme açısı (derece, + = dışa/yukarı) */

const STATES = {
  idle: {
    label: 'IDLE', led: '#5b6b7a',
    floatA: 2.0, floatS: 0.9, spin: 0, orbit: 0, sway: 1.2, swayS: 0.5,
    arm: -4, armA: 2, armS: 0.6, eye: 0.10, blink: 0, scanEye: 0,
    beep: [420]
  },
  thinking: {
    label: 'THINKING', led: null,           // null => tema rengi
    floatA: 3.4, floatS: 1.9, spin: 5.2, orbit: 1, sway: 5.5, swayS: 1.5,
    arm: 7, armA: 6, armS: 1.9, eye: 1.00, blink: 1.1, scanEye: 0,
    beep: [720, 880]
  },
  working: {
    label: 'WORKING', led: WORKING_LED,
    floatA: MICRO_BREATH ? 0.7 : 0, floatS: 0.5, spin: 0, orbit: 0, sway: 0, swayS: 0,
    arm: 12, armA: 0, armS: 0, eye: SQUINT, blink: 4.5, scanEye: 1.7,
    beep: [620, 760]
  },
  writing: {
    // working'in kardeşi: aynı mor aile, ama duran değil üreten bir hâl.
    // Kollar zıt fazda hızlı hareket eder -> klavyede yazma hissi.
    label: 'WRITING', led: '#c084fc',
    floatA: 1.6, floatS: 1.4, spin: 0, orbit: 0, sway: 1.4, swayS: 1.7,
    arm: 22, armA: 26, armS: 6.5, armAlt: true, eye: 0.58, blink: 2.8, scanEye: 1.2,
    beep: [880, 720]
  },
  waiting: {
    label: 'INPUT?', led: '#fbbf24',
    floatA: 3.2, floatS: 1.2, spin: 0, orbit: 0.3, sway: 3.5, swayS: 0.9,
    arm: 40, armA: 4, armS: 1.2, eye: 1.00, blink: 1.8, scanEye: 0,
    beep: [880, 660, 880]
  },
  success: {
    label: 'SUCCESS', led: '#4ade80',
    floatA: 3.0, floatS: 2.0, spin: 1.2, orbit: 0.6, sway: 3.0, swayS: 2.2,
    arm: 128, armA: 7, armS: 3.0, eye: 1.00, blink: 2.6, scanEye: 0,
    beep: [660, 880, 1180]
  },
  error: {
    label: 'ERROR', led: '#ef4444',
    floatA: 1.4, floatS: 1.2, spin: 0, orbit: 0, sway: 1.5, swayS: 1.0,
    arm: -14, armA: 2, armS: 0.8, eye: 0.85, blink: 3.0, scanEye: 0,
    beep: [300, 180]
  }
};

/* -------------------------------------------------------------------- durum */

let state = 'idle';
let custom = null;                       // ekranda gösterilecek özel yazı
let enter = performance.now() / 1000;    // duruma giriş anı
let soundOn = true;

const cur = { arm: -4, eye: 0.10, sway: 1.2, floatA: 2.0, shift: 0, orbit: 0 };
let spinA = 0, nextBlink = 2, blinkT = -1;

/* --------------------------------------------------------------------- ses */

let ac = null;
function beep(freq, when, dur, type) {
  try {
    if (!ac) ac = new AudioContext();
    const o = ac.createOscillator();
    const g = ac.createGain();
    const t = ac.currentTime + when;
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch { /* ses cihazı yoksa sessizce geç */ }
}

function playFor(s) {
  if (!soundOn) return;
  const f = STATES[s].beep;
  for (let i = 0; i < f.length; i++) {
    beep(f[i], i * 0.09, 0.075, s === 'error' ? 'sawtooth' : 'square');
  }
}

/* ------------------------------------------------------------------ animasyon */

const lerp = (a, b, k) => a + (b - a) * k;

function setState(next, text, silent) {
  if (!STATES[next]) return;
  const changed = next !== state;
  state = next;
  custom = text || null;
  enter = performance.now() / 1000;
  if (changed && !silent) playFor(next);
}

function themeLed() {
  return getComputedStyle(document.body).getPropertyValue('--led').trim() || '#22d3ee';
}

const t0 = performance.now() / 1000;
let last = t0, dots = 0, dotsT = 0;

function frame(now) {
  now /= 1000;
  const dt = Math.min(now - last, 0.05);
  last = now;
  const t = now - t0;
  const age = now - enter;
  const cfg = STATES[state];

  // kare hızından bağımsız yumuşatma
  const k = 1 - Math.pow(0.001, dt);
  cur.arm = lerp(cur.arm, cfg.arm, k);
  cur.sway = lerp(cur.sway, cfg.sway, k);
  cur.floatA = lerp(cur.floatA, cfg.floatA, k);
  cur.orbit = lerp(cur.orbit, cfg.orbit, k);

  // --- gözler: kırpma + yatay tarama
  let eyeTarget = cfg.eye;
  if (cfg.blink > 0) {
    nextBlink -= dt;
    if (nextBlink <= 0) {
      blinkT = 0.14;
      nextBlink = cfg.blink * (0.6 + Math.random() * 1.1);
    }
  }
  if (blinkT > 0) { blinkT -= dt; eyeTarget = cfg.eye * 0.08; }
  cur.eye = lerp(cur.eye, eyeTarget, 1 - Math.pow(1e-7, dt));
  cur.shift = lerp(cur.shift, cfg.scanEye * Math.sin(t * 0.9) * (0.6 + 0.4 * Math.sin(t * 2.3)), k);

  const e = Math.max(cur.eye, 0.06);
  eyeL.setAttribute('transform', `translate(${(86 + cur.shift).toFixed(2)},78) scale(1,${e.toFixed(3)}) translate(-86,-78)`);
  eyeR.setAttribute('transform', `translate(${(114 + cur.shift).toFixed(2)},78) scale(1,${e.toFixed(3)}) translate(-114,-78)`);

  // --- anten: yarıçap 0'a inince top tepeye oturur, dönme durur
  spinA += cfg.spin * dt;
  const R = 13 * cur.orbit;
  const bx = 100 + R * Math.cos(spinA);
  const by = 23 + (4 * cur.orbit) * Math.sin(spinA) - (1 - cur.orbit);
  ball.setAttribute('cx', bx.toFixed(2));
  ball.setAttribute('cy', by.toFixed(2));
  ball.setAttribute('r', (5.4 * (0.78 + 0.3 * ((Math.sin(spinA) * cur.orbit + 1) / 2))).toFixed(2));
  stalk.setAttribute('d', `M100 42 Q${(100 + (bx - 100) * 0.35).toFixed(1)} ${((42 + by) / 2).toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`);
  ball.setAttribute('opacity', state === 'working'
    ? (0.45 + 0.55 * Math.abs(Math.sin(t * 1.35))).toFixed(2)
    : '1');

  // --- gövde: süzülme, başarı zıplaması, hata sarsıntısı
  let fy = -cur.floatA * Math.sin(t * cfg.floatS * Math.PI);
  if (state === 'success' && age < 1.0) fy -= 16 * Math.exp(-3.2 * age) * Math.abs(Math.sin(age * 9));
  const sx = (state === 'error' && age < 0.55) ? 4.5 * Math.exp(-5 * age) * Math.sin(age * 46) : 0;
  floatG.setAttribute('transform', `translate(${sx.toFixed(2)},${fy.toFixed(2)})`);
  shadow.setAttribute('rx', (34 + fy * 0.5).toFixed(1));

  // --- baş salınımı
  head.setAttribute('transform', `rotate(${(cur.sway * Math.sin(t * cfg.swayS * Math.PI)).toFixed(2)} 100 118)`);

  // --- kollar: normalde simetrik ayna, armAlt ise zıt fazda (yazma hissi)
  const osc = cfg.armA * Math.sin(t * cfg.armS * Math.PI);
  const aL = cur.arm + osc;
  const aR = cur.arm + (cfg.armAlt ? -osc : osc);
  armL.setAttribute('transform', `rotate(${aL.toFixed(2)} 46 138)`);
  armR.setAttribute('transform', `rotate(${(-aR).toFixed(2)} 154 138)`);

  // --- renkler
  const led = cfg.led || themeLed();
  eyeL.setAttribute('fill', led);
  eyeR.setAttribute('fill', led);
  ball.setAttribute('fill', led);
  txtEl.setAttribute('fill', led);
  dot.setAttribute('fill', led);
  scan.setAttribute('fill', led);
  eyes.style.filter = `drop-shadow(0 0 5px ${led}) drop-shadow(0 0 11px ${led})`;
  ball.style.filter = `drop-shadow(0 0 5px ${led})`;
  txtEl.style.filter = `drop-shadow(0 0 4px ${led})`;

  // --- göğüs ekranı
  dotsT += dt;
  if (dotsT > 0.38) { dotsT = 0; dots = (dots + 1) % 4; }
  let label = custom
    ? custom.toUpperCase().slice(0, 11)
    : cfg.label + ((state === 'thinking' || state === 'working') ? '...'.slice(0, dots) : '');
  txtEl.textContent = label;
  txtEl.setAttribute('font-size', label.length > 9 ? 9 : 10);

  scan.setAttribute('y', (142 + ((t * 26) % 30)).toFixed(1));
  scan.setAttribute('opacity', state === 'idle' ? '0.05' : '0.16');
  dot.setAttribute('opacity', (state === 'idle' ? 0.25 : 0.35 + 0.45 * Math.abs(Math.sin(t * 2.2))).toFixed(2));
  thrust.setAttribute('opacity', (state === 'idle' ? 0.35 : 0.7 + 0.3 * Math.abs(Math.sin(t * 1.6))).toFixed(2));

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------- sürükleme + menü */

let dragging = false;
let offX = 0, offY = 0;

document.addEventListener('mousedown', async (ev) => {
  if (ev.button !== 0) return;
  const pos = await window.robot.dragStart();
  offX = ev.screenX - pos.x;
  offY = ev.screenY - pos.y;
  dragging = true;
  ev.preventDefault();
});

document.addEventListener('mousemove', (ev) => {
  if (dragging) {
    window.robot.dragMove(ev.screenX - offX, ev.screenY - offY);
    return;
  }
  // Fare robotun üstünde değilse tıklamalar arkadaki pencereye geçsin.
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const overRobot = !!el && el !== document.body && el !== document.documentElement && el.id !== 'bot';
  window.robot.setIgnore(!overRobot);
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  window.robot.dragEnd();
});

document.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  window.robot.menu();
});

/* ------------------------------------------------------------ ana süreç köprüsü */

window.robot.onState((p) => setState(p.state, p.text, p.silent));

window.robot.onConfig((c) => {
  document.body.className = 'theme-' + c.theme;
  soundOn = c.sound;
  if (!c.clickThrough) window.robot.setIgnore(false);
});

requestAnimationFrame(frame);
