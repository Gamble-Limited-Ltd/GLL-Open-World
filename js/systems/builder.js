// ====================================================================
// js/systems/builder.js — ground-up construction (Stage 7c):
// materials yard, catalog, ghost placement, rising sites.
// ====================================================================
import * as THREE from 'three';
import { fmt$ } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ECO } from '../systems/eco.js';

// ======== section: 56_builder.js ========
// ====================================================================
// v2.56 — GROUND UP. The ask: "Let players build on plots they own
// using a grid placement tool. Buildings cost materials (wood, stone,
// steel, etc.) from inventory, with several building types (house,
// shop, apartment block, factory shell) and a build time. Add
// demolish and refund. Enforce plot boundaries and save buildings."
// It rides the rails every land feature already uses:
//   - THE SHED: a materials inventory (STATE.mat — Wood, Stone, Steel,
//     Glass, in tonnes) bought with cash at the yard in the BUILD
//     panel; Steel and Glass may also be PULLED 1:1 from the Ore
//     Exchange stockpile your Works pour, so a steel-hungry build pays
//     less if you refine your own.
//   - THE GRID: PLACE arms placement — a 1 m grid overlays any plot
//     you own (in the plot's own rotated frame, so buildings sit
//     square to the road), a ghost of the real footprint follows the
//     cursor — green where it fits, red where it doesn't — and a click
//     sets the site down. Enforced: plot boundaries, clearance from
//     the cart's space, 8 buildings a plot, no overlaps.
//   - THE BUILD TIME: a site rises over real game days (½ day for a
//     house, 3 for a factory shell) — even while you're away (the
//     night shift advances the sites too), scaling up out of its
//     scaffold until it tops out with a toast.
//   - THE PAYOFF: a finished building pays every game day and counts
//     in WORTH (60% while on site), lists in the Empire panel.
//   - DEMOLISH: click your building → DEMOLISH refunds 60% of its
//     materials back to the shed — the same scrap rate as the Works.
//   - THE SAVE: buildings persist per plot (bld on the plot pack),
//     materials persist (mat on the pack) — older builds ignore both.
// ====================================================================
export const BLD = (() => {
  const DAY = 90;                     // one game day, same as every beat
  const MAX_PER_PLOT = 8;              // a plot carries eight buildings
  const CLEAR = .6;                    // m of air between buildings
  const MARGIN = .2;                   // stay this far inside the stakes
  const CART_W = 2.2, CART_D = 3.2;   // the cart keeps its space mid-plot
  const MAT_KEYS = ['Wood', 'Stone', 'Steel', 'Glass'];
  const YARD = { Wood: 30, Stone: 22, Steel: 78, Glass: 52 };   // $/t — steel & glass run above par (58/38): refine your own and pull
  const TYPES = [
    { id: 'house', name: 'House',           icon: '🏠', w: 6,  d: 6,  h: 4.6, days: .5, inc: 30,  val: 1250, mat: { Wood: 30, Stone: 18 } },
    { id: 'shop',  name: 'Shop',            icon: '🏪', w: 8,  d: 7,  h: 5.2, days: 1,  inc: 46,  val: 2100, mat: { Wood: 45, Stone: 25, Glass: 12 } },
    { id: 'apts',  name: 'Apartment Block', icon: '🏢', w: 10, d: 9,  h: 16,  days: 2,  inc: 118, val: 5400, mat: { Stone: 60, Steel: 40, Glass: 24 } },
    { id: 'fact',  name: 'Factory Shell',   icon: '🏭', w: 12, d: 10, h: 7.5, days: 3,  inc: 128, val: 5800, mat: { Stone: 45, Steel: 60 } },
  ];
  let placing = null;                  // { t } — placement armed
  const live = new Map();              // plot.id + '#' + idx -> { root, body, scaffold, site, lastP }
  let acc = 0, meshT = 0;

  // ---- materials ------------------------------------------------------
  const shed = k => +((+(STATE.mat ? STATE.mat[k] : 0)) || 0);
  const stock = k => +(((STATE.res || {})[k]) || 0);
  const avail = k => shed(k) + ((k === 'Steel' || k === 'Glass') ? stock(k) : 0);
  function matReady(T) { for (const k in T.mat) if (avail(k) + 1e-9 < T.mat[k]) return false; return true; }
  function shortOf(T) { const o = {}; for (const k in T.mat) { const s = T.mat[k] - avail(k); if (s > 1e-9) o[k] = Math.round(s * 10) / 10; } return o; }
  function missCost(T) { let c = 0; for (const k in T.mat) c += Math.max(0, T.mat[k] - avail(k)) * YARD[k]; return Math.round(c); }
  // stockpile first (the Works draw pattern), then the shed
  function deduct(T) {
    for (const k in T.mat) {
      let need = T.mat[k];
      if (k === 'Steel' || k === 'Glass') {
        const have = stock(k), use = Math.min(need, have);
        if (use > .005) {
          const left = +(have - use).toFixed(2);
          if (left > .005) STATE.res[k] = left; else delete STATE.res[k];
          need = +(need - use).toFixed(2);
        }
      }
      STATE.mat[k] = Math.max(0, +((shed(k)) - need).toFixed(1));
    }
  }
  function refundOf(T) { const o = {}; for (const k in T.mat) o[k] = Math.round(T.mat[k] * .6 * 10) / 10; return o; }   // the 60% scrap rate, same as the Works (rounded to 0.1 t — floor bit the last gram via float error)

  // ---- plot + grid math ----------------------------------------------
  function recOf(p) {   // the plot record in the loaded world (city or rural)
    try {
      if (p.cityKey === 'rural') {
        const w = WORLD.plots();
        return w.find(r => r.id === p.id) || w.find(r => Math.hypot(r.x - p.x, r.z - p.z) < 15);
      }
      if (CITY.rec && CITY.rec.key === p.cityKey) {
        return CITY.plots.find(r => r.id === p.id) || CITY.plots.find(r => Math.hypot(r.x - p.x, r.z - p.z) < 15);
      }
    } catch (er) { }
    return null;
  }
  function toLocal(rec, x, z) {
    const dx = x - rec.x, dz = z - rec.z, c = Math.cos(rec.rot), s = Math.sin(rec.rot);
    return [dx * c - dz * s, dx * s + dz * c];
  }
  function toWorld(rec, lx, lz) {
    const c = Math.cos(rec.rot), s = Math.sin(rec.rot);
    return [rec.x + lx * c + lz * s, rec.z - lx * s + lz * c];
  }
  function ownedUnder(x, z) {   // {p, rec} if the ground point sits on a plot you own
    let rec = null;
    try { rec = (CITY.rec && CITY.plotAt && CITY.plotAt(x, z)) || (WORLD.plotAt && WORLD.plotAt(x, z)); } catch (er) { }
    if (!rec) return null;
    const p = STATE.plots.find(q => q.id === rec.id);
    return p ? { p, rec } : null;
  }
  function validFoot(p, rec, T, lx, lz) {
    if (Math.abs(lx) + T.w / 2 > rec.w / 2 - MARGIN || Math.abs(lz) + T.d / 2 > rec.d / 2 - MARGIN)
      return { ok: false, why: 'bounds' };
    if ((p.bld || []).length >= MAX_PER_PLOT) return { ok: false, why: 'cap' };
    if (p.cart && Math.abs(lx) < CART_W + T.w / 2 && Math.abs(lz) < CART_D + T.d / 2)
      return { ok: false, why: 'cart' };
    for (const o of (p.bld || [])) {
      const T2 = TYPES[o.t] || TYPES[0];
      if (Math.abs(o.x - lx) < (T.w + T2.w) / 2 + CLEAR && Math.abs(o.z - lz) < (T.d + T2.d) / 2 + CLEAR)
        return { ok: false, why: 'overlap' };
    }
    return { ok: true };
  }

  // ---- meshes ---------------------------------------------------------
  let M = null;
  const LM = c => new THREE.MeshLambertMaterial({ color: c });
  function mats() {
    if (M) return M;
    M = {
      wallH: LM(0xe8dfcb), roof: LM(0x8a4a3c), win: LM(0x232e38),
      wallS: LM(0xd9cfc0), awn: LM(0x3f7484), sign: LM(0xf5cc74),
      wallA: LM(0xb7afa2), wallF: LM(0x9b948a), saw: LM(0x6d7783), stack: LM(0x847e75),
      site: new THREE.MeshBasicMaterial({ color: 0xd9a25a, transparent: true, opacity: .38, depthWrite: false }),
      scaff: new THREE.LineBasicMaterial({ color: 0xf5cc74, transparent: true, opacity: .85 }),
      grid: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .38 }),
      edge: new THREE.LineBasicMaterial({ color: 0x4dff88 }),
    };
    return M;
  }
  const box = (mt, w, h, d) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mt);
  function parts(t) {   // the finished building, in the plot-local frame
    const m = mats(), g = new THREE.Group();
    if (t === 0) {                                     // 🏠 house
      const w = box(m.wallH, 5.4, 3, 5.4); w.position.y = 1.5; g.add(w);
      const r1 = box(m.roof, 6.4, .24, 3.6); r1.position.set(0, 3.62, -1.42); r1.rotation.x = -.46; g.add(r1);
      const r2 = box(m.roof, 6.4, .24, 3.6); r2.position.set(0, 3.62, 1.42); r2.rotation.x = .46; g.add(r2);
      const dr = box(m.win, .95, 2, .14); dr.position.set(0, 1, 2.72); g.add(dr);
      const w1 = box(m.win, 1.3, 1.1, .14); w1.position.set(-1.8, 1.9, 2.72); g.add(w1);
      const w2 = box(m.win, 1.3, 1.1, .14); w2.position.set(1.8, 1.9, 2.72); g.add(w2);
    } else if (t === 1) {                              // 🏪 shop
      const b = box(m.wallS, 7.6, 3.4, 6.6); b.position.y = 1.7; g.add(b);
      const top = box(m.wallS, 7.9, .34, 6.9); top.position.y = 3.57; g.add(top);
      const aw = box(m.awn, 8.3, .18, 1.9); aw.position.set(0, 3.05, 3.35); aw.rotation.x = -.3; g.add(aw);
      const sg = box(m.sign, 3.4, .8, .18); sg.position.set(0, 4.35, 3.32); g.add(sg);
      const gf = box(m.win, 6.6, 2.1, .16); gf.position.set(0, 1.15, 3.32); g.add(gf);
    } else if (t === 2) {                              // 🏢 apartment block
      const b = box(m.wallA, 9.6, 15, 8.6); b.position.y = 7.5; g.add(b);
      for (let i = 0; i < 4; i++) {
        const s1 = box(m.win, 9.7, 1.15, .12); s1.position.set(0, 3.1 + i * 3.1, 4.36); g.add(s1);
        const s2 = box(m.win, 9.7, 1.15, .12); s2.position.set(0, 3.1 + i * 3.1, -4.36); g.add(s2);
      }
      const top = box(m.wallA, 9.9, .4, 8.9); top.position.y = 15.2; g.add(top);
      const pent = box(m.wallA, 3.4, 1.6, 3); pent.position.set(-2.6, 16.2, -2.4); g.add(pent);
    } else {                                           // 🏭 factory shell
      const b = box(m.wallF, 11.6, 6, 9.6); b.position.y = 3; g.add(b);
      for (let i = 0; i < 3; i++) {
        const s = box(m.saw, 3.4, .26, 9.8); s.position.set(-3.8 + i * 3.8, 6.55, 0); s.rotation.x = .42; g.add(s);
      }
      const st = new THREE.Mesh(new THREE.CylinderGeometry(.55, .62, 3.4, 10), m.stack);
      st.position.set(3.6, 8, -2.2); g.add(st);
      const gate = box(m.win, 5.2, 3.4, .16); gate.position.set(0, 1.7, 4.82); g.add(gate);
    }
    return g;
  }
  function makeLive(t, prog) {   // root + scaffold + rising body
    const T = TYPES[t];
    const root = new THREE.Group();
    const site = new THREE.Mesh(new THREE.PlaneGeometry(T.w, T.d), mats().site);
    site.rotation.x = -Math.PI / 2; site.position.y = .06; root.add(site);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(T.w - .5, T.h, T.d - .5)), mats().scaff);
    edges.position.y = T.h / 2; root.add(edges);
    const body = parts(t); root.add(body);
    const r = { root, site, scaffold: edges, body, lastP: -1 };
    refresh(r, t, prog);
    return r;
  }
  function refresh(r, t, prog) {   // the body rises out of the ground as the site builds
    const T = TYPES[t], fin = Math.max(0, Math.min(1, prog / T.days));
    if (r.lastP >= 0 && Math.abs(fin - r.lastP) < .02) return;
    r.lastP = fin;
    r.body.scale.y = .18 + .82 * fin;
    const done = fin >= 1;
    r.scaffold.visible = !done;
    r.site.visible = !done;
  }

  // ---- the runtime registry (spawn / keep alive) -----------------------
  const grpFor = rec => (rec && rec.rural) ? WORLD.group : ((CITY.rec && CITY.group) || WORLD.group);
  function ensureRegion() {
    for (const p of STATE.plots) {
      if (!(p.bld || []).length) continue;
      const rec = recOf(p); if (!rec) continue;
      (p.bld || []).forEach((b, i) => {
        const key = p.id + '#' + i;
        let r = live.get(key);
        if (r && r.root && r.root.parent === grpFor(rec)) { refresh(r, b.t, b.p); return; }
        if (r && r.root && r.root.parent) { try { r.root.parent.remove(r.root); } catch (er) { } live.delete(key); r = null; }
        if (!r) {
          r = makeLive(b.t, b.p);
          r.root.position.set(rec.x, 0, rec.z);
          r.root.rotation.y = rec.rot;
          const g = grpFor(rec);
          if (g) { g.add(r.root); live.set(key, r); }
        }
      });
    }
    // sweep keys whose plot lost its buildings (demolished)
    for (const [key, r] of live) {
      const pid = key.slice(0, key.lastIndexOf('#')), idxS = key.slice(key.lastIndexOf('#') + 1);
      const p = STATE.plots.find(q => q.id === pid);
      const b = p && p.bld && p.bld[+idxS];
      if (!b) { try { r.root.parent && r.root.parent.remove(r.root); } catch (er) { } live.delete(key); }
    }
  }
  const list = () => { const o = []; for (const p of STATE.plots) (p.bld || []).forEach((b, i) => o.push({ p, b, i })); return o; };
  function valueOf() {
    let v = 0;
    for (const x of list()) v += TYPES[x.b.t].val * (x.b.p >= TYPES[x.b.t].days ? 1 : .6);
    return Math.round(v);
  }
  function income() { let d = 0; for (const x of list()) if (x.b.p >= TYPES[x.b.t].days) d += TYPES[x.b.t].inc; return d; }

  // ---- placement ghost + grid -------------------------------------------
  let ghostG = null, ghost = null, ghostEdge = null, grids = new Map();
  function killGhost() {
    if (ghostG && ghostG.parent) ghostG.parent.remove(ghostG);
    ghostG = ghost = ghostEdge = null;
    for (const [, g] of grids) { if (g.parent) g.parent.remove(g); }
    grids = new Map();
  }
  function gridFor(rec) {
    let g = grids.get(rec.id);
    if (g && g.parent) return g;
    const m = mats(), pts = [], W = rec.w, D = rec.d;
    for (let x = Math.ceil(-W / 2); x <= W / 2; x++) pts.push(x, .07, -D / 2, x, .07, D / 2);
    for (let z = Math.ceil(-D / 2); z <= D / 2; z++) pts.push(-W / 2, .07, z, W / 2, .07, z);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g = new THREE.LineSegments(gg, m.grid);
    g.position.set(rec.x, 0, rec.z); g.rotation.y = rec.rot;
    const host = grpFor(rec); if (host) host.add(g);
    grids.set(rec.id, g);
    return g;
  }
  function moveGhost(x, z) {
    if (!placing) return null;
    const hit = ownedUnder(x, z);
    if (!hit) {
      if (ghostG) ghostG.visible = false;
      for (const [, g] of grids) g.visible = false;
      return { off: true };
    }
    const { p, rec } = hit, T = TYPES[placing.t];
    gridFor(rec).visible = true;
    for (const [k, g] of grids) if (k !== rec.id) g.visible = false;
    const [rx, rz] = toLocal(rec, x, z);
    const lx = Math.round(rx), lz = Math.round(rz);
    const v = validFoot(p, rec, T, lx, lz);
    if (!ghostG) {
      ghostG = new THREE.Group();
      ghost = new THREE.Mesh(new THREE.BoxGeometry(T.w, T.h, T.d), new THREE.MeshBasicMaterial({ transparent: true, opacity: .3, depthWrite: false }));
      ghostEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(T.w, T.h, T.d)), mats().edge);
      ghost.renderOrder = ghostEdge.renderOrder = 4;
      ghostG.add(ghost); ghostG.add(ghostEdge);
      const host = grpFor(rec); if (!host) return { off: true };
      host.add(ghostG);
    }
    ghostG.visible = true;
    ghostG.position.set(rec.x, 0, rec.z);
    ghostG.rotation.y = rec.rot;
    ghost.position.set(lx, T.h / 2, lz);
    ghostEdge.position.set(lx, T.h / 2, lz);
    const col = (v.ok && matReady(T)) ? 0x4dff88 : 0xff5470;
    ghost.material.color.setHex(col);
    ghostEdge.material.color.setHex(col);
    return { hit, lx, lz, v };
  }
  // the placement bar rides the same #mn-bar surface the mine uses
  let cssIn = false;
  function bar(msg, btnLabel, onBtn) {
    try {
      let b = document.getElementById('mn-bar');
      if (!b) {
        if (!cssIn) {
          const st = document.createElement('style');
          st.textContent = '#mn-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px;max-width:92vw;padding:8px 14px;border-radius:10px;background:rgba(13,17,23,.94);border:1px solid rgba(245,204,116,.4);font-size:12px;color:#E2E8F0;box-shadow:0 6px 24px rgba(0,0,0,.5)}#mn-bar.hidden{display:none}#mn-bar b{color:#f5cc74}#mn-bar .mn-x{flex:none;padding:5px 12px;border-radius:7px;background:rgba(245,204,116,.16);color:#f5cc74;font-weight:700;cursor:pointer}#mn-bar .mn-x:hover{background:rgba(245,204,116,.3)}';
          document.head.appendChild(st); cssIn = true;
        }
        b = document.createElement('div'); b.id = 'mn-bar'; document.body.appendChild(b);
      }
      b.innerHTML = '<span>' + msg + '</span>' + (btnLabel ? '<span class="mn-x" id="bd-bx">' + btnLabel + '</span>' : '');
      b.classList.remove('hidden');
      const bx = b.querySelector('#bd-bx'); if (bx) bx.onclick = onBtn;
    } catch (er) { }
  }
  function hideBar() { const b = document.getElementById('mn-bar'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; } }
  function armPlace(t) {
    if (STATE.mode !== 'city' || !WORLD.group) { toast('Enter the world first — buildings need ground under your boots.'); return; }
    try { closeModal(); } catch (er) { }
    placing = { t };
    const T = TYPES[t];
    bar('PLACING <b>' + T.name.toUpperCase() + '</b> · materials from your shed · <span style="color:var(--mut)">' + fmt$(STATE.money) + '</span>', 'DONE', () => exitPlacing(true));
    toast('Click a green cell on <b>a plot you own</b> to set the ' + T.name + ' down. ESC or DONE to finish.', 'warn');
  }
  function exitPlacing(reopen) {
    const was = placing ? TYPES[placing.t] : null;
    placing = null; killGhost(); hideBar();
    if (reopen && was) try { open(); } catch (er) { }
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Esc') { if (placing) { try { exitPlacing(true); } catch (er) { } } } });

  // ---- the commit (mouse path + QA path, same validation) -------------
  function commit(p, rec, t, lx, lz) {
    const T = TYPES[t];
    const v = validFoot(p, rec, T, lx, lz);
    if (!v.ok) return { ok: false, why: v.why };
    if (!matReady(T)) return { ok: false, why: 'mat' };
    deduct(T);
    (p.bld || (p.bld = [])).push({ t: t | 0, x: Math.round(lx * 10) / 10, z: Math.round(lz * 10) / 10, p: 0 });
    try { saveGame(); } catch (er) { }
    ensureRegion();
    return { ok: true };
  }
  function placeAttempt(x, z) {
    if (!placing) return;
    const T = TYPES[placing.t];
    const hit = ownedUnder(x, z);
    if (!hit) { toast('<b>Stand over a plot you own.</b> Buildings rise on your own land — roadside plots (15×20 m) carry them; sidewalk spots are cart-sized.', 'warn'); return; }
    const { p, rec } = hit;
    const [rx, rz] = toLocal(rec, x, z);
    const lx = Math.round(rx), lz = Math.round(rz);
    const r = commit(p, rec, placing.t, lx, lz);
    if (!r.ok) {
      toast(r.why === 'bounds' ? '<b>Outside the stakes.</b> Keep the whole footprint inside your plot.'
        : r.why === 'overlap' ? '<b>Too close to another building.</b> Give them ' + CLEAR + ' m of air.'
        : r.why === 'cart' ? '<b>That\u2019s the cart\u2019s space.</b> Build around where it parks.'
        : r.why === 'cap' ? '<b>This plot is full</b> (' + MAX_PER_PLOT + ' buildings). Demolish one, or buy another plot.'
        : '<b>Short on materials.</b> Buy the shortfall at the yard first (BUILD panel).', 'warn');
      return;
    }
    const n = (p.bld || []).length;
    toast(T.icon + ' <b>' + T.name + ' sited.</b> The crew raises it over ' + (T.days === .5 ? 'half a' : T.days) + ' game day' + (T.days > 1 ? 's' : '') + ' — ' + n + '/' + MAX_PER_PLOT + ' on this plot.');
    bar('PLACING <b>' + T.name.toUpperCase() + '</b> — ' + n + '/' + MAX_PER_PLOT + ' on this plot · <span style="color:var(--mut)">' + fmt$(STATE.money) + '</span>', 'DONE', () => exitPlacing(true));
    if (n >= MAX_PER_PLOT) exitPlacing(true);
  }

  // ---- click / tip on standing buildings -------------------------------
  function buildingAt(x, z) {
    for (const [key, r] of live) {
      if (!r.root || !r.root.parent) continue;
      const pid = key.slice(0, key.lastIndexOf('#')), idxS = key.slice(key.lastIndexOf('#') + 1);
      const p = STATE.plots.find(q => q.id === pid);
      const b = p && p.bld && p.bld[+idxS];
      if (!b) continue;
      const rec = recOf(p); if (!rec) continue;
      const T = TYPES[b.t];
      const [lx, lz] = toLocal(rec, x, z);
      if (Math.abs(lx - b.x) <= T.w / 2 + .25 && Math.abs(lz - b.z) <= T.d / 2 + .25)
        return { p, b, rec, T, i: +idxS };
    }
    return null;
  }
  function tip(x, z) {
    if (STATE.mode !== 'city' || !WORLD.group) return null;
    if (placing) {
      const g = moveGhost(x, z);
      const T = TYPES[placing.t];
      if (!g || g.off) return { t: T.icon + ' ' + T.name + ' — placement', s: 'Ghost hidden — hover a plot you own', p: '', a: '', l: 'Click your plot to place · ESC to finish' };
      const why = !g.v.ok ? (g.v.why === 'bounds' ? 'outside the stakes' : g.v.why === 'overlap' ? 'too close to another building' : g.v.why === 'cart' ? 'the cart\u2019s space' : 'plot full')
        : (!matReady(T) ? 'short on materials' : '');
      return {
        t: T.icon + ' ' + T.name + ' — ' + (why ? 'invalid here' : 'green — click to site'),
        s: T.w + '×' + T.d + ' m · ' + (T.days === .5 ? '½ day' : T.days + ' days') + ' · pays ' + fmt$(T.inc) + '/day',
        p: '', a: why ? '✗ ' + why : '✓ fits', l: why ? 'Move over your plot' : 'Click to set it down',
      };
    }
    const hit = buildingAt(x, z);
    if (hit) {
      const fin = hit.b.p >= hit.T.days;
      return {
        t: hit.T.icon + ' ' + hit.T.name + ' — Ground Up',
        s: fin ? 'Finished · pays ' + fmt$(hit.T.inc) + ' every game day'
          : 'Under construction · ' + Math.round(100 * hit.b.p / hit.T.days) + '% · ' + Math.max(.5, Math.round((hit.T.days - hit.b.p) * 2) / 2) + ' day left',
        p: fin ? '+' + fmt$(hit.T.inc) + '/day' : '',
        a: fin ? '✓ Yours' : '🔨 On site',
        l: 'Click to manage',
      };
    }
    return null;
  }
  function openBuilding(hit) {
    const T = hit.T, fin = hit.b.p >= T.days;
    const needList = Object.entries(T.mat).map(([k, n]) => k + ' ' + n + ' t').join(' · ');
    const rf = refundOf(T), rfList = Object.entries(rf).filter(([, n]) => n > 0).map(([k, n]) => k + ' ' + n + ' t').join(' · ');
    openModal(T.icon + ' ' + T.name + ' — Ground Up', `
      <p>${fin ? 'A finished <b>' + T.name.toLowerCase() + '</b> standing on your plot — it pays every game day.'
        : 'The crew is raising this <b>' + T.name.toLowerCase() + '</b> — it scales up out of its scaffold as the game days pass.'}</p>
      <div class="kv"><span class="k">STATUS</span><span class="v">${fin ? '✓ Finished · ' + fmt$(T.inc) + '/day' : '🔨 ' + Math.round(100 * hit.b.p / T.days) + '% built · ' + Math.max(.5, Math.round((T.days - hit.b.p) * 2) / 2) + ' day' + (T.days - hit.b.p > 1.5 ? 's' : '') + ' left'}</span></div>
      <div class="kv"><span class="k">FOOTPRINT</span><span class="v">${T.w}×${T.d} m · ${T.h} m tall · ${fmt$(T.val)} worth</span></div>
      <div class="kv"><span class="k">MATERIALS</span><span class="v">${needList}</span></div>
      <div class="kv"><span class="k">DEMOLISH</span><span class="v">Refunds ${rfList} back to your shed (the 60% scrap rate)</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn" id="bd-dem" style="flex:1;color:#ff5470">DEMOLISH — REFUND 60%</button>
        <button class="btn" id="bd-x">CLOSE</button>
      </div>`);
    document.getElementById('bd-x').onclick = closeModal;
    document.getElementById('bd-dem').onclick = () => {
      for (const k in rf) if (rf[k] > 0) STATE.mat[k] = Math.min(1e6, +((shed(k)) + rf[k]).toFixed(1));
      hit.p.bld.splice(hit.i, 1);
      try { saveGame(); } catch (er) { }
      ensureRegion();
      closeModal();
      toast(T.icon + ' <b>' + T.name + ' demolished.</b> ' + rfList + ' back in the shed.');
    };
  }
  function click(x, z) {
    if (STATE.mode !== 'city') return false;
    if (placing) { placeAttempt(x, z); return true; }
    const hit = buildingAt(x, z);
    if (hit) { openBuilding(hit); return true; }
    return false;
  }

  // ---- the BUILD panel + materials yard --------------------------------
  function open() {
    if (STATE.mode !== 'city') { toast('Enter the world first — buildings need ground under your boots.'); return; }
    const rural = STATE.plots.filter(p => p.cityKey === 'rural').length;
    const cityP = STATE.plots.filter(p => p.cityKey !== 'rural').length;
    const yard = MAT_KEYS.map(k => {
      const st = (k === 'Steel' || k === 'Glass') ? stock(k) : 0;
      return `<div class="kv"><span class="k">${k.toUpperCase()} — ${Math.round(shed(k) * 10) / 10} t${st > .005 ? ' <span style="color:var(--mut)">(+' + (Math.round(st * 10) / 10) + ' t on the exchange)</span>' : ''}</span>
        <span class="v">$${YARD[k]}/t</span>
        <button class="tpbtn" data-my="${k}">BUY 10 t — $${YARD[k] * 10}</button>
        ${st > .005 ? '<button class="tpbtn" data-pu="' + k + '">PULL ' + (Math.round(st * 10) / 10) + ' t</button>' : ''}</div>`;
    }).join('');
    const cards = TYPES.map((T, i) => {
      const need = Object.entries(T.mat).map(([k, n]) => {
        const a = avail(k), sh = Math.max(0, n - a);
        return k + ' ' + n + ' t' + (sh > 1e-9 ? ' <b style="color:#f5cc74">short ' + (Math.round(sh * 10) / 10) + '</b>' : ' <b style="color:#48BB78">✓</b>');
      }).join(' · ');
      const miss = missCost(T);
      return `
      <div class="kv"><span class="k">${T.icon} ${T.name.toUpperCase()}</span><span class="v">${T.w}×${T.d} m · ${T.days === .5 ? '½ day' : T.days + ' days'} to build · pays ${fmt$(T.inc)}/day · ${fmt$(T.val)} worth</span></div>
      <div class="kv"><span class="k">MATERIALS</span><span class="v">${need}</span>${miss > 0 ? '<button class="tpbtn" data-bm="' + i + '">BUY MISSING — ' + fmt$(miss) + '</button>' : ''}<button class="tpbtn" data-bp="${i}">PLACE ▸</button></div>`;
    }).join('');
    openModal('Ground Up — Build on Your Land', `
      <p>Pick a building, stock the materials, then <b>PLACE</b> — a grid overlays your plot, a ghost follows the cursor, and a click sites it. Buildings take real game days to rise, pay every day, and demolish back to 60% of their materials.</p>
      <div class="kv"><span class="k">YOUR LAND</span><span class="v">${rural} roadside plot${rural === 1 ? '' : 's'} (15×20 m — they carry buildings)${cityP ? ' · ' + cityP + ' city spot' + (cityP === 1 ? '' : 's') + ' (cart-sized)' : ''}</span></div>
      <div class="msec" style="margin-top:14px">The materials yard — ${fmt$(STATE.money)}</div>
      ${yard}
      <div class="msec" style="margin-top:14px">The catalog</div>
      ${cards}
      <div class="kv" style="margin-top:8px"><span class="k">STEEL &amp; GLASS</span><span class="v">Run the Works and PULL your own for less — yard prices sit above exchange par ($58 steel, $38 glass)</span></div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="bg-x" style="flex:1">CLOSE</button></div>`);
    document.getElementById('bg-x').onclick = closeModal;
    document.querySelectorAll('[data-my]').forEach(b => b.onclick = () => {
      const k = b.dataset.my, cost = YARD[k] * 10;
      if (!spend(cost)) { toast('<b>Not enough money.</b> Ten tonnes of ' + k.toLowerCase() + ' runs ' + fmt$(cost) + '.', 'warn'); return; }
      STATE.mat[k] = Math.min(1e6, +((shed(k)) + 10).toFixed(1));
      try { saveGame(); } catch (er) { }
      toast('🪵 <b>' + k + ' × 10 t</b> delivered to the shed.');
      open();
    });
    document.querySelectorAll('[data-pu]').forEach(b => b.onclick = () => {
      const k = b.dataset.pu, have = stock(k);
      if (have < .005) { open(); return; }
      delete STATE.res[k];
      STATE.mat[k] = Math.min(1e6, +((shed(k)) + have).toFixed(1));
      try { saveGame(); } catch (er) { }
      toast('↩ <b>' + (Math.round(have * 10) / 10) + ' t of ' + k + '</b> pulled from the exchange into the shed — it no longer sells on the market.');
      open();
    });
    document.querySelectorAll('[data-bm]').forEach(b => b.onclick = () => {
      const T = TYPES[+b.dataset.bm], sh = shortOf(T);
      let cost = 0; for (const k in sh) cost += sh[k] * YARD[k];
      cost = Math.round(cost);
      if (cost <= 0) { open(); return; }
      if (!spend(cost)) { toast('<b>Not enough money.</b> The shortfall runs ' + fmt$(cost) + ' at the yard.', 'warn'); return; }
      for (const k in sh) STATE.mat[k] = Math.min(1e6, +((shed(k)) + sh[k]).toFixed(1));
      try { saveGame(); } catch (er) { }
      toast('🧱 <b>Materials bought</b> — the ' + T.name + ' is ready to place.');
      open();
    });
    document.querySelectorAll('[data-bp]').forEach(b => b.onclick = () => armPlace(+b.dataset.bp));
  }

  // ---- the beat: rise, pay, stay alive ----------------------------------
  function tick(dt) {
    if (STATE.mode !== 'city' || !WORLD.group || !dt) return;
    dt = Math.min(dt, 2);
    let topped = 0;
    for (const p of STATE.plots) for (const b of (p.bld || [])) {
      const T = TYPES[b.t];
      if (b.p < T.days) {
        b.p = +(b.p + dt / DAY).toFixed(4);
        if (b.p >= T.days) {
          b.p = T.days; topped++;
          try { toast(T.icon + ' <b>' + T.name + ' topped out</b> — it pays ' + fmt$(T.inc) + ' every game day.'); } catch (er) { }
        }
      }
    }
    if (topped) try { saveGame(); } catch (er) { }
    acc += dt;
    if (acc >= 1) {
      const secs = Math.min(acc, 30); acc = 0;
      let d = 0;
      for (const p of STATE.plots) for (const b of (p.bld || [])) if (b.p >= TYPES[b.t].days) d += TYPES[b.t].inc / DAY * secs;
      if (d > 0) earn(d);
    }
    meshT += dt;
    if (meshT > .25) { meshT = 0; ensureRegion(); }
  }
  // NIGHT SHIFT hook: the sites rise while you sleep (whole days, no wages)
  function advance(days) {
    let d = 0, done = 0;
    for (const p of STATE.plots) for (const b of (p.bld || [])) {
      const T = TYPES[b.t];
      if (b.p < T.days) { b.p = Math.min(T.days, +(b.p + days).toFixed(4)); d += days; if (b.p >= T.days) done++; }
    }
    if (d > 0) try { saveGame(); } catch (er) { }
    return { days: Math.round(d), done };
  }
  function qaDay(n) { const r = advance(n || 1); ensureRegion(); return r; }   // QA: run build-days instantly

  // ---- Empire panel rows -------------------------------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    const all = list(), standing = all.filter(x => x.b.p >= TYPES[x.b.t].days);
    const rows = all.map(x => {
      const T = TYPES[x.b.t], fin = x.b.p >= T.days;
      return '<div class="kv"><span class="k">' + T.icon + ' ' + T.name + ' · ' + T.w + '×' + T.d + ' m · ' +
        (fin ? fmt$(T.inc) + '/day' : Math.round(100 * x.b.p / T.days) + '% built') + '</span>' +
        '<span class="v">' + (x.p.cityName || (x.p.cityKey === 'rural' ? 'Countryside' : '—')) + '</span></div>';
    }).join('');
    const html = '<div class="msec" style="margin-top:14px">Ground up — your buildings</div>' +
      (rows || '<p>No buildings yet. Press BUILD, stock materials at the yard and place a house, shop, apartment block or factory shell on a roadside plot you own.</p>') +
      (all.length ? '<div class="kv" style="margin-top:10px"><span class="k">CONSTRUCTION</span><span class="v g">' + income() + '/day · ' + standing.length + ' standing' + (all.length > standing.length ? ' · ' + (all.length - standing.length) + ' on site' : '') + ' · ' + fmt$(valueOf()) + ' worth</span></div>' : '') +
      '<div class="kv"><span class="k">MATERIALS SHED — ' + MAT_KEYS.map(k => Math.round(shed(k) * 10) / 10 + ' t ' + k.toLowerCase()).join(' · ') + '</span><button class="tpbtn" id="em-bld">YARD</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    const yb = document.getElementById('em-bld');
    if (yb) yb.onclick = () => { try { open(); } catch (er) { } };
  }

  return {
    open, tip, click, tick, empireInto, advance, qaDay,
    valueOf, income, list, shed, stock,
    place(plotId, t, lx, lz) {   // QA: programmatic placement (same validation, same commit)
      const p = STATE.plots.find(q => q.id === plotId);
      if (!p) return { ok: false, why: 'no plot' };
      const rec = recOf(p);
      if (!rec) return { ok: false, why: 'no rec (travel there first)' };
      return commit(p, rec, t | 0, +lx, +lz);
    },
    demolish(plotId, i) {        // QA: programmatic demolish
      const p = STATE.plots.find(q => q.id === plotId);
      const b = p && p.bld && p.bld[i | 0];
      if (!b) return { ok: false };
      const T = TYPES[b.t], rf = refundOf(T);
      for (const k in rf) if (rf[k] > 0) STATE.mat[k] = Math.min(1e6, +((shed(k)) + rf[k]).toFixed(1));
      p.bld.splice(i | 0, 1);
      try { saveGame(); } catch (er) { }
      ensureRegion();
      return { ok: true, refund: rf };
    },
    arming: () => !!placing, TYPES, YARD, MAX_PER_PLOT,
  };
})();
window.BLD = BLD;

// integration — same wrap pattern as 51_mining/54_works: every call
// try/caught so a builder error can never touch the world.
// 1. clicks: placement + standing buildings come BEFORE the plot flow
//    (buildings stand ON plots you own, so they must win the hit test)
const __bldPrevClickAt = ECO.clickAt.bind(ECO);
ECO.clickAt = function (x, z) {
  try { if (BLD.click(x, z)) return true; } catch (e) { console.error('[bld]', e); }
  return __bldPrevClickAt(x, z);
};
// 2. hover: the ghost rides the tip (and buildings tip before the plot)
const __bldPrevHover = ECO.hoverInfo.bind(ECO);
ECO.hoverInfo = function (x, z) {
  try { const t = BLD.tip(x, z); if (t) return t; } catch (e) { }
  return __bldPrevHover(x, z);
};
// 3. the Empire panel: your buildings, one tap to the yard
const __bldPrevEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __bldPrevEmpire();
  try { BLD.empireInto(); } catch (e) { console.error('[bld]', e); }
};
// 4. the update chain: … → THE WORKS → GROUND UP
const __bldOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __bldOrigUpdate(dt, px, pz, camDist);
  try { BLD.tick(dt); } catch (e) { console.error('[bld]', e); }
  return req;
};

