// ====================================================================
// js/systems/furniture.js — furniture (Stage 7c): ten pieces, cash
// or crafted, cursor ghosts, saved room by room.
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
import { MACH } from '../systems/machines.js';
import { BLD } from '../systems/builder.js';

// ======== section: 57_furniture.js ========
// ====================================================================
// v2.57 — HOME & HEARTH. The ask: "Craftable or purchasable furniture
// (beds, tables, chairs, etc.) that players can place inside houses
// and apartments they own or rent, with a simple interior placement
// mode — move, rotate, delete — and furniture saved per room." It
// rides the rails the rooms already use (v2.43 TITLE DEEDS + v2.45
// MACHINES + the v2.56 materials shed):
//   - THE SHOP: any room or floor you own or rent gains a FURNISH
//     button (deal block + MANAGE modal) — ten pieces from a $150
//     chair to a $1,350 computer, each BUYABLE with cash or CRAFTABLE
//     from the shed's materials (wood, stone, steel, glass — the
//     same tonnes the yard sells; crafting is the cheap path, the
//     Works' own draw pattern pulls stockpiled steel/glass first);
//   - THE MODE: CRAFT or BUY arms placement — a ghost of the real
//     footprint follows the cursor on your floor, green where it
//     fits and red where it doesn't, and R (or the ↻ button)
//     rotates it a quarter turn before the click sets the piece
//     down. Keep clicking to fill the room; DONE / ESC ends. Every
//     rule is enforced at click time and in the QA path alike:
//     inside your space (off the walls), no overlap with another
//     piece or a machine, and a per-unit cap from the area (one
//     piece per 2.5 m², 24 max);
//   - THE PIECE PANEL: click any placed piece in the world while its
//     building is inspected → ROTATE (a quarter turn, validated),
//     MOVE (re-arms the ghost for that piece — click its new spot,
//     ESC puts it back) and REMOVE, which pays 60% back — cash for
//     bought pieces, shed tonnes for crafted ones (the Works' scrap
//     rate, same as demolishing a building);
//   - THE SAVE: furn rides every rooms entry in the pack (type,
//     world x/z, quarter-turns of rotation, floor, crafted flag) —
//     an optional nested field older builds ignore, pack stays v5;
//     furniture is comfort, not income, but it counts in WORTH at
//     catalog price and lists on the deal block, the MANAGE modal
//     and the Empire rows.
//   - v2.58 HOME OFFICE: a Desk, and a Computer that rides it — the
//     computer's whole footprint must sit on one desk's top in the
//     same unit (computed live from the state, never stored, so the
//     pair can never drift apart), the ghost rises to the desk when
//     it rides, and a desk will not turn, move or sell while a
//     computer sits on it;
// Touchpoints outside this section (each annotated "v2.57"): the
// saveGame/loadGame furniture lists, the WORTH ticker + playerWorth,
// the v2.43 deal block (furniture line + FURNISH button + wiring),
// the v2.43 manage modal (furniture line + button), the v2.43 Empire
// rows (count), one help-modal line, and the version surfaces. Every
// furniture call is try/caught so a mistake here can never touch the
// world. window.FURN is the QA surface.
// ====================================================================
export const FURN = (() => {
  // ---- the catalog ----------------------------------------------------
  // Ten pieces; prices are comfort-tier (far under the machines),
  // craft bills are furniture-sized — a bed costs 2.4 t of the wood
  // the yard sells at $30/t, so a furnished home runs a fraction of
  // the shed that raises one.
  const TYPES = [
    { key: 'bed',    name: 'Bed',          icon: '\ud83d\udecf', price: 780,  w: 2.05, d: 1.5,  h: .62,  mat: { Wood: 2.4, Stone: .5 } },
    { key: 'chair',  name: 'Chair',        icon: '\ud83e\ude91', price: 150,  w: .52,  d: .52,  h: .95,  mat: { Wood: .3 } },
    { key: 'table',  name: 'Dining Table', icon: '\ud83c\udf7d', price: 460,  w: 1.6,  d: .9,   h: .78,  mat: { Wood: 1.1, Stone: .2 } },
    { key: 'sofa',   name: 'Sofa',         icon: '\ud83d\udecb', price: 1250, w: 1.9,  d: .85,  h: .78,  mat: { Wood: 2.8, Steel: .3 } },
    { key: 'ctable', name: 'Coffee Table', icon: '\u2615',       price: 290,  w: 1.0,  d: .55,  h: .42,  mat: { Wood: .7 } },
    { key: 'lamp',   name: 'Floor Lamp',   icon: '\ud83d\udca1', price: 240,  w: .42,  d: .42,  h: 1.62, mat: { Steel: .25, Glass: .1 } },
    { key: 'shelf',  name: 'Bookshelf',    icon: '\ud83d\udcda', price: 540,  w: 1.2,  d: .42,  h: 1.9,  mat: { Wood: 1.3 } },
    { key: 'ward',   name: 'Wardrobe',     icon: '\ud83d\udeaa', price: 890,  w: 1.3,  d: .62,  h: 2.0,  mat: { Wood: 2.1, Glass: .4 } },
    { key: 'desk',  name: 'Desk',         icon: '\ud83d\udcdd', price: 620,  w: 1.5,  d: .8,   h: .78, mat: { Wood: 1.4, Steel: .25 } },   // v2.58 HOME OFFICE
    { key: 'comp',  name: 'Computer',     icon: '\ud83d\udda5', price: 1350, w: .75,  d: .45,  h: .46, mat: { Steel: .9, Glass: .5 } },    // v2.58 HOME OFFICE — rides a desk
  ];
  const T_DESK = 8, T_COMP = 9;     // v2.58 HOME OFFICE: the catalog indices of the new pair
  const DESKH = .78, RIDE = .04;    // v2.58: the desk's top height · clearance a computer needs on it
  const SELL_BACK = .6;             // the Works' scrap rate, same as buildings and machines
  const INSET = .3;                 // furniture sits nearer the walls than machines (a bed hugs them)
  const GAP = .12;                  // air between a piece and any other piece or machine
  const CAP_MAX = 24;               // per-unit piece ceiling
  const SLAB0 = .21, FH = 3.2;      // the interior builder's own constants
  let placing = null;               // { o, b, rects, fl, yF, t, r, cap, how }
  let moving = null;                // { o, b, rects, fl, yF, t, r, i, x0, z0, mesh }
  let ghost = null, ghostMat = null, ghostT = -1;
  let lastPtr = null;               // {x, y} from pointermove (the ghost follows it)
  let lastGroup = null;             // city swap detector (the OH/MACH pattern)
  const built = new Map();          // bkey -> [{ o, i, g, t, r, x, z }]

  // ---- materials (the BLD shed pattern: stockpile first, then shed) ---
  const shed = k => +(((STATE.mat || {})[k]) || 0);
  const stock = k => +(((STATE.res || {})[k]) || 0);
  const avail = k => shed(k) + ((k === 'Steel' || k === 'Glass') ? stock(k) : 0);
  function matReady(T) { for (const k in T.mat) if (avail(k) + 1e-9 < T.mat[k]) return false; return true; }
  function shortOf(T) { const o = {}; for (const k in T.mat) { const s = T.mat[k] - avail(k); if (s > 1e-9) o[k] = Math.round(s * 10) / 10; } return o; }
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
  function refundOf(T) { const o = {}; for (const k in T.mat) o[k] = Math.round(T.mat[k] * SELL_BACK * 10) / 10; return o; }
  const billStr = T => Object.entries(T.mat).map(([k, n]) => n + ' t ' + k.toLowerCase()).join(' + ');

  // ---- bookkeeping -----------------------------------------------------
  const capOf = area => Math.min(CAP_MAX, Math.max(4, Math.floor((area || 10) / 2.5)));
  const yOf = fl => SLAB0 + fl * FH;
  const eff = (T, r) => ((r | 0) % 2) ? { w: T.d, d: T.w } : { w: T.w, d: T.d };
  const valueOfUnit = o => (o.furn || []).reduce((s, f) => s + (TYPES[f.t] ? TYPES[f.t].price : 0), 0);
  const valueOfRooms = () => (STATE.rooms || []).reduce((s, r) => s + valueOfUnit(r), 0);

  // ---- the 3D piece ----------------------------------------------------
  let M = null;
  const LM = c => new THREE.MeshLambertMaterial({ color: c });
  function mats() {
    if (M) return M;
    M = {
      wood: LM(0x8a6a48), wood2: LM(0x9c7c50), dark: LM(0x5f4632),
      cloth: LM(0xece5d6), pillow: LM(0xf4f0e7), cushion: LM(0x7e8ea0),
      steel: LM(0x8d99a6), mirror: LM(0xbcd3dc),
      chip: LM(0x394048),            // v2.58 HOME OFFICE: the computer's charcoal plastic
      shade: new THREE.MeshBasicMaterial({ color: 0xffe3a0 }),
      screen: new THREE.MeshBasicMaterial({ color: 0x8fd0f5 }),   // v2.58: the monitor's glowing face (the lamp-shade convention)
      book: [LM(0xa2472f), LM(0x2f6da2), LM(0x4c7a3f), LM(0xb08a2e)],
    };
    return M;
  }
  const box = (mt, w, h, d) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mt); m.castShadow = true; return m; };
  const cyl = (mt, rt, rb, h, seg) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 10), mt); m.castShadow = true; return m; };
  function buildMesh(t) {                    // the piece, centered, facing +x (a quarter turn = 90°)
    const T = TYPES[t] || TYPES[0], m = mats(), g = new THREE.Group();
    try {
      if (t === 0) {                                      // bed
        const fr = box(m.wood, 2.05, .3, 1.5); fr.position.set(0, .22, 0); g.add(fr);
        const ma = box(m.cloth, 1.93, .16, 1.38); ma.position.set(.04, .45, 0); g.add(ma);
        const pi = box(m.pillow, .42, .1, 1.0); pi.position.set(-.72, .58, 0); g.add(pi);
        const hb = box(m.dark, .12, .62, 1.5); hb.position.set(-1.02, .38, 0); g.add(hb);
      } else if (t === 1) {                               // chair
        const se = box(m.wood2, .5, .06, .5); se.position.y = .48; g.add(se);
        [[-.21, -.21], [.21, -.21], [-.21, .21], [.21, .21]].forEach(([x, z]) => {
          const lg = box(m.dark, .05, .48, .05); lg.position.set(x, .24, z); g.add(lg);
        });
        const bk = box(m.wood2, .5, .52, .05); bk.position.set(0, .74, -.225); g.add(bk);
      } else if (t === 2) {                               // dining table
        const tp = box(m.wood, 1.6, .07, .9); tp.position.y = .745; g.add(tp);
        [[-.7, -.36], [.7, -.36], [-.7, .36], [.7, .36]].forEach(([x, z]) => {
          const lg = box(m.dark, .08, .71, .08); lg.position.set(x, .355, z); g.add(lg);
        });
      } else if (t === 3) {                               // sofa
        const ba = box(m.cushion, 1.9, .78, .22); ba.position.set(0, .39, -.315); g.add(ba);
        const se = box(m.cushion, 1.9, .3, .85); se.position.set(0, .2, 0); g.add(se);
        const a1 = box(m.cushion, .22, .58, .85); a1.position.set(-.84, .32, 0); g.add(a1);
        const a2 = box(m.cushion, .22, .58, .85); a2.position.set(.84, .32, 0); g.add(a2);
      } else if (t === 4) {                               // coffee table
        const tp = box(m.wood2, 1.0, .06, .55); tp.position.y = .39; g.add(tp);
        [[-.43, -.22], [.43, -.22], [-.43, .22], [.43, .22]].forEach(([x, z]) => {
          const lg = box(m.dark, .05, .39, .05); lg.position.set(x, .195, z); g.add(lg);
        });
      } else if (t === 5) {                               // floor lamp (the shade glows warm)
        const bs = cyl(m.steel, .16, .18, .05, 12); bs.position.y = .025; g.add(bs);
        const po = cyl(m.steel, .025, .025, 1.28, 8); po.position.y = .69; g.add(po);
        const sh = new THREE.Mesh(new THREE.CylinderGeometry(.19, .24, .3, 12), m.shade); sh.position.y = 1.45; g.add(sh);
      } else if (t === 6) {                               // bookshelf
        const bk = box(m.wood, 1.2, 1.9, .42); bk.position.y = .95; g.add(bk);
        for (let s = 0; s < 4; s++) { const bo = box(m.wood2, 1.08, .04, .34); bo.position.set(0, .38 + s * .42, .02); g.add(bo); }
        for (let s = 0; s < 3; s++) for (let b = 0; b < 3; b++) {
          const bo = box(m.book[(s * 3 + b) % 4], .09, .28, .26);
          bo.position.set(-.42 + b * .34 + ((s % 2) * .07), .55 + s * .42, .03); g.add(bo);
        }
      } else if (t === 8) {                               // v2.58 HOME OFFICE: desk (top surface = DESKH; drawers face +x)
        const tp = box(m.wood, 1.5, .05, .8); tp.position.set(0, .755, 0); g.add(tp);
        const p1 = box(m.dark, .05, .73, .68); p1.position.set(-.7, .365, 0); g.add(p1);
        const p2 = box(m.dark, .05, .73, .68); p2.position.set(.7, .365, 0); g.add(p2);
        const mb = box(m.wood, .04, .36, .66); mb.position.set(-.35, .555, 0); g.add(mb);          // modesty back
        const dr = box(m.wood2, .5, .52, .58); dr.position.set(.36, .475, 0); g.add(dr);           // drawer chest
        [.29, .44, .59].forEach(y => {
          const df = box(m.dark, .02, .12, .5); df.position.set(.615, y, 0); g.add(df);            // drawer fronts face +x
          const hd = box(m.steel, .02, .015, .12); hd.position.set(.628, y, 0); g.add(hd);         // steel handles
        });
      } else if (t === 9) {                               // v2.58 HOME OFFICE: computer (origin = the desk top; screen faces +x)
        const ft = box(m.chip, .16, .02, .2); ft.position.set(-.2, .01, 0); g.add(ft);             // monitor foot
        const nk = box(m.chip, .04, .14, .05); nk.position.set(-.2, .09, 0); g.add(nk);            // neck
        const mo = box(m.chip, .045, .3, .44); mo.position.set(-.2, .31, 0); g.add(mo);            // monitor body
        const sc = box(m.screen, .012, .26, .4); sc.position.set(-.173, .31, 0); g.add(sc);        // the glowing screen
        const kb = box(m.chip, .14, .015, .3); kb.position.set(.13, .01, 0); g.add(kb);            // keyboard
        const ms = box(m.chip, .045, .014, .026); ms.position.set(.12, .008, .17); g.add(ms);      // mouse
        const tw = box(m.chip, .11, .32, .24); tw.position.set(-.315, .17, 0); g.add(tw);          // mini tower
        const led = box(m.screen, .012, .012, .012); led.position.set(-.253, .26, .07); g.add(led);// power LED
      } else {                                            // wardrobe (mirror door)
        const bd = box(m.wood, 1.3, 2.0, .62); bd.position.y = 1.0; g.add(bd);
        const sp = box(m.dark, .04, 1.86, .02); sp.position.set(0, 1.0, .315); g.add(sp);
        const mi = box(m.mirror, .56, 1.6, .02); mi.position.set(-.33, 1.05, .325); g.add(mi);
        const h1 = box(m.dark, .04, .22, .04); h1.position.set(-.1, 1.05, .33); g.add(h1);
        const h2 = box(m.dark, .04, .22, .04); h2.position.set(.1, 1.05, .33); g.add(h2);
      }
    } catch (er) { }
    return g;
  }

  // ---- build / refresh / dispose (the MACH pattern) --------------------
  // Rebuild the wanted list, reuse a mesh that already matches (holding
  // + type + rotation + spot), dispose the rest — so placements appear
  // instantly and removed pieces / ended leases clean themselves up.
  function ensureBuilt(bkey) {
    const holdings = (STATE.rooms || []).filter(r => r.bkey === bkey && r.furn && r.furn.length);
    const old = built.get(bkey) || [];
    const out = [];
    for (const h of holdings) {
      (h.furn || []).forEach((f, i) => {
        if (!TYPES[f.t]) return;
        let e = null;
        for (const v of old)
          if (v.o === h && v.t === f.t && v.r === (f.r | 0) && Math.abs(v.x - f.x) < .01 && Math.abs(v.z - f.z) < .01 && v.g) { e = v; break; }
        if (!e) {
          const g = buildMesh(f.t);
          // CITY.group sits at the origin with children in WORLD coordinates
          // (the arrivalPulse convention) — furniture goes straight to world coords
          g.position.set(f.x, yOf(f.fl) + ((f.t | 0) === T_COMP ? DESKH : 0), f.z);   // v2.58 HOME OFFICE: computers ride the desk top
          g.rotation.y = (f.r | 0) * Math.PI / 2;
          g.visible = false;
          e = { o: h, i, g, t: f.t, r: f.r | 0, x: f.x, z: f.z };
          try { CITY.group.add(g); } catch (er) { }
        }
        e.i = i;                          // indices shift when a piece is removed — keep the tags fresh
        e.g.userData.furn = { bkey, kind: h.kind, index: h.index, i };
        out.push(e);
      });
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
  // furniture shows only while its building is inspected — and a big
  // building's floor units follow the picked floor, exactly like the
  // machines and the dollhouse's own drawRange
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

  // ---- placement geometry (the MACH pattern) ---------------------------
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
  // v2.58 HOME OFFICE: the desk a computer rides — computed live from
  // the state (never stored), so desks and computers can never drift
  // apart. The computer's whole footprint must sit on one desk's top
  // with RIDE of clearance to spare; returns that desk's index in
  // o.furn, or -1 when nothing carries it.
  function deskUnder(o, x, z, r) {
    const E = eff(TYPES[T_COMP], (r | 0) % 4), hw = E.w / 2, hd = E.d / 2;
    const list = o.furn || [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if ((f.t | 0) !== T_DESK) continue;
      const D = eff(TYPES[T_DESK], f.r | 0);
      if (Math.abs(x - f.x) + hw + RIDE <= D.w / 2 + 1e-9 && Math.abs(z - f.z) + hd + RIDE <= D.d / 2 + 1e-9) return i;
    }
    return -1;
  }
  // the computer riding desk i of unit o (blocks turn/move/sell on
  // it), or -1 when the desk is clear
  function deskRider(o, i) {
    const list = o.furn || [];
    for (let k = 0; k < list.length; k++) {
      const f = list[k];
      if ((f.t | 0) !== T_COMP) continue;
      if (deskUnder(o, f.x, f.z, f.r) === i) return k;
    }
    return -1;
  }
  // skipI: the piece being moved never blocks its own new spot.
  function validSpot(x, z, o, rects, t, r, skipI) {
    if (!rects || !rects.length) return { ok: false, why: 'no space data' };
    const T = TYPES[t], E = eff(T, r);
    const hw = E.w / 2, hd = E.d / 2;
    let inside = false;
    for (const rc of rects) {
      if (x - hw >= rc.x0 + INSET && x + hw <= rc.x1 - INSET && z - hd >= rc.z0 + INSET && z + hd <= rc.z1 - INSET) { inside = true; break; }
    }
    if (!inside) return { ok: false, why: 'inside' };
    // v2.58 HOME OFFICE: a computer must ride a desk — its whole
    // footprint on one desk's top in the same unit (that desk alone
    // stops counting as an obstacle for this spot).
    const ride = t === T_COMP ? deskUnder(o, x, z, r) : -1;
    if (t === T_COMP && ride < 0) return { ok: false, why: 'nodesk' };
    let hit = null;                       // another piece of the same building
    for (const q of (STATE.rooms || [])) {
      if (q.bkey !== o.bkey || !q.furn) continue;
      for (let i = 0; i < q.furn.length; i++) {
        if (q === o && i === skipI) continue;
        if (q === o && i === ride) continue;   // v2.58 HOME OFFICE: the desk being ridden
        const f = q.furn[i], T2 = TYPES[f.t]; if (!T2) continue;
        const E2 = eff(T2, f.r);
        if (Math.abs(f.x - x) < (E.w + E2.w) / 2 + GAP && Math.abs(f.z - z) < (E.d + E2.d) / 2 + GAP) { hit = 'piece'; break; }
      }
      if (hit) break;
    }
    if (hit) return { ok: false, why: 'overlap' };
    for (const q of (STATE.rooms || [])) {   // and never a machine
      if (q.bkey !== o.bkey || !q.machines) continue;
      for (const mm of q.machines) {
        const T2 = (window.MACH ? MACH.TYPES[mm.t] : null); if (!T2) continue;
        if (Math.abs(mm.x - x) < (E.w + T2.w) / 2 + GAP && Math.abs(mm.z - z) < (E.d + T2.d) / 2 + GAP) { hit = 'mach'; break; }
      }
      if (hit) break;
    }
    if (hit) return { ok: false, why: 'machine' };
    return { ok: true };
  }
  const _rc = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _pt = new THREE.Vector3();
  const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function rayToFloor(cx, cy, yF) {
    try {
      _ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
      _rc.setFromCamera(_ndc, camera);
      _plane.constant = -yF;
      const pt = _rc.ray.intersectPlane(_plane, _pt);
      return pt ? { x: pt.x, z: pt.z } : null;
    } catch (er) { return null; }
  }

  // ---- the ghost + the gold bar ----------------------------------------
  try {   // the placement bar styles (injected once — gold, furniture's own)
    const st = document.createElement('style');
    st.textContent = [
      '#fn-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px',
      ' background:var(--panel2);border:1px solid rgba(245,204,116,.4);border-radius:10px;padding:8px 12px;font-size:12px;',
      ' color:var(--txt);box-shadow:0 8px 26px rgba(0,0,0,.55);white-space:nowrap;max-width:92vw;overflow:hidden}',
      '#fn-bar.hidden{display:none}',
      '#fn-bar b{color:#f5cc74}',
      '#fn-bar .fn-x{flex:none;padding:5px 12px;border-radius:7px;background:rgba(245,204,116,.16);color:#f5cc74;font-weight:700;cursor:pointer}',
      '#fn-bar .fn-x:hover{background:rgba(245,204,116,.3)}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }
  function ensureGhost(t, r) {
    if (ghost && ghostT === t) { ghost.rotation.y = (r | 0) * Math.PI / 2; return; }
    killGhost();
    const T = TYPES[t];
    ghostMat = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: .42, depthWrite: false });
    ghost = new THREE.Mesh(new THREE.BoxGeometry(T.w, T.h, T.d), ghostMat);
    ghost.renderOrder = 3;
    ghost.rotation.y = (r | 0) * Math.PI / 2;
    ghostT = t;
    try { CITY.group.add(ghost); } catch (er) { }
  }
  function killGhost() {
    if (!ghost) return;
    try { if (ghost.parent) ghost.parent.remove(ghost); ghost.geometry.dispose(); ghostMat.dispose(); } catch (er) { }
    ghost = null; ghostMat = null; ghostT = -1;
  }
  function showBar(msg, withRotate) {
    try {
      let b = document.getElementById('fn-bar');
      if (!b) { b = document.createElement('div'); b.id = 'fn-bar'; document.body.appendChild(b); }
      b.innerHTML = '<span>' + msg + '</span>' +
        (withRotate ? '<span class="fn-x" id="fn-rot" title="Rotate a quarter turn (R)">\u21bb</span>' : '') +
        '<span class="fn-x" id="fn-done">DONE</span>';
      b.classList.remove('hidden');
      const r = b.querySelector('#fn-rot'); if (r) r.onclick = () => rotateGhost();
      const d = b.querySelector('#fn-done'); if (d) d.onclick = () => exitMode(true);
    } catch (er) { }
  }
  function hideBar() { const b = document.getElementById('fn-bar'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; } }
  function rotateGhost() {
    const act = placing || moving; if (!act) return;
    act.r = ((act.r | 0) + 1) % 4;
    if (ghost) ghost.rotation.y = act.r * Math.PI / 2;
    refreshBar();
  }
  function refreshBar() {
    if (placing) {
      const T = TYPES[placing.t], n = (placing.o.furn || []).length;
      showBar('PLACING <b>' + T.name.toUpperCase() + '</b> \u00b7 click a spot inside <b>' + placing.o.name +
        '</b> \u00b7 <b>\u21bb / R</b> rotates \u00b7 ' + (n + 1) + '/' + placing.cap +
        ' \u00b7 <span style="color:var(--mut)">' + (placing.how === 'craft' ? 'craft: ' + billStr(T) : fmt$(T.price) + ' each') + '</span></span>', true);
    } else if (moving) {
      const T = TYPES[moving.t];
      showBar('MOVING <b>' + T.name.toUpperCase() + '</b> \u00b7 click its new spot \u00b7 <b>\u21bb / R</b> rotates \u00b7 <span style="color:var(--mut)">ESC puts it back</span></span>', true);
    }
  }

  // ---- the commit core (mouse path + QA path, same validation) ---------
  // how = 'buy' | 'craft'. Returns {ok, why?, cost?}.
  function commitPlace(o, rects, fl, t, r, x, z, how) {
    const T = TYPES[t]; if (!T) return { ok: false, why: 'no type' };
    const rr = (r | 0) % 4;
    const v = validSpot(x, z, o, rects, t, rr, -1);
    if (!v.ok) return { ok: false, why: v.why };
    if ((o.furn || []).length >= capOf(o.area)) return { ok: false, why: 'cap' };
    if (how === 'craft') {
      if (!matReady(T)) return { ok: false, why: 'mat', short: shortOf(T) };
      deduct(T);
    } else {
      if (!spend(T.price)) return { ok: false, why: 'funds', cost: T.price };
    }
    (o.furn || (o.furn = [])).push({ t: t | 0, x: +(+x).toFixed(2), z: +(+z).toFixed(2), r: rr, fl: fl | 0, craft: how === 'craft' ? 1 : 0 });
    try { saveGame(); } catch (er) { }
    ensureBuilt(o.bkey);
    return { ok: true };
  }
  function placeAt(x, z) {
    const o = placing.o, T = TYPES[placing.t];
    const r = commitPlace(o, placing.rects, placing.fl, placing.t, placing.r, x, z, placing.how);
    if (!r.ok) {
      toast(r.why === 'inside' ? '<b>That spot is outside your space.</b> Click inside ' + o.name + '.'
        : r.why === 'overlap' ? '<b>Too close to another piece.</b> Give them a little air.'
        : r.why === 'machine' ? '<b>Too close to a machine.</b> Build around it.'
        : r.why === 'nodesk' ? '<b>Computers sit on desks.</b>' + ((placing.o.furn || []).some(fq => (fq.t | 0) === T_DESK) ? ' Aim for the top of your desk — <b>R</b> turns it to match.' : ' Place a <b>desk</b> first, then set the computer on it.')
        : r.why === 'cap' ? '<b>' + o.name + ' is full</b> (' + capOf(o.area) + ' pieces — one per 2.5 m\u00b2). Remove one first.'
        : r.why === 'mat' ? '<b>Short on materials.</b> The next ' + T.name + ' needs ' + billStr(T) + ' — buy tonnes at the yard (BUILD).'
        : '<b>Not enough money.</b> The ' + T.name + ' costs ' + fmt$(T.price) + '.', 'warn');
      if (r.why === 'cap' || r.why === 'mat' || r.why === 'funds') exitMode(true);
      else if (r.why === 'nodesk' && !(placing.o.furn || []).some(fq => (fq.t | 0) === T_DESK)) exitMode(true);   // v2.58 HOME OFFICE: no desk to ride — back to the shop
      return;
    }
    refreshBar();
    try { OH.refresh(); } catch (er) { }
    const n = (o.furn || []).length;
    toast(T.icon + ' <b>' + T.name + ' placed</b> — ' + n + '/' + capOf(o.area) + ' in ' + o.name + '. Click it any time to turn, move or sell it.');
    if (n >= placing.cap) exitMode(true);
    else if (placing.how === 'craft' && !matReady(T)) exitMode(true);
    else if (placing.how !== 'craft' && STATE.money < T.price) exitMode(true);
  }

  // ---- placement mode ----------------------------------------------------
  function startPlacing(o, b, rects, t, how) {
    const fl = o.kind === 'floor' ? o.index : (rects[0] ? rects[0].fl : 0);
    placing = { o, b, rects, fl, yF: yOf(fl) + .02, t, r: 0, cap: capOf(o.area), how };
    try { closeModal(); } catch (er) { }
    ensureGhost(t, 0);
    refreshBar();
    try { OH.refresh(); } catch (er) { }
    toast('Click a spot inside <b>' + o.name + '</b> to set the ' + TYPES[t].name + ' down. <b>R rotates</b> \u00b7 ESC or DONE to finish.', 'warn');
  }
  // ---- move mode ---------------------------------------------------------
  function startMoving(o, b, rects, i) {
    const f = (o.furn || [])[i]; if (!f) return;
    if ((f.t | 0) === T_DESK && deskRider(o, i) >= 0) { toast('<b>A computer is sitting on that desk.</b> MOVE or SELL the computer first.', 'warn'); return; }   // v2.58 HOME OFFICE
    const fl = f.fl != null ? f.fl : (o.kind === 'floor' ? o.index : (rects[0] ? rects[0].fl : 0));
    moving = { o, b, rects, i, t: f.t, r: f.r | 0, fl, yF: yOf(fl) + .02, x0: f.x, z0: f.z, mesh: null };
    try { closeModal(); } catch (er) { }
    const list = built.get(o.bkey) || [];
    for (const e of list) if (e.o === o && e.i === i && e.g) { e.g.visible = false; moving.mesh = e.g; break; }
    ensureGhost(f.t, f.r | 0);
    refreshBar();
    toast('Click the new spot for your <b>' + (TYPES[f.t] || { name: 'piece' }).name + '</b> — ESC puts it back.', 'warn');
  }
  function commitMoveAt(x, z) {
    const o = moving.o;
    const f = (o.furn || [])[moving.i];
    if (!f) { exitMode(false); return; }
    const v = validSpot(x, z, o, moving.rects, moving.t, moving.r, moving.i);
    if (!v.ok) {
      toast(v.why === 'inside' ? '<b>That spot is outside your space.</b>'
        : v.why === 'overlap' ? '<b>Too close to another piece.</b>'
        : v.why === 'nodesk' ? '<b>Computers sit on desks.</b> Aim for a desk top.'
          : '<b>Too close to a machine.</b>', 'warn');
      return;
    }
    f.x = +(+x).toFixed(2); f.z = +(+z).toFixed(2); f.r = moving.r | 0;
    try { saveGame(); } catch (er) { }
    ensureBuilt(o.bkey);
    exitMode(false);
    toast((TYPES[f.t] || { icon: '\ud83d\udecb' }).icon + ' <b>' + TYPES[f.t].name + ' moved.</b>');
    try { OH.refresh(); } catch (er) { }
  }
  function exitMode(done) {
    const wasP = placing, wasM = moving;
    placing = null; moving = null;
    killGhost(); hideBar();
    if (wasM) { try { ensureBuilt(wasM.o.bkey); } catch (er) { } }   // the piece returns to its spot
    try { OH.refresh(); } catch (er) { }
    if (done && wasP) try { openShopFor(wasP.o); } catch (er) { }
  }

  // ---- rotate / remove (shared by the shop list + the piece panel) -----
  function rotateAt(o, i) {
    const f = (o.furn || [])[i]; if (!f || !TYPES[f.t]) return { ok: false };
    if ((f.t | 0) === T_DESK && deskRider(o, i) >= 0) { toast('<b>A computer is sitting on that desk.</b> MOVE or SELL the computer first.', 'warn'); return { ok: false, why: 'rider' }; }   // v2.58 HOME OFFICE
    const was = f.r | 0;
    f.r = (was + 1) % 4;
    const b = (CITY.buildingPolys || []).find(x => x.bkey === o.bkey);
    const rects = unitRects(o, b);
    const v = validSpot(f.x, f.z, o, rects, f.t, f.r, i);
    if (!v.ok) {
      f.r = was;
      toast('<b>It would not fit that way</b> — something is in the way.', 'warn');
      return { ok: false, why: v.why };
    }
    try { saveGame(); } catch (er) { }
    ensureBuilt(o.bkey);
    return { ok: true, r: f.r };
  }
  function removeAt(o, i) {
    const f = (o.furn || [])[i]; if (!f || !TYPES[f.t]) return { ok: false };
    if ((f.t | 0) === T_DESK && deskRider(o, i) >= 0) { toast('<b>A computer is sitting on that desk.</b> MOVE or SELL the computer first.', 'warn'); return { ok: false, why: 'rider' }; }   // v2.58 HOME OFFICE
    const T = TYPES[f.t];
    let txt;
    if (f.craft) {
      const rf = refundOf(T);
      for (const k in rf) if (rf[k] > 0) STATE.mat[k] = Math.min(1e6, +((shed(k)) + rf[k]).toFixed(1));
      txt = Object.entries(rf).filter(([, n]) => n > 0).map(([k, n]) => n + ' t ' + k.toLowerCase()).join(' \u00b7 ') + ' back to the shed';
    } else {
      earn(Math.round(T.price * SELL_BACK), false);   // resale doesn't count toward GDP
      txt = fmt$(Math.round(T.price * SELL_BACK)) + ' back in cash';
    }
    o.furn.splice(i, 1);
    try { saveGame(); } catch (er) { }
    ensureBuilt(o.bkey);
    toast(T.icon + ' <b>' + T.name + ' removed</b> — ' + txt + '.');
    try { OH.refresh(); } catch (er) { }
    return { ok: true, got: txt };
  }

  // ---- the piece panel (click a placed piece in the world) -------------
  function openPiece(o, i) {
    const f = (o.furn || [])[i]; if (!f) return;
    const T = TYPES[f.t]; if (!T) return;
    const rfTxt = f.craft
      ? Object.entries(refundOf(T)).filter(([, n]) => n > 0).map(([k, n]) => n + ' t ' + k.toLowerCase()).join(' \u00b7 ') + ' back to the shed'
      : fmt$(Math.round(T.price * SELL_BACK)) + ' back in cash';
    openModal(T.icon + ' ' + T.name + ' \u2014 your furniture', `
      <p>A <b>${T.name.toLowerCase()}</b> standing in <b>${o.name}</b> — ${f.craft ? 'crafted from your own materials' : 'bought with cash'}. Turn it, walk it to a new spot, or sell it back for ${Math.round(SELL_BACK * 100)}%.</p>
      <div class="kv"><span class="k">SIZE</span><span class="v">${T.w.toFixed(2)} \u00d7 ${T.d.toFixed(2)} m \u00b7 facing ${((f.r | 0) * 90)}\u00b0</span></div>
      <div class="kv"><span class="k">REMOVE</span><span class="v">${rfTxt}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn primary" id="fp-rot" style="flex:1">ROTATE \u21bb 90\u00b0</button>
        <button class="btn good" id="fp-mv" style="flex:1">MOVE</button>
        <button class="btn bad" id="fp-rm">SELL</button>
        <button class="btn" id="fp-x">CLOSE</button>
      </div>`);
    document.getElementById('fp-rot').onclick = () => {
      if (rotateAt(o, i)) openPiece(o, i);   // re-render with the new facing
    };
    document.getElementById('fp-mv').onclick = () => {
      const b = (CITY.buildingPolys || []).find(x => x.bkey === o.bkey);
      const rects = unitRects(o, b);
      closeModal();
      startMoving(o, b, rects, i);
    };
    document.getElementById('fp-rm').onclick = () => { removeAt(o, i); closeModal(); };
    document.getElementById('fp-x').onclick = closeModal;
  }

  // ---- the shop modal ---------------------------------------------------
  function openShop(bkey, kind, index) {
    const o = (STATE.rooms || []).find(r => r.bkey === bkey && r.kind === kind && r.index === index);
    if (!o) { toast('Buy or rent that ' + (kind === 'floor' ? 'floor' : 'room') + ' first \u2014 furniture goes in your own space.', 'warn'); return; }
    const b = (CITY.buildingPolys || []).find(x => x.bkey === bkey);
    if (!b) { toast('That building is not standing here \u2014 travel to ' + (o.cityName || o.cityKey) + ' first.', 'warn'); return; }
    let st = null;
    try { st = OH.state(); } catch (er) { }
    if (!st || !st.open || st.open.bkey !== bkey) {
      try { OH.force(bkey); } catch (er) { }        // open it: the layout drives the rects
    }
    // always (re)pick the unit — it re-glides the camera level with your
    // space, so the floor you are about to furnish is the one you see
    try { if (kind === 'floor') OH.selectFloor(index); else OH.selectRoom(index); } catch (er) { }
    const rects = unitRects(o, b);
    if (!rects.length) { toast('Could not open that ' + (kind === 'floor' ? 'floor' : 'room') + ' here.', 'warn'); return; }
    renderShop(o, b, rects);
  }
  function openShopFor(o) { if (o) openShop(o.bkey, o.kind, o.index); }
  function renderShop(o, b, rects) {
    const cap = capOf(o.area), n = (o.furn || []).length;
    const shedLine = ['Wood', 'Stone', 'Steel', 'Glass'].map(k => k + ' ' + (Math.round(shed(k) * 10) / 10) + ' t').join(' \u00b7 ');
    const cards = TYPES.map((T, i) => {
      const canC = matReady(T) && n < cap, canB = STATE.money >= T.price && n < cap;
      return '<div class="mshop-card' + (n >= cap ? ' dim' : '') + '">' +
        '<div class="mshop-info"><b>' + T.icon + ' ' + T.name + '</b><span>' + T.w.toFixed(2) + ' \u00d7 ' + T.d.toFixed(2) +
        ' m \u00b7 craft: ' + billStr(T) + (i === T_COMP ? ' \u00b7 <b>sits on a desk</b>' : '') + '</span></div>' +
        '<div class="mshop-buy"><span>' + fmt$(T.price) + '</span>' +
        '<button class="btn' + (canC ? ' good' : '') + '" data-fc="' + i + '"' + (canC ? '' : ' disabled') + '>CRAFT</button>' +
        '<button class="btn primary" data-fb="' + i + '"' + (canB ? '' : ' disabled') + '>BUY</button></div></div>';
    }).join('');
    const mine = (o.furn || []).map((f, i) => TYPES[f.t] ?
      '<div class="kv"><span class="k">' + TYPES[f.t].icon + ' ' + TYPES[f.t].name + ' \u00b7 ' + ((f.r | 0) * 90) + '\u00b0' + (f.craft ? ' \u00b7 crafted' : '') + '</span>' +
      '<span><button class="tpbtn" data-fr="' + i + '">\u21bb</button> <button class="tpbtn" data-fm="' + i + '">MOVE</button> ' +
      '<button class="tpbtn" data-fs="' + i + '">' + (f.craft ? 'SELL (MATS)' : 'SELL ' + fmt$(Math.round(TYPES[f.t].price * SELL_BACK))) + '</button></span></div>' : '').join('');
    openModal('FURNITURE \u2014 ' + o.name, `
      <p>Furnish <b>${o.name}</b>: pick a piece, then <b>click a spot inside your space</b> to set it down — <b>R rotates</b> the ghost, DONE ends. Craft from your shed's materials (the cheap path) or buy with cash. Click any placed piece in the world to turn, move or sell it. Computers <b>sit on desks</b> — place a desk, then aim for its top.</p>
      <div class="kv"><span class="k">YOUR SPACE</span><span class="v">${o.area} m\u00b2 \u00b7 ${n}/${cap} pieces placed</span></div>
      <div class="kv"><span class="k">THE SHED</span><span class="v">${shedLine} \u2014 buy tonnes at the yard (BUILD)</span></div>
      <div id="mshop">${cards}</div>
      ${mine ? '<div class="msec" style="margin-top:12px">Placed \u2014 \u21bb turns it, MOVE walks it, SELL clears it</div>' + mine : ''}
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="fs-x" style="flex:1">CLOSE</button></div>`);
    document.querySelectorAll('#mshop [data-fc]').forEach(el => {
      el.onclick = () => {
        const t = +el.dataset.fc, T = TYPES[t];
        if (n >= cap) { toast('<b>' + o.name + ' is full</b> (' + cap + ' pieces for ' + o.area + ' m\u00b2).', 'warn'); return; }
        if (!matReady(T)) { toast('<b>Short on materials.</b> The ' + T.name + ' takes ' + billStr(T) + ' — buy tonnes at the yard (BUILD) or pull steel and glass from the exchange.', 'warn'); return; }
        startPlacing(o, b, rects, t, 'craft');
      };
    });
    document.querySelectorAll('#mshop [data-fb]').forEach(el => {
      el.onclick = () => {
        const t = +el.dataset.fb, T = TYPES[t];
        if (n >= cap) { toast('<b>' + o.name + ' is full</b> (' + cap + ' pieces for ' + o.area + ' m\u00b2).', 'warn'); return; }
        if (STATE.money < T.price) { toast('<b>Not enough money.</b> The ' + T.name + ' costs ' + fmt$(T.price) + '.', 'warn'); return; }
        startPlacing(o, b, rects, t, 'buy');
      };
    });
    document.querySelectorAll('[data-fr]').forEach(el => {
      el.onclick = () => { rotateAt(o, +el.dataset.fr); renderShop(o, b, rects); };
    });
    document.querySelectorAll('[data-fm]').forEach(el => {
      el.onclick = () => { closeModal(); startMoving(o, b, rects, +el.dataset.fm); };
    });
    document.querySelectorAll('[data-fs]').forEach(el => {
      el.onclick = () => { removeAt(o, +el.dataset.fs); renderShop(o, b, rects); };
    });
    const x = document.getElementById('fs-x');
    if (x) x.onclick = closeModal;
  }

  // ---- the click path ---------------------------------------------------
  // While placing/moving, EVERY canvas click is a placement/move attempt
  // (this wrap runs FIRST — before the machines, the farm claim, the
  // openhouse inspector and the walk orders — so furnishing never walks
  // the character). Otherwise a click that lands ON a placed piece of the
  // inspected building opens the piece panel.
  function click(cx, cy) {
    if (placing) {
      const pt = rayToFloor(cx, cy, placing.yF);
      if (!pt) { toast('Aim at your floor \u2014 the camera needs to see it.', 'warn'); return true; }
      placeAt(pt.x, pt.z);
      return true;
    }
    if (moving) {
      const pt = rayToFloor(cx, cy, moving.yF);
      if (!pt) return true;
      commitMoveAt(pt.x, pt.z);
      return true;
    }
    try {
      if (STATE.mode !== 'city' || !CITY.group) return false;
      if (window.MACH && MACH.placing()) return false;      // a machine install wins its clicks
      if (window.BLD && BLD.arming()) return false;         // a building placement wins its clicks
      let st = null; try { st = OH.state(); } catch (er) { }
      if (!st || !st.open) return false;
      const list = built.get(st.open.bkey) || [];
      if (!list.length) return false;
      _ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
      _rc.setFromCamera(_ndc, camera);
      const hits = _rc.intersectObjects(list.map(e => e.g), true);
      for (const h of hits) {
        if (!h || !h.point) continue;
        let g = h.object;
        while (g && !(g.userData && g.userData.furn)) g = g.parent;   // climb to the tagged root
        if (!g || !g.userData || !g.userData.furn) continue;
        if (!g.visible) continue;                                     // a hidden floor's piece
        const ud = g.userData.furn;
        const hold = (STATE.rooms || []).find(r => r.bkey === ud.bkey && r.kind === ud.kind && r.index === ud.index);
        const f = hold && (hold.furn || [])[ud.i];
        if (!hold || !f) continue;
        if (hold.kind === 'floor' && st.open.floor != null && st.open.floor !== hold.index) continue;
        openPiece(hold, ud.i);
        return true;
      }
      return false;
    } catch (er) { console.error('[furniture]', er); return false; }
  }

  // ---- tick ---------------------------------------------------------------
  function tick(dt) {
    try {
      // city swap -> drop every built mesh (they lived in the old group)
      if (CITY.group !== lastGroup) { lastGroup = CITY.group; disposeAll(); if (placing || moving) exitMode(false); }
      // the inspector drives visibility (and both modes end when it closes)
      let st = null;
      try { st = OH.state(); } catch (er) { }
      if (placing && (!st || !st.open || st.open.bkey !== placing.o.bkey)) exitMode(false);
      if (moving && (!st || !st.open || st.open.bkey !== moving.o.bkey)) exitMode(false);
      if (st && st.open) ensureBuilt(st.open.bkey);
      syncVisibility(st);
      if (moving && moving.mesh) moving.mesh.visible = false;   // the piece hides while its ghost walks
      // the ghost follows the cursor (world coords — CITY.group is at origin)
      const act = placing || moving;
      if (act && lastPtr && ghost && ghostMat) {
        const pt = rayToFloor(lastPtr.x, lastPtr.y, act.yF);
        if (pt) {
          ghost.visible = true;
          const T = TYPES[act.t];
          ghost.position.set(pt.x, act.yF + (act.t === T_COMP && deskUnder(act.o, pt.x, pt.z, act.r) >= 0 ? DESKH : 0) + T.h / 2, pt.z);   // v2.58 HOME OFFICE: the ghost rises to the desk top when it rides
          ghost.rotation.y = (act.r | 0) * Math.PI / 2;
          const v = validSpot(pt.x, pt.z, act.o, act.rects, act.t, act.r, act === moving ? moving.i : -1);
          ghostMat.color.setHex(v.ok ? 0x4dff88 : 0xff5d5d);
        } else ghost.visible = false;
      } else if (ghost) ghost.visible = false;
    } catch (e) { console.error('[furniture]', e); }
  }

  // ---- listeners (once) ----------------------------------------------------
  try {
    canvas.addEventListener('pointermove', e => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true });
    canvas.addEventListener('pointerleave', () => { lastPtr = null; }, { passive: true });
    window.addEventListener('keydown', e => {           // capture: ESC/R end or turn BEFORE the inspector's own ESC
      try {
        if (e.key === 'Escape' && (placing || moving)) { e.stopPropagation(); exitMode(!!placing); return; }
        if ((e.key === 'r' || e.key === 'R') && (placing || moving)) rotateGhost();
      } catch (er) { }
    }, true);
  } catch (er) { }

  return {
    tick, click, openShop, openShopFor, exitMode, TYPES, capOf,
    valueOfRooms, valueOfUnit, rotateAt, removeAt,
    // QA: programmatic placement (no modal, no ghost) — same validation, same commit
    place(bkey, kind, index, t, x, z, r, how) {
      const o = (STATE.rooms || []).find(q => q.bkey === bkey && q.kind === kind && q.index === index);
      if (!o) return { ok: false, why: 'not yours' };
      const b = (CITY.buildingPolys || []).find(v => v.bkey === bkey);
      if (!b) return { ok: false, why: 'no building' };
      const rects = unitRects(o, b);
      if (!rects.length) return { ok: false, why: 'no rects' };
      const fl = o.kind === 'floor' ? o.index : (rects[0] ? rects[0].fl : 0);
      return commitPlace(o, rects, fl, t | 0, (r | 0) % 4, +x, +z, how === 'craft' ? 'craft' : 'buy');
    },
    // QA: programmatic move (same validation)
    move(bkey, kind, index, i, x, z) {
      const o = (STATE.rooms || []).find(q => q.bkey === bkey && q.kind === kind && q.index === index);
      const f = o && (o.furn || [])[i];
      if (!f) return { ok: false, why: 'no piece' };
      if ((f.t | 0) === T_DESK && deskRider(o, i) >= 0) return { ok: false, why: 'rider' };   // v2.58 HOME OFFICE: the desk stays until its computer moves
      const b = (CITY.buildingPolys || []).find(v => v.bkey === bkey);
      const rects = unitRects(o, b);
      const v = validSpot(+x, +z, o, rects, f.t, f.r | 0, i);
      if (!v.ok) return { ok: false, why: v.why };
      f.x = +(+x).toFixed(2); f.z = +(+z).toFixed(2);
      try { saveGame(); } catch (er) { }
      ensureBuilt(bkey);
      return { ok: true };
    },
    // QA: programmatic rotate/remove by identity
    rotate(bkey, kind, index, i) {
      const o = (STATE.rooms || []).find(q => q.bkey === bkey && q.kind === kind && q.index === index);
      if (!o) return { ok: false, why: 'not yours' };
      return rotateAt(o, i);
    },
    remove(bkey, kind, index, i) {
      const o = (STATE.rooms || []).find(q => q.bkey === bkey && q.kind === kind && q.index === index);
      if (!o) return { ok: false, why: 'not yours' };
      return removeAt(o, i);
    },
    // QA: does a piece fit here? (validation only — no commit)
    fits(bkey, kind, index, t, x, z, r) {
      const o = (STATE.rooms || []).find(q => q.bkey === bkey && q.kind === kind && q.index === index);
      if (!o) return { ok: false, why: 'not yours' };
      const b = (CITY.buildingPolys || []).find(v => v.bkey === bkey);
      const rects = unitRects(o, b);
      return validSpot(+x, +z, o, rects, t | 0, (r | 0) % 4, -1);
    },
    placing: () => placing ? { bkey: placing.o.bkey, kind: placing.o.kind, index: placing.o.index, t: placing.t, r: placing.r, how: placing.how, cap: placing.cap } : null,
    moving: () => moving ? { bkey: moving.o.bkey, kind: moving.o.kind, index: moving.o.index, i: moving.i, t: moving.t, r: moving.r } : null,
    meshCount(bkey) { return (built.get(bkey) || []).length; },
    state() {
      const R = STATE.rooms || [];
      return {
        pieces: R.reduce((s, r) => s + (r.furn || []).length, 0),
        value: valueOfRooms(),
        placing: !!placing, moving: !!moving,
      };
    },
  };
})();
window.FURN = FURN;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the click chain: furniture placement/move/piece-pick runs FIRST
//    (before the machines, the openhouse inspector and the walk
//    orders) so furnishing never walks the character or re-picks
//    the building.
const __furnClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (FURN.click(cx, cy)) return; } catch (e) { console.error('[furniture]', e); }
  return __furnClickPick(cx, cy);
});
// 2. the update chain: original -> world forest -> open house ->
//    suburbs -> title deeds -> patchwork -> machines -> landlord ->
//    exchange -> works -> ground up -> FURNITURE. Every call is
//    try/caught so a furniture error can never touch the world.
const __furnOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __furnOrigUpdate(dt, px, pz, camDist);
  try { FURN.tick(dt); } catch (e) { console.error('[furniture]', e); }
  return req;
};

