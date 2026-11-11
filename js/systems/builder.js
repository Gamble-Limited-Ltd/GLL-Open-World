// ====================================================================
// js/systems/builder.js — ground-up construction (Stage 7c):
// materials yard, catalog, ghost placement, rising sites.
// v2.67 THE ARCHITECT: DESIGN YOUR OWN — the studio (footprint, floors,
// style, a name of your own) writes a design into STATE.designs and the
// catalog carries it beside the classics; buildings placed from a design
// save t >= 100 (index + 100). City lots (15×20 m, city.js) and roadside
// plots both carry buildings; sidewalk spots stay cart-sized.
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

  // ---- v2.67 THE ARCHITECT: your own designs --------------------------
  // The ask: "Allow people to build their own unique buildings." The studio
  // composes one: footprint (6–14 × 6–12 m), floors (1–12), one of four
  // styles, a NAME — materials, cost, build days, income and worth all
  // derive from the same per-m²-per-floor rates the classics pay, so a
  // big landmark tower is a big landmark project. Designs save with the
  // world (STATE.designs ← pack dsg); a placed building records
  // t = 100 + designIndex, and T(t) below resolves either kind.
  const STYLES = [
    { id: 'brick',  name: 'Brick Walk-up', icon: '🧱', wall: 0xb0685a, band: 0x2e2a28, roofC: 0x5a4a4e, pitched: false, mat: (a, f) => ({ Stone: +(a * f * .13).toFixed(1), Wood: +(a * f * .02).toFixed(1) }) },
    { id: 'glass',  name: 'Glass Tower',   icon: '🏙️', wall: 0x7fa8c4, band: 0x31445c, roofC: 0x5a6472, pitched: false, mat: (a, f) => ({ Glass: +(a * f * .08).toFixed(1), Steel: +(a * f * .04).toFixed(1) }) },
    { id: 'modern', name: 'Modern Block',  icon: '🏢', wall: 0xb7b0a6, band: 0x37414d, roofC: 0x4c5258, pitched: false, mat: (a, f) => ({ Stone: +(a * f * .08).toFixed(1), Steel: +(a * f * .04).toFixed(1), Glass: +(a * f * .03).toFixed(1) }) },
    { id: 'timber', name: 'Timber Lodge',  icon: '🏡', wall: 0xa8845c, band: 0x2e2a28, roofC: 0x8a4a3c, pitched: true,  mat: (a, f) => ({ Wood: +(a * f * .10).toFixed(1), Stone: +(a * f * .03).toFixed(1) }) },
  ];
  const YARD_COST = o => Object.entries(o).reduce((s, [k, n]) => s + n * YARD[k], 0);
  function designOf(w, d, floors, styleId, name) {
    const st = STYLES.find(s => s.id === styleId) || STYLES[0];
    const area = w * d, f = Math.max(1, floors | 0);
    const mat = st.mat(area, f);
    for (const k in mat) if (!mat[k]) delete mat[k];   // a zero tonne line reads as noise
    const cost = Math.round(YARD_COST(mat));
    const h = +(f * 3.2).toFixed(1);
    const days = +Math.max(.5, (area / 80 + f * .28)).toFixed(1);
    return {
      id: 'dsg', name: (name || '').trim().slice(0, 24) || 'Your Building', icon: st.icon,
      w, d: +d, h, floors: f, style: st.id, mat,
      days, inc: Math.max(8, Math.round(cost / 46)), val: Math.round(cost * .95),
    };
  }
  // t < 100 → the classic catalog; t >= 100 → design (t - 100). A design
  // deleted while nothing stands from it keeps saves honest (the studio
  // refuses the delete while one does); a stale index still degrades to
  // the House, never a crash.
  function ensureDesigns() {   // raw packs from save.js → full specs, once per session
    const ds = STATE.designs || (STATE.designs = []);
    for (let i = 0; i < ds.length; i++) {
      if (ds[i] && ds[i].name === undefined && ds[i].n !== undefined)
        ds[i] = designOf(ds[i].w, ds[i].d, ds[i].f, ds[i].s, ds[i].n);
    }
  }
  function T(t) {
    if (t >= 100) { ensureDesigns(); const x = ((STATE.designs || [])[t - 100]); if (x) return x; }
    return TYPES[t] || TYPES[0];
  }
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
      const T2 = T(o.t);
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
  // v2.67 THE ARCHITECT: the custom mesh — one body, per-floor window
  // bands, a roof by style, and a wedding-cake setback on towers of 8+
  // floors (the same silhouette move the city's own skyline makes).
  function partsC(D) {
    const st = STYLES.find(s => s.id === D.style) || STYLES[0];
    if (!st._m) st._m = { wall: LM(st.wall), band: LM(st.band), roof: LM(st.roofC) };   // one material set per style
    const wall = st._m.wall, band = st._m.band, roof = st._m.roof;
    const g = new THREE.Group();
    const w = D.w - .4, d = D.d - .4, fh = 3.2, fl = D.floors;
    const tiered = fl >= 8;
    const bodyH = tiered ? fh * fl * .68 : fh * fl;
    const b = box(wall, w, bodyH, d); b.position.y = bodyH / 2; g.add(b);
    // window bands — front + back every floor, sides every other floor
    const yAt = f => fh * (f + .5);
    for (let f = 0; f < (tiered ? Math.floor(fl * .68) : fl); f++) {
      const y = yAt(f);
      if (y + 1.1 > bodyH) break;
      const wb = box(band, w * .74, 1.05, .12); wb.position.set(0, y, d / 2 + .05); g.add(wb);
      const wb2 = box(band, w * .74, 1.05, .12); wb2.position.set(0, y, -d / 2 - .05); g.add(wb2);
      if (f % 2 === 0) {
        const sb = box(band, .12, 1.05, d * .74); sb.position.set(w / 2 + .05, y, 0); g.add(sb);
        const sb2 = box(band, .12, 1.05, d * .74); sb2.position.set(-w / 2 - .05, y, 0); g.add(sb2);
      }
    }
    if (tiered) {                                   // the setback crown
      const p2w = w * .68, p2d = d * .68, p2H = fh * fl - bodyH;
      const p2 = box(wall, p2w, p2H, p2d); p2.position.y = bodyH + p2H / 2; g.add(p2);
      for (let f = Math.floor(fl * .68); f < fl; f++) {
        const y = bodyH + (f - Math.floor(fl * .68)) * fh + fh * .5;
        if (y + 1.1 > bodyH + p2H) break;
        const wb = box(band, p2w * .7, 1.05, .12); wb.position.set(0, y, p2d / 2 + .05); g.add(wb);
        const wb2 = box(band, p2w * .7, 1.05, .12); wb2.position.set(0, y, -p2d / 2 - .05); g.add(wb2);
      }
      const cap = box(roof, p2w + .5, .35, p2d + .5); cap.position.y = bodyH + p2H + .17; g.add(cap);
    } else if (st.pitched) {                        // the lodge — warm pitched roof
      const rw = w + 1.2, rd = d / 2 + .8;
      const r1 = box(roof, rw, .3, Math.hypot(rd, 1.6)); r1.position.set(0, fh * fl + .75, -rd / 2); r1.rotation.x = -.5; g.add(r1);
      const r2 = box(roof, rw, .3, Math.hypot(rd, 1.6)); r2.position.set(0, fh * fl + .75, rd / 2); r2.rotation.x = .5; g.add(r2);
    } else {                                        // flat roof + parapet lip
      const cap = box(roof, w + .5, .35, d + .5); cap.position.y = fh * fl + .17; g.add(cap);
      const lip = box(band, w + .62, .55, d + .62); lip.position.y = fh * fl - .1; g.add(lip);
      if (fl >= 4) {                                 // a roof-access bulkhead on the bigger ones
        const bh = box(wall, Math.min(2.6, w * .3), 1.7, Math.min(2.2, d * .3));
        bh.position.set(w * .22, fh * fl + 1.2, -d * .22); g.add(bh);
      }
    }
    return g;
  }
  function parts(t) {   // the finished building, in the plot-local frame
    if (t >= 100) return partsC(T(t));               // v2.67 THE ARCHITECT
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
    const TT = T(t);
    const root = new THREE.Group();
    const site = new THREE.Mesh(new THREE.PlaneGeometry(TT.w, TT.d), mats().site);
    site.rotation.x = -Math.PI / 2; site.position.y = .06; root.add(site);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(TT.w - .5, TT.h, TT.d - .5)), mats().scaff);
    edges.position.y = TT.h / 2; root.add(edges);
    const body = parts(t); root.add(body);
    // v2.67 THE ARCHITECT: the gold dashed frame — the player's own
    // buildings stand inside one once finished (the reference look:
    // a dashed gold rectangle around what is yours, on the ground).
    const fw = TT.w + 1.6, fd = TT.d + 1.6;
    const fpts = [new THREE.Vector3(-fw / 2, .22, -fd / 2), new THREE.Vector3(fw / 2, .22, -fd / 2),
      new THREE.Vector3(fw / 2, .22, fd / 2), new THREE.Vector3(-fw / 2, .22, fd / 2), new THREE.Vector3(-fw / 2, .22, -fd / 2)];
    const frame = new THREE.Line(new THREE.BufferGeometry().setFromPoints(fpts),
      new THREE.LineDashedMaterial({ color: 0xf5cc74, dashSize: 1, gapSize: .6, transparent: true, opacity: .9 }));
    frame.computeLineDistances();
    frame.visible = false; root.add(frame);
    const r = { root, site, scaffold: edges, body, frame, lastP: -1 };
    refresh(r, t, prog);
    return r;
  }
  function refresh(r, t, prog) {   // the body rises out of the ground as the site builds
    const TT = T(t), fin = Math.max(0, Math.min(1, prog / TT.days));
    if (r.lastP >= 0 && Math.abs(fin - r.lastP) < .02) return;
    r.lastP = fin;
    r.body.scale.y = .18 + .82 * fin;
    const done = fin >= 1;
    r.scaffold.visible = !done;
    r.site.visible = !done;
    if (r.frame) r.frame.visible = done;   // v2.67: the gold frame draws on topping-out
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
    for (const x of list()) v += T(x.b.t).val * (x.b.p >= T(x.b.t).days ? 1 : .6);
    return Math.round(v);
  }
  function income() { let d = 0; for (const x of list()) if (x.b.p >= T(x.b.t).days) d += T(x.b.t).inc; return d; }

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
    const { p, rec } = hit, Tg = T(placing.t);
    gridFor(rec).visible = true;
    for (const [k, g] of grids) if (k !== rec.id) g.visible = false;
    const [rx, rz] = toLocal(rec, x, z);
    const lx = Math.round(rx), lz = Math.round(rz);
    const v = validFoot(p, rec, Tg, lx, lz);
    if (!ghostG) {
      ghostG = new THREE.Group();
      ghost = new THREE.Mesh(new THREE.BoxGeometry(Tg.w, Tg.h, Tg.d), new THREE.MeshBasicMaterial({ transparent: true, opacity: .3, depthWrite: false }));
      ghostEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(Tg.w, Tg.h, Tg.d)), mats().edge);
      ghost.renderOrder = ghostEdge.renderOrder = 4;
      ghostG.add(ghost); ghostG.add(ghostEdge);
      const host = grpFor(rec); if (!host) return { off: true };
      host.add(ghostG);
    }
    ghostG.visible = true;
    ghostG.position.set(rec.x, 0, rec.z);
    ghostG.rotation.y = rec.rot;
    ghost.position.set(lx, Tg.h / 2, lz);
    ghostEdge.position.set(lx, Tg.h / 2, lz);
    const col = (v.ok && matReady(Tg)) ? 0x4dff88 : 0xff5470;
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
    const TT = T(t);
    bar('PLACING <b>' + TT.name.toUpperCase() + '</b> · materials from your shed · <span style="color:var(--mut)">' + fmt$(STATE.money) + '</span>', 'DONE', () => exitPlacing(true));
    toast('Click a green cell on <b>a plot you own</b> to set the ' + TT.name + ' down. ESC or DONE to finish.', 'warn');
  }
  function exitPlacing(reopen) {
    const was = placing ? T(placing.t) : null;
    placing = null; killGhost(); hideBar();
    if (reopen && was) try { open(); } catch (er) { }
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Esc') { if (placing) { try { exitPlacing(true); } catch (er) { } } } });

  // ---- the commit (mouse path + QA path, same validation) -------------
  function commit(p, rec, t, lx, lz) {
    const TT = T(t);
    const v = validFoot(p, rec, TT, lx, lz);
    if (!v.ok) return { ok: false, why: v.why };
    if (!matReady(TT)) return { ok: false, why: 'mat' };
    deduct(TT);
    (p.bld || (p.bld = [])).push({ t: t | 0, x: Math.round(lx * 10) / 10, z: Math.round(lz * 10) / 10, p: 0 });
    try { saveGame(); } catch (er) { }
    ensureRegion();
    return { ok: true };
  }
  function placeAttempt(x, z) {
    if (!placing) return;
    const TT = T(placing.t);
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
      const TT = T(b.t);
      const [lx, lz] = toLocal(rec, x, z);
      if (Math.abs(lx - b.x) <= TT.w / 2 + .25 && Math.abs(lz - b.z) <= TT.d / 2 + .25)
        return { p, b, rec, T: TT, i: +idxS };
    }
    return null;
  }
  function tip(x, z) {
    if (STATE.mode !== 'city' || !WORLD.group) return null;
    if (placing) {
      const g = moveGhost(x, z);
      const TT = T(placing.t);
      if (!g || g.off) return { t: TT.icon + ' ' + TT.name + ' — placement', s: 'Ghost hidden — hover a plot you own', p: '', a: '', l: 'Click your plot to place · ESC to finish' };
      const why = !g.v.ok ? (g.v.why === 'bounds' ? 'outside the stakes' : g.v.why === 'overlap' ? 'too close to another building' : g.v.why === 'cart' ? 'the cart\u2019s space' : 'plot full')
        : (!matReady(TT) ? 'short on materials' : '');
      return {
        t: TT.icon + ' ' + TT.name + ' — ' + (why ? 'invalid here' : 'green — click to site'),
        s: TT.w + '×' + TT.d + ' m · ' + (TT.days === .5 ? '½ day' : TT.days + ' days') + ' · pays ' + fmt$(TT.inc) + '/day',
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
    // v2.61 FACTORY FLOOR: a finished factory shell opens its floor to
    // machines — the machine line + the MACHINES button ride the panel
    const isFact = fin && T.id === 'fact';
    const mn = (hit.b.mach || []).length;
    const mi = isFact && window.FACT ? FACT.incomeOf(hit.b) : 0;
    const cap = isFact && window.FACT ? FACT.CAP() : 0;
    openModal(T.icon + ' ' + T.name + ' — Ground Up', `
      <p>${fin ? 'A finished <b>' + T.name.toLowerCase() + '</b> standing on your plot — it pays every game day.'
        : 'The crew is raising this <b>' + T.name.toLowerCase() + '</b> — it scales up out of its scaffold as the game days pass.'}</p>
      <div class="kv"><span class="k">STATUS</span><span class="v">${fin ? '✓ Finished · ' + fmt$(T.inc) + '/day' : '🔨 ' + Math.round(100 * hit.b.p / T.days) + '% built · ' + Math.max(.5, Math.round((T.days - hit.b.p) * 2) / 2) + ' day' + (T.days - hit.b.p > 1.5 ? 's' : '') + ' left'}</span></div>
      <div class="kv"><span class="k">FOOTPRINT</span><span class="v">${T.w}×${T.d} m · ${T.h} m tall · ${fmt$(T.val)} worth</span></div>
      ${isFact ? '<div class="kv"><span class="k">MACHINES</span><span class="v g">' + (mn ? mn + '/' + cap + ' installed · +$' + mi + '/day' : 'none yet — the floor is open') + '</span></div>' : ''}
      <div class="kv"><span class="k">MATERIALS</span><span class="v">${needList}</span></div>
      <div class="kv"><span class="k">DEMOLISH</span><span class="v">Refunds ${rfList} back to your shed (the 60% scrap rate)${mn ? ' · machines sell for 60% too' : ''}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        ${isFact ? '<button class="btn good" id="bd-mach" style="flex:1">MACHINES' + (mn ? ' · ' + mn : '') + '</button>' : ''}
        <button class="btn" id="bd-dem" style="flex:1;color:#ff5470">DEMOLISH — REFUND 60%</button>
        <button class="btn" id="bd-x">CLOSE</button>
      </div>`);
    document.getElementById('bd-x').onclick = closeModal;
    const mb = document.getElementById('bd-mach');   // v2.61 FACTORY FLOOR: open the machine shop
    if (mb) mb.onclick = () => { try { if (window.FACT) FACT.openShop(hit.p.id, hit.i); } catch (er) { } };
    document.getElementById('bd-dem').onclick = () => {
      let machGot = 0;   // v2.61 FACTORY FLOOR: machines sell back with the shell
      try { if (window.FACT) { const r = FACT.onDemolish(hit.p, hit.b); if (r) machGot = r.got; } } catch (er) { }
      for (const k in rf) if (rf[k] > 0) STATE.mat[k] = Math.min(1e6, +((shed(k)) + rf[k]).toFixed(1));
      hit.p.bld.splice(hit.i, 1);
      try { saveGame(); } catch (er) { }
      ensureRegion();
      closeModal();
      toast(T.icon + ' <b>' + T.name + ' demolished.</b> ' + rfList + ' back in the shed.' + (machGot ? ' Machines sold for <b>' + fmt$(machGot) + '</b>.' : ''));
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
  function cardOf(T, i) {   // one catalog row — classic (i < 4) or design (i >= 100)
    const need = Object.entries(T.mat).map(([k, n]) => {
      const a = avail(k), sh = Math.max(0, n - a);
      return k + ' ' + n + ' t' + (sh > 1e-9 ? ' <b style="color:#f5cc74">short ' + (Math.round(sh * 10) / 10) + '</b>' : ' <b style="color:#48BB78">✓</b>');
    }).join(' · ');
    const miss = missCost(T);
    return `
      <div class="kv"><span class="k">${T.icon} ${T.name.toUpperCase()}</span><span class="v">${T.w}×${T.d} m${T.floors ? ' · ' + T.floors + ' floors' : ''} · ${T.days === .5 ? '½ day' : T.days + ' days'} to build · pays ${fmt$(T.inc)}/day · ${fmt$(T.val)} worth</span></div>
      <div class="kv"><span class="k">MATERIALS</span><span class="v">${need}</span>${miss > 0 ? '<button class="tpbtn" data-bm="' + i + '">BUY MISSING — ' + fmt$(miss) + '</button>' : ''}<button class="tpbtn" data-bp="${i}">PLACE ▸</button></div>`;
  }
  function open() {
    if (STATE.mode !== 'city') { toast('Enter the world first — buildings need ground under your boots.'); return; }
    ensureDesigns();
    const rural = STATE.plots.filter(p => p.cityKey === 'rural').length;
    const cityP = STATE.plots.filter(p => p.cityKey !== 'rural').length;
    const lots = STATE.plots.filter(p => p.lot).length;
    const yard = MAT_KEYS.map(k => {
      const st = (k === 'Steel' || k === 'Glass') ? stock(k) : 0;
      return `<div class="kv"><span class="k">${k.toUpperCase()} — ${Math.round(shed(k) * 10) / 10} t${st > .005 ? ' <span style="color:var(--mut)">(+' + (Math.round(st * 10) / 10) + ' t on the exchange)</span>' : ''}</span>
        <span class="v">$${YARD[k]}/t</span>
        <button class="tpbtn" data-my="${k}">BUY 10 t — $${YARD[k] * 10}</button>
        ${st > .005 ? '<button class="tpbtn" data-pu="' + k + '">PULL ' + (Math.round(st * 10) / 10) + ' t</button>' : ''}</div>`;
    }).join('');
    const cards = TYPES.map((T, i) => cardOf(T, i)).join('');
    const dsg = (STATE.designs || []);
    const dCards = dsg.length
      ? '<div class="msec" style="margin-top:14px">Your designs — ' + dsg.length + ' of 12</div>' + dsg.map((D, j) => cardOf(D, 100 + j)).join('')
      : '';
    openModal('Ground Up — Build on Your Land', `
      <p>Pick a building, stock the materials, then <b>PLACE</b> — a grid overlays your plot, a ghost follows the cursor, and a click sites it. Buildings take real game days to rise, pay every day, and demolish back to 60% of their materials.</p>
      <div style="display:flex;gap:8px;margin:0 0 12px"><button class="btn primary" id="bg-new" style="flex:1">✏️ DESIGN YOUR OWN BUILDING</button></div>
      <div class="kv"><span class="k">YOUR LAND</span><span class="v">${rural} roadside plot${rural === 1 ? '' : 's'} (15×20 m)${lots ? ' · ' + lots + ' city lot' + (lots === 1 ? '' : 's') + ' (15×20 m)' : ''}${cityP ? ' · ' + cityP + ' city spot' + (cityP === 1 ? '' : 's') + ' (cart-sized)' : ''} — the big ones carry buildings</span></div>
      <div class="msec" style="margin-top:14px">The materials yard — ${fmt$(STATE.money)}</div>
      ${yard}
      <div class="msec" style="margin-top:14px">The catalog</div>
      ${cards}
      ${dCards}
      <div class="kv" style="margin-top:8px"><span class="k">STEEL &amp; GLASS</span><span class="v">Run the Works and PULL your own for less — yard prices sit above exchange par ($58 steel, $38 glass)</span></div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="bg-x" style="flex:1">CLOSE</button></div>`);
    document.getElementById('bg-x').onclick = closeModal;
    document.getElementById('bg-new').onclick = () => { try { openStudio(); } catch (er) { console.error('[bld]', er); } };
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
      const T1 = T(+b.dataset.bm), sh = shortOf(T1);
      let cost = 0; for (const k in sh) cost += sh[k] * YARD[k];
      cost = Math.round(cost);
      if (cost <= 0) { open(); return; }
      if (!spend(cost)) { toast('<b>Not enough money.</b> The shortfall runs ' + fmt$(cost) + ' at the yard.', 'warn'); return; }
      for (const k in sh) STATE.mat[k] = Math.min(1e6, +((shed(k)) + sh[k]).toFixed(1));
      try { saveGame(); } catch (er) { }
      toast('🧱 <b>Materials bought</b> — the ' + T1.name + ' is ready to place.');
      open();
    });
    document.querySelectorAll('[data-bp]').forEach(b => b.onclick = () => armPlace(+b.dataset.bp));
  }

  // ---- v2.67 THE ARCHITECT: the studio ---------------------------------
  // DESIGN YOUR OWN — a footprint, a floor count, one of four styles and
  // a name; materials, cost, days, income and worth derive live from the
  // sliders, all on the same per-m²-per-floor rates the catalog pays, so
  // whatever you dream up prices like the rest of the world. SAVE puts it
  // in the catalog (and the world save); REMOVE takes it back out again
  // — only while nothing of yours still stands from it.
  function openStudio() {
    if (STATE.mode !== 'city') { toast('Enter the world first — buildings need ground under your boots.'); return; }
    ensureDesigns();
    const S = { w: 10, d: 8, floors: 3, style: 'brick', name: '' };
    const step = (id, val, min, max, by, unit, fmt) => `<div class="kv"><span class="k">${id}</span><span class="v" id="st-${id.toLowerCase()}">${fmt(val)}</span>
      <button class="tpbtn" data-st="${id.toLowerCase()}" data-d="-${by}">−</button><button class="tpbtn" data-st="${id.toLowerCase()}" data-d="${by}">+</button></div>`;
    const draw = () => {
      const D = designOf(S.w, S.d, S.floors, S.style, S.name);
      const matList = Object.entries(D.mat).map(([k, n]) => k + ' ' + n + ' t').join(' · ');
      const yours = (STATE.designs || []);
      const styleChips = STYLES.map(s => `<button class="tpbtn" data-sy="${s.id}" style="${S.style === s.id ? 'font-weight:700;background:rgba(245,204,116,.25)' : ''}">${s.icon} ${s.name}</button>`).join(' ');
      openModal('The Architect — Design Your Own', `
        <p>Compose a building only you would think of. Cost, build time and income scale honestly with the size — a twelve-floor landmark is a twelve-floor project.</p>
        ${step('WIDTH', S.w, 6, 14, 2, 'm', v => v + ' m')}
        ${step('DEPTH', S.d, 6, 12, 2, 'm', v => v + ' m')}
        ${step('FLOORS', S.floors, 1, 12, 1, '', v => v)}
        <div class="kv"><span class="k">STYLE</span><span class="v">${styleChips}</span></div>
        <div class="kv"><span class="k">NAME</span><span class="v"><input id="st-name" maxlength="24" placeholder="${(STATE.name || 'Your') + ' ' + (S.floors >= 8 ? 'Tower' : S.floors >= 4 ? 'Block' : 'House')}" value="${S.name.replace(/"/g, '&quot;')}" style="background:rgba(13,17,23,.8);border:1px solid #4A5568;color:#E2E8F0;padding:6px 10px;border-radius:7px;font-size:12px;width:180px"></span></div>
        <div class="kv"><span class="k">THE DRAFT</span><span class="v">${D.w}×${D.d} m · ${D.floors} floors · ${D.h} m tall${D.floors >= 8 ? ' · wedding-cake setback' : ''}</span></div>
        <div class="kv"><span class="k">MATERIALS</span><span class="v">${matList}</span></div>
        <div class="kv"><span class="k">COST AT THE YARD</span><span class="v">${fmt$(Math.round(YARD_COST(D.mat)))}${missCost(D) > 0 ? ' <span style="color:#f5cc74">(short ' + fmt$(missCost(D)) + ')</span>' : ''}</span></div>
        <div class="kv"><span class="k">BUILDS & PAYS</span><span class="v">${D.days === .5 ? '½ day' : D.days + ' days'} to rise · ${fmt$(D.inc)}/day · ${fmt$(D.val)} worth</span></div>
        ${yours.length ? '<div class="msec" style="margin-top:14px">Your designs</div>' + yours.map((X, j) => `<div class="kv"><span class="k">${X.icon} ${X.name}</span><span class="v">${X.w}×${X.d} · ${X.floors} fl</span><button class="tpbtn" data-rm="${j}">REMOVE</button></div>`).join('') : ''}
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn good" id="st-save" style="flex:1">SAVE TO CATALOG</button>
          <button class="btn" id="st-x" style="flex:1">CLOSE</button>
        </div>`);
      document.getElementById('st-x').onclick = () => { closeModal(); try { open(); } catch (er) { } };
      const nm = document.getElementById('st-name');
      nm.oninput = () => { S.name = nm.value; };
      document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => {
        const k = b.dataset.st, dv = +b.dataset.d;
        if (k === 'width') S.w = Math.max(6, Math.min(14, S.w + dv * 2));
        if (k === 'depth') S.d = Math.max(6, Math.min(12, S.d + dv * 2));
        if (k === 'floors') S.floors = Math.max(1, Math.min(12, S.floors + dv));
        draw();
      });
      document.querySelectorAll('[data-sy]').forEach(b => b.onclick = () => { S.style = b.dataset.sy; draw(); });
      document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
        const j = +b.dataset.rm;
        const inUse = list().some(x => x.b.t === 100 + j);
        if (inUse) { toast('<b>A building of yours still stands from this design.</b> Demolish it first — then remove the drawing.', 'warn'); return; }
        (STATE.designs || []).splice(j, 1);
        // re-seat any standing buildings from later designs onto their new indices
        for (const p of STATE.plots) for (const bb of (p.bld || []))
          if (bb.t > 100 + j) bb.t--;
        try { saveGame(); } catch (er) { }
        toast('Design removed — the catalog is yours to redraw.');
        draw();
      });
      document.getElementById('st-save').onclick = () => {
        if (!(STATE.designs)) STATE.designs = [];
        if (STATE.designs.length >= 12) { toast('<b>Twelve designs</b> fit on the shelf — remove one first.', 'warn'); return; }
        STATE.designs.push(designOf(S.w, S.d, S.floors, S.style, S.name));
        try { saveGame(); } catch (er) { }
        toast('📐 <b>' + STATE.designs[STATE.designs.length - 1].name + '</b> drafted — find it in the catalog, PLACE to site it.');
        closeModal();
        try { open(); } catch (er) { }
      };
    };
    draw();
  }

  // ---- the beat: rise, pay, stay alive ----------------------------------
  function tick(dt) {
    if (STATE.mode !== 'city' || !WORLD.group || !dt) return;
    dt = Math.min(dt, 2);
    let topped = 0;
    for (const p of STATE.plots) for (const b of (p.bld || [])) {
      const TT = T(b.t);
      if (b.p < TT.days) {
        b.p = +(b.p + dt / DAY).toFixed(4);
        if (b.p >= TT.days) {
          b.p = TT.days; topped++;
          try { toast(TT.icon + ' <b>' + TT.name + ' topped out</b> — it pays ' + fmt$(TT.inc) + ' every game day.' + (TT.id === 'fact' ? ' Click it to open <b>the factory floor</b> for machines.' : '')); } catch (er) { }   // v2.61 FACTORY FLOOR: the shell's floor opens
        }
      }
    }
    if (topped) try { saveGame(); } catch (er) { }
    acc += dt;
    if (acc >= 1) {
      const secs = Math.min(acc, 30); acc = 0;
      let d = 0;
      for (const p of STATE.plots) for (const b of (p.bld || [])) if (b.p >= T(b.t).days) d += T(b.t).inc / DAY * secs;
      if (d > 0) earn(d);
    }
    meshT += dt;
    if (meshT > .25) { meshT = 0; ensureRegion(); }
  }
  // NIGHT SHIFT hook: the sites rise while you sleep (whole days, no wages)
  function advance(days) {
    let d = 0, done = 0;
    for (const p of STATE.plots) for (const b of (p.bld || [])) {
      const TT0 = T(b.t);
      if (b.p < TT0.days) { b.p = Math.min(TT0.days, +(b.p + days).toFixed(4)); d += days; if (b.p >= TT0.days) done++; }
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
    const all = list(), standing = all.filter(x => x.b.p >= T(x.b.t).days);
    const rows = all.map(x => {
      const TT = T(x.b.t), fin = x.b.p >= TT.days;
      return '<div class="kv"><span class="k">' + TT.icon + ' ' + TT.name + ' · ' + TT.w + '×' + TT.d + ' m · ' +
        (fin ? fmt$(TT.inc) + '/day' : Math.round(100 * x.b.p / TT.days) + '% built') +
        ((x.b.mach || []).length ? ' · ' + x.b.mach.length + ' mach' : '') +   // v2.61 FACTORY FLOOR: the row counts the factory's machines
        '</span>' +
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
    open, openStudio, tip, click, tick, empireInto, advance, qaDay,
    valueOf, income, list, shed, stock, designs: () => STATE.designs || [], T,
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
      const T0 = T(b.t), rf = refundOf(T0);
      let machGot = 0;
      try { if (window.FACT) { const r = FACT.onDemolish(p, b); if (r) machGot = r.got; } } catch (er) { }   // v2.61 FACTORY FLOOR
      for (const k in rf) if (rf[k] > 0) STATE.mat[k] = Math.min(1e6, +((shed(k)) + rf[k]).toFixed(1));
      p.bld.splice(i | 0, 1);
      try { saveGame(); } catch (er) { }
      ensureRegion();
      return { ok: true, refund: rf, machines: machGot };
    },
    arming: () => !!placing, TYPES, YARD, MAX_PER_PLOT,
    // v2.61 FACTORY FLOOR: the factory machine system rides these internals
    liveAt: key => live.get(key) || null,   // the live root/body of a standing building
    recOf, toLocal, toWorld,
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

