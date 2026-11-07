// ====================================================================
// js/systems/farmland.js — patchwork farm parcels (Stage 7c):
// tenant income, land market rate. LORD late-bound below.
// ====================================================================
import * as THREE from 'three';
import { CITIES } from '../config.js';
import { _mulberry, fmt$, hashStr } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { LANDGEO } from '../core.js';
import { WORLD, camCtl } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';
import { camera, enterWorld } from '../render/main.js';
import { clickPick, patchClickPick, ray, screenToGround } from '../render/night.js';

// ---- late binding (boot binds after every module evaluates) --------
export let LORD;
export function __late(b) { ({ LORD } = b); }

// ======== section: 48_farmland.js ========
// ====================================================================
// v2.44 — PATCHWORK. The ask: "make squares everywhere in the world
// around the cities people can buy of all shapes and sizes like in
// this picture with the exact same look" — the picture being a
// satellite photo of farm country: a quilt of green rectangles in
// every shade, a road, tree clumps, roofs at the edges.
//
// What this adds, all ADDITIVE (one new section + the usual annotated
// touchpoints, the exact pattern v2.39/42/43 shipped):
//   - the open country past every city's suburb ring now wears a
//     PATCHWORK of farm parcels — rectangles of all shapes and sizes
//     (30 m strips to 400 m fields) divided by darker hedge lines,
//     tinted from a satellite-green palette with occasional plough
//     stripes and harvested tans. The lattice is a jittered global
//     grid, so the quilt is continuous across the whole Earth at 1:1
//     and every parcel's identity is deterministic (same parcel, same
//     price, same name, every session, on every machine).
//   - EVERY PARCEL IS BUYABLE: zoom out past ~300 m and the whole
//     quilt becomes a land catalog — hover any field for its size and
//     price, click it to buy. At street level a small FOR SALE
//     signpost stands in every field (click it), and plain ground
//     clicks keep their walk-to meaning.
//   - OWNERSHIP: a bought field pays tenant rent every day (same beat
//     as office suites and title deeds), its hedge border turns GOLD,
//     the sign goes away, it counts in the WORTH ticker at purchase
//     price, lists in the Empire panel with one-tap TELEPORT, and
//     sells back any time for 60%. Persisted as an optional `acres`
//     pack field (pack stays v5 — older builds ignore it).
//   - GUARDS: never inside a city or its suburb ring (past 2.4 km),
//     never in water (centre + all four corners must be dry, so no
//     field bleeds into a lake or the sea), and the quilt plane rides
//     at .028 under every road (.095), vendor pad (.105) and sidewalk
//     (.16) — with the two tiny pond lifts annotated "v2.44" so the
//     little blue ponds keep their water over the fields.
//
// Mechanically it mirrors the world-forest streaming it follows: same
// 500 m chunk grid, same focus rule (character while following,
// panned view while roaming), same 400 ms cadence and 2-chunks-per-
// frame budget; the quilted zone breathes out with altitude (1.2 km
// at street level up to 3 km once you are a kilometre up) and the
// FOR SALE signs hide past 900 m exactly like the suburb houses do.
// window.FARM is the QA surface.
// ====================================================================
export const FARM = (() => {
  const CH = 500;                       // same chunk grid as everything else
  const MOB = matchMedia('(pointer:coarse)').matches;
  const BASE_R = MOB ? 800 : 1200;      // quilted radius at street level
  const MAX_R = MOB ? 1700 : 3000;      // breathing room with altitude
  const DISPOSE_R = MAX_R + 450;        // fixed hysteresis, like the forest
  const SUB_R = 2400;                   // quilt starts past the suburb ring (2360)
  const LAT_B = 260, LAT_J = 70;        // jittered parcel lattice (cells 120–400 m)
  const Y_F = .028, Y_S = .0295, Y_H = .032;   // field / stripe / hedge heights
  const RO_QUILT = 1.8;                 // flat-ground ladder: above the plate (1.6), under the skyline (2)
  const CAP = 150;                      // land holdings cap
  const SELL_BACK = .6;
  const SHOP_DIST = 300;                // camDist ≥ this: the quilt is a land catalog
  const SIGN_DIST = 900;                // signposts hide past this (sub-pixel specks)
  const HW = 2.4;                       // hedge border width

  // satellite farm palette — greens of every shade, rare tans/straws
  const wcol = h => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
  const PAL = [0x5d8a41, 0x69913f, 0x74a04a, 0x7fae52, 0x8fb75a, 0x9cbf62,
    0x6f8c3c, 0xa3b266, 0x557f3a, 0x8ab054].map(wcol);
  const RARE = [0xb3a45e, 0xb9c47e].map(wcol);        // harvested / pale straw
  const HEDGE = wcol(0x3f5c33), GOLD = wcol(0xf5cc74);
  const POST = wcol(0x6e5138), BOARD = wcol(0xf4ead0), INK = wcol(0x4a3a28);
  const FN = ['Wheat', 'Barley', 'Clover', 'Meadow', 'Orchard', 'Corn', 'Rye', 'Oat',
    'Hay', 'Bean', 'Pea', 'Flax', 'Alder', 'Birch', 'Cedar', 'Maple', 'Willow', 'Hazel'];
  const FS = ['Field', 'Plot', 'Grounds', 'Flat', 'Acre', 'Row'];

  const chunks = new Map();             // 'cx,cz' -> group | null (null = built empty)
  const cells = new Map();              // 'k,m' -> parcel recs (deterministic)
  let queue = [], lastUpd = 0, root = null;
  let signMeshes = [], lastSignVis = null;
  let acc = 0;                          // income accumulator (1 s beat, like rooms)

  // ---- helpers ---------------------------------------------------------
  function nearCity(x, z) {
    let best = 1e9;
    for (const c of CITIES) { const d = Math.hypot(x - c.wx, z - c.wz); if (d < best) best = d; }
    return best;
  }
  function nearestCity(x, z) {
    let best = null;
    for (const c of CITIES) { const d = Math.hypot(x - c.wx, z - c.wz); if (!best || d < best.d) best = { c, d }; }
    return best;
  }
  const isW = (x, z) => { try { return !!(LANDGEO.ready && LANDGEO.isWaterWorld(x, z)); } catch (e) { return false; } };

  // ---- the jittered lattice (global, deterministic, seam-free) ---------
  function lineX(k) { return k * LAT_B + (hashStr('fq' + k) % (LAT_J * 2 + 1)) - LAT_J; }
  function lineZ(m) { return m * LAT_B + (hashStr('fr' + m) % (LAT_J * 2 + 1)) - LAT_J; }
  function cellK(x) {
    const k0 = Math.floor(x / LAT_B);
    for (let k = k0 - 1; k <= k0 + 1; k++) if (lineX(k) <= x && x < lineX(k + 1)) return k;
    return k0;
  }
  function cellM(z) {
    const m0 = Math.floor(z / LAT_B);
    for (let m = m0 - 1; m <= m0 + 1; m++) if (lineZ(m) <= z && z < lineZ(m + 1)) return m;
    return m0;
  }

  // ---- the parcels of one lattice cell ---------------------------------
  // Recursive binary splits at jittered fractions (sometimes an extreme
  // .16–.31 split — that's what makes long strip fields), so every cell
  // carries 1–8 rectangles of genuinely varied shapes and sizes.
  function cellParcels(k, m) {
    const key = k + ',' + m;
    let arr = cells.get(key);
    if (arr) return arr;
    const rnd = _mulberry(hashStr('fc' + k + '_' + m));
    const x0 = lineX(k), x1 = lineX(k + 1), z0 = lineZ(m), z1 = lineZ(m + 1);
    const rects = [];
    (function split(rx0, rz0, rx1, rz1, depth) {
      const w = rx1 - rx0, d = rz1 - rz0, mn = Math.min(w, d);
      if (depth >= 3 || mn < 70 || (mn < 170 && rnd() < .62)) { rects.push([rx0, rz0, rx1, rz1]); return; }
      const t = rnd() < .25 ? .16 + rnd() * .15 : .3 + rnd() * .4;
      if (w >= d) { const xm = rx0 + w * t; split(rx0, rz0, xm, rz1, depth + 1); split(xm, rz0, rx1, rz1, depth + 1); }
      else { const zm = rz0 + d * t; split(rx0, rz0, rx1, zm, depth + 1); split(rx0, zm, rx1, rz1, depth + 1); }
    })(x0, z0, x1, z1, 0);
    arr = [];
    rects.forEach((rc, i) => {
      const [rx0, rz0, rx1, rz1] = rc;
      const cx = (rx0 + rx1) / 2, cz = (rz0 + rz1) / 2;
      const w = rx1 - rx0, d = rz1 - rz0, ha = w * d / 1e4;
      const id = 'f' + k + '_' + m + '_' + i;
      const h = hashStr(id), h2 = hashStr(id + 'x');
      const base = (h2 % 100) < 9 ? RARE[h % RARE.length] : PAL[h % PAL.length];
      const jit = .94 + (h2 % 100) / 100 * .12;
      const nc = nearestCity(cx, cz);
      const rate = Math.max(6, Math.round(12 + ha * 7.8 + (h % 5) * 3));   // v2.46 PREMIUM LAND: 3x the tenant rent (was 4+ha*2.6+h%5)
      arr.push({
        id, x0: rx0, z0: rz0, x1: rx1, z1: rz1, cx, cz, w, d, ha,
        color: [base[0] * jit, base[1] * jit, base[2] * jit],
        striped: (h2 % 100) > 30 && Math.min(w, d) > 60,      // a third of the fields carry plough stripes
        ry: (h % 628) / 100,
        name: FN[h % FN.length] + ' ' + FS[h2 % FS.length],
        rate,
        price: Math.max(750, Math.round(rate * 47 / 10) * 10),   // v2.46 PREMIUM LAND: ~10x the sticker, 47-day payback (was 14 days / $80 floor)
        near: nc && nc.d < 120000 ? nc.c.name : null,
        nearKey: nc ? nc.c.key : null,
        usable: null,                                          // lazy — LANDGEO may still be loading
      });
    });
    if (cells.size > 6000) cells.clear();
    cells.set(key, arr);
    return arr;
  }

  function usable(p) {
    if (p.usable !== null) return p.usable;
    let ok = nearCity(p.cx, p.cz) >= SUB_R;                   // never in a city or its suburbs
    if (ok && LANDGEO.ready) {                                // dry land only — centre + all four corners
      if (isW(p.cx, p.cz) || isW(p.x0, p.z0) || isW(p.x1, p.z0) || isW(p.x0, p.z1) || isW(p.x1, p.z1)) ok = false;
      p.usable = ok;
    }
    return ok;
  }

  function parcelAt(x, z) {
    const arr = cellParcels(cellK(x), cellM(z));
    for (const p of arr)
      if (x >= p.x0 && x < p.x1 && z >= p.z0 && z < p.z1) return usable(p) ? p : null;
    return null;
  }

  // ---- geometry builders (chunk-local frame, float32-safe at 1:1) ------
  function pushQuad(b, x0, z0, x1, z1, y, c) {
    b.pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
    for (let i = 0; i < 6; i++) b.col.push(c[0], c[1], c[2]);
  }
  const _BOX = new THREE.BoxGeometry(1, 1, 1);
  const _m4 = new THREE.Matrix4(), _q4 = new THREE.Quaternion(), _e4 = new THREE.Euler();
  const _nm4 = new THREE.Matrix3(), _v4a = new THREE.Vector3(), _v4b = new THREE.Vector3(), _s4 = new THREE.Vector3();
  function pushBox(b, x, y, z, ry, sx, sy, sz, c) {
    _e4.set(0, ry, 0); _q4.setFromEuler(_e4);
    _m4.compose(_v4a.set(x, y, z), _q4, _s4.set(sx, sy, sz));
    _nm4.getNormalMatrix(_m4);
    const p = _BOX.attributes.position, n = _BOX.attributes.normal, idx = _BOX.index.array;
    for (let i = 0; i < idx.length; i++) {
      const vi = idx[i];
      _v4a.fromBufferAttribute(p, vi).applyMatrix4(_m4);
      _v4b.fromBufferAttribute(n, vi).applyMatrix3(_nm4).normalize();
      b.pos.push(_v4a.x, _v4a.y, _v4a.z);
      b.norm.push(_v4b.x, _v4b.y, _v4b.z);
      b.col.push(c[0], c[1], c[2]);
      b.uv.push(0, 0);
    }
  }
  function toMesh(b, flat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    if (flat) {
      const nm = new Float32Array((b.pos.length / 3) * 3);
      for (let i = 0; i < nm.length; i += 3) { nm[i] = 0; nm[i + 1] = 1; nm[i + 2] = 0; }
      g.setAttribute('normal', new THREE.BufferAttribute(nm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((b.pos.length / 3) * 2), 2));
    } else {
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  }
  const goldTint = c => [c[0] + (GOLD[0] - c[0]) * .18, c[1] + (GOLD[1] - c[1]) * .18, c[2] + (GOLD[2] - c[2]) * .18];

  // ---- the chunk builder ------------------------------------------------
  function build(cx, cz) {
    const key = cx + ',' + cz;
    if (chunks.has(key)) return;
    chunks.set(key, null);                 // reserve — built, even if it ends up empty
    const x0 = cx * CH, z0 = cz * CH, xm = x0 + CH / 2, zm = z0 + CH / 2;
    // whole-chunk water — nothing to farm
    if (isW(xm, zm) && isW(x0, z0) && isW(x0 + CH, z0) && isW(x0, z0 + CH) && isW(x0 + CH, z0 + CH)) return;
    // whole chunk inside the city + suburb zone
    if (nearCity(xm, zm) < SUB_R - CH * .8) return;

    const Q = { pos: [], col: [] };                       // the quilt (fields + stripes + hedges)
    const S = { pos: [], norm: [], uv: [], col: [] };     // the FOR SALE signposts
    const signs = [];
    const owned = new Set((STATE.acres || []).map(a => a.id));

    // every lattice cell whose CENTRE lives in this chunk (seam-free: a
    // cell belongs to exactly one chunk, whoever builds it)
    const k0 = Math.floor((x0 - LAT_B) / LAT_B) - 1, k1 = Math.floor((x0 + CH + LAT_B) / LAT_B) + 1;
    const m0 = Math.floor((z0 - LAT_B) / LAT_B) - 1, m1 = Math.floor((z0 + CH + LAT_B) / LAT_B) + 1;
    for (let k = k0; k <= k1; k++) for (let m = m0; m <= m1; m++) {
      const ccx = (lineX(k) + lineX(k + 1)) / 2, ccz = (lineZ(m) + lineZ(m + 1)) / 2;
      if (ccx < x0 || ccx >= x0 + CH || ccz < z0 || ccz >= z0 + CH) continue;
      for (const p of cellParcels(k, m)) {
        if (!usable(p)) continue;
        const own = owned.has(p.id);
        const lx0 = p.x0 - xm, lz0 = p.z0 - zm, lx1 = p.x1 - xm, lz1 = p.z1 - zm;
        const fc = own ? goldTint(p.color) : p.color;
        pushQuad(Q, lx0, lz0, lx1, lz1, Y_F, fc);
        // plough stripes — darker bands across the short axis
        if (p.striped && !own) {
          const sc = [fc[0] * .9, fc[1] * .9, fc[2] * .9];
          const short = Math.min(p.w, p.d);
          const n = Math.max(2, Math.min(5, Math.round(short / 70)));
          const sw = short / (n * 2);
          for (let i = 0; i < n; i++) {
            if (p.w >= p.d) { const a = lz0 + (i * 2 + 1) * sw, b = a + sw; pushQuad(Q, lx0, a, lx1, b, Y_S, sc); }
            else { const a = lx0 + (i * 2 + 1) * sw, b = a + sw; pushQuad(Q, a, lz0, b, lz1, Y_S, sc); }
          }
        }
        // the hedge border — gold when the field is yours
        const hc = own ? GOLD : HEDGE;
        pushQuad(Q, lx0, lz0, lx1, lz0 + HW, Y_H, hc);
        pushQuad(Q, lx0, lz1 - HW, lx1, lz1, Y_H, hc);
        pushQuad(Q, lx0, lz0, lx0 + HW, lz1, Y_H, hc);
        pushQuad(Q, lx1 - HW, lz0, lx1, lz1, Y_H, hc);
        // a small FOR SALE signpost at the centre (street-level buy entry)
        if (!own && p.ha >= .3) {
          let onRoad = false;
          try { onRoad = WORLD.nearRoad(p.cx, p.cz, 8); } catch (e) { }
          if (!onRoad) {
            pushBox(S, p.cx - xm, .75, p.cz - zm, p.ry, .1, 1.5, .1, POST);
            pushBox(S, p.cx - xm, 1.28, p.cz - zm, p.ry, 1.45, .75, .07, BOARD);
            pushBox(S, p.cx - xm, 1.3, p.cz - zm, p.ry, 1.02, .16, .09, INK);   // the painted line — reads as writing from afar
            signs.push({ x: p.cx, z: p.cz, p });
          }
        }
      }
    }

    const cg = new THREE.Group();
    if (Q.pos.length) {
      const mesh = toMesh(Q, true);
      mesh.position.set(xm, 0, zm);
      mesh.renderOrder = RO_QUILT;         // v2.44 flat-ground ladder rung
      mesh.receiveShadow = true;
      cg.add(mesh);
    }
    if (S.pos.length) {
      const mesh = toMesh(S, false);
      mesh.position.set(xm, 0, zm);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.signs = signs;
      mesh.visible = lastSignVis !== false;
      signMeshes.push(mesh);
      cg.add(mesh);
    }
    if (!cg.children.length) return;
    if (root) root.add(cg);
    chunks.set(key, cg);
  }

  function dispose(key) {
    const cg = chunks.get(key);
    if (cg) {
      cg.traverse(o => { if (o.geometry) { try { o.geometry.dispose(); } catch (e) { } } });
      cg.children.forEach(ch => {
        const i = signMeshes.indexOf(ch);
        if (i >= 0) signMeshes.splice(i, 1);
      });
      if (cg.parent) cg.parent.remove(cg);
    }
    chunks.delete(key);
  }
  function reset() {
    for (const key of [...chunks.keys()]) dispose(key);
    queue = []; signMeshes = []; lastSignVis = null;
  }
  function rebuildAt(x, z) {         // a purchase re-draws its chunk (gold border, no sign)
    const key = Math.floor(x / CH) + ',' + Math.floor(z / CH);
    if (!chunks.has(key)) return;
    dispose(key);
    const [cx, cz] = key.split(',').map(Number);
    build(cx, cz);
  }

  // ---- the deal ---------------------------------------------------------
  function commit(par) {
    const A = STATE.acres || (STATE.acres = []);
    if (A.find(a => a.id === par.id)) return { ok: false, why: 'taken' };
    if (A.length >= CAP) return { ok: false, why: 'cap' };
    if (!spend(par.price)) return { ok: false, why: 'funds', cost: par.price };
    A.push({ id: par.id, name: par.name, ha: par.ha, price: par.price, rate: par.rate,
      x: par.cx, z: par.cz, near: par.near, nearKey: par.nearKey });
    try { saveGame(); } catch (e) { }
    rebuildAt(par.cx, par.cz);
    return { ok: true, cost: par.price };
  }
  function openBuy(par) {
    openModal(par.name + ' \u2014 Farm Parcel', `
      <p>A <b>${par.ha.toFixed(1)} ha</b> parcel of open farmland${par.near ? ' out past <b>' + par.near + '</b>' : ' in the open country'} — buy it and tenant farmers work the land, paying you <b>$${par.rate}/day</b>. Yours forever; sell it back any time for 60%.</p>
      <div class="kv"><span class="k">SIZE</span><span class="v">${par.ha.toFixed(1)} ha \u00b7 ${Math.round(par.ha * 1e4).toLocaleString('en-US')} m\u00b2</span></div>
      <div class="kv"><span class="k">PRICE</span><span class="v g">${fmt$(par.price)}</span></div>
      <div class="kv"><span class="k">FARM INCOME</span><span class="v g">+$${par.rate}/day</span></div>
      <div class="kv"><span class="k">BALANCE</span><span class="v">${fmt$(STATE.money)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn good" id="fa-go" style="flex:1">BUY ${par.name.toUpperCase()}</button>
        <button class="btn" id="fa-x">CLOSE</button>
      </div>`);
    document.getElementById('fa-go').onclick = () => {
      const res = commit(par);
      if (!res.ok) {
        if (res.why === 'cap') toast('<b>Land cap reached</b> (' + CAP + ' parcels). Sell some farmland first.', 'warn');
        else if (res.why === 'funds') toast('<b>Not enough money.</b> Serve some food first.', 'warn');
        else toast('That parcel is already yours.', 'warn');
        return;
      }
      closeModal();
      toast('Bought <b>' + par.name + '</b> for ' + fmt$(res.cost) + ' \u2014 the farmers move in and pay $' + par.rate + '/day.');
    };
    document.getElementById('fa-x').onclick = closeModal;
  }
  function openManage(a) {
    if (!a) return;
    openModal(a.name + ' \u2014 Your Farmland', `
      <div id="pl"><span class="l">Income</span><span class="v">+$${(a.rate / 90 * 60).toFixed(2)}/min</span></div>
      <div class="kv"><span class="k">LOCATION</span><span class="v">${a.near ? 'Open country near ' + a.near : 'The open country'}</span></div>
      <div class="kv"><span class="k">SIZE</span><span class="v">${a.ha.toFixed(1)} ha</span></div>
      <div class="kv"><span class="k">RENT</span><span class="v g">$${a.rate}.00 /day</span></div>
      <div class="kv"><span class="k">RESALE VALUE</span><span class="v">${fmt$(Math.round(a.price * SELL_BACK))}</span></div>
      ${(function () { try { return window.LORD ? LORD.tagLine(a.id, true) : ''; } catch (er) { return ''; } })()}   <!-- v2.47 LANDLORD -->
      <button class="btn good" id="fm-rent" style="width:100%;margin-top:14px">RENT OUT THE FARM — SET YOUR PRICE</button>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn primary" id="fm-tp" style="flex:1">TELEPORT THERE</button>
        <button class="btn bad" id="fm-sell">SELL \u2014 ${fmt$(Math.round(a.price * SELL_BACK))}</button>
        <button class="btn" id="fm-x">CLOSE</button>
      </div>`);
    document.getElementById('fm-tp').onclick = () => travelTo(a);
    document.getElementById('fm-sell').onclick = () => {
      STATE.acres = (STATE.acres || []).filter(x => x !== a);
      earn(Math.round(a.price * SELL_BACK), false);   // resale proceeds don't count toward GDP
      try { saveGame(); } catch (e) { }
      rebuildAt(a.x, a.z);
      closeModal();
      toast('Sold <b>' + a.name + '</b> for ' + fmt$(Math.round(a.price * SELL_BACK)) + '.');
    };
    document.getElementById('fm-x').onclick = closeModal;
    const fmr = document.getElementById('fm-rent');   // v2.47 LANDLORD: rent the field out at your own price
    if (fmr) fmr.onclick = () => { try { LORD.open(a.id); } catch (er) { } };
  }

  // ---- travel (one world, one tap) ---------------------------------------
  function travelTo(a) {
    if (!a) return;
    closeModal();
    const p = ACTORS.player && ACTORS.player.group.position;
    const local = STATE.mode === 'city' && WORLD.group && p && Math.hypot(p.x - a.x, p.z - a.z) < 3000;
    if (local) {
      try { ACTORS.clearGoal(); } catch (e) { }
      ACTORS.placePlayer(a.x, a.z);
      camCtl.tx = a.x; camCtl.tz = a.z;
      camCtl.follow = true; camCtl.distT = 64;
      ECO.arrivalPulse(a.x, a.z);
      toast('\u26a1 Teleported to your <b>' + a.name + '</b>.', 'warn');
      return;
    }
    const c = nearestCity(a.x, a.z);
    if (!c) return;
    enterWorld({ key: c.c.key, name: c.c.name, lat: c.c.lat, lon: c.c.lon, tier: c.c.tier },
      { at: { x: a.x, z: a.z } });
  }

  // ---- the Empire panel rows --------------------------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    const A = STATE.acres || [];
    const rows = A.map((a, i) =>
      '<div class="kv"><span class="k">' + a.name + ' \u00b7 ' + a.ha.toFixed(1) + ' ha \u00b7 ' +
      (a.near || 'open country') + ' \u00b7 $' + a.rate + '/day</span>' +
      '<button class="tpbtn" data-fa="' + i + '">TELEPORT</button></div>').join('');
    const inc = A.reduce((s, a) => s + a.rate, 0);
    const ha = A.reduce((s, a) => s + a.ha, 0);
    const html = '<div class="msec" style="margin-top:14px">Farmland \u2014 your acres</div>' +
      (rows || '<p>No farmland yet. Zoom out over the open country and click a field (or walk up to a FOR SALE sign) to buy it.</p>') +
      (rows ? '<div class="kv" style="margin-top:10px"><span class="k">FARM INCOME</span><span class="v g">+$' + (inc / 90 * 60).toFixed(2) + '/min \u00b7 ' + ha.toFixed(1) + ' ha owned</span></div>' : '');
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    body.querySelectorAll('[data-fa]').forEach(b => {
      b.onclick = () => { travelTo(A[+b.dataset.fa]); };
    });
  }

  // ---- picking ----------------------------------------------------------
  const _ndc = new THREE.Vector2();
  function signHit(cx, cy) {
    if (!signMeshes.length) return null;
    _ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    ray.setFromCamera(_ndc, camera);
    const hits = ray.intersectObjects(signMeshes, false);
    if (!hits.length || !hits[0].object.userData || !hits[0].object.userData.signs) return null;
    const idx = Math.floor((hits[0].faceIndex || 0) / 36);      // 3 boxes = 36 triangles per sign
    return hits[0].object.userData.signs[idx] || null;
  }
  function signNear(x, z, r) {
    for (const m of signMeshes) {
      if (!m.visible || !m.userData.signs) continue;
      for (const s of m.userData.signs)
        if (Math.hypot(s.x - x, s.z - z) < r) return s.p;
    }
    return null;
  }
  function pick(cx, cy) {
    if (STATE.mode !== 'city' || !WORLD.group) return false;
    const pt = screenToGround(cx, cy);
    if (!pt) return false;
    // clicks that belong to older systems are never stolen
    try { if (CITY.pointInBuilding && CITY.pointInBuilding(pt.x, pt.z)) return false; } catch (e) { }
    try { if (CITY.plotAt && CITY.plotAt(pt.x, pt.z)) return false; } catch (e) { }
    try { if (WORLD.plotAt && WORLD.plotAt(pt.x, pt.z)) return false; } catch (e) { }
    // 1) a tap on a FOR SALE sign — works at any zoom
    let par = null;
    try { const s = signHit(cx, cy); if (s) par = s.p; } catch (e) { }
    // 2) shopping view (camDist ≥ 300): the whole quilt is a land catalog
    if (!par && camCtl.dist >= SHOP_DIST) {
      try { if (!WORLD.nearRoad(pt.x, pt.z, 10)) par = parcelAt(pt.x, pt.z); } catch (e) { }
    }
    if (!par) return false;
    const own = (STATE.acres || []).find(a => a.id === par.id);
    if (own) openManage(own); else openBuy(par);
    return true;
  }
  function tip(x, z) {
    if (STATE.mode !== 'city' || !WORLD.group) return null;
    const shopping = camCtl.dist >= SHOP_DIST;
    let par = null;
    if (shopping) {
      try { if (!WORLD.nearRoad(x, z, 10)) par = parcelAt(x, z); } catch (e) { }
    }
    if (!par) { try { par = signNear(x, z, 3); } catch (e) { } }
    if (!par) return null;
    const own = (STATE.acres || []).find(a => a.id === par.id);
    if (own) return { t: own.name + ' \u2014 your land', s: own.ha.toFixed(1) + ' ha \u00b7 ' + (own.near || 'open country'), p: '+$' + own.rate + '/day', a: '\u2713 OWNED', l: 'Click to manage' };
    // street level the ground click still walks — the tip teaches the way in
    const hint = shopping ? 'Click to buy' : 'Zoom out to buy \u00b7 or click its FOR SALE sign';
    return { t: par.name, s: par.ha.toFixed(1) + ' ha \u00b7 ' + (par.near ? 'near ' + par.near : 'the open country'), p: fmt$(par.price), a: '\u2713 For sale', l: hint };
  }

  // ---- income (the office-suite / title-deed beat) ----------------------
  function accrue(dt) {
    const A = STATE.acres || [];
    if (STATE.mode !== 'city' || !A.length) { acc = 0; return; }
    acc += dt;
    if (acc >= 1) {
      const secs = acc; acc = 0;
      let inc = 0;
      for (const a of A) inc += a.rate;
      if (inc > 0) earn(inc / 90 * secs);
    }
  }

  // ---- streaming (the world-forest pattern) -----------------------------
  function tick(dt, px, pz, camDist) {
    const r = WORLD.group;
    if (!r) { if (chunks.size) reset(); return; }
    if (r !== root) { reset(); root = r; }
    accrue(dt);
    const now = performance.now();
    const fx = camCtl.follow ? px : camCtl.tx, fz = camCtl.follow ? pz : camCtl.tz;
    const R = Math.min(BASE_R + Math.max(0, camDist - 260) * 1.15, MAX_R);
    if (now - lastUpd > 400) {
      lastUpd = now;
      const c0x = Math.floor((fx - R) / CH), c1x = Math.floor((fx + R) / CH);
      const c0z = Math.floor((fz - R) / CH), c1z = Math.floor((fz + R) / CH);
      const want = new Set();
      for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) want.add(cx + ',' + cz);
      for (const key of [...chunks.keys()]) {
        if (want.has(key)) continue;
        const [cx, cz] = key.split(',').map(Number);
        if (Math.abs(cx * CH + CH / 2 - fx) > DISPOSE_R || Math.abs(cz * CH + CH / 2 - fz) > DISPOSE_R) dispose(key);
      }
      queue = [...want].filter(k => !chunks.has(k))
        .map(k => { const [cx, cz] = k.split(',').map(Number); return { k, cx, cz, d: Math.hypot(cx * CH + CH / 2 - fx, cz * CH + CH / 2 - fz) }; })
        .sort((a, b) => a.d - b.d);
    }
    for (let i = 0; i < 2 && queue.length; i++) {
      const job = queue.shift();
      build(job.cx, job.cz);
    }
    // sign LOD — past 900 m the posts are sub-pixel specks (like suburb houses)
    const sv = camDist < SIGN_DIST;
    if (sv !== lastSignVis) {
      lastSignVis = sv;
      for (const m of signMeshes) m.visible = sv;
    }
  }

  // ---- QA ---------------------------------------------------------------
  function audit() {
    let parcels = 0, badCity = 0, badWater = 0, signs = 0;
    for (const g of chunks.values()) {
      if (!g) continue;
      for (const ch of g.children) {
        const ss = ch.userData && ch.userData.signs;
        if (ss) signs += ss.length;
      }
    }
    const seen = new Set();
    for (const key of chunks.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      const x0 = cx * CH, z0 = cz * CH;
      const k0 = Math.floor((x0 - LAT_B) / LAT_B) - 1, k1 = Math.floor((x0 + CH + LAT_B) / LAT_B) + 1;
      const m0 = Math.floor((z0 - LAT_B) / LAT_B) - 1, m1 = Math.floor((z0 + CH + LAT_B) / LAT_B) + 1;
      for (let k = k0; k <= k1; k++) for (let m = m0; m <= m1; m++) {
        const ccx = (lineX(k) + lineX(k + 1)) / 2, ccz = (lineZ(m) + lineZ(m + 1)) / 2;
        if (ccx < x0 || ccx >= x0 + CH || ccz < z0 || ccz >= z0 + CH) continue;
        for (const p of cellParcels(k, m)) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          parcels++;
          if (nearCity(p.cx, p.cz) < SUB_R) badCity++;
          if (isW(p.cx, p.cz) || isW(p.x0, p.z0) || isW(p.x1, p.z0) || isW(p.x0, p.z1) || isW(p.x1, p.z1)) badWater++;
        }
      }
    }
    return { parcels, badCity, badWater, signs, chunks: chunks.size };
  }

  return {
    tick, pick, tip, parcelAt, travelTo, openManage, empireInto, rebuildAt,
    list: () => (STATE.acres || []).slice(),
    count: () => (STATE.acres || []).length,
    buyAt(x, z) { const p = parcelAt(x, z); if (!p) return { ok: false, why: 'no parcel' }; return commit(p); },
    sellAt(id) {
      const A = STATE.acres || [];
      const a = A.find(x => x.id === id);
      if (!a) return { ok: false, why: 'no acre ' + id };
      STATE.acres = A.filter(x => x !== a);
      earn(Math.round(a.price * SELL_BACK), false);
      try { saveGame(); } catch (e) { }
      rebuildAt(a.x, a.z);
      return { ok: true, got: Math.round(a.price * SELL_BACK) };
    },
    state() {
      return {
        chunks: chunks.size,
        meshed: [...chunks.values()].filter(Boolean).length,
        signs: signMeshes.reduce((s, m) => s + ((m.userData.signs || []).length), 0),
        signMeshes: signMeshes.length,
        acres: (STATE.acres || []).length,
        incomePerDay: (STATE.acres || []).reduce((s, a) => s + a.rate, 0),
        accrual: +acc.toFixed(2),
        camDist: camCtl.dist,
      };
    },
    audit,
  };
})();
window.FARM = FARM;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the click chain: a farm parcel claim runs BEFORE the openhouse /
//    plot / walk routing (it wraps the wrapper OH installed in v2.41);
//    if the farmland pass ever throws, the original flow still runs.
const __farmClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (FARM.pick(cx, cy)) return; } catch (e) { console.error('[farmland]', e); }
  return __farmClickPick(cx, cy);
});
// 2. hover: the farm tip fills in wherever nothing older claims the point
const __farmHoverInfo = ECO.hoverInfo.bind(ECO);
ECO.hoverInfo = function (x, z) {
  const info = __farmHoverInfo(x, z);
  if (info) return info;
  try { return FARM.tip(x, z); } catch (e) { return null; }
};
// 3. the Empire panel: your acres, one tap away
const __farmEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __farmEmpire();
  try { FARM.empireInto(); } catch (e) { console.error('[farmland]', e); }
};
// 4. the update chain: original → world forest → open house → suburbs →
//    title deeds → PATCHWORK. Every call is try/caught so a farmland
//    error can never touch the world.
const __farmOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __farmOrigUpdate(dt, px, pz, camDist);
  try { FARM.tick(dt, px, pz, camDist); } catch (e) { console.error('[farmland]', e); }
  return req;
};

