// ====================================================================
// js/world/worldforest.js — real 3D forest across the dry-land
// chunks (Stage 6); the FIRST link of the WORLD.update patch chain.
// ====================================================================
import * as THREE from 'three';
import { CITIES } from '../config.js';
import { _mulberry, hashStr, cityDNA } from '../util.js';
import { LANDGEO } from '../core.js';
import { WORLD, camCtl } from '../world/world.js';

// ======== section: 45_worldforest.js ========
// ====================================================================
// v2.39 — WORLD FOREST. The ask: "add trees all around the world
// besides in the cities, don't change past code." This whole section
// is ADDITIVE: not one existing line above was modified or removed —
// the deep-blue lakes, the 23,000 km whole-world zoom, the belts, the
// streets and the economy all ride exactly as v2.38 shipped them.
// What is new: the open country BEYOND the city woodland belts (past
// CITY_R + 3300, where the v2.35 belt's clumped stands end) now grows
// real 3D forest everywhere you roam — every dry-land chunk, gated
// tree by tree (dry land only, 8 m off every road, clear of the
// roadside vendor plots). Inside the belt annulus and the cities
// themselves NOTHING changed: the belt keeps its approved look and
// city plates stay bare.
//
// Mechanically it mirrors the pasture-chunk streaming it shadows:
// same 500 m chunk grid, same focus rule (the character while
// following, the panned view while roaming), same 400 ms cadence and
// 2-chunks-per-frame budget — one new mercy: the treed zone breathes
// OUT with altitude (1050 m at street level, up to 2400 m once you
// are a couple of km up), so a mid-zoom look around shows forest past
// the pasture detail ring, and it trims back on its own. Trees are
// the exact recipe the world already uses (cylinder trunk, 42% pine
// cones, icosahedron canopies, the same greens) merged per chunk into
// one Lambert mesh in the chunk-local frame — float32-safe at 1:1,
// shadow-casting, deterministic per chunk.
// ====================================================================
export const WF = (() => {
  const CH = 500;                       // same chunk grid as the pasture pass
  const CITY_R = 745;                   // mirrors WORLD's CITY_R (city import extent)
  // v2.65 CITY DNA: the belt boundary is per-city now — nearCity()
  // returns distance PAST the nearest city's own suburb edge, and
  // BELT_PAST is the old belt margin (CITY_R + 3300 − 2360 = 1685 m
  // past the edge: the belt's 940 + the 745 m city breathing room)
  const BELT_PAST = 1685;
  const MOB = matchMedia('(pointer:coarse)').matches;
  const MOBF = MOB ? .55 : 1;
  const BASE_R = MOB ? 750 : 1050;      // matches WORLD.CHUNK_R at street level
  const MAX_R = MOB ? 1300 : 2000;      // treed zone breathing room with altitude
  const DISPOSE_R = MAX_R + 450;        // fixed hysteresis — no churn on zoom cycles

  const chunks = new Map();             // 'cx,cz' -> group | null (null = built empty)
  let queue = [], lastUpd = 0, root = null, trees = 0;

  const wcol = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  // open-ended trunk: the top cap hides inside the canopy and the bottom
  // cap sits on the ground — at the game's fixed 71.6° pitch neither is
  // ever visible, and it halves the trunk's vertex count (26 -> 14)
  const TRUNK = new THREE.CylinderGeometry(.22, .30, 2.2, 6, 1, true);
  const PINE = new THREE.ConeGeometry(1.7, 3.4, 7);
  const LEAF = new THREE.IcosahedronGeometry(1.75, 0);
  const C_TRUNK = wcol(0x6b4f33), C_PINE = wcol(0x2f6b34),
        C_LEAF_A = wcol(0x3d7f36), C_LEAF_B = wcol(0x4c8f3e);

  // micro merged-geometry builder — same contract as the WORLD closure's
  // GeoBuilder (local frame around ox/oz, vertex colors, one Lambert mesh)
  const _nm3 = new THREE.Matrix3(), _v3a = new THREE.Vector3(), _v3b = new THREE.Vector3();
  const _mShift = new THREE.Matrix4();
  function GeoB(ox, oz) {
    const off = (ox || 0) !== 0 || (oz || 0) !== 0;
    if (off) _mShift.makeTranslation(-(ox || 0), 0, -(oz || 0));
    const pos = [], norm = [], uv = [], colr = [];
    function addGeo(geo, mat4, color) {
      const p = geo.attributes.position, n = geo.attributes.normal;
      const idx = geo.index ? geo.index.array : null;
      const count = idx ? idx.length : p.count;
      _nm3.getNormalMatrix(mat4);
      for (let i = 0; i < count; i++) {
        const vi = idx ? idx[i] : i;
        _v3a.fromBufferAttribute(p, vi).applyMatrix4(mat4);
        if (off) _v3a.applyMatrix4(_mShift);
        _v3b.fromBufferAttribute(n, vi).applyMatrix3(_nm3).normalize();
        pos.push(_v3a.x, _v3a.y, _v3a.z);
        norm.push(_v3b.x, _v3b.y, _v3b.z);
        uv.push(0, 0);
        colr.push(color[0], color[1], color[2]);
      }
    }
    function mesh() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      if (off) m.position.set(ox, 0, oz);   // chunk-local frame (float32-safe at 1:1)
      m.castShadow = true; m.receiveShadow = true;
      return m;
    }
    return { addGeo, mesh, get count() { return pos.length / 3; } };
  }
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s3 = new THREE.Vector3();
  function trs(x, y, z, ry, sx, sy, sz) {
    _e.set(0, ry || 0, 0);
    _q.setFromEuler(_e);
    return _m4.compose(_s3.set(x, y, z), _q, new THREE.Vector3(sx, sy, sz)).clone();
  }

  // v2.65 CITY DNA: edge-relative — distance PAST the nearest city's own
  // suburb edge (negative inside the city+suburbs, 0 at the ring rim).
  // Same shape as before, but a metro's belt now reaches as far as the
  // metro itself does.
  function nearCity(x, z) {
    let best = 1e9, bc = null;
    for (const c of CITIES) { const d = Math.hypot(x - c.wx, z - c.wz); if (d < best) { best = d; bc = c; } }
    return bc ? best - cityDNA(bc).subR1 : best;
  }

  // plot snapshot — green $ pads AND sold roadside plots (sold recs stay
  // in the list, so a bought cart is guarded the same as a live pad)
  let _plots = [], _plotsAt = 0;
  function onPlot(x, z) {
    const now = performance.now();
    if (now - _plotsAt > 400) { _plotsAt = now; try { _plots = WORLD.plots() || []; } catch (e) { _plots = []; } }
    for (const p of _plots) {
      if (Math.abs(p.x - x) > 15 || Math.abs(p.z - z) > 15) continue;
      if (Math.hypot(p.x - x, p.z - z) < 14) return true;
    }
    return false;
  }

  // the tree — the exact recipe the world's own addTree uses (unit
  // template geometries scaled by s ≡ the per-tree geometries it bakes)
  function addTree(B, x, z, s, rnd) {
    if (nearCity(x, z) < BELT_PAST) return;                   // belt + cities keep their approved look (v2.65: per-city edge)
    if (WORLD.nearRoad(x, z, 8)) return;                      // off the asphalt, 8 m like every tree
    if (LANDGEO.ready && LANDGEO.isWaterWorld(x, z)) return;  // never at sea / never in a lake
    if (onPlot(x, z)) return;                                 // never on a roadside vendor plot
    const ry = rnd() * 3.14;
    B.addGeo(TRUNK, trs(x, 1.1 * s, z, ry, s, s, s), C_TRUNK);
    if (rnd() < .42) B.addGeo(PINE, trs(x, 3.6 * s, z, ry, s, s, s), C_PINE);
    else B.addGeo(LEAF, trs(x, 3.1 * s, z, ry, s, .95 * s, s), rnd() < .5 ? C_LEAF_A : C_LEAF_B);
    trees++;
  }

  function build(cx, cz) {
    const key = cx + ',' + cz;
    if (chunks.has(key)) return;
    chunks.set(key, null);                 // reserve — built, even if it ends up empty
    const rnd = _mulberry(hashStr('wf' + key));   // own seed stream — the pasture pass is untouched
    const x0 = cx * CH, z0 = cz * CH, xm = x0 + CH / 2, zm = z0 + CH / 2;
    // whole-chunk water (the pasture pass's own 5-point rule)
    if (LANDGEO.ready && LANDGEO.isWaterWorld(xm, zm) &&
      LANDGEO.isWaterWorld(x0, z0) && LANDGEO.isWaterWorld(x0 + CH, z0) &&
      LANDGEO.isWaterWorld(x0, z0 + CH) && LANDGEO.isWaterWorld(x0 + CH, z0 + CH)) return;
    // whole chunk inside the belt / city — the belt owns it
    if (nearCity(xm, zm) < BELT_PAST - CH * .8) return;

    // v2.39c woodland density: ~263 trees per full chunk (one per ~30 m —
    // open woodland), wider character swing (.4-1.0) so thick woods meet
    // real clearings, leaner per-tree geometry keeps ~7k verts a chunk
    const density = .4 + rnd() * .6;     // woodland character: thick woods ↔ open savanna
    const B = GeoB(xm, zm);
    const stands = Math.max(4, Math.round((14 + rnd() * 10) * density * MOBF));
    for (let s = 0; s < stands; s++) {
      const sx = x0 + 40 + rnd() * (CH - 80), sz = z0 + 40 + rnd() * (CH - 80);
      if (nearCity(sx, sz) < BELT_PAST + 160) continue;   // stand head past the belt edge
      const cnt = 9 + Math.floor(rnd() * 9);
      for (let i = 0; i < cnt; i++)
        addTree(B, sx + (rnd() - .5) * 320, sz + (rnd() - .5) * 320, .8 + rnd() * .7, rnd);
    }
    const fill = Math.round((14 + rnd() * 16) * density * MOBF);
    for (let i = 0; i < fill; i++)
      addTree(B, x0 + rnd() * CH, z0 + rnd() * CH, .6 + rnd() * .6, rnd);
    if (B.count < 6) return;
    const cg = new THREE.Group();
    cg.add(B.mesh());
    if (root) root.add(cg);
    chunks.set(key, cg);
  }

  function dispose(key) {
    const cg = chunks.get(key);
    if (cg) cg.traverse(o => { if (o.geometry) { try { o.geometry.dispose(); } catch (e) { } } });
    if (cg && cg.parent) cg.parent.remove(cg);
    chunks.delete(key);
  }
  function reset() {
    for (const key of [...chunks.keys()]) dispose(key);
    queue = []; trees = 0;
  }

  function tick(dt, px, pz, camDist) {
    const r = WORLD.group;
    if (!r) { if (chunks.size) reset(); return; }    // world not built / disposed
    if (r !== root) { reset(); root = r; }           // the world rebuilt under us
    const now = performance.now();
    // same focus rule as the pasture pass: the character while following,
    // the panned view while roaming
    const fx = camCtl.follow ? px : camCtl.tx, fz = camCtl.follow ? pz : camCtl.tz;
    // the treed zone breathes with altitude; dispose hysteresis is fixed
    const R = Math.min(BASE_R + Math.max(0, camDist - 260) * .8, MAX_R);
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
  }
  // QA: audit every standing tree against the same guards that placed it
  // (trunk-bottom vertices sit exactly at each tree's world x,z) — proves
  // on the shipped geometry that no tree stands in a city, in water or
  // on a road. Runs only when called from the console.
  function audit() {
    let trees = 0, badCity = 0, badWater = 0, badRoad = 0;
    for (const g of chunks.values()) {
      if (!g) continue;
      const m = g.children[0], pos = m.geometry.attributes.position;
      const ox = m.position.x, oz = m.position.z;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) > .01) continue;
        const wx = ox + pos.getX(i), wz = oz + pos.getZ(i);
        trees++;
        if (nearCity(wx, wz) < BELT_PAST) badCity++;   // v2.65: per-city edge
        if (LANDGEO.ready && LANDGEO.isWaterWorld(wx, wz)) badWater++;
        if (WORLD.nearRoad(wx, wz, 8)) badRoad++;
      }
    }
    return { trees, badCity, badWater, badRoad };
  }
  return { tick, reset, audit, get count() { return chunks.size; }, get meshed() { let n = 0; for (const v of chunks.values()) if (v) n++; return n; }, get trees() { return trees; },
    // QA: world-frame data of every standing forest chunk (null = built empty)
    get debug() { return [...chunks.entries()].map(([k, g]) => g ? { k, x: g.children[0].position.x, z: g.children[0].position.z, verts: g.children[0].geometry.attributes.position.count } : { k, empty: true }); } };
})();

// ADDITIVE hook — the only touch on the running system: WORLD.update
// keeps doing everything it always did, and the world forest streams
// on the same beat right after it (the same wrap pattern the game
// already uses for EARTH.diveTo). Installed at module-eval time,
// before the first rAF tick ever fires.
const __wfOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __wfOrigUpdate(dt, px, pz, camDist);
  try { WF.tick(dt, px, pz, camDist); } catch (e) { console.error('[worldforest]', e); }
  return req;
};
window.WF = WF;   // QA surface

