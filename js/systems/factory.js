// ====================================================================
// js/systems/factory.js — machines on the FACTORY FLOOR (v2.61):
// a heavy-industry catalog + placement inside your own factory shells.
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
import { MACH } from '../systems/machines.js';
import { BLD } from '../systems/builder.js';

// ======== section: 58_factory.js ========
// ====================================================================
// v2.61 — FACTORY FLOOR. The ask: "Make more machines that can be
// placed in factories." The v2.45 MACHINES shop fills the rooms and
// floors you hold TITLE DEEDS on — but the factory shell you raise
// with GROUND UP (v2.56) was a dead box: it paid its flat $128/day and
// nothing could happen inside it. Now the shell opens up:
//   - click a FINISHED factory shell → its panel gains a MACHINES
//     button and a machine line → the FACTORY FLOOR shop: six new
//     heavy machines, from a $26,000 Packaging Station to a $160,000
//     Injection Molder (~45-day payback, same curve as every other
//     machine), plus the six classic unit machines (vending, arcade,
//     laundry, coffee, 3D printer, server rack) — twelve machines can
//     stand on a factory floor;
//   - INSTALL switches to placement mode: while it runs THE SHELL
//     ITSELF GOES TRANSLUCENT (a cutaway — the same trick the
//     dollhouse plays on OSM buildings, applied to the Ground-Up
//     shell) so you can see the floor, and a ghost box follows your
//     cursor — green where it fits (inside the shell, clear of the
//     other machines), red where it doesn't. A click sets the machine
//     down; keep clicking to fill the floor; DONE / ESC ends;
//   - machines are AABB-checked (footprints up to 3.6 m long) with a
//     .25 m gap, stay .45 m off the walls, and respect the same
//     area-driven cap as unit machines (1 per 6 m² — the ~93 m² clear
//     floor of a shell carries 15);
//   - income accrues on the 90 s game-day beat through the additive
//     WORLD.update wrap chain (after GROUND UP), the WORTH ticker
//     counts factory machines at purchase price, the Empire panel
//     gains a "factory floor" section (and the building rows count
//     machines), the machine line rides the factory's own panel, and
//     every machine sells back for 60% from the same shop;
//   - demolishing a factory shell sells its machines back at 60%
//     automatically (same rate as the materials scrap);
//   - machines persist in the save as a `mach` array on each bld
//     entry (optional nested field, pack stays v5 — older builds and
//     older saves simply ignore it; the classic machines reuse their
//     catalog index + 10 so one byte of `t` picks the line).
// Touchpoints outside this section (each annotated "v2.61"): BLD
// exports liveAt/recOf/toLocal, the factory panel + demolish + topped-
// out toast + Empire rows in builder.js, saveGame/loadGame mach list,
// the WORTH ticker + help line + What's-New card in night.js,
// playerWorth in rivals.js, the boot import + ready log. Every factory
// call is try/caught so a mistake here can never touch the world.
// window.FACT is the QA surface.
// ====================================================================
export const FACT = (() => {
  // ---- the catalog ---------------------------------------------------
  // payback ~45 days each, on the same curve as the unit machines;
  // heavier machines = fewer clicks per dollar.
  const FTYPES = [
    { key: 'pack', name: 'Packaging Station',      cost: 26000,  inc: 575,  w: 1.6, d: 1.3, h: 1.5, body: 0x4a69bd, top: 0x6a89cc, led: 0xffe08a },
    { key: 'cnc',  name: 'CNC Machining Center',   cost: 44000,  inc: 970,  w: 2.0, d: 1.6, h: 1.9, body: 0x2f8f5b, top: 0x48b478, led: 0x9ff9a0 },
    { key: 'press',name: 'Stamping Press',         cost: 68000,  inc: 1500, w: 2.4, d: 1.8, h: 2.6, body: 0x8e2f38, top: 0xb3454f, led: 0xffd27d },
    { key: 'asm',  name: 'Assembly Line',          cost: 95000,  inc: 2100, w: 3.6, d: 1.2, h: 1.5, body: 0x5d6d7e, top: 0x85929e, led: 0x6fd6ff },
    { key: 'weld', name: 'Robotic Weld Cell',      cost: 120000, inc: 2650, w: 2.6, d: 2.2, h: 2.4, body: 0xc2793b, top: 0xd99a4e, led: 0x7df9ff },
    { key: 'mold', name: 'Injection Molder',       cost: 160000, inc: 3530, w: 3.2, d: 1.5, h: 2.0, body: 0x6b5b95, top: 0x8a7ab0, led: 0x4dff88 },
  ];
  // t >= 10 reuses the classic unit-machine catalog (MACH.TYPES[t-10]);
  // t < 6 is the heavy line above. One number picks the machine.
  const TOF = t => (t >= 10 ? (MACH.TYPES[t - 10] || MACH.TYPES[0]) : (FTYPES[t] || FTYPES[0]));

  const SELL_BACK = .6;            // sell a machine back for 60% (the property rate)
  const INSET = .45;               // keep off the shell walls (the machines inset)
  const GAP = .25;                 // air between machine footprints (AABB)
  const FLOOR_Y = .02;             // the shell floor rides just above the ground
  const FACT_T = () => (BLD.TYPES || []).find(T => T.id === 'fact') || BLD.TYPES[3];
  // the clear floor inside the 12×10 shell: the body box is 11.6×9.6,
  // inset .45 each side -> half-extents around the building center
  const HW = () => 11.6 / 2 - INSET, HD = () => 9.6 / 2 - INSET;
  const AREA = () => (11.6 - 2 * INSET) * (9.6 - 2 * INSET);   // ~93 m² -> 15 machines
  const CAP = () => MACH.capOf(AREA());

  let acc = 0;                     // income accumulator (the office-suite beat)
  let placing = null;              // { p, b, rec, key, i, t, cap }
  let shopKey = null;              // plot#idx while the factory shop modal is up
  let cutKey = null;               // plot#idx whose shell is faded to cutaway
  let meshKey = null;              // plot#idx whose machines have live meshes
  let ghost = null, ghostMat = null, ghostT = -1;
  let lastPtr = null;              // {x, y} from pointermove (the ghost follows it)
  const built = new Map();         // key -> [{ g, led, t, x, z }]
  const cutMats = new Map();       // material.uuid -> translucent clone (the cutaway)

  const factories = () => {
    const out = [];
    for (const p of (STATE.plots || [])) (p.bld || []).forEach((b, i) => {
      const T = BLD.TYPES[b.t];
      if (T && T.id === 'fact') out.push({ p, b, i });
    });
    return out;
  };
  const incomeOf = b => (b.mach || []).reduce((s, m) => s + (TOF(m.t) ? TOF(m.t).inc : 0), 0);
  const valueOf = () => factories().reduce((s, x) => s + (x.b.mach || []).reduce((t, m) => t + (TOF(m.t) ? TOF(m.t).cost : 0), 0), 0);
  const keyOf = (p, i) => p.id + '#' + i;

  // ---- the 3D prop ---------------------------------------------------
  const LM = c => new THREE.MeshLambertMaterial({ color: c });
  function buildMesh(t) {
    const T = TOF(t), g = new THREE.Group();
    try {
      const body = new THREE.Mesh(new THREE.BoxGeometry(T.w, T.h, T.d), LM(T.body));
      body.position.y = T.h / 2; body.castShadow = true;
      const top = new THREE.Mesh(new THREE.BoxGeometry(T.w + .07, .07, T.d + .07), LM(T.top));
      top.position.y = T.h + .035;
      const led = new THREE.Mesh(new THREE.BoxGeometry(.11, .06, .11),
        new THREE.MeshBasicMaterial({ color: T.led }));
      led.position.set(T.w / 2 - .08, T.h + .1, T.d / 2 - .08);
      g.add(body); g.add(top); g.add(led);
      // v2.61 accents — one telling detail per heavy machine (the
      // classic machines keep the plain v2.45 recipe)
      if (t < 10) {
        if (t === 0) {          // packaging: the outfeed tray
          const tr = new THREE.Mesh(new THREE.BoxGeometry(.7, .1, .5), LM(0x9aa5b1));
          tr.position.set(0, 1.02, T.d / 2 + .22); g.add(tr);
        } else if (t === 1) {   // CNC: the control pendant
          const cp = new THREE.Mesh(new THREE.BoxGeometry(.42, .5, .1), LM(0x212f3d));
          cp.position.set(T.w / 2 - .28, 1.25, T.d / 2 + .07); g.add(cp);
        } else if (t === 2) {   // press: the ram head rides on top
          const rh = new THREE.Mesh(new THREE.BoxGeometry(1.5, .55, 1.1), LM(0x6e2a31));
          rh.position.set(0, T.h + .3, 0); g.add(rh);
        } else if (t === 3) {   // assembly line: conveyor rollers
          for (let k = -1; k <= 1; k++) {
            const ro = new THREE.Mesh(new THREE.BoxGeometry(.2, .14, .9), LM(0x2c3440));
            ro.position.set(k * 1.0, T.h + .09, 0); g.add(ro);
          }
        } else if (t === 4) {   // weld cell: the orange robot arm
          const post = new THREE.Mesh(new THREE.BoxGeometry(.18, 1.0, .18), LM(0xe07b39));
          post.position.set(-.7, T.h + .5, -.5); g.add(post);
          const reach = new THREE.Mesh(new THREE.BoxGeometry(.9, .14, .14), LM(0xe07b39));
          reach.position.set(-.28, T.h + .95, -.5); g.add(reach);
        } else {                // injection molder: the hopper
          const hp = new THREE.Mesh(new THREE.CylinderGeometry(.28, .42, .5, 10), LM(0x4a4a55));
          hp.position.set(T.w / 2 - .75, T.h + .28, 0); g.add(hp);
        }
      }
      g.userData.led = led;
    } catch (e) { }
    return g;
  }

  // build/refresh the meshes of one factory's machines: they live as
  // children of the shell's own live root (the plot-local frame, so
  // they rotate with the building), rebuilt when the root is recreated
  // (city swap / region re-entry) and disposed the moment the floor
  // goes dark again
  function ensureBuilt(key) {
    const hit = key ? findOf(key) : null;
    const root = hit ? BLD.liveAt(key) : null;
    const old = built.get(key) || [];
    const out = [];
    if (hit && root && root.root) {
      for (const m of (hit.b.mach || [])) {
        let e = null;
        for (const v of old) if (v.t === m.t && v.x === m.x && v.z === m.z && v.g && v.g.parent === root.root) { e = v; break; }
        if (!e) {
          const g = buildMesh(m.t);
          g.position.set(m.x, FLOOR_Y, m.z);
          g.visible = false;
          try { root.root.add(g); } catch (er) { }
          e = { g, led: g.userData.led, t: m.t, x: m.x, z: m.z };
        }
        out.push(e);
      }
    }
    for (const e of old) if (out.indexOf(e) < 0) { try { if (e.g.parent) e.g.parent.remove(e.g); } catch (er) { } }
    if (out.length || old.length) built.set(key, out); else built.delete(key);
    return out;
  }
  function disposeAll() {
    for (const list of built.values())
      for (const e of list) { try { if (e.g && e.g.parent) e.g.parent.remove(e.g); } catch (er) { } }
    built.clear();
  }

  // ---- the cutaway: fade the shell while its floor is open -----------
  function fadeBody(body) {
    for (const ch of (body.children || [])) {
      if (!ch || !ch.material) continue;
      if (!ch.userData.__om) ch.userData.__om = ch.material;
      let m = cutMats.get(ch.material.uuid);
      if (!m) {
        m = ch.material.clone();
        m.transparent = true; m.opacity = .16; m.depthWrite = false;
        cutMats.set(ch.material.uuid, m);
      }
      ch.material = m;
    }
  }
  function restoreBody(body) {
    for (const ch of (body.children || [])) {
      if (ch && ch.userData && ch.userData.__om) { ch.material = ch.userData.__om; delete ch.userData.__om; }
    }
  }
  function setCutaway(key) {
    // a city swap can rebuild the shell's body with fresh materials —
    // detect a stale fade and re-apply
    if (key && key === cutKey) {
      const r0 = BLD.liveAt(key);
      if (!r0 || !r0.body || !(r0.body.children || []).length ||
        !(r0.body.children[0].userData && r0.body.children[0].userData.__om)) cutKey = null;
    }
    if (key === cutKey) return;
    if (cutKey) { const r = BLD.liveAt(cutKey); if (r && r.body) restoreBody(r.body); cutKey = null; }
    if (key) { const r = BLD.liveAt(key); if (r && r.body) fadeBody(r.body); cutKey = key; }
  }

  // ---- placement geometry --------------------------------------------
  function findOf(key) {           // { p, b, i } for a plot#idx key
    const idx = +key.slice(key.lastIndexOf('#') + 1), pid = key.slice(0, key.lastIndexOf('#'));
    const p = (STATE.plots || []).find(q => q.id === pid);
    const b = p && (p.bld || [])[idx];
    const T = b && BLD.TYPES[b.t];
    return (p && b && T && T.id === 'fact') ? { p, b, i: idx } : null;
  }
  function validSpot(lx, lz, t, b) {
    const T = TOF(t);
    const hw = T.w / 2 + .05, hd = T.d / 2 + .05;
    if (Math.abs(lx - b.x) + hw > HW() || Math.abs(lz - b.z) + hd > HD())
      return { ok: false, why: 'bounds' };
    for (const m of (b.mach || [])) {
      const T2 = TOF(m.t);
      if (Math.abs(m.x - lx) < (T.w + T2.w) / 2 + GAP && Math.abs(m.z - lz) < (T.d + T2.d) / 2 + GAP)
        return { ok: false, why: 'clear' };
    }
    return { ok: true };
  }
  const _rc = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _pt = new THREE.Vector3();
  const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
  function rayToFloor(cx, cy) {
    try {
      _ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
      _rc.setFromCamera(_ndc, camera);
      const pt = _rc.ray.intersectPlane(_plane, _pt);
      return pt ? { x: pt.x, z: pt.z } : null;
    } catch (er) { return null; }
  }

  // ---- the ghost + bar -------------------------------------------------
  try {   // the placement bar style (injected once — the machines bar's twin, in factory gold)
    const st = document.createElement('style');
    st.textContent = [
      '#fc-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px',
      ' background:var(--panel2);border:1px solid rgba(245,204,116,.4);border-radius:10px;padding:8px 12px;font-size:12px;',
      ' color:var(--txt);box-shadow:0 8px 26px rgba(0,0,0,.55);white-space:nowrap;max-width:92vw;overflow:hidden}',
      '#fc-bar.hidden{display:none}',
      '#fc-bar b{color:#f5cc74}',
      '#fc-bar .fc-x{flex:none;padding:5px 12px;border-radius:7px;background:rgba(245,204,116,.16);color:#f5cc74;font-weight:700;cursor:pointer}',
      '#fc-bar .fc-x:hover{background:rgba(245,204,116,.3)}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }
  function ensureGhost() {
    const root = BLD.liveAt(placing.key);
    if (ghost && ghostT === placing.t && root && ghost.parent === root.root) return;
    killGhost();
    const T = TOF(placing.t);
    ghostMat = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: .42, depthWrite: false });
    ghost = new THREE.Mesh(new THREE.BoxGeometry(T.w, T.h, T.d), ghostMat);
    ghost.renderOrder = 3;
    ghostT = placing.t;
    if (root && root.root) { try { root.root.add(ghost); } catch (er) { } }
  }
  function killGhost() {
    if (!ghost) return;
    try { if (ghost.parent) ghost.parent.remove(ghost); ghost.geometry.dispose(); ghostMat.dispose(); } catch (er) { }
    ghost = null; ghostMat = null; ghostT = -1;
  }
  function barHTML() {
    const T = TOF(placing.t);
    const n = (placing.b.mach || []).length;
    return '<span>PLACING <b>' + T.name.toUpperCase() + '</b> \u00b7 click the factory floor \u00b7 ' + fmt$(T.cost) +
      ' each \u00b7 ' + (n + 1) + '/' + placing.cap + ' \u00b7 <span style="color:var(--mut)">' + fmt$(STATE.money) + '</span></span>' +
      '<span class="fc-x" id="fc-done">DONE</span>';
  }
  function refreshBar() {
    const bar = document.getElementById('fc-bar');
    if (!bar) return;
    bar.innerHTML = barHTML();
    const done = bar.querySelector('#fc-done');
    if (done) done.onclick = () => exitPlacing(true);
  }

  // ---- placement mode --------------------------------------------------
  function startPlacing(hit, rec, t) {
    try { if (window.MACH && MACH.placing()) MACH.exitPlacing(false); } catch (er) { }   // one placer at a time
    placing = { p: hit.p, b: hit.b, i: hit.i, rec, key: keyOf(hit.p, hit.i), t, cap: CAP() };
    shopKey = null;
    try { closeModal(); } catch (er) { }
    let bar = document.getElementById('fc-bar');
    if (!bar) { try { bar = document.createElement('div'); bar.id = 'fc-bar'; document.body.appendChild(bar); } catch (er) { } }
    if (bar) { refreshBar(); bar.classList.remove('hidden'); }
    ensureGhost();
    toast('Click a spot on <b>the factory floor</b> to set the ' + TOF(t).name + ' down. ESC or DONE to finish.', 'warn');
  }
  function exitPlacing(done) {
    placing = null;
    killGhost();
    const bar = document.getElementById('fc-bar');
    if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
    if (done) try { toast('The line is running \u2014 every machine pays you daily.', 'warn'); } catch (er) { }
  }
  function placeAt(lx, lz) {
    const T = TOF(placing.t);
    const v = validSpot(lx, lz, placing.t, placing.b);
    if (!v.ok) {
      toast(v.why === 'clear' ? '<b>Too close to another machine.</b> Give them ' + GAP + ' m of air.'
        : '<b>That spot is outside the shell.</b> Click the floor inside the factory walls.', 'warn');
      return;
    }
    if ((placing.b.mach || []).length >= placing.cap) { toast('<b>This factory floor is full</b> (' + placing.cap + ' machines).', 'warn'); exitPlacing(true); return; }
    if (!spend(T.cost)) { toast('<b>Not enough money.</b> The ' + T.name + ' costs ' + fmt$(T.cost) + '.', 'warn'); exitPlacing(true); return; }
    (placing.b.mach || (placing.b.mach = [])).push({ t: placing.t, x: +lx.toFixed(2), z: +lz.toFixed(2) });
    try { saveGame(); } catch (er) { }
    ensureBuilt(placing.key);          // the machine appears right now
    refreshBar();
    if ((placing.b.mach || []).length >= placing.cap || STATE.money < T.cost) exitPlacing(true);
  }
  // the click: while placing, EVERY canvas click is a placement attempt
  // (this wrap runs first in the chain — before the unit-machine
  // placer, the farm claim and the walk orders)
  function click(cx, cy) {
    if (!placing) return false;
    const pt = rayToFloor(cx, cy);
    if (!pt) { toast('Aim at the factory floor \u2014 the camera needs to see it.', 'warn'); return true; }
    const [lx, lz] = BLD.toLocal(placing.rec, pt.x, pt.z);
    placeAt(lx, lz);
    return true;
  }

  // ---- the shop modal -------------------------------------------------
  function openShop(plotId, i) {
    const p = (STATE.plots || []).find(q => q.id === plotId);
    const b = p && (p.bld || [])[i | 0];
    const T = b && BLD.TYPES[b.t];
    if (!p || !b || !T || T.id !== 'fact') { toast('Machines go in a <b>factory shell</b> — raise one with BUILD first.', 'warn'); return; }
    if (b.p < T.days) { toast('The shell is still under construction \u2014 the floor opens when it tops out.', 'warn'); return; }
    const rec = BLD.recOf(p);
    if (!rec || !BLD.liveAt(keyOf(p, i | 0))) { toast('That factory is not standing here \u2014 travel to ' + (p.cityName || 'its city') + ' first.', 'warn'); return; }
    shopKey = keyOf(p, i | 0);
    renderShop(p, b, i | 0);
  }
  function renderShop(p, b, i) {
    const cap = CAP(), n = (b.mach || []).length;
    const card = (T, t) =>
      '<div class="mshop-card' + (n >= cap || STATE.money < T.cost ? ' dim' : '') + '">' +
      '<div class="mshop-info"><b>' + T.name + '</b><span>+$' + T.inc + '/day \u00b7 ' + T.w.toFixed(2) + ' \u00d7 ' + T.d.toFixed(2) + ' m</span></div>' +
      '<div class="mshop-buy"><span>' + fmt$(T.cost) + '</span>' +
      '<button class="btn primary" data-fi="' + t + '"' + (n >= cap ? ' disabled' : '') + '>INSTALL</button></div></div>';
    const heavy = FTYPES.map((T, k) => card(T, k)).join('');
    const classic = MACH.TYPES.map((T, k) => card(T, k + 10)).join('');
    const mine = (b.mach || []).map((m, k) => TOF(m.t) ?
      '<div class="kv"><span class="k">' + TOF(m.t).name + ' \u00b7 +$' + TOF(m.t).inc + '/day</span>' +
      '<button class="tpbtn" data-fs="' + k + '">SELL ' + fmt$(Math.round(TOF(m.t).cost * SELL_BACK)) + '</button></div>' : '').join('');
    openModal('FACTORY FLOOR \u2014 ' + (p.cityName || 'Countryside'), `
      <p>Fill this factory shell with working machines. Pick one, then <b>click the floor</b> to set it down \u2014 the shell fades to a cutaway while you place, each machine pays you every day, and sells back for ${Math.round(SELL_BACK * 100)}%.</p>
      <div class="kv"><span class="k">THE FLOOR</span><span class="v">${(2 * HW()).toFixed(1)} \u00d7 ${(2 * HD()).toFixed(1)} m clear inside the shell \u00b7 ${n}/${cap} machines installed</span></div>
      <div class="kv"><span class="k">MACHINE INCOME</span><span class="v g">+$${incomeOf(b)}/day</span></div>
      <div class="msec" style="margin-top:12px">Factory machines \u2014 heavy industry</div>
      <div id="fshop">${heavy}</div>
      <div class="msec" style="margin-top:12px">The classics \u2014 any floor takes these too</div>
      <div id="fshop2">${classic}</div>
      ${mine ? '<div class="msec" style="margin-top:12px">Installed \u2014 sell any back for ' + Math.round(SELL_BACK * 100) + '%</div>' + mine : ''}
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="fs-x" style="flex:1">CLOSE</button></div>`);
    document.querySelectorAll('#fshop [data-fi], #fshop2 [data-fi]').forEach(el => {
      el.onclick = () => {
        const t = +el.dataset.fi;
        if (n >= cap) { toast('<b>This floor is full</b> (' + cap + ' machines for ~' + Math.round(AREA()) + ' m\u00b2).', 'warn'); return; }
        if (STATE.money < TOF(t).cost) { toast('<b>Not enough money.</b> The ' + TOF(t).name + ' costs ' + fmt$(TOF(t).cost) + '.', 'warn'); return; }
        const hit = findOf(keyOf(p, i));
        if (!hit) return;
        startPlacing(hit, BLD.recOf(p), t);
      };
    });
    document.querySelectorAll('[data-fs]').forEach(el => {
      el.onclick = () => {
        const k = +el.dataset.fs;
        const m = (b.mach || [])[k];
        if (!m || !TOF(m.t)) return;
        b.mach.splice(k, 1);
        earn(Math.round(TOF(m.t).cost * SELL_BACK), false);   // resale doesn't count toward GDP
        try { saveGame(); } catch (er) { }
        ensureBuilt(keyOf(p, i));
        toast('Sold the <b>' + TOF(m.t).name + '</b> for ' + fmt$(Math.round(TOF(m.t).cost * SELL_BACK)) + '.');
        renderShop(p, b, i);
      };
    });
    const x = document.getElementById('fs-x');
    if (x) x.onclick = closeModal;
  }

  // ---- income + tick ---------------------------------------------------
  function tick(dt) {
    try {
      if (placing) {
        if (window.MACH && MACH.placing()) exitPlacing(false);          // the unit placer wins
        if (!BLD.liveAt(placing.key)) exitPlacing(false);               // demolished mid-placement
      }
      // the shop stays "open" only while OUR modal is the one showing
      if (shopKey && !(document.getElementById('fshop') && modalUp())) shopKey = null;
      const want = placing ? placing.key : shopKey;
      setCutaway(want);
      // the floor goes dark again the moment nothing wants it: dispose
      // the old list, then (re)build for the active factory
      if (want !== meshKey) {
        if (meshKey) {
          for (const e of (built.get(meshKey) || [])) { try { if (e.g.parent) e.g.parent.remove(e.g); } catch (er) { } }
          built.delete(meshKey);
        }
        meshKey = want;
      }
      if (want) ensureBuilt(want);
      if (placing) ensureGhost();               // re-parents if the shell root was recreated
      const list = want ? (built.get(want) || []) : [];
      for (const e of list) e.g.visible = true;
      // income on the office-suite beat (same rule as every machine:
      // accrues while the world is live and you are in it)
      const facs = factories();
      if (STATE.mode !== 'city' || !facs.length) acc = 0;
      else {
        acc += dt;
        if (acc >= 1) {
          const secs = acc; acc = 0;
          let inc = 0;
          for (const x of facs) inc += incomeOf(x.b);
          if (inc > 0) earn(inc / 90 * secs);
        }
      }
      // the ghost follows the cursor (plot-local frame, on the shell root)
      if (placing && lastPtr && ghost && ghostMat) {
        const pt = rayToFloor(lastPtr.x, lastPtr.y);
        if (pt) {
          const [lx, lz] = BLD.toLocal(placing.rec, pt.x, pt.z);
          ghost.visible = true;
          ghost.position.set(lx, FLOOR_Y + (TOF(placing.t).h / 2), lz);
          const v = validSpot(lx, lz, placing.t, placing.b);
          ghostMat.color.setHex(v.ok ? 0x4dff88 : 0xff5d5d);
        } else ghost.visible = false;
      } else if (ghost) ghost.visible = false;
      // blinking work lights on the visible machines (phase per machine)
      if (list.length) {
        const now = performance.now() / 900;
        for (const e of list) {
          if (!e.g.visible || !e.led) continue;
          e.led.visible = ((now + (e.x * .37 + e.z * .11)) % 1) < .55;
        }
      }
    } catch (e) { console.error('[factory]', e); }
  }
  const modalUp = () => {
    const mw = document.getElementById('modalwrap');
    return !!(mw && !mw.classList.contains('hidden'));
  };

  // ---- listeners (once) -------------------------------------------------
  try {
    canvas.addEventListener('pointermove', e => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true });
    canvas.addEventListener('pointerleave', () => { lastPtr = null; }, { passive: true });
    window.addEventListener('keydown', e => {           // capture: ESC ends placement
      if (e.key !== 'Escape' || !placing) return;
      try { e.stopPropagation(); } catch (er) { }
      exitPlacing(true);
    }, true);
  } catch (er) { }

  // ---- Empire panel rows -------------------------------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const facs = factories().filter(x => (x.b.mach || []).length);
    if (!facs.length) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    const rows = facs.map(x =>
      '<div class="kv"><span class="k">🏭 ' + (x.b.mach || []).length + ' machines \u00b7 +$' + incomeOf(x.b) + '/day</span>' +
      '<span class="v">' + (x.p.cityName || (x.p.cityKey === 'rural' ? 'Countryside' : '—')) + '</span></div>').join('');
    const html = '<div class="msec" style="margin-top:14px">Factory floor \u2014 your machines</div>' + rows +
      '<div class="kv" style="margin-top:10px"><span class="k">MACHINE WORKS</span><span class="v g">+$' +
      facs.reduce((s, x) => s + incomeOf(x.b), 0) + '/day \u00b7 ' + fmt$(valueOf()) + ' worth</span></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
  }

  return {
    tick, click, openShop, empireInto, exitPlacing, incomeOf,
    FTYPES, TOF, CAP,
    valueOf,
    // QA: programmatic install (no modal, no ghost) — same validation
    install(plotId, i, t, lx, lz) {
      const p = (STATE.plots || []).find(q => q.id === plotId);
      const b = p && (p.bld || [])[i | 0];
      const T = b && BLD.TYPES[b.t];
      if (!p || !b || !T || T.id !== 'fact') return { ok: false, why: 'not a factory' };
      if (b.p < T.days) return { ok: false, why: 'under construction' };
      if (!TOF(t)) return { ok: false, why: 'no such machine' };
      const v = validSpot(+lx, +lz, t, b);
      if (!v.ok) return { ok: false, why: v.why };
      if ((b.mach || []).length >= CAP()) return { ok: false, why: 'cap' };
      if (!spend(TOF(t).cost)) return { ok: false, why: 'funds', cost: TOF(t).cost };
      (b.mach || (b.mach = [])).push({ t: t | 0, x: +(+lx).toFixed(2), z: +(+lz).toFixed(2) });
      try { saveGame(); } catch (er) { }
      ensureBuilt(keyOf(p, i | 0));
      return { ok: true };
    },
    // QA: remove the k-th machine (pays 60%)
    removeAt(plotId, i, k) {
      const p = (STATE.plots || []).find(q => q.id === plotId);
      const b = p && (p.bld || [])[i | 0];
      const m = b && (b.mach || [])[k];
      if (!m || !TOF(m.t)) return { ok: false, why: 'no machine' };
      b.mach.splice(k, 1);
      earn(Math.round(TOF(m.t).cost * SELL_BACK), false);
      try { saveGame(); } catch (er) { }
      ensureBuilt(keyOf(p, i | 0));
      return { ok: true, got: Math.round(TOF(m.t).cost * SELL_BACK) };
    },
    // v2.61: demolishing the shell sells its machines at 60% (builder.js
    // calls this in both demolish paths before the splice)
    onDemolish(p, b) {
      const got = (b.mach || []).reduce((s, m) => s + (TOF(m.t) ? Math.round(TOF(m.t).cost * SELL_BACK) : 0), 0);
      if (got > 0) earn(got, false);
      b.mach = [];
      return { got };
    },
    placing() { return placing ? { key: placing.key, t: placing.t, cap: placing.cap } : null; },
    meshCount(key) { return (built.get(key) || []).length; },
    cutaway() { return cutKey; },
    state() {
      const facs = factories();
      return {
        factories: facs.length,
        machines: facs.reduce((s, x) => s + (x.b.mach || []).length, 0),
        incomePerDay: facs.reduce((s, x) => s + incomeOf(x.b), 0),
        value: valueOf(),
        placing: !!placing,
        accrual: +acc.toFixed(2),
      };
    },
  };
})();
window.FACT = FACT;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the click chain: a factory placement runs FIRST (before the
//    unit-machine placer, the farm claim and the walk orders) so
//    installing never walks the character or re-picks the building.
const __factClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (FACT.click(cx, cy)) return; } catch (e) { console.error('[factory]', e); }
  return __factClickPick(cx, cy);
});
// 2. the Empire panel: … → GROUND UP → FACTORY FLOOR (appends after
//    the buildings section — factory.js loads after builder.js, so
//    this wrap lands outside BLD's and the section reads in order)
const __factOrigEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __factOrigEmpire();
  try { FACT.empireInto(); } catch (e) { console.error('[factory]', e); }
};
// 3. the update chain: … → THE WORKS → GROUND UP → FACTORY FLOOR
const __factOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __factOrigUpdate(dt, px, pz, camDist);
  try { FACT.tick(dt); } catch (e) { console.error('[factory]', e); }
  return req;
};
