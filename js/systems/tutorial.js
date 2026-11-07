// ====================================================================
// js/systems/tutorial.js — the starter guide (Stage 7a): steps,
// beacon, panel.
// ====================================================================
import * as THREE from 'three';
import { ECON } from '../config.js';
import { fmt$ } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';

// ======== section: 65_tutorial.js ========
// ======== section: 65_tutorial.js ========
// ====================================================================
// v2.05 — TUTORIAL: the getting-started guide for your first hot dog
// stand. A six-step quest chip on the left edge plus a bobbing gold
// beacon in the world that walks a new tycoon from "walk" to "passive
// income": walk → find a $ parcel → buy it → park a 🌭 cart → serve
// the queue → hire a vendor. Progress saves with the game, it can be
// skipped from the chip's ✕, and replayed from HELP at any time.
// Returning players who already own plots/offices are exempt.
// ====================================================================
export const TUT = (() => {
  const isTouch = matchMedia('(pointer:coarse)').matches;
  let _spawn = [0, 0];        // where the player landed this city
  let _served = false;        // completed a manual serve (step 5)
  let _target = null;         // locked beacon target (plot rec) for this step
  let _renderT = 0;           // panel re-render throttle (real time)
  let _bcnT = 0;              // beacon re-target throttle (real time)
  let _animT = 0;             // beacon animation clock (real time)
  let _lastNow = 0;           // last update timestamp

  // ---------------- world queries ------------------------------------
  const playerPos = () => ACTORS.player
    ? [ACTORS.player.group.position.x, ACTORS.player.group.position.z]
    : [1e9, 1e9];

  function nearestSalePlot() {
    const [px, pz] = playerPos();
    let best = null, bd = 1e9;
    for (const r of CITY.plots) {          // v2.15: city sidewalk spots…
      if (r.sold) continue;
      const d = Math.hypot(r.x - px, r.z - pz);
      if (d < bd) { bd = d; best = r; }
    }
    if (typeof WORLD !== 'undefined' && WORLD.plots) {
      for (const r of WORLD.plots()) {      // …and roadside plots in the wild
        if (r.sold) continue;
        const d = Math.hypot(r.x - px, r.z - pz);
        if (d < bd) { bd = d; best = r; }
      }
    }
    return best;
  }
  function ownedPlotHere() {
    const ck = (typeof ECO !== 'undefined' && ECO.region) || (CITY.rec && CITY.rec.key);
    for (const p of STATE.plots) {
      if (p.cart || p.cityKey !== ck) continue;
      let r = CITY.plots.find(x => x.id === p.id);
      if (!r && typeof WORLD !== 'undefined' && WORLD.plots) r = WORLD.plots().find(x => x.id === p.id);
      if (r) return r;
    }
    return null;
  }
  const cartHere = () => (ECO.carts && ECO.carts[0]) || null;

  // ---------------- the six steps -------------------------------------
  // tgt: which world object the gold beacon locks onto for this step
  //      'sale'  → a for-sale parcel (locked, hysteresis on relock)
  //      'owned' → the player's cartless plot in this city
  //      'cart'  → the player's first cart in this city
  const STEPS = [
    {
      key: 'walk', title: 'Walk the block', tgt: null,
      body: () => isTouch
        ? '<b>Tap any spot</b> on the ground and you walk right over. <b>Drag a finger</b> to glide the bird\u2019s-eye view across the map, or push the <b>joystick</b> (bottom-left) to slide it.'
        : '<b>Click any spot</b> on the ground and you walk right over — that\u2019s the only way you move. <b>Drag</b> (or <b>W A S D</b>) glides the bird\u2019s-eye view across the map; <b>right-drag</b> rotates; <b>C</b> snaps back to you.',
      obj: () => 'Take a short stroll away from your landing spot.',
      check: () => {
        const [px, pz] = playerPos();
        return Math.hypot(px - _spawn[0], pz - _spawn[1]) > 9;
      },
    },
    {
      key: 'find', title: 'Find a green parcel', tgt: 'sale',
      body: () => 'Parcels outlined in <b>green dashes</b> with a floating <b>$</b> are street plots for sale — the only land you can build a business on.',
      obj: () => 'Follow the gold arrow to the nearest green $ parcel.',
      check: () => {
        if (STATE.plots.length > 0) return true;
        const r = nearestSalePlot();
        if (!r) return false;
        const [px, pz] = playerPos();
        return Math.hypot(r.x - px, r.z - pz) < 26;
      },
    },
    {
      key: 'buy', title: 'Buy your first plot', tgt: 'sale',
      body: () => {
        const r = (_target && !_target.sold) ? _target : nearestSalePlot();
        return 'Click the parcel, then hit <b>BUY PLOT</b>.' + (r
          ? ' This one is <b>' + fmt$(r.price) + '</b> — any green parcel works if you\'d rather shop around.'
          : '');
      },
      obj: () => 'Click the green parcel → BUY PLOT.',
      check: () => STATE.plots.length > 0,
    },
    {
      key: 'cart', title: 'Park a hot dog cart', tgt: 'owned',
      body: () => {
        const own = ownedPlotHere();
        const permit = STATE.plots.some(p => p.cart) ? 0 : ECON.permitCost;
        return 'Click <b>your</b> plot again and pick <b>🌭 Hot Dog</b> — <b>' + fmt$(ECON.cartCost + permit) + '</b>' +
          (permit ? ' including your first street-vending permit' : '') + '. Locals queue up within seconds.' +
          (own ? '' : ' (You don\'t own a plot in this city — grab another green parcel first.)');
      },
      obj: () => 'Click your plot → choose the Hot Dog cart.',
      check: () => STATE.plots.some(p => p.cart),
    },
    {
      key: 'serve', title: 'Serve the queue', tgt: 'cart',
      body: () => 'Stand beside your cart and press <b>E</b>' + (isTouch
        ? ' — or tap the <b>SERVE</b> button — '
        : ' — or click <b>SERVE</b> — ') +
        'whenever someone is waiting. Every dog sold pays its menu price <b>plus a tip</b>.',
      obj: () => 'Serve 1 customer at your cart.',
      check: () => _served,
    },
    {
      key: 'hire', title: 'Hire a vendor', tgt: 'cart',
      body: () => 'Click the cart to open the <b>business panel</b>, then <b>HIRE</b> a vendor. Star vendors work the line while you\'re away — that\'s <b>passive income</b>.' +
        (isTouch ? '' : ' (Short on cash? Keep serving by hand until you can afford one.)'),
      obj: () => 'Open the business panel → HIRE your first vendor.',
      check: () => STATE.plots.some(p => (p.crew || []).length > 0),
    },
  ];

  // ---------------- gold beacon ---------------------------------------
  let _bcn = null;   // { grp, spr, ring, beam }
  function buildBeacon() {
    if (_bcn) return _bcn;
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    const tri = () => { c.beginPath(); c.moveTo(30, 26); c.lineTo(98, 26); c.lineTo(64, 96); c.closePath(); };
    tri(); c.lineWidth = 12; c.lineJoin = 'round'; c.strokeStyle = 'rgba(13,17,23,.85)'; c.stroke();
    tri(); c.fillStyle = '#F5CC74'; c.fill();
    tri(); c.lineWidth = 4; c.strokeStyle = '#fff3d6'; c.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));
    spr.scale.set(5.2, 5.2, 1); spr.position.y = 8.4; spr.renderOrder = 999;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.7, 3.5, 30),
      new THREE.MeshBasicMaterial({ color: 0xf5cc74, transparent: true, opacity: .85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .17;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(.65, .65, 26, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xf5cc74, transparent: true, opacity: .10, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 13;
    const grp = new THREE.Group();
    grp.add(spr); grp.add(ring); grp.add(beam);
    _bcn = { grp, spr, ring, beam };
    return _bcn;
  }
  function setBeacon(x, z) {
    buildBeacon();
    _bcn.grp.position.set(x, 0, z);
    if (!_bcn.grp.parent) { const g = CITY.group || (typeof WORLD !== 'undefined' && WORLD.group); if (g) g.add(_bcn.grp); }
  }
  function clearBeacon() { if (_bcn && _bcn.grp.parent) _bcn.grp.parent.remove(_bcn.grp); }

  // locked target resolution — the arrow stays put instead of jittering
  // between parcels as the player walks (relocks only when decisive)
  function resolveTarget() {
    const s = STEPS[STATE.tut.step];
    if (!s || !s.tgt) { _target = null; return null; }
    if (s.tgt === 'sale') {
      if (_target && _target.sold) _target = null;      // it got bought
      const near = nearestSalePlot();
      if (!_target) _target = near;
      else if (near && near !== _target) {
        const [px, pz] = playerPos();
        const dn = Math.hypot(near.x - px, near.z - pz);
        const dc = Math.hypot(_target.x - px, _target.z - pz);
        if (dn < dc * .5) _target = near;               // decisively closer
      }
    } else if (s.tgt === 'owned') {
      const ok = _target && _target.sold && STATE.plots.some(p =>
        p.id === _target.id && !p.cart && p.cityKey === (CITY.rec && CITY.rec.key));
      if (!ok) _target = ownedPlotHere();
    } else if (s.tgt === 'cart') {
      const c = cartHere();
      return c ? { x: c.rec.x, z: c.rec.z } : null;
    }
    return _target ? { x: _target.x, z: _target.z } : null;
  }

  // ---------------- panel ----------------------------------------------
  const panel = document.getElementById('tut');
  function showPanel() {
    if (panel.classList.contains('hidden')) { panel.classList.remove('hidden'); render(); }
  }
  function hidePanel() { if (!panel.classList.contains('hidden')) panel.classList.add('hidden'); }
  function render() {
    const s = STEPS[STATE.tut.step];
    if (!s) return;
    document.getElementById('tut-n').textContent = (STATE.tut.step + 1) + '/' + STEPS.length;
    document.getElementById('tut-t').textContent = s.title;
    document.getElementById('tut-b').innerHTML = s.body();
    document.getElementById('tut-o').innerHTML = '▸ ' + s.obj();
  }
  panel.addEventListener('click', e => {
    const x = e.target.closest ? e.target.closest('#tut-x') : null;
    if (x) skip();
  });

  // manual-serve signal from the economy (E key / SERVE button)
  window.addEventListener('ow:tut-serve', () => { _served = true; });

  // ---------------- progression ----------------------------------------
  function advance() {
    const fin = STEPS[STATE.tut.step];
    STATE.tut.step++;
    _target = null; _renderT = 0; _bcnT = 0;   // instant re-render + relock
    if (STATE.tut.step >= STEPS.length) { finish(false); return; }
    saveGame();
    toast('✓ <b>' + fin.title + '</b> — next: ' + STEPS[STATE.tut.step].title);
  }
  function finish(skipped) {
    STATE.tut.step = STEPS.length;
    STATE.tut.done = true;
    saveGame();
    hidePanel(); clearBeacon();
    if (skipped) { toast('Starter guide skipped — replay it anytime from <b>HELP</b>.', 'warn'); return; }
    openModal('🌭 You\'re in business!', `
      <p>Your first <b>hot dog stand</b> is up and running — and it keeps earning while you explore.</p>
      <div class="kv"><span class="k">YOU LEARNED</span><span class="v">buy a $ plot · park a cart · serve [E] · hire crews</span></div>
      <div class="kv"><span class="k">MORE CARTS</span><span class="v">next cart ${fmt$(ECON.cartCost)}, no new permit — try 🌮 Tacos in another city</span></div>
      <div class="kv"><span class="k">TOWERS</span><span class="v">hover a tower → click → lease offices for passive rent</span></div>
      <div class="kv"><span class="k">THE EXCHANGE</span><span class="v">📈 MARKET button — limit &amp; market orders</span></div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="tutfin" style="flex:1">KEEP BUILDING</button></div>`);
    const b = document.getElementById('tutfin');
    if (b) b.onclick = () => {
      closeModal();
      toast('The streets are yours, <b>' + (STATE.name || 'Tycoon') + '</b>.');
    };
  }
  function skip() { finish(true); }
  function restart() {
    STATE.tut = { step: 0, done: false };
    _served = false; _target = null; _renderT = 0; _bcnT = 0;
    saveGame();
    if (STATE.mode === 'city' && ACTORS.player) {
      _spawn = playerPos();
      showPanel(); render();
      toast('Starter guide restarted — follow the gold arrow.');
    } else {
      toast('Starter guide queued — enter any city to begin.');
    }
  }
  function go(n) {
    STATE.tut.step = Math.max(0, Math.min(STEPS.length - 1, n | 0));
    STATE.tut.done = false;
    _target = null; _renderT = 0; _bcnT = 0;
    render();
  }

  // ---------------- frame update ---------------------------------------
  // throttles run on REAL time (not capped game dt) so the guide stays
  // responsive even when the browser throttles rAF (hidden/headless tabs)
  function update(dt) {
    const now = performance.now();
    let rdt = _lastNow ? (now - _lastNow) / 1000 : 0;
    _lastNow = now;
    rdt = Math.min(.25, rdt);
    const tutGrp = CITY.group || (typeof WORLD !== 'undefined' && WORLD.group);
    if (STATE.tut.done || STATE.mode !== 'city' || !tutGrp) { hidePanel(); clearBeacon(); _lastNow = 0; return; }
    const s = STEPS[STATE.tut.step];
    if (!s) { hidePanel(); clearBeacon(); return; }
    showPanel();
    _renderT -= rdt;
    if (_renderT <= 0) { _renderT = 1.2; render(); }
    _bcnT -= rdt;
    if (_bcnT <= 0) {
      _bcnT = .4;
      const t = resolveTarget();
      if (t) setBeacon(t.x, t.z); else clearBeacon();
    }
    if (_bcn && _bcn.grp.parent) {
      _animT += rdt;
      _bcn.spr.position.y = 8.4 + Math.sin(_animT * 2.3) * .95;
      const k = 1 + .22 * Math.sin(_animT * 3.1);
      _bcn.ring.scale.set(k, k, 1);
      _bcn.beam.material.opacity = .07 + .05 * (Math.sin(_animT * 2.3) * .5 + .5);
    }
    if (s.check()) advance();
  }

  // ---------------- mode hooks (from 90_main) --------------------------
  function onEnterCity() {
    if (ACTORS.player) _spawn = playerPos();
    _target = null;   // fresh city → fresh plots
  }
  function onLeaveCity() { hidePanel(); clearBeacon(); _lastNow = 0; }

  function state() {
    return {
      step: STATE.tut.step, done: STATE.tut.done,
      active: !STATE.tut.done && STATE.mode === 'city',
      beacon: (_bcn && _bcn.grp.parent)
        ? [+_bcn.grp.position.x.toFixed(1), +_bcn.grp.position.z.toFixed(1)] : null,
    };
  }

  return { update, onEnterCity, onLeaveCity, restart, go, skip, state };
})();

window.TUT = TUT;

