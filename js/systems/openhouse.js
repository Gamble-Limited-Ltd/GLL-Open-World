// ====================================================================
// js/systems/openhouse.js — open-house interiors (Stage 7c): click a
// building to open it; floors/rooms; the dollhouse view. PROP is
// late-bound below.
// ====================================================================
import * as THREE from 'three';
import { _mulberry, hashStr } from '../util.js';
import { STATE } from '../state.js';
import { WORLD, camCtl } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';
import { camera, canvas, renderer } from '../render/main.js';
import { clickPick, groundPlane, patchClickPick, ray } from '../render/night.js';

// ---- late binding (boot binds after every module evaluates) --------
export let PROP;
export function __late(b) { ({ PROP } = b); }

// ======== section: 46_openhouse.js ========
// ====================================================================
// v2.41 — FLOOR PLAN. The ask evolved: "allow people to see the rooms
// inside of buildings" shipped as v2.40's proximity dollhouse; the
// follow-up ask is "when people CLICK on a building, they should be
// able to select a FLOOR for big buildings and ROOMS for smaller
// ones" — so the trigger is now a click, and the section grew a
// building inspector on top of the proven v2.40 rig:
//   - click any building (true mesh raycast first, so a tower's
//     facade maps to THAT tower; a ground-plane fallback catches the
//     base, matching the hover semantics) and it opens like a
//     dollhouse with an inspector panel beside it;
//   - BIG BUILDINGS (3+ floors) list their floors — pick one and the
//     shell is sliced at that floor's ceiling while the interior's
//     drawRange shows ONLY that floor's furnished rooms (one merged
//     mesh, emitted floor-by-floor, so a floor is a vertex range —
//     zero extra draw calls, zero recompiles);
//   - SMALLER BUILDINGS (1-2 floors) list their rooms BY NAME —
//     Living Room, Kitchen, Bedroom, Stock Room… — deterministic
//     from the building's own seed, and the picked room glows: a
//     pulsing floor quad plus a room-volume outline;
//   - the camera glides level with the pick (any grab/WASD cancels);
//     ✕, ESC, walking 650 m away or zooming past 900 m closes it;
//   - leasable towers keep their suite flow: the inspector carries
//     the LEASE / MANAGE SUITE button.
// The clip rig itself is v2.40's proven machinery, untouched in
// spirit: renderer.localClippingEnabled + one horizontal cut plane
// and up to 12 vertical hull planes on the BUILDING SHELL materials
// only (clipIntersection), captured exactly at build time during the
// city builder's own "Raising … buildings" phase. Every openhouse
// call is try/caught so a mistake here can never touch the world.
// window.OH exposes the state for QA.
// ====================================================================
export const OH = (() => {
  // ---- tuning -------------------------------------------------------
  const CUT = 1.45;            // dollhouse cut height above the pad
  const MARGIN = .22;          // prism grows past the wall line so the shell's own zero-thickness quads clip
  const CLOSE_D = 650;         // v2.41: the inspector is manual — wandering this far away closes it
  const CLOSE_ZOOM = 900;      // v2.41: pulling the view out past this closes it too
  const FH = 3.2;              // the game's own floor height (h / 3.2)
  const SLAB0 = .21;           // ground-floor finish height (clear of the .16 pad)
  const SKIRT = .24;           // slab edge band so each floor reads as a plate
  const PART_H = 2.99;         // partitions run slab-to-slab (airtight stack)
  const PART_T = .15;          // partition thickness
  const DOOR = 1.15;           // doorway gap in every partition
  const MAXEDGE = 12;          // vertical prism planes (FIXED count -> no recompile churn)
  const CACHE_MAX = 4;         // furnished interiors kept alive at once

  try { renderer.localClippingEnabled = true; } catch (e) { }

  // ---- the clip rig: 13 shared world-space planes -------------------
  // plane[0] = horizontal cut; plane[1..12] = vertical hull edges.
  // A parked plane (normal (0,-1,0), constant 1e9) clips nothing, so a
  // fixed-length array can be mutated in place every frame with zero
  // shader recompiles (only constants move; count never changes).
  const planes = [];
  for (let i = 0; i <= MAXEDGE; i++) planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9));
  let planesActive = false;
  function parkAll() {
    for (const p of planes) { p.normal.set(0, -1, 0); p.constant = 1e9; }
    planesActive = false;
  }

  // convex hull (monotone chain, CCW) — the prism of a concave footprint
  // is its hull so the WHOLE building opens (the kernel would leave arms closed)
  function hullOf(pts) {
    const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (P.length < 3) return null;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of P) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
      up.push(p);
    }
    lo.pop(); up.pop();
    const h = lo.concat(up);
    return h.length >= 3 ? h : null;
  }

  function setPrism(poly) {
    planes[0].normal.set(0, -1, 0);
    planes[0].constant = CUT;
    let h = hullOf(poly);
    if (!h) {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const v of poly) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); z0 = Math.min(z0, v[1]); z1 = Math.max(z1, v[1]); }
      h = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    }
    const edges = [];
    for (let i = 0; i < h.length; i++) {
      const a = h[i], c = h[(i + 1) % h.length];
      const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz);
      if (L > .05) edges.push({ a, nx: dz / L, nz: -dx / L, L });   // outward normal for CCW — the wallBand convention
    }
    edges.sort((e, f) => f.L - e.L);          // keep the longest hull edges
    for (let i = 1; i <= MAXEDGE; i++) {
      const p = planes[i], e = edges[i - 1];
      if (e) { p.normal.set(e.nx, 0, e.nz); p.constant = -(e.nx * e.a[0] + e.nz * e.a[1]) - MARGIN; }
      else { p.normal.set(0, -1, 0); p.constant = -1e9; }   // ALWAYS-CLIPPED side: never constrains the intersection
    }
    planesActive = true;
  }

  // ---- shell capture: exact, at build time --------------------------
  // The capture window is the city builder's own "Raising …" status
  // phase: between "Raising N buildings…" and "Marking real estate…"
  // the ONLY meshes added to the city group are the building shell's
  // (walls x4, shopfronts, roofs, pitched faces, trim, HVAC/tank/
  // antenna clutter — and barn walls in the open country). The
  // prototype wrap is inert outside that window.
  let shellMeshes = [], win = false;
  function attachPlanes() {
    const seen = new Set();
    for (const m of shellMeshes) {
      const mat = m && m.material;
      if (!mat || Array.isArray(mat) || !mat.isMeshLambertMaterial || seen.has(mat)) continue;
      seen.add(mat);
      try {
        mat.clippingPlanes = planes;
        mat.clipIntersection = true;
        mat.clipShadows = true;
        mat.needsUpdate = true;
      } catch (e) { }
    }
  }
  const __ohAdd = THREE.Object3D.prototype.add;
  THREE.Object3D.prototype.add = function (...objs) {
    try {
      if (win && this === CITY.group) {
        for (const o of objs)
          if (o && (o.isMesh || o.isInstancedMesh) && o.material && !Array.isArray(o.material) && o.material.isMeshLambertMaterial)
            shellMeshes.push(o);
      }
    } catch (e) { }
    return __ohAdd.apply(this, objs);
  };
  const __ohBuild = CITY.build.bind(CITY);
  CITY.build = async function (cityData, cityMeta, anchor, onStatus) {
    const st = typeof onStatus === 'function' ? onStatus : null;
    const wrap = st ? function (s) {
      try {
        if (/^Raising/.test(s)) { win = true; shellMeshes = []; }
        else if (/^Marking/.test(s)) {
          win = false;
          if (shellMeshes.length < 2 && CITY.group) {   // fallback: at this instant the group holds ground, roads and SHELLS only
            try {
              CITY.group.traverse(o => {
                if (o !== CITY.group && o.isMesh && !o.isInstancedMesh && o.castShadow &&
                  o.material && !Array.isArray(o.material) && o.material.isMeshLambertMaterial)
                  shellMeshes.push(o);
              });
            } catch (e) { }
          }
          attachPlanes();
        }
        // v2.42: at 'Planting parks…' the NEIGHBORHOOD shells join the
        // clip rig so a clicked house slices open exactly like a
        // downtown building. The suburb meshes live in their own
        // distance-LOD group, so the add-hook above never sees them —
        // a deduped traverse collects them here (castShadow Lambert
        // meshes only: downtown shells, suburb walls + roofs; lawns,
        // instanced trees/lamps/cars stay out, exactly like downtown).
        // Idle planes park at 1e9 = clip nothing; clipIntersection=true
        // keeps every other building whole.
        else if (/^Planting/.test(s)) {
          win = false;
          if (CITY.group) {
            try {
              const seen = new Set(shellMeshes);
              CITY.group.traverse(o => {
                if (o !== CITY.group && o.isMesh && !o.isInstancedMesh && o.castShadow &&
                  o.material && !Array.isArray(o.material) && o.material.isMeshLambertMaterial &&
                  !seen.has(o)) { shellMeshes.push(o); seen.add(o); }
              });
            } catch (e) { }
          }
          attachPlanes();
        }
      } catch (e) { }
      return st(s);
    } : null;
    return __ohBuild(cityData, cityMeta, anchor, wrap);
  };

  // ---- the interior builder -----------------------------------------
  const _col = new THREE.Color();
  const C = h => { _col.setHex(h); return [_col.r, _col.g, _col.b]; };
  const jitA = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
  const FLOORS_OFF = [C(0xa98f6f), C(0x9aa0a3)], FLOORS_HOME = [C(0xb39068), C(0xa98f6f)];
  const FLOOR_RETAIL = C(0xcfc8bb), FLOOR_LOBBY = C(0xd6d0c4);
  const PARTC = [C(0xefe9dc), C(0xe6dfd2)];
  const C_DESK = C(0x8a6a48), C_MON = C(0x23262b), C_CHAIR = C(0x46505a), C_CAB = C(0x6d7278);
  const C_BEDF = C(0x7a5c44), C_BEDD = C(0xece5d6), C_PIL = C(0xf4f0e7), C_WARD = C(0x5f4632);
  const C_CNT = C(0x6f4f36), C_CNTTOP = C(0xd9cdbb), C_SHELF = C(0x7f6a4f), C_CRATE = C(0x9c7c50);
  const C_POT = C(0x6b5a48), C_PLANT = C(0x3e7c41), C_BENCH = C(0x86664c), C_STAIR = C(0x9c8668);
  const RUGS = [C(0xa2653f), C(0x7e8ea0), C(0x8f7f5a)];

  function buildInterior(b, anchor) {
    const P = b.poly, ax = anchor.x, az = anchor.z;
    const rnd = _mulberry(hashStr('oh' + b.bkey));
    const nF = Math.max(1, Math.round(b.h / FH));
    // v2.41: the inspector's data — house-sized footprints get home rooms,
    // 1-2 floor buildings get the ROOM picker, 3+ get the FLOOR picker
    const house = b.area < 170 && b.h < 9.5;
    const small = nF <= 2;
    const floorRanges = [], floorTypes = [], rooms = [];
    const pos = [], nor = [], uv = [], col = [];
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const v of P) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); z0 = Math.min(z0, v[1]); z1 = Math.max(z1, v[1]); }
    const w = x1 - x0, d = z1 - z0;

    function inP(x, z) { return CITY.inPoly(x, z, P); }
    function rectIn(rx0, rz0, rx1, rz1) {
      return inP(rx0, rz0) && inP(rx1, rz0) && inP(rx1, rz1) && inP(rx0, rz1) && inP((rx0 + rx1) / 2, (rz0 + rz1) / 2);
    }
    function spotOK(x, z, hw, hd) {
      return inP(x, z) && inP(x - hw, z - hd) && inP(x + hw, z - hd) && inP(x + hw, z + hd) && inP(x - hw, z + hd);
    }

    // quad: two tris A,B,C / A,C,D — world in, city-local out
    const q = (A, B, Cq, D, n, c) => {
      pos.push(A[0] - ax, A[1], A[2] - az, B[0] - ax, B[1], B[2] - az, Cq[0] - ax, Cq[1], Cq[2] - az,
        A[0] - ax, A[1], A[2] - az, Cq[0] - ax, Cq[1], Cq[2] - az, D[0] - ax, D[1], D[2] - az);
      for (let k = 0; k < 6; k++) { nor.push(n[0], n[1], n[2]); uv.push(0, 0); col.push(c[0], c[1], c[2]); }
    };
    const box = (x, y0, y1, z, hw, hd, c) => {
      q([x + hw, y0, z - hd], [x + hw, y1, z - hd], [x + hw, y1, z + hd], [x + hw, y0, z + hd], [1, 0, 0], c);
      q([x - hw, y0, z + hd], [x - hw, y1, z + hd], [x - hw, y1, z - hd], [x - hw, y0, z - hd], [-1, 0, 0], c);
      q([x + hw, y0, z + hd], [x + hw, y1, z + hd], [x - hw, y1, z + hd], [x - hw, y0, z + hd], [0, 0, 1], c);
      q([x - hw, y0, z - hd], [x - hw, y1, z - hd], [x + hw, y1, z - hd], [x + hw, y0, z - hd], [0, 0, -1], c);
      q([x - hw, y1, z + hd], [x + hw, y1, z + hd], [x + hw, y1, z - hd], [x - hw, y1, z - hd], [0, 1, 0], c);
    };

    // stair core: solid 8-step flight in the (x0,z0) corner, marching +z;
    // slabs above get the matching opening (earcut hole)
    const stX = x0 + 1.35, stZ = z0 + 1.35;
    const sOK = nF >= 2 && w >= 4.6 && d >= 4.6 && rectIn(stX - .68, stZ - .2, stX + .68, stZ + 2.5);
    const holeRing = [[stX - .6, stZ - .12], [stX + .6, stZ - .12], [stX + .6, stZ + 2.38], [stX - .6, stZ + 2.38]];

    const slab = (yb, i, fc) => {
      const contour = P.map(v => new THREE.Vector2(v[0] - ax, v[1] - az));
      const holes = [];
      if (i >= 1 && sOK) holes.push(holeRing.map(v => new THREE.Vector2(v[0] - ax, v[1] - az)));
      let tris = null;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { tris = null; }
      if (tris && tris.length) {
        const verts = contour.concat(...holes);
        for (const t of tris) {
          const A = verts[t[0]], Bv = verts[t[1]], Cv = verts[t[2]];
          pos.push(A.x, yb, A.y, Cv.x, yb, Cv.y, Bv.x, yb, Bv.y);   // roofDeck's proven emit order
          for (let k = 0; k < 3; k++) { nor.push(0, 1, 0); uv.push(0, 0); col.push(fc[0], fc[1], fc[2]); }
        }
      }
      if (i > 0) {
        const sc = jitA(fc, .8);
        for (let e = 0; e < P.length; e++) {
          const a = P[e], c = P[(e + 1) % P.length];
          const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz);
          if (L < .05) continue;
          const nx = dz / L, nz = -dx / L;
          q([a[0], yb - SKIRT, a[1]], [a[0], yb, a[1]], [c[0], yb, c[1]], [c[0], yb - SKIRT, c[1]], [nx, 0, nz], sc);
        }
      }
    };

    // longest contiguous inside-poly run of a segment (t0,t1 fractions)
    function insideRun(axp, azp, bxp, bzp) {
      const L = Math.hypot(bxp - axp, bzp - azp) || 1;
      const N = Math.max(8, Math.ceil(L * 2.2));
      let best = null, run = null;
      for (let k = 0; k <= N; k++) {
        const t = k / N, x = axp + (bxp - axp) * t, z = azp + (bzp - azp) * t;
        if (inP(x, z)) { if (!run) run = [t, t]; run[1] = t; }
        else if (run) { if (!best || run[1] - run[0] > best[1] - best[0]) best = run; run = null; }
      }
      if (run && (!best || run[1] - run[0] > best[1] - best[0])) best = run;
      return best;
    }

    // one partition: a wall segment with a doorway, trimmed to the real interior
    function wallRun(axp, azp, bxp, bzp, yb, pc) {
      const run = insideRun(axp, azp, bxp, bzp);
      if (!run) return;
      const L = Math.hypot(bxp - axp, bzp - azp) || 1;
      const s0 = run[0] * L + .35, s1 = run[1] * L - .35;
      if (s1 - s0 < 2.6) return;
      const ux = (bxp - axp) / L, uz = (bzp - azp) / L;
      const dC = s0 + (s1 - s0) * (.3 + rnd() * .4), dH = DOOR / 2;
      const seg = (m0, m1) => {
        if (m1 - m0 < .2) return;
        const px = axp + ux * m0, pz = azp + uz * m0, qx = axp + ux * m1, qz = azp + uz * m1;
        if (Math.abs(ux) < .01) box(px, yb, yb + PART_H, (pz + qz) / 2, PART_T / 2, Math.abs(qz - pz) / 2, pc);
        else box((px + qx) / 2, yb, yb + PART_H, pz, Math.abs(qx - px) / 2, PART_T / 2, pc);
      };
      seg(s0, dC - dH); seg(dC + dH, s1);
    }

    // ---- furniture emitters (all guarded by spotOK) ----
    function furnishRoom(rx0, rx1, rz0, rz1, yb, type, r) {
      const cw = rx1 - rx0, cd = rz1 - rz0;
      if (cw < 2.1 || cd < 2.1) return;
      const put = (x, z, hw, hd, y0, y1, c) => { if (spotOK(x, z, hw + .1, hd + .1)) { box(x, y0, y1, z, hw, hd, c); return true; } return false; };
      if (type === 'office') {
        const n = cw * cd > 42 ? 4 : cw * cd > 20 ? 3 : 2;
        for (let k = 0; k < n; k++) {
          const fx = rx0 + .85 + r() * Math.max(.2, cw - 1.7), fz = rz0 + .85 + r() * Math.max(.2, cd - 1.7);
          const dir = r() < .5 ? 1 : -1;
          if (put(fx, fz, .68, .38, yb, yb + .74, C_DESK)) {
            put(fx + dir * .16, fz, .27, .06, yb + .74, yb + 1.07, C_MON);       // monitor
            put(fx - dir * .8, fz, .24, .24, yb, yb + .52, C_CHAIR);             // chair
          }
        }
        if (r() < .7) put(rx1 - .55, rz0 + 1, .3, .55, yb, yb + 1.32, C_CAB);   // filing cabinet
        if (r() < .5) put(rx0 + .55, rz1 - 1.1, .3, .55, yb, yb + 1.32, C_CAB); // second cabinet
      } else if (type === 'home') {
        const longX = cw >= cd;                     // bed along the longer side
        const bx = longX ? (r() < .5 ? rx0 + 1.15 : rx1 - 1.15) : (r() < .5 ? rx0 + .8 : rx1 - .8);
        const bz = longX ? (r() < .5 ? rz0 + .8 : rz1 - .8) : (r() < .5 ? rz0 + 1.15 : rz1 - 1.15);
        const bhw = longX ? 1.02 : .47, bhd = longX ? .47 : 1.02;
        if (put(bx, bz, bhw, bhd, yb, yb + .42, C_BEDF)) {
          put(bx, bz, bhw - .07, bhd - .07, yb + .42, yb + .58, C_BEDD);         // mattress
          const hx = longX ? bx - Math.sign(bx - (rx0 + rx1) / 2) * (bhw - .36) : bx;
          const hz = longX ? bz : bz - Math.sign(bz - (rz0 + rz1) / 2) * (bhd - .36);
          put(hx, hz, .3, .18, yb + .58, yb + .68, C_PIL);                        // pillow
        } else {                                                                  // studio: sofa + coffee table
          put((rx0 + rx1) / 2, (rz0 + rz1) / 2, .9, .38, yb, yb + .62, C_BENCH);
          put((rx0 + rx1) / 2, (rz0 + rz1) / 2 + .75, .55, .3, yb, yb + .4, C_DESK);
        }
        if (cw > 3.4 && cd > 3.4 && r() < .85) {                                 // sofa corner + table in every home
          put(rx0 + .85, rz1 - .7, .8, .34, yb, yb + .62, C_BENCH);
          put(rx0 + .85, rz1 - 1.75, .5, .28, yb, yb + .38, C_DESK);
        }
        if (r() < .8) put(longX ? rx1 - .62 : (r() < .5 ? rx0 + .7 : rx1 - .7), longX ? (r() < .5 ? rz0 + .7 : rz1 - .7) : rz1 - .62, .6, .32, yb, yb + 1.85, C_WARD);
        const rug = RUGS[Math.floor(r() * RUGS.length)];                          // rug under it all
        q([(rx0 + rx1) / 2 - Math.min(1.15, cw * .4), yb + .012, (rz0 + rz1) / 2 - Math.min(.85, cd * .4)],
          [(rx0 + rx1) / 2 + Math.min(1.15, cw * .4), yb + .012, (rz0 + rz1) / 2 - Math.min(.85, cd * .4)],
          [(rx0 + rx1) / 2 + Math.min(1.15, cw * .4), yb + .012, (rz0 + rz1) / 2 + Math.min(.85, cd * .4)],
          [(rx0 + rx1) / 2 - Math.min(1.15, cw * .4), yb + .012, (rz0 + rz1) / 2 + Math.min(.85, cd * .4)], [0, 1, 0], rug);
      } else if (type === 'lobby') {
        const cx = (rx0 + rx1) / 2, cz = (rz0 + rz1) / 2;
        if (put(cx, cz, 1.4, .4, yb, yb + 1.02, C_CNT)) put(cx, cz, 1.48, .46, yb + 1.02, yb + 1.07, C_CNTTOP);
        put(rx0 + .6, cz, .3, .3, yb, yb + .85, C_POT);
        if (r() < .8) put(rx0 + .6, cz, .26, .26, yb + .85, yb + 1.4, C_PLANT);
        put(rx1 - .55, cz - .9, .32, .3, yb, yb + .85, C_POT);
        if (r() < .8) put(rx1 - .55, cz - .9, .27, .26, yb + .85, yb + 1.42, C_PLANT);
        if (cw > 5) put(cx, rz0 + .7, .95, .26, yb, yb + .46, C_BENCH);           // waiting bench
      } else {                                                                    // retail
        const cx = (rx0 + rx1) / 2, cz = (rz0 + rz1) / 2;
        if (put(cx, cz, 1.3, .38, yb, yb + .95, C_CNT)) put(cx, cz, 1.38, .44, yb + .95, yb + 1, C_CNTTOP);
        if (put(rx0 + 1, rz0 + .45, .9, .22, yb, yb + 1.65, C_SHELF)) { }
        if (cw > 4.6 && r() < .85) put(rx1 - 1, rz0 + .45, .9, .22, yb, yb + 1.65, C_SHELF);
        if (cd > 5 && r() < .6) put(rx0 + .5, rz1 - .5, .28, .28, yb, yb + .5, C_CRATE);
        if (cd > 5 && r() < .6) put(rx0 + .95, rz1 - .5, .28, .28, yb, yb + .86, C_CRATE);
      }
    }

    // ---- per-floor assembly ----
    const lobby = b.h >= 12 || b.area >= 200;
    for (let i = 0; i < nF; i++) {
      const fStart = pos.length / 3;              // v2.41: this floor's drawRange start
      const yb = SLAB0 + i * FH;
      const fc = i === 0 ? (lobby ? FLOOR_LOBBY : FLOOR_RETAIL)
        : (b.h >= 24 ? FLOORS_OFF[i % 2] : FLOORS_HOME[i % 2]);
      const pc = PARTC[i % 2];
      slab(yb, i, fc);

      // partitions: a room grid that scales with the floor — 1 split per axis
      // past 9.5 m, 2 past 17 m (up to 3x3 rooms on big tower floors)
      const vs = [], hs = [];
      if (w > 9.5) vs.push(x0 + w * (.38 + rnd() * .16));
      if (w > 17) vs.push(x0 + w * (.58 + rnd() * .16));
      if (d > 9.5) hs.push(z0 + d * (.38 + rnd() * .16));
      if (d > 17) hs.push(z0 + d * (.58 + rnd() * .16));
      for (const sx of vs) wallRun(sx, z0 + .55, sx, z1 - .55, yb, pc);
      for (const sz of hs) wallRun(x0 + .55, sz, x1 - .55, sz, yb, pc);

      // stairs (every floor except the top)
      if (sOK && i < nF - 1) {
        const steps = 8, rise = FH / steps;
        for (let k = 0; k < steps; k++)
          box(stX, yb, yb + (k + 1) * rise, stZ + (k + .5) * .28, .55, .16, C_STAIR);
      }

      // rooms + furniture (v2.41: house-sized small buildings dress as HOMES —
      // their room list says Living Room / Bedroom, and the beds agree)
      const type = i === 0 ? (lobby ? 'lobby' : (small && house ? 'home' : 'retail'))
        : (b.h >= 24 ? (rnd() < .72 ? 'office' : 'home') : (small && house ? 'home' : (rnd() < .42 ? 'office' : 'home')));
      floorTypes.push(type);
      const xsL = [x0 + .55, ...vs, x1 - .55];
      const zsL = [z0 + .55, ...hs, z1 - .55];
      for (let a = 0; a < xsL.length - 1; a++)
        for (let bq = 0; bq < zsL.length - 1; bq++) {
          const rx0 = xsL[a] + .45, rx1 = xsL[a + 1] - .45, rz0 = zsL[bq] + .45, rz1 = zsL[bq + 1] - .45;
          furnishRoom(rx0, rx1, rz0, rz1, yb, type, rnd);
          rooms.push({ floor: i, x0: rx0, x1: rx1, z0: rz0, z1: rz1, type, name: '' });   // v2.41: a clickable room
        }
      floorRanges.push({ start: fStart, count: pos.length / 3 - fStart });   // v2.41: floors are vertex ranges
    }

    // v2.41: deterministic room names — the biggest cell on a floor gets the
    // headline name (Living Room, Shop Floor…), same seed on every visit, so
    // the panel, the furniture and the glow always agree
    const RNAMES = {
      home: ['Living Room', 'Kitchen', 'Bedroom', 'Bathroom', 'Study', 'Den', 'Guest Room'],
      office: ['Corner Office', 'Open Office', 'Meeting Room', 'Copy Nook', 'Team Room', 'Office', 'Office'],
      retail: ['Shop Floor', 'Stock Room', 'Back Office', 'Break Room', 'Fitting Room'],
      lobby: ['Lobby', 'Reception', 'Waiting Area', 'Mail Room', 'Back Office'],
    };
    for (let i = 0; i < nF; i++) {
      const fr = rooms.filter(r => r.floor === i)
        .sort((a, c) => (c.x1 - c.x0) * (c.z1 - c.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
      const pool = RNAMES[floorTypes[i]] || RNAMES.office;
      fr.forEach((r, k) => {
        r.name = (k < pool.length ? pool[k] : 'Room ' + (k + 1)) + (i === 1 && small ? ' · up' : '');
      });
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    m.position.set(ax, 0, az);      // city-local frame, exactly like every city mesh
    m.castShadow = true; m.receiveShadow = true;
    m.visible = false;
    m.name = 'oh-interior-' + b.bkey;
    // v2.41: the mesh plus its inspector data — floors are vertex ranges of
    // this exact geometry, rooms are world-space rects on named floors
    return { mesh: m, layout: { nF, floorRanges, floorTypes, rooms, house, small } };
  }

  // ---- open / close / selection -------------------------------------
  let lastGroup = null, cur = null, curMesh = null, curLayout = null, pinned = null;
  let sel = { floor: null, room: null };   // v2.41: the inspector's pick
  let glide = null, hl = null, hlT = 0;    // v2.41: camera glide + room glow
  const cache = new Map();          // bkey -> { mesh, layout, b } (LRU, max CACHE_MAX)
  function dropCache() {
    for (const e of cache.values()) {
      try {
        if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
        e.mesh.geometry.dispose(); e.mesh.material.dispose();
      } catch (er) { }
    }
    cache.clear(); curMesh = null;
  }
  function open(b) {
    if (!b) return;
    let e = cache.get(b.bkey);
    if (!e || (e.mesh.parent !== CITY.group)) {
      if (e) { try { e.mesh.geometry.dispose(); e.mesh.material.dispose(); } catch (er) { } cache.delete(b.bkey); }
      const anchor = CITY.anchor || { x: 0, z: 0 };
      const built = buildInterior(b, anchor);
      e = { mesh: built.mesh, layout: built.layout, b };
      cache.set(b.bkey, e);
      while (cache.size > CACHE_MAX) {                       // LRU eviction (insertion order)
        const oldK = cache.keys().next().value;
        if (oldK === b.bkey) break;
        const oe = cache.get(oldK);
        try { if (oe.mesh.parent) oe.mesh.parent.remove(oe.mesh); oe.mesh.geometry.dispose(); oe.mesh.material.dispose(); } catch (er) { }
        cache.delete(oldK);
      }
      try { CITY.group.add(e.mesh); } catch (er) { }
    }
    for (const oe of cache.values()) if (oe !== e) oe.mesh.visible = false;   // v2.41: one dollhouse at a time
    cur = b; curMesh = e.mesh; curLayout = e.layout;
    setPrism(b.poly);
    curMesh.visible = true;
    applySel();
  }
  // v2.41: the inspector's selection — FLOOR isolation slices the shell at
  // that floor's ceiling and drawRanges the interior to that floor's own
  // vertex range (the mesh was emitted floor-by-floor, so a floor IS a
  // range); ROOM picks glow instead. null/null = the full dollhouse.
  function applySel() {
    if (!curMesh || !curLayout) return;
    clearHighlight();
    const R = curLayout.floorRanges;
    if (sel.floor != null && R[sel.floor] && R[sel.floor].count > 0) {
      const top = sel.floor === curLayout.nF - 1;          // the roof deck itself must lift
      planes[0].constant = top
        ? Math.min(SLAB0 + (sel.floor + 1) * FH - .06, .15 + cur.h - .25)
        : SLAB0 + (sel.floor + 1) * FH - .06;
      try { curMesh.geometry.setDrawRange(R[sel.floor].start, R[sel.floor].count); } catch (er) { }
    } else {
      planes[0].constant = CUT;                            // waist-high rims, every floor visible
      try { curMesh.geometry.setDrawRange(0, Infinity); } catch (er) { }
      if (sel.room != null && curLayout.rooms[sel.room]) {
        let own = null;
        try { own = PROP.status(cur.bkey, 'room', sel.room); } catch (er) { }   // v2.43: gold glow on owned, green on rented
        highlightRoom(curLayout.rooms[sel.room], own);
      }
    }
  }
  function heal() {
    cur = null; curMesh = null; curLayout = null; pinned = null;
    sel = { floor: null, room: null }; glide = null;
    parkAll();
    clearHighlight();
    hidePanel();
    for (const e of cache.values()) {
      e.mesh.visible = false;
      try { e.mesh.geometry.setDrawRange(0, Infinity); } catch (er) { }
    }
  }
  function force(bkey) {
    if (bkey == null) { heal(); return 'healed'; }
    const B = CITY.buildingPolys || [];
    const b = B.find(x => x.bkey === bkey) || null;
    if (!b) return 'no building ' + bkey;
    pinned = b;
    sel = { floor: null, room: null };
    open(b);
    showPanel();
    return 'open ' + bkey;
  }
  // v2.41: the CLICK — a building becomes the inspected one, opens as a
  // full dollhouse and its panel lists floors (big) or rooms (small)
  function select(b) {
    if (!b) return false;
    if (cur && cur.bkey === b.bkey && panelOpen()) return true;   // already inspecting this one
    pinned = b;
    sel = { floor: null, room: null };
    open(b);
    showPanel();
    return true;
  }
  function panelOpen() { return !!(panel && !panel.classList.contains('hidden')); }

  // ---- room glow ------------------------------------------------------
  function clearHighlight() {
    if (!hl) return;
    try {
      if (hl.quad.parent) hl.quad.parent.remove(hl.quad);
      hl.quad.geometry.dispose(); hl.quad.material.dispose();
      if (hl.box.parent) hl.box.parent.remove(hl.box);
      hl.box.geometry.dispose(); hl.box.material.dispose();
    } catch (er) { }
    hl = null;
  }
  function highlightRoom(r, own) {          // v2.43 TITLE DEEDS: own = {mode:'owned'|'rented'} tints the glow
    clearHighlight();
    try {
      const qC = own ? (own.mode === 'owned' ? 0xf5cc74 : 0x48bb78) : 0x38bdf8;
      const bC = own ? (own.mode === 'owned' ? 0xf6d365 : 0x7ee2a8) : 0x7dd3fc;
      const anchor = CITY.anchor || { x: 0, z: 0 };
      const y = SLAB0 + r.floor * FH + .03;
      const x0 = r.x0 + .12, x1 = r.x1 - .12, z0 = r.z0 + .12, z1 = r.z1 - .12;
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(x1 - x0, z1 - z0),
        new THREE.MeshBasicMaterial({ color: qC, transparent: true, opacity: .3, depthWrite: false, side: THREE.DoubleSide }));
      quad.rotation.x = -Math.PI / 2;
      quad.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);   // v2.45 fix: CITY.group is at the origin — world coords directly (the glow rendered off-screen since v2.41)
      quad.renderOrder = 2;
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, PART_H, z1 - z0)),
        new THREE.LineBasicMaterial({ color: bC, transparent: true, opacity: .85 }));
      box.position.set((x0 + x1) / 2, y + PART_H / 2, (z0 + z1) / 2);   // v2.45 fix: same — the outline joins its room
      CITY.group.add(quad); CITY.group.add(box);
      hl = { quad, box };
    } catch (er) { }
  }

  // ---- camera glide ---------------------------------------------------
  function startGlide(tx, tz, el, dist) {
    try {
      camCtl.follow = false;                       // the glide owns the view for a moment
      camCtl.distT = THREE.MathUtils.clamp(dist, 55, 900);
      glide = { tx, tz, el, t0: performance.now() };
    } catch (er) { }
  }
  function startGlideFloor(i) {
    if (!cur || !curLayout) return;
    const yb = SLAB0 + i * FH;
    const el = THREE.MathUtils.clamp(.6 + (yb / Math.max(cur.h, 8)) * .5, .62, 1.05);
    startGlide(cur.x, cur.z, el, Math.max(70, (yb + 62) / Math.sin(el)));
  }
  function startGlideRoom(r) {
    if (!r) return;
    const yb = SLAB0 + r.floor * FH;
    startGlide((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, .78, Math.max(60, (yb + 50) / Math.sin(.78)));
  }

  // ---- the inspector panel -------------------------------------------
  let panel = null;
  function buildPanel() {
    if (panel) return;
    try {
      const st = document.createElement('style');
      st.textContent = [
        '#ohpanel{position:fixed;right:12px;top:70px;width:252px;max-height:min(430px,56vh);display:flex;flex-direction:column;',
        ' background:var(--panel2);border:1px solid rgba(255,255,255,.1);border-radius:12px;z-index:60;overflow:hidden;',
        ' box-shadow:0 10px 34px rgba(0,0,0,.55);font-size:12px;color:var(--txt)}',
        '#ohpanel.hidden{display:none}',
        '#ohp-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 4px}',
        '#ohp-t{font-weight:800;font-size:13px;color:#fff;letter-spacing:.3px;padding-right:8px}',
        '#ohp-x{width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#cbd5e1;background:rgba(255,255,255,.06);flex:none}',
        '#ohp-x:hover{background:rgba(255,255,255,.14);color:#fff}',
        '#ohp-s{padding:0 12px 8px;color:var(--mut);border-bottom:1px solid rgba(255,255,255,.08)}',
        '#ohp-su{padding:8px 12px 0}',
        '#ohp-su button{width:100%}',
        '#ohp-l{padding:9px 12px 3px;font-size:10px;letter-spacing:1.3px;color:#7dd3fc;font-weight:700}',
        '#ohp-list{overflow:auto;padding:2px 6px 8px}',
        '.ohp-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer}',
        '.ohp-row:hover{background:rgba(125,211,252,.13)}',
        '.ohp-row.on{background:rgba(56,189,248,.22);box-shadow:inset 0 0 0 1px rgba(56,189,248,.5)}',
        '.ohp-row b{font-weight:700;white-space:nowrap}',
        '.ohp-row span{color:var(--mut);text-align:right}',
        '@media(max-width:760px){#ohpanel{right:8px;top:64px;width:196px;max-height:38vh}}',
        // v2.43 TITLE DEEDS — the buy/rent deal block + the gold holdings rows
        '#ohp-deal{flex:none;padding:8px 10px 10px;border-top:1px solid rgba(255,255,255,.08);display:none}',
        '#ohp-deal.on{display:block}',
        '#ohp-dl{font-size:10px;letter-spacing:1.3px;color:#f5cc74;font-weight:700;margin-bottom:4px}',
        '.ohp-kv{display:flex;justify-content:space-between;color:var(--mut);padding:2px 0;font-size:11px}',
        '.ohp-kv b{color:var(--txt);font-weight:700}',
        '#ohp-deal .btn{width:100%;margin-top:6px;padding:7px 8px;font-size:11px}',
        '.ohp-row.mine{background:rgba(245,204,116,.14);box-shadow:inset 0 0 0 1px rgba(245,204,116,.45)}',
        '.ohp-row.mine:hover{background:rgba(245,204,116,.22)}',
        '.ohp-row.mine .ohp-mine{color:#f5cc74;font-weight:700;white-space:nowrap}',
      ].join('');
      document.head.appendChild(st);
      panel = document.createElement('div');
      panel.id = 'ohpanel';
      panel.className = 'hidden';
      panel.innerHTML = '<div id="ohp-h"><span id="ohp-t">Building</span><span id="ohp-x" title="Close">\u2715</span></div>' +
        '<div id="ohp-s"></div><div id="ohp-su"></div><div id="ohp-l"></div><div id="ohp-list"></div><div id="ohp-deal"></div>';   // v2.43: the deal block rides under the list
      document.body.appendChild(panel);
      panel.querySelector('#ohp-x').addEventListener('click', () => heal());
    } catch (er) { }
  }
  function showPanel() {
    buildPanel();
    if (!panel || !cur || !curLayout) return;
    const b = cur, L = curLayout;
    const suite = (CITY.suites || []).find(s => s.bkey === b.bkey);
    const mine = suite && STATE.offices.find(o => o.bkey === suite.bkey);
    panel.querySelector('#ohp-t').textContent = suite ? suite.name : (L.house ? 'Private House' : 'Private Building');
    panel.querySelector('#ohp-s').textContent =
      Math.round(b.h) + ' m \u00b7 ' + L.nF + (L.nF > 1 ? ' floors \u00b7 ' : ' floor \u00b7 ') +
      Math.round(b.area) + ' m\u00b2' + (suite ? ' \u00b7 $' + suite.rate + '/day suite' : '');
    const su = panel.querySelector('#ohp-su');
    su.innerHTML = suite ? '<button class="btn ' + (mine ? 'good' : 'primary') + '" id="ohp-lease">' +
      (mine ? 'MANAGE SUITE' : 'LEASE SUITE \u2014 $' + suite.rate + '/day') + '</button>' : '';
    if (suite) su.querySelector('#ohp-lease').addEventListener('click', () => {
      try { ECO.clickAt(b.x, b.z); } catch (er) { }        // the game's own lease/manage flow
    });
    const lbl = panel.querySelector('#ohp-l'), list = panel.querySelector('#ohp-list');
    const rows = [];
    if (L.nF >= 3) {
      lbl.textContent = 'FLOORS \u2014 PICK, BUY OR RENT';   // v2.43
      rows.push({ k: 'all', t: '<b>All floors</b>', s: 'full dollhouse', on: sel.floor == null });
      for (let i = L.nF - 1; i >= 0; i--) {
        const nm = i === 0 ? 'Ground' : 'Floor ' + (i + 1);
        const tp = L.floorTypes[i] === 'office' ? 'Offices'
          : L.floorTypes[i] === 'home' ? (i === L.nF - 1 && L.nF >= 5 ? 'Penthouse' : 'Apartments')
            : L.floorTypes[i] === 'lobby' ? 'Lobby' : (L.house ? 'Home' : 'Shops');
        // v2.43 TITLE DEEDS: each floor carries its market rent, and yours wears the gold tag
        let own = null, rt = 0;
        try { own = PROP.status(b.bkey, 'floor', i); rt = PROP.rateOf(b, 'floor', i, b.area); } catch (er) { }
        rows.push({
          k: 'f' + i, t: '<b>' + nm + '</b>', mine: own ? own.mode : null,
          s: own ? tp + ' \u00b7 <span class="ohp-mine">' + (own.mode === 'owned' ? '\u2713 OWNED' : '\u2713 RENTED') + '</span>'
            : tp + ' \u00b7 $' + rt + '/d',
          on: sel.floor === i,
        });
      }
    } else {
      lbl.textContent = 'ROOMS \u2014 PICK, BUY OR RENT';   // v2.43
      if (L.rooms.length) L.rooms.forEach((r, i) => {
        const a = Math.max(1, Math.round((r.x1 - r.x0) * (r.z1 - r.z0)));
        // v2.43 TITLE DEEDS: each room carries its market rent, and yours wears the gold tag
        let own = null, rt = 0;
        try { own = PROP.status(b.bkey, 'room', i); rt = PROP.rateOf(b, 'room', i, a); } catch (er) { }
        rows.push({
          k: 'r' + i, t: '<b>' + r.name + '</b>', mine: own ? own.mode : null,
          s: own ? a + ' m\u00b2 \u00b7 <span class="ohp-mine">' + (own.mode === 'owned' ? '\u2713 OWNED' : '\u2713 RENTED') + '</span>'
            : a + ' m\u00b2 \u00b7 $' + rt + '/d',
          on: sel.room === i,
        });
      });
      else rows.push({ k: 'all', t: '<b>Whole building</b>', s: '', on: sel.room == null });
    }
    list.innerHTML = rows.map(r =>
      '<div class="ohp-row' + (r.on ? ' on' : '') + (r.mine ? ' mine' : '') + '" data-k="' + r.k + '">' + r.t +   // v2.43: gold tint on your holdings
      (r.s ? '<span>' + r.s + '</span>' : '') + '</div>').join('');
    list.querySelectorAll('.ohp-row').forEach(el => el.addEventListener('click', () => {
      if (!curLayout) return;   // v2.43 hardening: a healed inspector leaves no live rows to click
      const k = el.dataset.k;
      if (k === 'all') sel = { floor: null, room: null };
      else if (k.charAt(0) === 'f') { sel = { floor: +k.slice(1), room: null }; startGlideFloor(sel.floor); }
      else { sel = { floor: null, room: +k.slice(1) }; startGlideRoom(curLayout.rooms[sel.room]); }
      applySel();
      showPanel();
    }));
    try { PROP.dealInto(panel.querySelector('#ohp-deal'), b, L, sel); } catch (er) { }   // v2.43 TITLE DEEDS: the deal block under the list
    panel.classList.remove('hidden');
    try { const on = list.querySelector('.ohp-row.on'); if (on) on.scrollIntoView({ block: 'nearest' }); } catch (er) { }
  }
  function hidePanel() { if (panel) panel.classList.add('hidden'); }

  // ---- the click (raycast the real shells; fall back to the ground) ---
  const _ndc = new THREE.Vector2();
  const _pt = new THREE.Vector3();
  function pick(cx, cy) {
    try {
      if (STATE.mode !== 'city' || !CITY.group || !CITY.buildingPolys || !CITY.buildingPolys.length) return false;
      _ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
      ray.setFromCamera(_ndc, camera);
      const hits = ray.intersectObjects(CITY.group.children, true);
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (!h || !h.point) continue;
        const b = CITY.pointInBuilding(h.point.x, h.point.z);
        if (b && h.point.y < b.h + 14) return select(b);      // a true wall/roof hit
      }
      const pt = ray.ray.intersectPlane(groundPlane, _pt);    // hover semantics: the base counts too
      if (pt) {
        const b = CITY.pointInBuilding(pt.x, pt.z);
        if (b) return select(b);
      }
    } catch (er) { console.error('[openhouse]', er); }
    return false;
  }

  // ---- listeners (once) ----------------------------------------------
  try {
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const mw = document.getElementById('modalwrap');
      if (mw && !mw.classList.contains('hidden')) return;     // a real modal wins
      if (cur) heal();
    });
    canvas.addEventListener('pointerdown', () => { glide = null; }, { passive: true });   // any grab cancels the glide
  } catch (er) { }

  function tick(dt, px, pz, camDist) {
    const g = CITY.group;
    if (g !== lastGroup) {          // a new city (or none) — heal, unpin and drop the cache
      lastGroup = g;
      heal(); dropCache();
      return;
    }
    if (!g) return;
    if (pinned && (!cur || cur.bkey !== pinned.bkey)) { open(pinned); showPanel(); }
    if (cur) {
      // v2.41: the inspector is MANUAL — it only closes itself when the view
      // has truly wandered off (or a city swap healed it above)
      const fx = camCtl.follow ? px : camCtl.tx;
      const fz = camCtl.follow ? pz : camCtl.tz;
      if (Math.hypot(fx - cur.x, fz - cur.z) > CLOSE_D || camDist > CLOSE_ZOOM) { heal(); return; }
    }
    // v2.41: the camera glide to the picked floor / room (input cancels it)
    if (glide) {
      let cancel = false;
      try { cancel = ACTORS.navInput().active; } catch (er) { }
      if (cancel) glide = null;
      else {
        const k = Math.min(1, dt * 3);
        camCtl.tx += (glide.tx - camCtl.tx) * k;
        camCtl.tz += (glide.tz - camCtl.tz) * k;
        camCtl.el += (glide.el - camCtl.el) * Math.min(1, dt * 2.4);
        if (performance.now() - glide.t0 > 2600) glide = null;
      }
    }
    if (hl) { hlT += dt; try { hl.quad.material.opacity = .2 + .13 * (Math.sin(hlT * 2.6) * .5 + .5); } catch (er) { } }
  }

  return {
    tick, force, heal, pick,
    close() { heal(); },
    refresh() { if (cur) { applySel(); showPanel(); } },   // v2.43 TITLE DEEDS: re-render after a purchase (row tags, glow, deal)
    roomRect(i) {   // v2.43 TITLE DEEDS: the open building's room rect (QA + property pricing)
      if (!curLayout || !curLayout.rooms[i]) return null;
      const r = curLayout.rooms[i];
      return { name: r.name, floor: r.floor, x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, area: Math.max(1, Math.round((r.x1 - r.x0) * (r.z1 - r.z0))) };
    },
    get shells() { return shellMeshes.length; },
    rig() { return planes.map(p => [p.normal.x, p.normal.y, p.normal.z, p.constant]); },
    probe(x, y, z) {          // QA: is a world point inside the live clip prism (above cut)?
      for (const p of planes) if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant >= 0) return false;
      return true;
    },
    mats() {                  // QA: the shell materials' clipping state
      const out = [];
      for (const m of shellMeshes) {
        const mat = m && m.material;
        if (mat && !Array.isArray(mat) && mat.isMeshLambertMaterial && !out.includes(mat))
          out.push({ type: m.isInstancedMesh ? 'inst' : 'mesh', planes: mat.clippingPlanes ? mat.clippingPlanes.length : 0, inter: !!mat.clipIntersection, shadows: !!mat.clipShadows });
      }
      return out;
    },
    rooms() { return curLayout ? curLayout.rooms.map(r => r.name) : []; },   // QA
    selectFloor(i) {          // QA: pick a floor of the open building
      if (!cur || !curLayout || i == null || i < 0 || i >= curLayout.nF) return false;
      sel = { floor: i, room: null }; applySel(); startGlideFloor(i); showPanel(); return true;
    },
    selectRoom(i) {           // QA: pick a room of the open building
      if (!cur || !curLayout || i == null || !curLayout.rooms[i]) return false;
      sel = { floor: null, room: i }; applySel(); startGlideRoom(curLayout.rooms[i]); showPanel(); return true;
    },
    state() {
      return {
        open: cur ? {
          bkey: cur.bkey, h: Math.round(cur.h),
          floors: curLayout ? curLayout.nF : Math.max(1, Math.round(cur.h / FH)),
          x: Math.round(cur.x), z: Math.round(cur.z),
          floor: sel.floor,
          room: (sel.room != null && curLayout && curLayout.rooms[sel.room]) ? curLayout.rooms[sel.room].name : null,
          rooms: curLayout ? curLayout.rooms.length : 0,
          drawRange: curMesh ? curMesh.geometry.drawRange : null,
          verts: curMesh ? curMesh.geometry.attributes.position.count : 0,
        } : null,
        pinned: pinned ? pinned.bkey : null,
        panel: panelOpen(),
        planesActive, shells: shellMeshes.length, cached: cache.size,
      };
    },
  };
})();
window.OH = OH;   // QA surface

// ADDITIVE hook — the same wrap pattern the game already uses (the
// world forest wrapped WORLD.update first; this chains right after it,
// so the beat is: the original update, then the forest tick, then the
// open house tick). Installed at module-eval time, before the first
// rAF tick ever fires.
const __ohOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __ohOrigUpdate(dt, px, pz, camDist);
  try { OH.tick(dt, px, pz, camDist); } catch (e) { console.error('[openhouse]', e); }
  return req;
};

// v2.41 ADDITIVE hook — the CLICK path: a tap that lands on a building
// opens the inspector BEFORE the game's own click routing runs (plots,
// suites, walk orders). Same wrap pattern as WORLD.update above; if the
// openhouse pass ever throws, the original click flow still runs.
const __ohClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (OH.pick(cx, cy)) return; } catch (e) { console.error('[openhouse]', e); }
  return __ohClickPick(cx, cy);
});

// v2.42 ADDITIVE hook — the suburb distance LOD: past ~1 km of view
// distance the house/tree/car meshes of the neighborhoods hide (they
// are sub-5px specks up there; the streets, lawns and the suburb decal
// keep the neighborhood pattern legible from altitude, and the shadow
// pass skips them too). Same wrap pattern as the forest and openhouse
// ticks before it — the original update runs untouched.
const __nbOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __nbOrigUpdate(dt, px, pz, camDist);
  try {
    const g = CITY.suburbGroup;
    if (g) {
      const vis = camDist < 1000;
      if (g.visible !== vis) g.visible = vis;
    }
  } catch (e) { }
  return req;
};

