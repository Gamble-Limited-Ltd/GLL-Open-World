// ====================================================================
// js/systems/machines.js — machines in your units (Stage 7c):
// catalog, placement ghosts, daily income.
// ====================================================================
import * as THREE from 'three';
import { fmt$ } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { CITY } from '../world/city.js';
import { camera, canvas } from '../render/main.js';
import { clickPick, patchClickPick } from '../render/night.js';
import { OH } from '../systems/openhouse.js';

// ======== section: 49_machines.js ========
// ====================================================================
// v2.45 — MACHINES. The ask: "I want people to be able to put machines
// inside their rooms or floors." It builds straight on the v2.43 TITLE
// DEEDS: every unit you own or rent (a floor of a big building, a named
// room of a house or small shop) can now be filled with working
// machines — you buy them in the MACHINE SHOP and set them down
// YOURSELF, click by click, wherever you like inside your space:
//   - the deal block of a unit you hold gains an INSTALL MACHINES
//     button -> the shop modal (the game's own modal engine) lists six
//     machines, from a $2,400 Vending Machine to a $52,000 Server Rack,
//     each earning every day (payback ~45 days, so machines are the
//     strong play once you hold property);
//   - INSTALL switches to placement mode: a translucent ghost box
//     follows your cursor on your unit's floor — green where it fits
//     (inside your room / floor, clear of walls and other machines),
//     red where it doesn't — and a click sets the real machine down
//     right there. Keep clicking to fill the space; DONE / ESC ends.
//     Machines never overlap (0.8 m clearance) and respect a per-unit
//     cap from the unit's area (1 per 6 m², 16 max);
//   - in the world every machine is a real little 3D prop — body, top
//     and a blinking work light — visible whenever its building is
//     inspected (and only on the picked floor of a big building,
//     exactly like the dollhouse interior itself);
//   - income accrues on the same beat as the title deeds ($inc per 90 s
//     game-day) through the established additive WORLD.update wrap
//     chain, the WORTH ticker counts machines at purchase price, the
//     Empire panel's deed rows count machines and include their income,
//     the MANAGE modal shows the machine line, and any machine sells
//     back for 60% from the same shop;
//   - machines persist in the save as a `machines` array on each rooms
//     entry (pack stays v5 — optional nested field; older builds and
//     older saves simply ignore it).
// Touchpoints outside this section (each annotated "v2.45"): saveGame/
// loadGame machine lists, the WORTH ticker, the v2.43 deal block
// (machine line + INSTALL MACHINES button + wiring), the v2.43 manage
// modal (machine line + MACHINES button), the v2.43 Empire rows (count
// + income), one help-modal BUILDINGS line, and the version surfaces.
// Every machines call is try/caught so a mistake here can never touch
// the world. window.MACH is the QA surface.
// ====================================================================
export const MACH = (() => {
  // ---- the catalog ---------------------------------------------------
  // payback ~45 days each; bigger machines = fewer clicks per dollar.
  const TYPES = [
    { key: 'vending', name: 'Vending Machine', cost: 2400, inc: 52, w: .95, d: .75, h: 1.85, body: 0xc0392b, top: 0xe74c3c, led: 0xffe08a },
    { key: 'arcade', name: 'Arcade Cabinet', cost: 4800, inc: 105, w: .85, d: .85, h: 1.75, body: 0x6c3d9a, top: 0x8e5bbf, led: 0x7df9ff },
    { key: 'laundry', name: 'Laundry Pair', cost: 3900, inc: 86, w: 1.55, d: .8, h: 1.15, body: 0xecf0f1, top: 0xbdc3c7, led: 0x6fd6ff },
    { key: 'coffee', name: 'Coffee Kiosk', cost: 9800, inc: 215, w: 1.5, d: .95, h: 1.25, body: 0x8d5524, top: 0xd9a066, led: 0xffd27d },
    { key: 'printer', name: '3D Printer', cost: 21000, inc: 465, w: 1.25, d: 1.05, h: 1.45, body: 0x5d6d7e, top: 0x85929e, led: 0x9ff9a0 },
    { key: 'server', name: 'Server Rack', cost: 52000, inc: 1150, w: .75, d: .95, h: 1.95, body: 0x212f3d, top: 0x2e4053, led: 0x4dff88 },
  ];
  const CAP_MAX = 16;              // per-unit machine cap ceiling
  const SELL_BACK = .6;            // sell a machine back for 60% (the property rate)
  const CLEAR = .8;                // min distance between machine centers
  const INSET = .45;               // keep off the walls (the furniture inset)
  const SLAB0 = .21, FH = 3.2;     // the interior builder's own constants
  let acc = 0;                      // income accumulator (the office-suite beat)
  let placing = null;               // { o, b, rects, fl, yF, t, cap }
  let ghost = null, ghostMat = null, ghostT = -1;
  let lastPtr = null;              // {x, y} from pointermove (the ghost follows it)
  let lastGroup = null;            // city swap detector (the OH pattern)
  const built = new Map();         // bkey -> [{ o, g, led }]

  const capOf = area => Math.min(CAP_MAX, Math.max(1, Math.floor((area || 12) / 6)));
  const yOf = fl => SLAB0 + fl * FH;
  const incOfDay = o => (o && o.machines || []).reduce((s, m) => s + (TYPES[m.t] ? TYPES[m.t].inc : 0), 0);
  const valueOfRooms = () => (STATE.rooms || []).reduce((s, r) => s + (r.machines || []).reduce((t, m) => t + (TYPES[m.t] ? TYPES[m.t].cost : 0), 0), 0);

  // ---- the 3D prop ---------------------------------------------------
  function buildMesh(t) {
    const T = TYPES[t] || TYPES[0];
    const g = new THREE.Group();
    try {
      const body = new THREE.Mesh(new THREE.BoxGeometry(T.w, T.h, T.d),
        new THREE.MeshLambertMaterial({ color: T.body }));
      body.position.y = T.h / 2; body.castShadow = true;
      const top = new THREE.Mesh(new THREE.BoxGeometry(T.w + .07, .07, T.d + .07),
        new THREE.MeshLambertMaterial({ color: T.top }));
      top.position.y = T.h + .035;
      const led = new THREE.Mesh(new THREE.BoxGeometry(.11, .06, .11),
        new THREE.MeshBasicMaterial({ color: T.led }));
      led.position.set(T.w / 2 - .08, T.h + .1, T.d / 2 - .08);
      g.add(body); g.add(top); g.add(led);
      g.userData.led = led;
    } catch (e) { }
    return g;
  }

  // build/refresh the meshes of every machine holding in one building:
  // rebuild the wanted list, reuse a mesh that already matches (holding
  // + type + spot), dispose the rest — so installs appear instantly and
  // sold machines / ended leases clean themselves up
  function ensureBuilt(bkey) {
    const holdings = (STATE.rooms || []).filter(r => r.bkey === bkey && r.machines && r.machines.length);
    const old = built.get(bkey) || [];
    const out = [];
    for (const h of holdings) {
      for (const m of h.machines) {
        let e = null;
        for (const v of old) if (v.o === h && v.t === m.t && v.x === m.x && v.z === m.z && v.g) { e = v; break; }
        if (!e) {
          const g = buildMesh(m.t);
          // CITY.group sits at the origin with children in WORLD coordinates
          // (the arrivalPulse convention) — machines go straight to world coords
          g.position.set(m.x, yOf(m.fl), m.z);
          g.visible = false;
          try { CITY.group.add(g); } catch (er) { }
          e = { o: h, g, led: g.userData.led, t: m.t, x: m.x, z: m.z };
        }
        out.push(e);
      }
    }
    for (const e of old) if (out.indexOf(e) < 0) { try { if (e.g.parent) e.g.parent.remove(e.g); } catch (er) { } }
    built.set(bkey, out);
    return out;
  }
  function disposeAll() {
    for (const list of built.values())
      for (const e of list) { try { if (e.g && e.g.parent) e.g.parent.remove(e.g); } catch (er) { } }
    built.clear();
  }
  // machines show only while their building is inspected — and a big
  // building's floor units follow the picked floor, exactly like the
  // dollhouse's own drawRange
  function syncVisibility(st) {
    for (const [bkey, list] of built) {
      const on = !!(st && st.open && st.open.bkey === bkey);
      for (const e of list) {
        let vis = on;
        if (vis && e.o.kind === 'floor' && st.open.floor != null) vis = st.open.floor === e.o.index;
        e.g.visible = vis;
      }
    }
  }

  // ---- placement geometry -------------------------------------------
  // rects: the room rect (room units) or the room rects of that floor
  // (floor units — keeps machines off the partition walls); null-safe.
  function unitRects(o, b) {
    const rects = [];
    try {
      if (o.kind === 'room') {
        const rc = OH.roomRect(o.index);
        if (rc) rects.push({ x0: rc.x0, x1: rc.x1, z0: rc.z0, z1: rc.z1, fl: rc.floor });
      } else {
        const n = (OH.rooms() || []).length;
        for (let i = 0; i < n; i++) {
          const rc = OH.roomRect(i);
          if (rc && rc.floor === o.index) rects.push({ x0: rc.x0, x1: rc.x1, z0: rc.z0, z1: rc.z1, fl: rc.floor });
        }
      }
    } catch (er) { }
    if (!rects.length && b && b.poly && b.poly.length) {   // fallback: the whole plate
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const v of b.poly) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); z0 = Math.min(z0, v[1]); z1 = Math.max(z1, v[1]); }
      rects.push({ x0, x1, z0, z1, fl: o.kind === 'floor' ? o.index : 0 });
    }
    return rects;
  }
  function validSpot(x, z, o, rects) {
    if (!placing || !rects || !rects.length) return { ok: false, why: 'no space data' };
    const T = TYPES[placing.t];
    const hw = T.w / 2 + .05, hd = T.d / 2 + .05;
    let inside = false;
    for (const rc of rects) {
      if (x - hw >= rc.x0 + INSET && x + hw <= rc.x1 - INSET && z - hd >= rc.z0 + INSET && z + hd <= rc.z1 - INSET) { inside = true; break; }
    }
    if (!inside) return { ok: false, why: 'inside' };
    for (const r of (STATE.rooms || [])) {
      if (r.bkey !== o.bkey || !r.machines) continue;
      for (const m of r.machines)
        if (Math.hypot(m.x - x, m.z - z) < CLEAR) return { ok: false, why: 'clear' };
    }
    return { ok: true };
  }
  const _rc = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _pt = new THREE.Vector3();
  const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function rayToFloor(cx, cy) {
    try {
      _ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
      _rc.setFromCamera(_ndc, camera);
      _plane.constant = -placing.yF;
      const pt = _rc.ray.intersectPlane(_plane, _pt);
      return pt ? { x: pt.x, z: pt.z } : null;
    } catch (er) { return null; }
  }

  // ---- the ghost + hint bar -----------------------------------------
  try {   // the shop cards + the placement bar styles (injected once)
    const st = document.createElement('style');
    st.textContent = [
      '#mshop{display:flex;flex-direction:column;gap:6px;margin-top:10px}',
      '.mshop-card{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09)}',
      '.mshop-card.dim{opacity:.45}',
      '.mshop-info{display:flex;flex-direction:column;gap:2px;font-size:12px}',
      '.mshop-info span{color:var(--mut);font-size:10.5px}',
      '.mshop-buy{display:flex;align-items:center;gap:8px;flex:none}',
      '.mshop-buy span{font-weight:700;font-size:12px}',
      '.mshop-buy .btn{padding:6px 12px;font-size:11px;margin:0}',
      '#mh-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px',
      ' background:var(--panel2);border:1px solid rgba(77,255,136,.35);border-radius:10px;padding:8px 12px;font-size:12px;',
      ' color:var(--txt);box-shadow:0 8px 26px rgba(0,0,0,.55);white-space:nowrap;max-width:92vw;overflow:hidden}',
      '#mh-bar.hidden{display:none}',
      '#mh-bar b{color:#4dff88}',
      '#mh-bar .mh-x{flex:none;padding:5px 12px;border-radius:7px;background:rgba(77,255,136,.16);color:#4dff88;font-weight:700;cursor:pointer}',
      '#mh-bar .mh-x:hover{background:rgba(77,255,136,.3)}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }
  function ensureGhost() {
    if (ghost && ghostT === placing.t) return;
    killGhost();
    const T = TYPES[placing.t];
    ghostMat = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: .42, depthWrite: false });
    ghost = new THREE.Mesh(new THREE.BoxGeometry(T.w, T.h, T.d), ghostMat);
    ghost.renderOrder = 3;
    ghostT = placing.t;
    try { CITY.group.add(ghost); } catch (er) { }
  }
  function killGhost() {
    if (!ghost) return;
    try { if (ghost.parent) ghost.parent.remove(ghost); ghost.geometry.dispose(); ghostMat.dispose(); } catch (er) { }
    ghost = null; ghostMat = null; ghostT = -1;
  }
  function ensureBar() {
    let bar = document.getElementById('mh-bar');
    if (bar) return bar;
    try {
      bar = document.createElement('div');
      bar.id = 'mh-bar';
      document.body.appendChild(bar);
    } catch (er) { }
    return bar;
  }
  function barHTML() {
    const T = TYPES[placing.t];
    const n = (placing.o.machines || []).length;
    return '<span>PLACING <b>' + T.name.toUpperCase() + '</b> \u00b7 click a spot inside <b>' + placing.o.name +
      '</b> \u00b7 ' + fmt$(T.cost) + ' each \u00b7 ' + (n + 1) + '/' + placing.cap +
      ' \u00b7 <span style="color:var(--mut)">' + fmt$(STATE.money) + '</span></span>' +
      '<span class="mh-x" id="mh-done">DONE</span>';
  }

  // ---- placement mode --------------------------------------------------
  function startPlacing(o, b, rects, t) {
    const fl = o.kind === 'floor' ? o.index : (rects[0] ? rects[0].fl : 0);
    placing = { o, b, rects, fl, yF: yOf(fl) + .02, t, cap: capOf(o.area) };
    try { closeModal(); } catch (er) { }
    ensureBar();
    const bar = document.getElementById('mh-bar');
    if (bar) {
      bar.innerHTML = barHTML();
      bar.classList.remove('hidden');
      const done = bar.querySelector('#mh-done');
      if (done) done.onclick = () => exitPlacing(true);
    }
    ensureGhost();
    try { OH.refresh(); } catch (er) { }
    toast('Click a spot inside <b>' + o.name + '</b> to set the ' + TYPES[t].name + ' down. ESC or DONE to finish.', 'warn');
  }
  function exitPlacing(done) {
    placing = null;
    killGhost();
    const bar = document.getElementById('mh-bar');
    if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
    try { OH.refresh(); } catch (er) { }
    if (done) try { toast('Machine work finished \u2014 every machine pays you daily.', 'warn'); } catch (er) { }
  }
  function placeAt(x, z) {
    const o = placing.o, T = TYPES[placing.t];
    const v = validSpot(x, z, o, placing.rects);
    if (!v.ok) {
      toast(v.why === 'clear' ? '<b>Too close to another machine.</b> Give it ' + CLEAR + ' m of clearance.'
        : '<b>That spot is outside your space.</b> Click inside ' + o.name + '.', 'warn');
      return;
    }
    if ((o.machines || []).length >= placing.cap) { toast('<b>' + o.name + ' is full</b> (' + placing.cap + ' machines).', 'warn'); exitPlacing(true); return; }
    if (!spend(T.cost)) { toast('<b>Not enough money.</b> The ' + T.name + ' costs ' + fmt$(T.cost) + '.', 'warn'); exitPlacing(true); return; }
    (o.machines || (o.machines = [])).push({ t: placing.t, x: +x.toFixed(2), z: +z.toFixed(2), fl: placing.fl });
    try { saveGame(); } catch (er) { }
    ensureBuilt(o.bkey);          // the machine appears right now
    const bar = document.getElementById('mh-bar');
    if (bar) bar.innerHTML = barHTML();
    const done = bar && bar.querySelector('#mh-done');
    if (done) done.onclick = () => exitPlacing(true);
    try { OH.refresh(); } catch (er) { }
    if ((o.machines || []).length >= placing.cap || STATE.money < T.cost) exitPlacing(true);
  }
  // the click: while placing, EVERY canvas click is a placement attempt
  // (this wrap runs before the farm claim, the openhouse and the walk
  // orders — installing never walks the character)
  function click(cx, cy) {
    if (!placing) return false;
    const pt = rayToFloor(cx, cy);
    if (!pt) { toast('Aim at your floor — the camera needs to see it.', 'warn'); return true; }
    placeAt(pt.x, pt.z);
    return true;
  }

  // ---- the shop modal -------------------------------------------------
  function openShop(bkey, kind, index) {
    const o = (STATE.rooms || []).find(r => r.bkey === bkey && r.kind === kind && r.index === index);
    if (!o) { toast('Buy or rent that ' + (kind === 'floor' ? 'floor' : 'room') + ' first \u2014 machines go in your own space.', 'warn'); return; }
    const b = (CITY.buildingPolys || []).find(x => x.bkey === bkey);
    if (!b) { toast('That building is not standing here \u2014 travel to ' + (o.cityName || o.cityKey) + ' first.', 'warn'); return; }
    let st = null;
    try { st = OH.state(); } catch (er) { }
    if (!st || !st.open || st.open.bkey !== bkey) {
      try { OH.force(bkey); } catch (er) { }        // open it: the layout drives the rects
      // keep the unit PICKED after the force (force resets the pick) so the
      // deal block stays coherent while the shop is up
      try { if (kind === 'floor') OH.selectFloor(index); else OH.selectRoom(index); } catch (er) { }
    }
    const rects = unitRects(o, b);
    if (!rects.length) { toast('Could not open that ' + (kind === 'floor' ? 'floor' : 'room') + ' here.', 'warn'); return; }
    renderShop(o, b, rects);
  }
  function openShopFor(o) { if (o) openShop(o.bkey, o.kind, o.index); }
  function renderShop(o, b, rects) {
    const cap = capOf(o.area), n = (o.machines || []).length;
    const cards = TYPES.map((T, i) =>
      '<div class="mshop-card' + (n >= cap || STATE.money < T.cost ? ' dim' : '') + '">' +
      '<div class="mshop-info"><b>' + T.name + '</b><span>+$' + T.inc + '/day \u00b7 ' + T.w.toFixed(2) + ' \u00d7 ' + T.d.toFixed(2) + ' m</span></div>' +
      '<div class="mshop-buy"><span>' + fmt$(T.cost) + '</span>' +
      '<button class="btn primary" data-mi="' + i + '"' + (n >= cap ? ' disabled' : '') + '>INSTALL</button></div></div>').join('');
    const mine = (o.machines || []).map((m, i) => TYPES[m.t] ?
      '<div class="kv"><span class="k">' + TYPES[m.t].name + ' \u00b7 +$' + TYPES[m.t].inc + '/day</span>' +
      '<button class="tpbtn" data-ms="' + i + '">SELL ' + fmt$(Math.round(TYPES[m.t].cost * SELL_BACK)) + '</button></div>' : '').join('');
    openModal('MACHINES \u2014 ' + o.name, `
      <p>Fill <b>${o.name}</b> with working machines. Pick one, then <b>click a spot inside your space</b> to set it down \u2014 each machine pays you every day, and sells back for ${Math.round(SELL_BACK * 100)}%.</p>
      <div class="kv"><span class="k">YOUR SPACE</span><span class="v">${o.area} m\u00b2 \u00b7 ${n}/${cap} machines installed</span></div>
      <div class="kv"><span class="k">MACHINE INCOME</span><span class="v g">+$${incOfDay(o)}/day</span></div>
      <div id="mshop">${cards}</div>
      ${mine ? '<div class="msec" style="margin-top:12px">Installed \u2014 sell any back for ' + Math.round(SELL_BACK * 100) + '%</div>' + mine : ''}
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="ms-x" style="flex:1">CLOSE</button></div>`);
    document.querySelectorAll('#mshop [data-mi]').forEach(el => {
      el.onclick = () => {
        const t = +el.dataset.mi;
        if (n >= cap) { toast('<b>' + o.name + ' is full</b> (' + cap + ' machines for ' + o.area + ' m\u00b2).', 'warn'); return; }
        if (STATE.money < TYPES[t].cost) { toast('<b>Not enough money.</b> The ' + TYPES[t].name + ' costs ' + fmt$(TYPES[t].cost) + '.', 'warn'); return; }
        startPlacing(o, b, rects, t);
      };
    });
    document.querySelectorAll('[data-ms]').forEach(el => {
      el.onclick = () => {
        const i = +el.dataset.ms;
        const m = (o.machines || [])[i];
        if (!m || !TYPES[m.t]) return;
        o.machines.splice(i, 1);
        earn(Math.round(TYPES[m.t].cost * SELL_BACK), false);   // resale doesn't count toward GDP
        try { saveGame(); } catch (er) { }
        ensureBuilt(o.bkey);
        toast('Sold the <b>' + TYPES[m.t].name + '</b> for ' + fmt$(Math.round(TYPES[m.t].cost * SELL_BACK)) + '.');
        renderShop(o, b, rects);
      };
    });
    const x = document.getElementById('ms-x');
    if (x) x.onclick = closeModal;
  }

  // ---- income + tick ---------------------------------------------------
  function tick(dt) {
    try {
      // city swap -> drop every built mesh (they lived in the old group)
      if (CITY.group !== lastGroup) { lastGroup = CITY.group; disposeAll(); if (placing) exitPlacing(false); }
      // income on the office-suite beat
      const R = STATE.rooms || [];
      if (STATE.mode !== 'city' || !R.length) acc = 0;
      else {
        acc += dt;
        if (acc >= 1) {
          const secs = acc; acc = 0;
          let inc = 0;
          for (const r of R) inc += incOfDay(r);
          if (inc > 0) earn(inc / 90 * secs);
        }
      }
      // the inspector drives visibility (and placement ends when it closes)
      let st = null;
      try { st = OH.state(); } catch (er) { }
      if (placing && (!st || !st.open || st.open.bkey !== placing.o.bkey)) exitPlacing(false);
      if (st && st.open) ensureBuilt(st.open.bkey);
      syncVisibility(st);
      // the ghost follows the cursor (world coords — CITY.group is at origin)
      if (placing && lastPtr && ghost && ghostMat) {
        const pt = rayToFloor(lastPtr.x, lastPtr.y);
        if (pt) {
          ghost.visible = true;
          ghost.position.set(pt.x, placing.yF + (TYPES[placing.t].h / 2), pt.z);
          const v = validSpot(pt.x, pt.z, placing.o, placing.rects);
          ghostMat.color.setHex(v.ok ? 0x4dff88 : 0xff5d5d);
        } else ghost.visible = false;
      } else if (ghost) ghost.visible = false;
      // blinking work lights on the visible machines (phase per machine)
      if (st && st.open) {
        const now = performance.now() / 900;
        const list = built.get(st.open.bkey) || [];
        for (const e of list) {
          if (!e.g.visible || !e.led) continue;
          e.led.visible = ((now + (e.x * .37 + e.z * .11)) % 1) < .55;
        }
      }
    } catch (e) { console.error('[machines]', e); }
  }

  // ---- listeners (once) -------------------------------------------------
  try {
    canvas.addEventListener('pointermove', e => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true });
    canvas.addEventListener('pointerleave', () => { lastPtr = null; }, { passive: true });
    window.addEventListener('keydown', e => {           // capture: ESC ends placement BEFORE the inspector's own ESC
      if (e.key !== 'Escape' || !placing) return;
      try { e.stopPropagation(); } catch (er) { }
      exitPlacing(true);
    }, true);
  } catch (er) { }

  return {
    tick, click, openShop, openShopFor, incOfDay, capOf, exitPlacing,
    TYPES,
    valueOfRooms,
    // QA: programmatic install (no modal, no ghost) — same validation
    install(bkey, kind, index, t, x, z) {
      const o = (STATE.rooms || []).find(r => r.bkey === bkey && r.kind === kind && r.index === index);
      if (!o) return { ok: false, why: 'not yours' };
      const b = (CITY.buildingPolys || []).find(v => v.bkey === bkey);
      if (!b) return { ok: false, why: 'no building' };
      const rects = unitRects(o, b);
      const fl = o.kind === 'floor' ? o.index : (rects[0] ? rects[0].fl : 0);
      const saved = placing;
      placing = { o, b, rects, fl, yF: yOf(fl) + .02, t, cap: capOf(o.area) };
      const v = validSpot(x, z, o, placing.rects);
      if (!v.ok) { placing = saved; return { ok: false, why: v.why }; }
      if ((o.machines || []).length >= placing.cap) { placing = saved; return { ok: false, why: 'cap' }; }
      if (!spend(TYPES[t].cost)) { placing = saved; return { ok: false, why: 'funds', cost: TYPES[t].cost }; }
      (o.machines || (o.machines = [])).push({ t, x: +x.toFixed(2), z: +z.toFixed(2), fl });
      try { saveGame(); } catch (er) { }
      ensureBuilt(bkey);
      placing = saved;
      return { ok: true };
    },
    // QA: remove the i-th machine of a holding (pays 60%)
    removeAt(bkey, kind, index, i) {
      const o = (STATE.rooms || []).find(r => r.bkey === bkey && r.kind === kind && r.index === index);
      const m = o && (o.machines || [])[i];
      if (!m || !TYPES[m.t]) return { ok: false, why: 'no machine' };
      o.machines.splice(i, 1);
      earn(Math.round(TYPES[m.t].cost * SELL_BACK), false);
      try { saveGame(); } catch (er) { }
      ensureBuilt(bkey);
      return { ok: true, got: Math.round(TYPES[m.t].cost * SELL_BACK) };
    },
    placing() { return placing ? { bkey: placing.o.bkey, kind: placing.o.kind, index: placing.o.index, t: placing.t, cap: placing.cap } : null; },
    meshCount(bkey) { return (built.get(bkey) || []).length; },
    state() {
      const R = STATE.rooms || [];
      return {
        machines: R.reduce((s, r) => s + (r.machines || []).length, 0),
        incomePerDay: R.reduce((s, r) => s + incOfDay(r), 0),
        value: valueOfRooms(),
        placing: !!placing,
        accrual: +acc.toFixed(2),
      };
    },
  };
})();
window.MACH = MACH;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the click chain: a machine placement runs FIRST (before the farm
//    claim, the openhouse inspector and the walk orders) so installing
//    never walks the character or re-picks the building.
const __machClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (MACH.click(cx, cy)) return; } catch (e) { console.error('[machines]', e); }
  return __machClickPick(cx, cy);
});
// 2. the update chain: original -> world forest -> open house -> suburbs
//    -> title deeds -> patchwork -> MACHINES. Every call is try/caught
//    so a machines error can never touch the world.
const __machOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __machOrigUpdate(dt, px, pz, camDist);
  try { MACH.tick(dt); } catch (e) { console.error('[machines]', e); }
  return req;
};


