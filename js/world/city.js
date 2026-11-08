// ====================================================================
// js/world/city.js — the city builder (Stage 6): streets, blocks,
// buildings, rooms.
// ====================================================================
import * as THREE from 'three';
import { ECON } from '../config.js';
import { _ihash, _mulberry, _polyArea, hashStr } from '../util.js';
import { LANDGEO } from '../core.js';
import { WORLD } from '../world/world.js';

// ======== section: 40_city.js ========
// ======== section: 40_city.js ========
// ====================================================================
// v2.07 — CITY: CLEAR STREETS — trees, lamps, benches, bollards and
// parked cars now check the asphalt of EVERY road (nearest-road test),
// not just the street they were planted along: nothing spawns in the
// middle of a crossing road at intersections any more. Lawns got the
// same width-aware clearance.
// ====================================================================
// v2.04 — CITY: async progressive build — phases yield to the browser
// (rAF) with live status text, so entering never freezes the page.
// v2.03 — CITY: every building is now an individual — 4 facade systems
// (classic grid / glass curtain / punched residential / pre-war bays),
// a warm-pastel + earth-tone palette picked by height, per-building
// window pattern shifts, pitched hip + gable roofs with dormers and
// chimneys on the low-rise, wedding-cake setbacks on the towers,
// cornices, roof-access bulkheads, parapets, water tanks, antennas —
// plus bright lawn strips with trees around pitched houses. v2.02's
// street detail (curbs, crosswalks, shopfronts, lamps, cars) stays.
// ====================================================================
// v2.02 — CITY: renders imported street data in the Capital Rift look,
// with the full STREET DETAIL pass: raised curbs and slab-seamed
// sidewalks, zebra crosswalks at intersections, manhole covers,
// noise-grained asphalt and mottled ground, shop-front ground floors
// with striped awnings, roof parapets, water tanks and antennas, street
// lamps, hydrants, benches, trash bins, parked cars (yellow taxis in
// tier-3 cities), park walking paths. (v2.16 CLEAN HORIZON: the fake
// backdrop skyline ring is GONE — the horizon shows the real one world.)
// ====================================================================
export const CITY = (() => {
  const WIN = 3.2;                      // meters per window cell
  let group, plotGroup;
  let roads = [], plotRecs = [], suites = [];
  let bHash = null, rHash = null;       // spatial hashes
  let buildingPolys = [];
  let cityRec = null;
  let cityAnchor = null;                // v2.15: world position of this city
  // v2.27 TRUE SCALE: the current city's anchor, subtracted from every
  // vertex this module emits — merged geometry is CITY-LOCAL (float32-
  // safe at 1:1) and each mesh/instanced layer carries the anchor in
  // double precision. Set in build() before any builder runs.
  let AX = 0, AZ = 0;
  let isMob = false;                    // touch device → lighter densities
  let benchScratch = [];                // benches collected from parks + walks
  let pitchedRects = [];              // lawn candidates from pitched-roof buildings
  let buildStats = null;               // QA census of the last build (styles/roofs)
  let treeList = [], treeStats = null; // v2.07: final planted trees + road-clearance census
  let gates = [];            // v2.14: country road gates -> land-connected cities
  let _grassTex = null;      // v2.14: pasture ground
  const hexOf = c => '#' + c.getHexString();

  // ---------- low-level quad/triangle pushers ----------------------
  // p1..p4 = [x,y,z]; uv1..4 = [u,v]; triangles (p1,p2,p3),(p1,p3,p4)
  // v2.27: every pusher subtracts the city anchor (AX, AZ) — callers keep
  // working in absolute world coordinates, the buffers stay city-local.
  function pushQuad(arr, p1, p2, p3, p4, n, uv1, uv2, uv3, uv4, col) {
    const P = [p1, p2, p3, p1, p3, p4], U = [uv1, uv2, uv3, uv1, uv3, uv4];
    for (let i = 0; i < 6; i++) {
      arr.pos.push(P[i][0] - AX, P[i][1], P[i][2] - AZ);
      arr.norm.push(n[0], n[1], n[2]);
      arr.uv.push(U[i][0], U[i][1]);
      if (arr.col && col) arr.col.push(col.r, col.g, col.b);
    }
  }
  // upward-facing triangle a→center→b (CCW seen from +y)
  function pushFlat(arr, a, b, c, col) {
    arr.pos.push(a[0] - AX, a[1], a[2] - AZ, c[0] - AX, c[1], c[2] - AZ, b[0] - AX, b[1], b[2] - AZ);
    for (let i = 0; i < 3; i++) { arr.norm.push(0, 1, 0); arr.uv.push(0, 0); if (arr.col && col) arr.col.push(col.r, col.g, col.b); }
  }
  // triangle with auto normal (hint flips winding so the face is visible)
  function pushTri(arr, a, b, c, col, hint) {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (hint && n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) {
      const t = b; b = c; c = t; n = [-n[0], -n[1], -n[2]];
    }
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const q of [a, b, c]) {
      arr.pos.push(q[0] - AX, q[1], q[2] - AZ); arr.norm.push(n[0] / l, n[1] / l, n[2] / l); arr.uv.push(0, 0);
      if (arr.col && col) arr.col.push(col.r, col.g, col.b);
    }
  }
  // quad with auto normal from winding (hint flips if back-facing)
  function pushQuadN(arr, p1, p2, p3, p4, col, hint) {
    pushTri(arr, p1, p2, p3, col, hint);
    pushTri(arr, p1, p3, p4, col, hint);
  }
  // oriented bounding rect via PCA — pitched roofs + lawns
  function obbOf(p) {
    let mx = 0, mz = 0;
    for (const v of p) { mx += v[0]; mz += v[1]; }
    mx /= p.length; mz /= p.length;
    let xx = 0, xz = 0, zz = 0;
    for (const v of p) { const dx = v[0] - mx, dz = v[1] - mz; xx += dx * dx; xz += dx * dz; zz += dz * dz; }
    const tr = xx + zz, det = xx * zz - xz * xz;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const lam = tr / 2 + disc;
    let ux, uz;
    if (Math.abs(xz) > 1e-9) { ux = xz; uz = lam - xx; } else { ux = 1; uz = 0; }
    const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    const vx = -uz, vz = ux;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const q of p) {
      const du = (q[0] - mx) * ux + (q[1] - mz) * uz;
      const dv = (q[0] - mx) * vx + (q[1] - mz) * vz;
      u0 = Math.min(u0, du); u1 = Math.max(u1, du); v0 = Math.min(v0, dv); v1 = Math.max(v1, dv);
    }
    return { cx: mx, cz: mz, ux, uz, vx, vz, u0, u1, v0, v1, Lu: u1 - u0, Lv: v1 - v0, area: (u1 - u0) * (v1 - v0) };
  }
  const colOf = hex => new THREE.Color(hex);   // r160: hex is auto-converted to linear
  const jit = (c, f) => c.clone().multiplyScalar(f);   // brightness jitter

  // ---------- textures (module singletons; dispose() skips) ---------
  // 4 facade systems — every building rolls one, so no two neighbors read
  // the same: 0 classic grid · 1 glass curtain wall · 2 punched openings
  // (residential) · 3 pre-war vertical bays.
  function windowTexture(variant) {
    const N = 16, S = 48, PX = N * S;
    const cv = document.createElement('canvas'); cv.width = PX; cv.height = PX;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f4f2ef'; ctx.fillRect(0, 0, PX, PX);   // near-white wall (tinted per building)
    const glassFor = (r, darkA, darkB) =>
      r < .10 ? '#ffedbe' : r < .16 ? '#ffe3a6' : r < .28 ? darkA : darkB;
    // large-scale architecture baked into the tile: vertical expansion
    // joints every 4th column + a darker mechanical belt floor every 5th
    // row — breaks the "one repeating swatch" read on big facades
    const joint = (x, y) => { if (x % 4 === 3) { ctx.fillStyle = 'rgba(40,42,46,.35)'; ctx.fillRect(x * S + S - 3, y * S, 3, S); } };
    const belt = (x, y) => { if (y % 5 === 4) { ctx.fillStyle = 'rgba(40,42,46,.22)'; ctx.fillRect(x * S, y * S + S - 7, S, 7); } };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const r = _ihash(x, y, 91 + variant * 17);
      const wx = x * S, wy = y * S;
      joint(x, y); belt(x, y);
      if (variant === 1) {                                  // glass curtain wall
        ctx.fillStyle = 'rgba(58,62,68,.30)'; ctx.fillRect(wx, wy, S, 3);              // spandrel line
        ctx.fillStyle = glassFor(r, '#39424d', (r * 7 % 1) < .5 ? '#2e353e' : '#333a44');
        ctx.fillRect(wx + 2, wy + 3, S - 4, S - 6);
        ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(wx + 2, wy + 3, S - 4, 2); // sky reflection
        ctx.fillStyle = 'rgba(244,242,239,.9)'; ctx.fillRect(wx + S / 2 - 1, wy + 3, 2, S - 6); // mullion
        ctx.fillStyle = 'rgba(244,242,239,.55)';
        ctx.fillRect(wx, wy + 3, 2, S - 6); ctx.fillRect(wx + S - 2, wy + 3, 2, S - 6);
      } else if (variant === 2) {                           // punched openings (residential)
        ctx.fillStyle = 'rgba(70,70,74,.14)'; ctx.fillRect(wx, wy, S, 2);
        const pw = 21, ph = 22, ox = (S - pw) / 2, oy = 10;
        ctx.fillStyle = glassFor(r, '#3d434c', '#343a42');
        ctx.fillRect(wx + ox, wy + oy, pw, ph);
        ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(wx + ox, wy + oy, pw, 2);
        ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(wx + ox - 1, wy + oy + ph, pw + 2, 2);
      } else if (variant === 3) {                           // pre-war vertical bays
        ctx.fillStyle = 'rgba(0,0,0,.10)';
        ctx.fillRect(wx, wy, 3, S); ctx.fillRect(wx + S - 3, wy, 3, S);   // pilaster shade
        ctx.fillStyle = 'rgba(255,255,255,.28)';
        ctx.fillRect(wx + 3, wy, 2, S); ctx.fillRect(wx + S - 5, wy, 2, S); // pilaster edges
        const bw = 20, bh = S - 18, ox = (S - bw) / 2, oy = 9;
        ctx.fillStyle = glassFor(r, '#3d434c', '#363c45');
        ctx.fillRect(wx + ox, wy + oy, bw, bh);
        ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.fillRect(wx + ox, wy + oy, bw, 2);
        ctx.fillStyle = 'rgba(70,70,74,.2)'; ctx.fillRect(wx, wy, S, 2);
      } else {                                              // 0 classic grid
        const gx = x * S + 12, gy = y * S + 10, gw = S - 21, gh = S - 18;
        ctx.fillStyle = 'rgba(70,70,74,.18)'; ctx.fillRect(wx, wy, S, 2);
        if (r < .13) ctx.fillStyle = '#ffedbe';                 // lit windows (two warmths)
        else if (r < .21) ctx.fillStyle = '#ffe3a6';
        else if (r < .30) ctx.fillStyle = '#3d434c';
        else if (r > .955) ctx.fillStyle = '#262b31';           // blinds drawn
        else ctx.fillStyle = (r * 7 % 1) < .5 ? '#333941' : '#373d46';
        ctx.fillRect(gx, gy, gw, gh);
        ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(gx, gy, gw, 2);       // glass sheen
        ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(gx - 1, gy + gh, gw + 2, 3); // sill
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  // dark asphalt with speckle, repair patches and tire-wear streaks
  function asphaltTexture() {
    const PX = 256;
    const cv = document.createElement('canvas'); cv.width = PX; cv.height = PX;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#3a3f44'; ctx.fillRect(0, 0, PX, PX);
    const rnd = _mulberry(1234);
    for (let i = 0; i < 5; i++) {                              // lighter repair patches
      ctx.fillStyle = 'rgba(74,79,85,.4)';
      const w = 30 + rnd() * 60, h = 20 + rnd() * 50;
      ctx.fillRect(rnd() * (PX - w), rnd() * (PX - h), w, h);
    }
    for (let i = 0; i < 3; i++) {                              // faint tire-wear (along u)
      ctx.fillStyle = 'rgba(0,0,0,.04)';
      ctx.fillRect(0, rnd() * PX, PX, 3 + rnd() * 6);
    }
    for (let i = 0; i < 700; i++) {                            // grit speckle
      ctx.fillStyle = rnd() < .5 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.045)';
      ctx.fillRect(rnd() * PX, rnd() * PX, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  // mottled earth/concrete for the ground plane under everything
  function groundTexture() {
    const PX = 256;
    const cv = document.createElement('canvas'); cv.width = PX; cv.height = PX;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#b3aea5'; ctx.fillRect(0, 0, PX, PX);
    const rnd = _mulberry(777);
    for (let i = 0; i < 26; i++) {                             // soil blotches
      ctx.fillStyle = rnd() < .5 ? 'rgba(143,138,128,.09)' : 'rgba(176,171,162,.08)';
      const r = 8 + rnd() * 38;
      ctx.beginPath(); ctx.ellipse(rnd() * PX, rnd() * PX, r, r * (.5 + rnd() * .5), rnd() * 3, 0, 6.29); ctx.fill();
    }
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = rnd() < .5 ? 'rgba(0,0,0,.05)' : 'rgba(255,255,255,.04)';
      ctx.fillRect(rnd() * PX, rnd() * PX, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.repeat.set(26, 26);
    return tex;
  }

  // street-level storefronts: glass panes, doors, striped awnings
  function shopTexture() {
    const W = 1024, H = 256, C = 128;                          // 2x res — crisp at gameplay zoom
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#cfc9c0'; ctx.fillRect(0, 0, W, H);       // light base (tinted per building)
    const AWN = [['#b03a30', '#ece6dc'], ['#2f6b4a', '#ece6dc'], ['#2a4a68', '#ece6dc'], ['#3a3a3d', '#d8d3c9']];
    for (let i = 0; i < W / C; i++) {
      const x0 = i * C;
      ctx.fillStyle = '#bdb6ac';                               // pilaster dividers
      ctx.fillRect(x0, 0, 10, H); ctx.fillRect(x0 + C - 10, 0, 10, H);
      // awning valance (canvas top = texture top)
      const [a, b] = AWN[i % 4];
      ctx.fillStyle = b; ctx.fillRect(x0 + 10, 0, C - 20, 60);
      ctx.fillStyle = a;
      for (let s = 0; s < 4; s++) ctx.fillRect(x0 + 10 + s * 30, 0, 16, 60);
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(x0 + 10, 60, C - 20, 8);   // valance shadow
      // storefront glass
      ctx.fillStyle = '#222b34'; ctx.fillRect(x0 + 10, 68, C - 20, H - 68);
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(x0 + 10, 68, C - 20, 48); // sky reflection band
      ctx.fillStyle = '#4b545e';                               // mullions
      ctx.fillRect(x0 + 42, 68, 6, H - 68); ctx.fillRect(x0 + 76, 68, 6, H - 68);
      if (i % 3 === 2) {                                       // a door
        ctx.fillStyle = '#4a3b2c'; ctx.fillRect(x0 + 84, 88, 34, H - 88);
        ctx.fillStyle = '#c9c2b6'; ctx.fillRect(x0 + 88, 140, 4, 14); ctx.fillRect(x0 + 110, 140, 4, 14);
      }
      ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(x0 + 10, H - 18, C - 20, 18); // damp base
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  // ---- the building-color system: muted pastels + earth tones (the
  // reference look), picked warm-or-cool by height so towers read cooler
  // and low-rise blocks read warm ----
  // v2.64 CITY BEAUTIFUL palettes: terracotta/clay warms and slate/
  // blue-glass cools join the stock pastels; roofs gain gravel-tan,
  // tar-red and pale concrete so the skyline patchworks like a real
  // city seen from above instead of one flat gray-brown.
  const PAL_WARM = [0xf2e6d0, 0xf2ead0, 0xe8dcc0, 0xcfb37f, 0xcd9488, 0xc4907f, 0xb08d76, 0xa05252, 0xe0dcd4, 0xc8beac, 0x9db5a0,
    0xd9b8a3, 0xb76b5e, 0xc2766b, 0xd8a087];              // terracotta + clay
  const PAL_COOL = [0xe1e3e6, 0xb5bdc2, 0x9aa2a8, 0x8e99a6, 0x9a9c9e, 0x4f4f52,
    0x7f8fa0, 0xa8b4c2, 0x6e7b86, 0x8496a8];              // slate + blue-glass
  const ROOF_DECKS = [0x3f4347, 0x4a3b2f, 0x3a434d, 0x4d5c51, 0x57504a,
    0x6b5d4a, 0x7a4638, 0x8a8378];                        // gravel-tan, tar-red, pale concrete
  const SHINGLES = [0x6b4a33, 0x9c4a3c, 0x46505c, 0x3d4043, 0x7a5c48, 0x55603f];
  const TRIMS = [0x3a3f44, 0x4a3b2c, 0x5a4a42, 0x39424a, 0x4f4438, 0x2f3a41];
  let _winTexs = [null, null, null, null], _asphTex = null, _groundTex = null, _shopTex = null, _dollarTex = null;
  const getWinTex = i => _winTexs[i] || (_winTexs[i] = windowTexture(i));
  const getAsphTex = () => _asphTex || (_asphTex = asphaltTexture());
  const getGroundTex = () => _groundTex || (_groundTex = groundTexture());
  const getGrassTex = () => _grassTex || (_grassTex = grassTexture());
  const getShopTex = () => _shopTex || (_shopTex = shopTexture());

  // ---------- 2D segment intersection ------------------------------
  function segX(p1, p2, p3, p4) {
    const rx = p2[0] - p1[0], rz = p2[1] - p1[1], sx = p4[0] - p3[0], sz = p4[1] - p3[1];
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) return null;
    const qpx = p3[0] - p1[0], qpz = p3[1] - p1[1];
    const t = (qpx * sz - qpz * sx) / den;
    const u = (qpx * rz - qpz * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t, u };
  }

  // ---------- roads + sidewalks + markings --------------------------
  // v2.64 CLEAN STREETS: junctions draw like junctions now. Every road
  // samples into a junction index first, then — sidewalks that would
  // run into ANOTHER road's asphalt step down to a crossing ramp
  // instead of raising a curb wall through the crossing street; center
  // dashes, edge lines, manholes and country verges stay out of
  // junction squares; and each road's asphalt carries its own micro
  // height so co-class crossings always have a clean winner (no
  // z-fighting shimmer where two ribbons stack).
  function buildRoads(city) {
    const asph = { pos: [], norm: [], uv: [], col: [] };
    const mark = { pos: [], norm: [], uv: [], col: [] };
    const walk = { pos: [], norm: [], uv: [], col: [] };
    const cAsph = colOf(0xffffff), cYel = colOf(0xe8c243), cWht = colOf(0xe8e4dc), cWalk = colOf(0xc4bcb0);
    const cCurb = colOf(0xb3ab9e), cSeam = colOf(0xa39a8b), cCW = colOf(0xeceae2);
    const cVerge = colOf(0x8f8a7c);   // v2.14: country gravel verge
    const cRamp = colOf(0xb9b1a5);    // v2.64: crossing-ramp concrete
    const UP = [0, 1, 0];
    const mobF = isMob ? .5 : 1;
    const WALKY = .16, RAMP0 = .049;

    // ---- v2.64 junction index: every road sampled every ~8 m --------
    const SCELL = 28, sgrid = new Map(), samps = [];
    const addS = (ri, x, z) => {
      samps.push({ ri, x, z });
      const k = Math.floor(x / SCELL) + ',' + Math.floor(z / SCELL);
      let a = sgrid.get(k); if (!a) sgrid.set(k, a = []); a.push(samps.length - 1);
    };
    roads.forEach((r, ri) => {
      const p = r.pts;
      for (let i = 0; i < p.length; i++) {
        if (i < p.length - 1) {
          const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
          const L = Math.hypot(dx, dz) || 1, n = Math.min(60, Math.floor(L / 8));
          addS(ri, p[i][0], p[i][1]);
          for (let k = 1; k < n; k++) addS(ri, p[i][0] + dx * k / n, p[i][1] + dz * k / n);
        } else addS(ri, p[i][0], p[i][1]);
      }
    });
    let MAXW = 9; roads.forEach(r => { if (r.w > MAXW) MAXW = r.w; });
    const nearS = (x, z, rad, fn) => {
      for (let cx = Math.floor((x - rad) / SCELL); cx <= Math.floor((x + rad) / SCELL); cx++)
        for (let cz = Math.floor((z - rad) / SCELL); cz <= Math.floor((z + rad) / SCELL); cz++) {
          const a = sgrid.get(cx + ',' + cz); if (!a) continue;
          for (let si = 0; si < a.length; si++) fn(samps[a[si]]);
        }
    };
    // true when (x,z) enters ANOTHER road's corridor by margin m
    // (self excluded: a road's own walk band never conflicts with itself)
    const inJunction = (x, z, self, m) => {
      let hit = false;
      nearS(x, z, MAXW / 2 + m + SCELL, s => {
        if (hit || s.ri === self) return;
        if (Math.hypot(s.x - x, s.z - z) < roads[s.ri].w / 2 + m) hit = true;
      });
      return hit;
    };

    // ribbon quad between (ax,az)-(bx,bz), width w, height y
    // uUnit/vUnit: meters per texture tile along/across (asphalt noise)
    const rib = (arr, ax, az, bx, bz, w, y, col, uUnit, vUnit) => {
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      const px = -dz / len * w / 2, pz = dx / len * w / 2;
      const u1 = uUnit ? len / uUnit : 1;
      const v1 = vUnit ? w / vUnit : 1;
      pushQuad(arr,
        [ax + px, y, az + pz], [bx + px, y, bz + pz], [bx - px, y, bz - pz], [ax - px, y, az - pz],
        UP, [0, 0], [u1, 0], [u1, v1], [0, v1], col);
    };
    // v2.64: sloped surface quad — the curb-ramp transition where a
    // raised walk steps down to a crossing ramp
    const ribSlope = (arr, ax, az, yA, bx, bz, yB, w, col) => {
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      const px = -dz / len * w / 2, pz = dx / len * w / 2;
      pushQuad(arr,
        [ax + px, yA, az + pz], [bx + px, yB, bz + pz], [bx - px, yB, bz - pz], [ax - px, yA, az - pz],
        UP, [0, 0], [1, 0], [1, 1], [0, 1], col);
    };

    const manholes = [];
    const FINE = 2.75;
    roads.forEach((rd, ri) => {
      const pts = rd.pts;
      // v2.64: per-road micro height (unique by construction) — co-class
      // crossings always have a winner, never a z-fight. Stays clear of
      // the ramp (.049+) and marking (.054+) layers below.
      const yJ = roads.length ? (ri / roads.length) * .007 : 0;
      const y = (rd.cls === 3 ? .030 : rd.cls === 2 ? .034 : .038) + yJ;
      for (let i = 0; i < pts.length - 1; i++) rib(asph, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], rd.w, y, cAsph, 3.2, 3.2);
      if (rd.country) {
        // v2.14: country highway — no sidewalks, no curbs: gravel verges
        // (v2.64: verge strips skip the crossing square — two country
        // lanes crossing at a homestead used to stack gravel-on-gravel)
        for (const side of [1, -1]) {
          const off = rd.w / 2 + 2.1;
          for (let i = 0; i < pts.length - 1; i++) {
            const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
            const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
            const ux = dx / len, uz = dz / len;
            const px = -uz * off * side, pz = ux * off * side;
            const n = Math.max(1, Math.ceil(len / 3.5));
            for (let k = 0; k < n; k++) {
              const d0 = k * len / n, d1 = (k + 1) * len / n;
              const mx = ax + ux * (d0 + d1) / 2 + px, mz = az + uz * (d0 + d1) / 2 + pz;
              if (inJunction(mx, mz, ri, 2)) continue;
              rib(walk, ax + ux * d0 + px, az + uz * d0 + pz, ax + ux * d1 + px, az + uz * d1 + pz, 3.6, .03, cVerge);
            }
          }
        }
      } else if (rd.sub) {
        // v2.64 CITY BEAUTIFUL: suburb rings, radials and outer lanes
        // carry thin gravel-grass shoulders instead of full urban
        // sidewalk + curb. Out in the neighborhoods a concrete walk on
        // both sides for 55 km read as a triple-band "twin road" from
        // any distance; a shoulder reads as one road with a verge, and
        // it saves the curb geometry too. (Downtown keeps real walks.)
        for (const side of [1, -1]) {
          const off = rd.w / 2 + 1.35;
          for (let i = 0; i < pts.length - 1; i++) {
            const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
            const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
            const ux = dx / len, uz = dz / len;
            const px = -uz * off * side, pz = ux * off * side;
            const n = Math.max(1, Math.ceil(len / 3.5));
            for (let k = 0; k < n; k++) {
              const d0 = k * len / n, d1 = (k + 1) * len / n;
              const mx = ax + ux * (d0 + d1) / 2 + px, mz = az + uz * (d0 + d1) / 2 + pz;
              if (inJunction(mx, mz, ri, 2)) continue;   // keep the crossing square clear
              rib(walk, ax + ux * d0 + px, az + uz * d0 + pz, ax + ux * d1 + px, az + uz * d1 + pz, 2.7, .028, cVerge);
            }
          }
        }
      } else if (!rd.ped) {
        for (const side of [1, -1]) {
          const off = rd.w / 2 + 1.75;
          for (let i = 0; i < pts.length - 1; i++) {
            const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
            const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
            const ux = dx / len, uz = dz / len;
            const px = -uz * off * side, pz = ux * off * side;      // walk centerline offset
            const ox = -uz * 1.75 * side, oz = ux * 1.75 * side;    // half-walk perpendicular
            const onx = -uz * side, onz = ux * side;                // outward normal
            // v2.64: fine-step the walk; each step stays a raised walk
            // or becomes a crossing ramp depending on whether ANOTHER
            // road claims the ground. Consecutive same-mode steps merge
            // into one quad; ramps slope down at their boundaries.
            const nf = Math.max(1, Math.ceil(len / FINE));
            const flags = new Array(nf);
            for (let f = 0; f < nf; f++) {
              const d = (f + .5) * len / nf;
              flags[f] = inJunction(ax + ux * d + px, az + uz * d + pz, ri, 2.0);
            }
            const rampY = RAMP0 + yJ * .68;                          // unique per road, ≤ .0538
            const DX = f => ax + ux * (f * len / nf), DZ = f => az + uz * (f * len / nf);
            let f0 = 0;
            while (f0 < nf) {
              const fl = flags[f0];
              let f1 = f0;
              while (f1 + 1 < nf && flags[f1 + 1] === fl) f1++;
              const x0 = DX(f0) + px, z0 = DZ(f0) + pz, x1 = DX(f1 + 1) + px, z1 = DZ(f1 + 1) + pz;
              if (fl) {
                // crossing ramp: near-asphalt surface, sloped entry/exit
                const bIn = f0 > 0, bOut = f1 + 1 < nf;
                const s0 = bIn ? f0 + 1 : f0, s1 = bOut ? f1 : f1 + 1;
                if (bIn) ribSlope(walk, DX(f0) + px, DZ(f0) + pz, WALKY, DX(f0 + 1) + px, DZ(f0 + 1) + pz, rampY, 3.5, cRamp);
                if (s1 > s0) rib(walk, DX(s0) + px, DZ(s0) + pz, DX(s1) + px, DZ(s1) + pz, 3.5, rampY, cRamp);
                if (bOut) ribSlope(walk, DX(f1) + px, DZ(f1) + pz, rampY, DX(f1 + 1) + px, DZ(f1 + 1) + pz, WALKY, 3.5, cRamp);
              } else {
                // raised walk surface + curb faces
                rib(walk, x0, z0, x1, z1, 3.5, WALKY, cWalk);
                const g0 = .02, g1 = .165;
                // outer face (points away from road)
                pushQuad(walk,
                  [x0 + ox, g1, z0 + oz], [x1 + ox, g1, z1 + oz],
                  [x1 + ox, g0, z1 + oz], [x0 + ox, g0, z0 + oz],
                  [onx, 0, onz], [0, 0], [1, 0], [1, 1], [0, 1], cCurb);
                // inner face (toward the road)
                pushQuad(walk,
                  [x0 - ox, g1, z0 - oz], [x1 - ox, g1, z1 - oz],
                  [x1 - ox, g0, z1 - oz], [x0 - ox, g0, z0 - oz],
                  [-onx, 0, -onz], [0, 0], [1, 0], [1, 1], [0, 1], cCurb);
                // concrete slab seams every 2.3 m across the walk — v2.42:
                // suburb streets skip them (they are ~80% of a street's
                // geometry; the ring would carry ~470k verts of seams alone)
                if (!rd.sub) {
                  const runLen = Math.hypot(x1 - x0, z1 - z0);
                  for (let d = 1.2; d < runLen; d += 2.3) {
                    const mx = x0 + ux * d, mz = z0 + uz * d;
                    rib(walk, mx - ox, mz - oz, mx + ox, mz + oz, .07, .163, cSeam);
                  }
                }
              }
              f0 = f1 + 1;
            }
          }
        }
      }
      // yellow center dashes on cls>=2 (v2.64: they stop short of every
      // crossing — a center line never runs through an intersection)
      if (rd.cls >= 2 && !rd.ped) {
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 6) continue;
          const ux = (bx - ax) / len, uz = (bz - az) / len;
          for (let d = 3; d < len - 3; d += 7) {
            const e = Math.min(d + 3, len - .5);
            const mx = ax + ux * (d + e) / 2, mz = az + uz * (d + e) / 2;
            if (inJunction(mx, mz, ri, 3.2)) continue;   // 3.2: dash tips stay clear of shallow-angle mouths too
            rib(mark, ax + ux * d, az + uz * d, ax + ux * e, az + uz * e, .38, .0585, cYel);
          }
        }
      }
      // white edge lines on main avenues (cls 3) — v2.64: substepped so
      // they, too, break at junctions
      if (rd.cls === 3) {
        for (const side of [1, -1]) {
          const off = rd.w / 2 - .7;
          for (let i = 0; i < pts.length - 1; i++) {
            const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
            const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
            const ux = dx / len, uz = dz / len;
            const px = -uz * off * side, pz = ux * off * side;
            const n = Math.max(1, Math.ceil(len / 3.5));
            for (let k = 0; k < n; k++) {
              const d0 = k * len / n, d1 = (k + 1) * len / n;
              const mx = ax + ux * (d0 + d1) / 2 + px, mz = az + uz * (d0 + d1) / 2 + pz;
              if (inJunction(mx, mz, ri, 2.2)) continue;
              rib(mark, ax + ux * d0 + px, az + uz * d0 + pz, ax + ux * d1 + px, az + uz * d1 + pz, .22, .0545, cWht);
            }
          }
        }
      }
      // manhole covers (v2.14: urban plumbing — country roads get none;
      // v2.64: never in a junction square)
      if (rd.cls >= 2 && !rd.ped && !rd.country) {
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 14) continue;
          const ux = (bx - ax) / len, uz = (bz - az) / len;
          for (let d = 9; d < len - 4; d += 16) {
            const side = (Math.floor(d / 16) % 2) ? 1 : -1;
            const mx = ax + ux * d - uz * rd.w * .22 * side, mz = az + uz * d + ux * rd.w * .22 * side;
            if (inJunction(mx, mz, ri, 2.2)) continue;
            manholes.push([mx, mz]);
          }
        }
      }
    });

    // ---------- zebra crosswalks at road intersections ---------------
    const raw = [];
    const rbbox = roads.map(rd => {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      rd.pts.forEach(p => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); });
      return [x0, x1, z0, z1];
    });
    outer:
    for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
      const A = roads[i], B = roads[j];
      if (A.ped || B.ped || A.country || B.country) continue;   // v2.14: no zebras in the country
      if (A.sub && B.sub) continue;   // v2.64: suburb ring×radial crossings skip the paint budget
      const ba = rbbox[i], bb = rbbox[j];
      if (ba[1] < bb[0] || bb[1] < ba[0] || ba[3] < bb[2] || bb[3] < ba[2]) continue;
      for (let s = 0; s < A.pts.length - 1; s++) for (let t = 0; t < B.pts.length - 1; t++) {
        const p1 = A.pts[s], p2 = A.pts[s + 1], p3 = B.pts[t], p4 = B.pts[t + 1];
        if (Math.max(p1[0], p2[0]) < Math.min(p3[0], p4[0]) - 1 || Math.min(p1[0], p2[0]) > Math.max(p3[0], p4[0]) + 1) continue;
        if (Math.max(p1[1], p2[1]) < Math.min(p3[1], p4[1]) - 1 || Math.min(p1[1], p2[1]) > Math.max(p3[1], p4[1]) + 1) continue;
        const r = segX(p1, p2, p3, p4);
        if (!r) continue;
        const x = p1[0] + (p2[0] - p1[0]) * r.t, z = p1[1] + (p2[1] - p1[1]) * r.t;
        raw.push({ x, z, A, B, s, t });
        if (raw.length >= 700) break outer;   // safety valve
      }
    }
    // v2.64: paint the DENSE CORE first. The cap used to fill in road-
    // order, so the first few streets in the list hoovered the entire
    // paint budget and the visible core got none.
    const ccx = cityAnchor ? cityAnchor.x : 0, ccz = cityAnchor ? cityAnchor.z : 0;
    raw.sort((a, b) => Math.hypot(a.x - ccx, a.z - ccz) - Math.hypot(b.x - ccx, b.z - ccz));
    const ints = [];
    for (const m of raw) {
      if (ints.some(q => Math.hypot(q.x - m.x, q.z - m.z) < 9)) continue;
      ints.push(m);
      if (ints.length >= 170) break;   // v2.64: 90→170, center-out
    }
    let stripes = 0;
    for (const m of ints) {
      const R = m.A.w <= m.B.w ? m.A : m.B;         // paint across the narrower road
      const O = R === m.A ? m.B : m.A;
      const p1 = R === m.A ? m.A.pts[m.s] : m.B.pts[m.t];
      const p2 = R === m.A ? m.A.pts[m.s + 1] : m.B.pts[m.t + 1];
      const dx = p2[0] - p1[0], dz = p2[1] - p1[1], slen = Math.hypot(dx, dz) || 1;
      const ux = dx / slen, uz = dz / slen, prx = -uz, prz = ux;
      const stripeLen = Math.max(2.6, Math.min(R.w * .55, 5));
      for (const sgn of [1, -1]) {
        const d = O.w / 2 + 1.9;
        const bx = m.x + ux * d * sgn, bz = m.z + uz * d * sgn;
        const tt = (bx - p1[0]) * ux + (bz - p1[1]) * uz;
        if (tt < 1.5 || tt > slen - 1.5) continue;
        const span = Math.max(3, Math.min(R.w - 3.4, 6.4));
        const n = Math.max(3, Math.round(span / .92));
        for (let k = 0; k < n; k++) {
          if (stripes >= 1500) break;   // v2.64: 620→1500 (more painted junctions downtown)
          const q = -span / 2 + (n > 1 ? span * k / (n - 1) : 0);
          const cxk = bx + ux * q, czk = bz + uz * q;
          rib(mark, cxk - prx * stripeLen / 2, czk - prz * stripeLen / 2,
            cxk + prx * stripeLen / 2, czk + prz * stripeLen / 2, .5, .062, cCW);
          stripes++;
        }
      }
    }

    const mk = (arr, tex, two) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial(
        tex ? { map: tex, vertexColors: true } : { vertexColors: true, side: two ? THREE.DoubleSide : THREE.FrontSide }));
      m.position.set(AX, 0, AZ); m.receiveShadow = true;   // v2.27: city-local geometry
      group.add(m);
      return m;
    };
    mk(asph, getAsphTex());      // noise-grained asphalt (color from texture)
    mk(walk, null, true);        // DoubleSide: safe curb faces
    mk(mark, null, false);

    // manhole covers (instanced)
    if (manholes.length) {
      const n = Math.min(manholes.length, Math.floor(240 * mobF));
      const geo = new THREE.CircleGeometry(.55, 10); geo.rotateX(-Math.PI / 2);
      const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x2b2f33 }), n);
      const mat4 = new THREE.Matrix4();
      for (let i = 0; i < n; i++) { mat4.identity(); mat4.setPosition(manholes[i][0] - AX, .045, manholes[i][1] - AZ); inst.setMatrixAt(i, mat4); }
      inst.position.set(AX, 0, AZ);   // v2.27: city-local instances
      group.add(inst);
    }
  }

  // ---------- buildings (per-building style: 4 facade systems, pitched
  // roofs with dormers + chimneys, wedding-cake setbacks, cornices,
  // bulkheads, parapets, water tanks, antennas) -----------------------
  function buildBuildings(city) {
    const wallArrs = [0, 1, 2, 3].map(() => ({ pos: [], norm: [], uv: [], col: [] }));
    const shops = { pos: [], norm: [], uv: [], col: [] };
    const roofs = { pos: [], norm: [], uv: [], col: [] };    // decks, parapets, cornices
    const pitched = { pos: [], norm: [], uv: [], col: [] };  // hip/gable roof faces
    const trim = { pos: [], norm: [], uv: [], col: [] };     // dormers, chimneys, bulkheads
    const hvac = [], tanks = [], antennas = [];
    buildingPolys = [];
    pitchedRects = [];
    const rnd = _mulberry(hashStr('b' + (city.key || city.name)));
    let si = 0, nTier = 0;
    let tallest = null;   // v2.64: the skyline crown — track the tallest building
    const tintsUsed = [], roofsUsed = [];

    // ---- shared builders -------------------------------------------
    // one band of perimeter walls (with optional shopfront ground floor)
    const wallBand = (p, yA, yB, tint, style, uOff, vOff, shopTint) => {
      let per = 0;
      for (let i = 0; i < p.length; i++) {
        const a = p[i], c = p[(i + 1) % p.length];
        const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
        if (len < .05) continue;
        const nx = dz / len, nz = -dx / len;               // outward for CCW
        const u0 = per / WIN + uOff, u1 = (per + len) / WIN + uOff;
        pushQuad(wallArrs[style],
          [a[0], yA, a[1]], [a[0], yB, a[1]], [c[0], yB, c[1]], [c[0], yA, c[1]],
          [nx, 0, nz], [u0, vOff], [u0, (yB - yA) / WIN + vOff], [u1, (yB - yA) / WIN + vOff], [u1, vOff], tint);
        if (shopTint && len > 5.5) {
          const s0 = per / (WIN * 8), s1 = (per + len) / (WIN * 8);  // one storefront per window cell
          pushQuad(shops,
            [a[0], .15, a[1]], [a[0], yA, a[1]], [c[0], yA, c[1]], [c[0], .15, c[1]],
            [nx, 0, nz], [s0, 0], [s0, 1], [s1, 1], [s1, 0], shopTint);
        }
        per += len;
      }
    };
    // flat roof deck (concave-safe triangulation)
    const roofDeck = (p, y, col) => {
      const ccx = p.reduce((s, v) => s + v[0], 0) / p.length;
      const ccz = p.reduce((s, v) => s + v[1], 0) / p.length;
      const v2 = p.map(v => new THREE.Vector2(v[0], v[1]));
      let tris = null;
      try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch (e) { tris = null; }
      if (tris && tris.length) {
        for (const t of tris) {
          const [a, b2, c2] = [p[t[0]], p[t[1]], p[t[2]]];
          roofs.pos.push(a[0] - AX, y, a[1] - AZ, c2[0] - AX, y, c2[1] - AZ, b2[0] - AX, y, b2[1] - AZ);
          for (let k = 0; k < 3; k++) { roofs.norm.push(0, 1, 0); roofs.uv.push(0, 0); roofs.col.push(col.r, col.g, col.b); }
        }
      } else {
        for (let i = 0; i < p.length; i++) pushFlat(roofs, p[i], p[(i + 1) % p.length], [ccx, y, ccz], col);
      }
    };
    // parapet rim ring (tall roofs + tier ledges)
    const parapet = (p, yTop, col, lipCol) => {
      for (let i = 0; i < p.length; i++) {
        const a = p[i], c = p[(i + 1) % p.length];
        const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
        if (len < .05) continue;
        const nx = dz / len, nz = -dx / len;               // outward
        const ix = -nx * .15, iz = -nz * .15;              // inward lip half-width
        pushQuad(roofs,
          [a[0], yTop, a[1]], [a[0], yTop + .78, a[1]], [c[0], yTop + .78, c[1]], [c[0], yTop, c[1]],
          [nx, 0, nz], [0, 0], [0, 1], [1, 1], [1, 0], col);
        pushQuad(roofs,
          [a[0] + ix, yTop + .78, a[1] + iz], [c[0] + ix, yTop + .78, c[1] + iz],
          [c[0] - ix, yTop + .78, c[1] - iz], [a[0] - ix, yTop + .78, a[1] - iz],
          [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], lipCol);
      }
    };
    // pre-war cornice trim band + protruding lip (mid-rise)
    const cornice = (p, yTop, col) => {
      for (let i = 0; i < p.length; i++) {
        const a = p[i], c = p[(i + 1) % p.length];
        const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
        if (len < .05) continue;
        const nx = dz / len, nz = -dx / len;
        const ox = nx * .03, oz = nz * .03;               // proud of the wall (no z-fight)
        pushQuad(roofs,
          [a[0] + ox, yTop - .8, a[1] + oz], [a[0] + ox, yTop + .1, a[1] + oz],
          [c[0] + ox, yTop + .1, c[1] + oz], [c[0] + ox, yTop - .8, c[1] + oz],
          [nx, 0, nz], [0, 0], [0, 1], [1, 1], [1, 0], col);
        pushQuadN(roofs,
          [a[0] + ox, yTop + .1, a[1] + oz], [c[0] + ox, yTop + .1, c[1] + oz],
          [c[0] + nx * .3, yTop + .1, c[1] + nz * .3], [a[0] + nx * .3, yTop + .1, a[1] + nz * .3],
          col, [0, 1, 0]);
      }
    };
    // small axis-aligned box (bulkheads, dormer bodies, chimneys)
    const boxInto = (arr, x, z, y0, y1, hw, hd, col) => {
      pushQuadN(arr, [x + hw, y0, z - hd], [x + hw, y0, z + hd], [x + hw, y1, z + hd], [x + hw, y1, z - hd], col, [1, 0, 0]);
      pushQuadN(arr, [x - hw, y0, z + hd], [x - hw, y0, z - hd], [x - hw, y1, z - hd], [x - hw, y1, z + hd], col, [-1, 0, 0]);
      pushQuadN(arr, [x - hw, y0, z + hd], [x + hw, y0, z + hd], [x + hw, y1, z + hd], [x - hw, y1, z + hd], col, [0, 0, 1]);
      pushQuadN(arr, [x + hw, y0, z - hd], [x - hw, y0, z - hd], [x - hw, y1, z - hd], [x + hw, y1, z - hd], col, [0, 0, -1]);
      pushQuadN(arr, [x - hw, y1, z + hd], [x + hw, y1, z + hd], [x + hw, y1, z - hd], [x - hw, y1, z - hd], col, [0, 1, 0]);
    };
    // rooftop clutter (HVAC, water tanks, antennas)
    const clutter = (poly, areaFor, yTop) => {
      if (areaFor <= 500) return;
      const ccx = poly.reduce((s, v) => s + v[0], 0) / poly.length;
      const ccz = poly.reduce((s, v) => s + v[1], 0) / poly.length;
      const n = Math.min(5, Math.floor(areaFor / 650) + 1);
      let maxR = 1e9;
      poly.forEach(v => maxR = Math.min(maxR, Math.hypot(v[0] - ccx, v[1] - ccz)));
      const rr = Math.min(maxR * .55, 12);
      for (let i = 0; i < n; i++) {
        const a = i * 2.399 + rnd() * .8;
        hvac.push([ccx + Math.cos(a) * rr * rnd(), yTop, ccz + Math.sin(a) * rr * rnd(), 2.2 + rnd() * 2.4, 1.1 + rnd() * 1.3]);
      }
      if (yTop >= 26.15 && rnd() < .42 && maxR > 3) {
        const a = rnd() * 6.28, tr = maxR * .3;
        tanks.push([ccx + Math.cos(a) * tr, yTop, ccz + Math.sin(a) * tr]);
      }
      if (yTop >= 30.15 && rnd() < .3) antennas.push([ccx, yTop, ccz, 4 + rnd() * 3.5]);
    };
    // hip or gable roof over an OBB, with dormers + chimney; returns lawn info
    const hipRoof = (obb, wallTop, tint, shinC) => {
      let ux = obb.ux, uz = obb.uz, vx = obb.vx, vz = obb.vz, Lu = obb.Lu, Lv = obb.Lv;
      if (Lu < Lv) { const tx = ux; ux = vx; vx = tx; const tz = uz; uz = vz; vz = tz; const tl = Lu; Lu = Lv; Lv = tl; }
      const ovh = .4;
      const hU = Lu / 2 + ovh, hV = Lv / 2 + ovh;
      const P = (du, dv, y) => [obb.cx + ux * du + vx * dv, y, obb.cz + uz * du + vz * dv];
      let ridgeHalf = hU - hV;
      const gable = ridgeHalf < .35;
      if (gable) ridgeHalf = hU;
      const rise = Math.min(3.4, hV * .6);
      const E1 = P(hU, hV, wallTop), E2 = P(-hU, hV, wallTop), E3 = P(-hU, -hV, wallTop), E4 = P(hU, -hV, wallTop);
      const R1 = P(ridgeHalf, 0, wallTop + rise), R2 = P(-ridgeHalf, 0, wallTop + rise);
      pushQuadN(pitched, E1, R1, R2, E2, shinC, [vx, .4, vz]);       // +v slope
      pushQuadN(pitched, E3, R2, R1, E4, shinC, [-vx, .4, -vz]);     // -v slope
      const gableC = jit(tint, .93);
      if (gable) {
        pushTri(pitched, E1, E4, R1, gableC, [ux, .4, uz]);          // gable end walls
        pushTri(pitched, E2, E3, R2, gableC, [-ux, .4, -uz]);
      } else {
        pushTri(pitched, E1, E4, R1, shinC, [ux, .4, uz]);           // hip ends
        pushTri(pitched, E2, E3, R2, shinC, [-ux, .4, -uz]);
      }
      // dormers on the long slopes
      const sr = _mulberry(hashStr('d' + obb.cx + ',' + obb.cz));
      if (Lu >= 9.5 && sr() < .72) {
        const n = Lu >= 18 ? 3 : Lu >= 13 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const du = (i - (n - 1) / 2) * Math.min(4.2, Lu / (n + .6));
          const sgn = i % 2 === 0 ? 1 : -1;                          // alternate slopes
          const dv = hV * .48 * sgn;
          const base = wallTop + rise * (1 - Math.abs(dv) / hV) - .22;
          const [bx, , bz] = P(du, dv, 0);
          const [fx, , fz] = P(du, dv + sgn * .64, 0);               // downhill face center
          boxInto(trim, bx, bz, base, base + 1.85, .58, .62, jit(tint, 1));
          pushQuadN(trim,
            [fx - ux * .4, base + .38, fz - uz * .4], [fx + ux * .4, base + .38, fz + uz * .4],
            [fx + ux * .4, base + 1.4, fz + uz * .4], [fx - ux * .4, base + 1.4, fz - uz * .4],
            colOf(0x2c333d), [vx * sgn, .2, vz * sgn]);              // dormer window
          pushQuadN(trim,                                           // shingle cap
            [bx - ux * .66 - vx * .66, base + 1.95, bz - uz * .66 - vz * .66],
            [bx + ux * .66 - vx * .66, base + 1.95, bz + uz * .66 - vz * .66],
            [bx + ux * .66 + vx * .66, base + 1.95, bz + uz * .66 + vz * .66],
            [bx - ux * .66 + vx * .66, base + 1.95, bz - uz * .66 + vz * .66],
            shinC, [0, 1, 0]);
        }
      }
      // chimney near the ridge
      if (sr() < .5 && hU > 2.6) {
        const cu = (sr() < .5 ? 1 : -1) * hU * .55;
        const [chx, , chz] = P(cu, 0, 0);
        const base = wallTop + rise - .35;
        boxInto(trim, chx, chz, base, base + 1.9, .34, .34, jit(colOf(0x8a4a3c), .9 + sr() * .2));
        pushQuadN(trim, [chx - .38, base + 1.9, chz - .38], [chx + .38, base + 1.9, chz - .38],
          [chx + .38, base + 2.05, chz - .38], [chx - .38, base + 2.05, chz - .38], colOf(0x3a3a3c), [0, 1, 0]);
      }
      // lawn candidate rect (expanded pad, world corners + check points)
      const pad = 1.7;
      const corners = [P(hU + pad, hV + pad, 0), P(-hU - pad, hV + pad, 0), P(-hU - pad, -hV - pad, 0), P(hU + pad, -hV - pad, 0)];
      const mids = [P(0, hV + pad, 0), P(-hU - pad, 0, 0), P(0, -hV - pad, 0), P(hU + pad, 0, 0)];
      return {
        corners, checkPts: corners.concat(mids), cx: obb.cx, cz: obb.cz,
        area: (Lu + 2 * pad) * (Lv + 2 * pad), Lu: Lu + 2 * pad, Lv: Lv + 2 * pad, ux, uz
      };
    };

    // ---- main building loop ----------------------------------------
    for (const b of city.buildings) {
      let p = b.poly;
      if (p.length < 4 || Math.abs(_polyArea(p)) < 30) continue;
      if (p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
      if (p.length < 3) continue;
      if (_polyArea(p) < 0) p = [...p].reverse();      // normalize CCW (positive shoelace)
      const area = Math.abs(_polyArea(p));
      const cx = p.reduce((s, v) => s + v[0], 0) / p.length;
      const cz = p.reduce((s, v) => s + v[1], 0) / p.length;
      const h = b.h;
      // ---- per-building style roll (deterministic by bkey) ----
      const srnd = _mulberry(hashStr('s' + b.bkey));
      const warmP = Math.min(.94, Math.max(.34, 1.15 - h / 44));
      const PAL = srnd() < warmP ? PAL_WARM : PAL_COOL;
      // walls push past white (vertex colors >1 are legal) so the pastel
      // palette reads BRIGHT against the reference, not muted mid-tone
      const tint = jit(colOf(PAL[Math.floor(srnd() * PAL.length)]), 1.28 + srnd() * .14);
      const shopTint = h >= 8.5 ? tint.clone().lerp(colOf(0xffffff), .5) : null;
      const y0 = shopTint ? 3.55 : .15;
      const sr = srnd();
      let style;                                        // facade system by scale
      if (h >= 26) style = sr < .58 ? 1 : 3;            // towers: curtain or pre-war bays
      else if (h >= 12) style = sr < .38 ? 0 : sr < .68 ? 3 : 2;
      else style = sr < .55 ? 0 : 2;                    // low-rise: classic or punched
      const uOff = Math.floor(srnd() * 16);             // shift lit-window pattern
      const vOff = Math.floor(srnd() * 4);
      const deckC = jit(colOf(ROOF_DECKS[Math.floor(srnd() * ROOF_DECKS.length)]), .84 + srnd() * .18);
      const rimC = jit(colOf(TRIMS[Math.floor(srnd() * TRIMS.length)]), .9 + srnd() * .2);
      const trimC = jit(rimC, 1.1);
      const shinC = jit(colOf(SHINGLES[Math.floor(srnd() * SHINGLES.length)]), .9 + srnd() * .2);
      // ---- silhouette roll ----
      let obb = null;
      if (h <= 16.5 && area >= 60 && p.length <= 8) obb = obbOf(p);
      const isPitched = !!(obb && obb.area && area / obb.area >= .78 && Math.min(obb.Lu, obb.Lv) >= 3.6);
      const tiered = h >= 40 && area >= 900 && srnd() < .55;
      if (tintsUsed.length < 60) tintsUsed.push(hexOf(tint) + (isPitched ? ' p' : tiered ? ' t' : ''));
      if (roofsUsed.length < 60) roofsUsed.push(hexOf(isPitched ? shinC : deckC));
      // ---- build ----
      if (tiered) {                                     // wedding-cake setback tower
        nTier++;
        const h1 = h * .62;
        wallBand(p, y0, .15 + h1, tint, style, uOff, vOff, shopTint);
        const p2 = p.map(v => [cx + (v[0] - cx) * .68, cz + (v[1] - cz) * .68]);
        if (_polyArea(p2) < 0) p2.reverse();
        wallBand(p2, .15 + h1, .15 + h, tint, style, uOff, vOff + 2, null);
        roofDeck(p, .15 + h1, deckC);
        parapet(p, .15 + h1, rimC, jit(deckC, 1.1));
        roofDeck(p2, .15 + h, deckC);
        parapet(p2, .15 + h, rimC, jit(deckC, 1.1));
        clutter(p2, area * .46, .15 + h);
      } else {
        wallBand(p, y0, .15 + h, tint, style, uOff, vOff, shopTint);
        if (isPitched) {                                // pitched roof + dormers + chimney
          const L = hipRoof(obb, .15 + h, tint, shinC);
          L.col = jit(colOf(0x5cb85a), .9 + srnd() * .18);
          pitchedRects.push(L);
        } else {                                        // flat roof finish
          roofDeck(p, .15 + h, deckC);
          if (h >= 40) parapet(p, .15 + h, rimC, jit(deckC, 1.1));
          else if (h > 7) cornice(p, .15 + h, trimC);
          if (h < 26 && area >= 140 && srnd() < .75) {  // roof-access bulkhead
            const a = srnd() * 6.28, rr = Math.sqrt(area / Math.PI) * .38;
            boxInto(trim, cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, .15 + h, .15 + h + 2.6, 1.15, 1.0, jit(tint, .74));
          }
          clutter(p, area, .15 + h);
        }
      }
      const rec = { poly: p, h, bkey: b.bkey, area, x: cx, z: cz };
      if (!tallest || h > tallest.h) tallest = { poly: p, h, x: cx, z: cz, area };   // v2.64
      buildingPolys.push(rec);
      if (h >= 18 && area >= 380 && si < 260) {
        const sqm = Math.round(area * .72);
        suites.push({
          bkey: b.bkey, name: 'Office suite #' + (1 + (hashStr('' + b.bkey) % 97)),
          sqm, rate: Math.round(60 + sqm / 6 + hashStr('r' + b.bkey) % 40),
          x: cx, z: cz, floors: Math.max(1, Math.round(h / 3.2)),
        });
        si++;
      }
    }

    // ---- v2.64 CITY BEAUTIFUL — the crown: the single tallest -----
    // building gets a setback crown + slim tapering spire with a red
    // aviation tip, so every skyline carries one punctuation mark (the
    // Willis read). Crowns only on towers 55 m+. Emitted into the trim
    // array BEFORE mesh assembly so the geometry actually ships.
    if (tallest && tallest.h >= 55) {
      const yT = .15 + tallest.h;
      const rr = Math.max(2.6, Math.sqrt(tallest.area / Math.PI) * .34);
      boxInto(trim, tallest.x, tallest.z, yT, yT + 5.2, rr * .78, rr * .78, jit(colOf(0x9fb4c4), 1.04));
      boxInto(trim, tallest.x, tallest.z, yT + 5.2, yT + 8.6, rr * .5, rr * .5, jit(colOf(0x8496a8), 1.02));
      boxInto(trim, tallest.x, tallest.z, yT + 8.6, yT + 16.5, .48, .48, jit(colOf(0x4a4f55), 1));
      boxInto(trim, tallest.x, tallest.z, yT + 16.5, yT + 21.5, .26, .26, jit(colOf(0x3d4247), 1));
      boxInto(trim, tallest.x, tallest.z, yT + 21.5, yT + 22.3, .5, .5, colOf(0xc0392b));   // beacon
    }

    // ---- assemble meshes -------------------------------------------
    const mk = (arr, tex) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial(tex ? { map: tex, vertexColors: true } : { vertexColors: true }));
      m.position.set(AX, 0, AZ);   // v2.27: city-local geometry
      return m;
    };
    wallArrs.forEach((arr, i) => {                       // one mesh per facade system
      if (!arr.pos.length) return;
      const m = mk(arr, getWinTex(i));
      m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    });
    if (shops.pos.length) {
      const shopMesh = mk(shops, getShopTex());
      shopMesh.castShadow = true; shopMesh.receiveShadow = true;
      group.add(shopMesh);
    }
    if (roofs.pos.length) { const roofMesh = mk(roofs, null); roofMesh.castShadow = true; group.add(roofMesh); }
    if (pitched.pos.length) {
      const pm = mk(pitched, null); pm.castShadow = true; pm.receiveShadow = true; group.add(pm);
    }
    if (trim.pos.length) {
      const tm = mk(trim, null); tm.castShadow = true; group.add(tm);
    }
    if (hvac.length) {
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial({ color: 0xffffff }), hvac.length);
      const mat4 = new THREE.Matrix4(), hc = new THREE.Color();
      const HCOLS = [0xd8d4cc, 0xc4beb4, 0xb8b2a6, 0xcfc9bf, 0xb0aaa0];
      hvac.forEach((v, i) => {
        mat4.makeScale(v[3], v[4], v[3] * .8);
        mat4.setPosition(v[0] - AX, v[1] + v[4] / 2, v[2] - AZ);
        inst.setMatrixAt(i, mat4);
        inst.setColorAt(i, hc.set(HCOLS[i % HCOLS.length]));
      });
      inst.castShadow = true;
      inst.position.set(AX, 0, AZ);   // v2.27: city-local instances
      group.add(inst);
    }
    // rooftop water tanks (NYC style)
    if (tanks.length) {
      const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.0, 1.18, 2.6, 10),
        new THREE.MeshLambertMaterial({ color: 0x8a6f52 }), tanks.length);
      const cap = new THREE.InstancedMesh(new THREE.CylinderGeometry(.42, .52, .42, 8),
        new THREE.MeshLambertMaterial({ color: 0x5a6169 }), tanks.length);
      const mat4 = new THREE.Matrix4();
      tanks.forEach((v, i) => {
        mat4.identity(); mat4.setPosition(v[0] - AX, v[1] + 1.3, v[2] - AZ); inst.setMatrixAt(i, mat4);
        mat4.setPosition(v[0] - AX, v[1] + 2.75, v[2] - AZ); cap.setMatrixAt(i, mat4);
      });
      inst.castShadow = true;
      inst.position.set(AX, 0, AZ); cap.position.set(AX, 0, AZ);   // v2.27
      group.add(inst, cap);
    }
    // antenna masts
    if (antennas.length) {
      const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(.05, .09, 1, 6),
        new THREE.MeshLambertMaterial({ color: 0x4a4f55 }), antennas.length);
      // v2.64: aviation-red tips — every mast carries a little beacon
      const tip = new THREE.InstancedMesh(new THREE.BoxGeometry(.22, .22, .22),
        new THREE.MeshLambertMaterial({ color: 0xc0392b, emissive: 0x5a1008 }), antennas.length);
      const mat4 = new THREE.Matrix4();
      antennas.forEach((v, i) => {
        mat4.makeScale(1, v[3], 1);
        mat4.setPosition(v[0] - AX, v[1] + v[3] / 2, v[2] - AZ);
        inst.setMatrixAt(i, mat4);
        mat4.identity(); mat4.setPosition(v[0] - AX, v[1] + v[3] + .11, v[2] - AZ);
        tip.setMatrixAt(i, mat4);
      });
      inst.position.set(AX, 0, AZ); tip.position.set(AX, 0, AZ);   // v2.27: city-local instances
      group.add(inst, tip);
    }
    buildStats = {
      pitched: pitchedRects.length, tiered: nTier, suites: suites.length,
      wallStyleVerts: wallArrs.map(a => a.pos.length / 3 | 0),
      pitchedVerts: pitched.pos.length / 3 | 0,
      trimVerts: trim.pos.length / 3 | 0,
      roofsVerts: roofs.pos.length / 3 | 0,
      shopVerts: shops.pos.length / 3 | 0,
      hvac: hvac.length, tanks: tanks.length, antennas: antennas.length,
      tints: tintsUsed, roofs: roofsUsed,
    };
    buildSpatialHash();
  }

  // ---------- greens, water, park paths, trees, bollards ------------
  function buildGreensWater(city) {
    const flat = (polys, hex, y) => {
      if (!polys || !polys.length) return;
      const arr = { pos: [], norm: [], uv: [], col: [] };
      const c = colOf(hex);
      for (const gp of polys) {
        let p = gp.poly;
        if (!p) continue;
        if (p[0] && p.length > 3 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
        if (_polyArea(p) < 0) p = [...p].reverse();
        const cx = p.reduce((s, v) => s + v[0], 0) / p.length, cz = p.reduce((s, v) => s + v[1], 0) / p.length;
        // v2.14 fix: rim verts were 2D [x,z] — the third slot pushed
        // undefined → NaN → every greens/waters triangle was silently
        // dropped by the GPU (parks kept only their paths + trees).
        for (let i = 0; i < p.length; i++)
          pushFlat(arr, [p[i][0], 0, p[i][1]], [p[(i + 1) % p.length][0], 0, p[(i + 1) % p.length][1]], [cx, 0, cz], c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.position.set(AX, y, AZ);      // v2.27: city-local geometry
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    flat(city.greens, 0x5fbf6f, .065);
    flat(city.waters, 0x3479bd, .042);   // v2.44 PATCHWORK: above the farm quilt (.028) so pasture ponds keep their water

    // walking-path rings through the parks + benches facing the center
    const paths = { pos: [], norm: [], uv: [], col: [] };
    const pathC = colOf(0xb3a68a);
    const UP = [0, 1, 0];
    for (const gp of city.greens || []) {
      const poly = gp.poly;
      if (!poly) continue;
      const area = Math.abs(_polyArea(poly));
      if (area < 900) continue;
      const cx = poly.reduce((s, v) => s + v[0], 0) / poly.length, cz = poly.reduce((s, v) => s + v[1], 0) / poly.length;
      const rad = Math.sqrt(area / Math.PI) * .48;
      const SEG = 26;
      for (let k = 0; k < SEG; k++) {
        const a0 = k / SEG * 6.2832, a1 = (k + 1) / SEG * 6.2832;
        const x0 = cx + Math.cos(a0) * rad, z0 = cz + Math.sin(a0) * rad;
        const x1 = cx + Math.cos(a1) * rad, z1 = cz + Math.sin(a1) * rad;
        const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
        const px = -dz / len * 1.05, pz = dx / len * 1.05;
        pushQuad(paths,
          [x0 + px, .142, z0 + pz], [x1 + px, .142, z1 + pz], [x1 - px, .142, z1 - pz], [x0 - px, .142, z0 - pz],
          UP, [0, 0], [1, 0], [1, 1], [0, 1], pathC);
        if (k % 3 === 0) {
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          benchScratch.push([mx, mz, Math.atan2(cx - mx, cz - mz)]);
        }
      }
    }
    if (paths.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(paths.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(paths.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(paths.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(paths.col, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.position.set(AX, 0, AZ);   // v2.27: city-local geometry
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    const trees = [];
    for (const gp of city.greens || []) {
      const poly = gp.poly;
      if (!poly) continue;
      const area = Math.abs(_polyArea(poly));
      const n = Math.min(34, Math.floor(area / 340));
      const cx = poly.reduce((s, v) => s + v[0], 0) / poly.length, cz = poly.reduce((s, v) => s + v[1], 0) / poly.length;
      for (let i = 0; i < n; i++) {
        const r = Math.sqrt(area / Math.PI) * .68 * Math.sqrt((i + 1) / (n + 1));
        const a = i * 2.399;
        trees.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
      }
    }
    const rnd = _mulberry(hashStr('t' + (city.key || city.name)));
    for (const rd of city.roads) {
      // v2.64 CITY BEAUTIFUL: avenues (cls 2 — the secondary streets
      // and the suburb rings) get street trees too, not just residential
      // lanes: tree-lined boulevards are the single biggest downtown
      // upgrade. Rings/avenues plant slightly denser and sit just off
      // the outer walk edge (+4.3) so they never fight the bollard row.
      const av = rd.cls === 2;
      if ((rd.cls !== 1 && !av) || rd.ped) continue;
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 14) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        for (let d = 12; d < len; d += av ? 19 : 26) {
          if (rnd() < (av ? .3 : .45)) continue;
          const side = rnd() < .5 ? 1 : -1;
          const off = rd.w / 2 + (av ? 4.3 : 3.4);
          const tx = ax + ux * d - uz * off * side, tz = az + uz * d + ux * off * side;
          if (plotAt(tx, tz)) continue;                 // keep trees off purchasable land
          if (pointInBuilding(tx, tz)) continue;        // v2.42: never inside a house either
          trees.push([tx, tz]);
        }
      }
    }
    // (trees list still accumulating — lawns below may add more before instancing)

    // bright residential lawns around pitched-roof houses (reference look:
    // saturated green strips hugging the buildings) + a tree or two
    if (pitchedRects.length) {
      const lawns = { pos: [], norm: [], uv: [], col: [] };
      const UP = [0, 1, 0];
      const lrnd = _mulberry(hashStr('L' + (city.key || city.name)));
      let nLawn = 0;
      for (const L of pitchedRects) {
        if (nLawn >= 80) break;
        let ok = true;
        for (const q of L.checkPts) {
          // v2.27: checkPts are 3D [x, y, z] — these gates used to read
          // the Y slot (always 0), so every lawn "passed" against the
          // equator and the quads themselves rendered there
          const dq = distToRoad(q[0], q[2]);
          if (dq.d < 5.6 || (dq.rd && dq.d < dq.rd.w / 2 + 3.7)) { ok = false; break; }   // stay off road+sidewalk (any road width)
          if (plotAt(q[0], q[2])) { ok = false; break; }               // stay off purchasable plots
          if (pointInBuilding(q[0], q[2])) { ok = false; break; }      // stay off neighbors
        }
        if (!ok) continue;
        // v2.27: corners are 3D [x, y, z] — Z lives in slot 2 (the old
        // code read slot 1 = Y = 0, so lawns rendered at the equator)
        const c = [L.corners[0][0], .07, L.corners[0][2]], c1 = [L.corners[1][0], .07, L.corners[1][2]],
              c2 = [L.corners[2][0], .07, L.corners[2][2]], c3 = [L.corners[3][0], .07, L.corners[3][2]];
        pushQuad(lawns, c, c1, c2, c3, UP, [0, 0], [1, 0], [1, 1], [0, 1],
          jit(colOf(0x6cc066), .92 + lrnd() * .16));
        nLawn++;
        if (L.area >= 130 && lrnd() < .8) {                           // lawn trees
          const s1 = lrnd() < .5 ? 1 : -1, s2 = lrnd() < .5 ? 1 : -1;
          trees.push([L.cx + L.ux * L.Lu * .3 * s1, L.cz + L.uz * L.Lu * .3 * s1]);
          if (L.area >= 240 && lrnd() < .6)
            trees.push([L.cx - L.ux * L.Lu * .3 * s2, L.cz - L.uz * L.Lu * .3 * s2]);
        }
      }
      if (lawns.pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(lawns.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(lawns.norm, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(lawns.uv, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(lawns.col, 3));
        const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
        mesh.position.set(AX, 0, AZ);   // v2.27: city-local geometry
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    // v2.07 — trees must clear the ASPHALT of every road, not just the
    // street they were planted along: at intersections a tree set beside
    // a narrow side street used to land in the middle of the wide road it
    // crosses (park + lawn trees get the same guarantee here).
    const keptTrees = [];
    let droppedTrees = 0;
    for (const t of trees) {
      if (offAsphalt(t[0], t[1], 1.4)) keptTrees.push(t); else droppedTrees++;
    }
    treeList = keptTrees;
    treeStats = { kept: keptTrees.length, dropped: droppedTrees };
    addTrees(keptTrees);      // single instancing pass — parks + streets + lawns

    const bolls = [];
    for (const rd of city.roads) {
      if (rd.cls < 2 || rd.ped || rd.country || rd.sub) continue;   // v2.14: no bollards in the country; v2.64: none on suburb shoulders either
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 10) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        for (let d = 8; d < len; d += rd.cls === 2 ? 26 : 13) {   // v2.64: sparser on avenues (trees took the curb line)
          const off = rd.w / 2 + 3.7;
          const qx = ax + ux * d - uz * off, qz = az + uz * d + ux * off;
          if (!offAsphalt(qx, qz, 1.4)) continue;   // v2.07: never in a crossing road
          bolls.push([qx, qz]);
        }
      }
    }
    if (bolls.length) {
      const n = Math.min(bolls.length, 900);
      const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(.16, .19, .95, 6),
        new THREE.MeshLambertMaterial({ color: 0xd8d8d6 }), n);
      const mat4 = new THREE.Matrix4();
      for (let i = 0; i < n; i++) { mat4.identity(); mat4.setPosition(bolls[i][0] - AX, .55, bolls[i][1] - AZ); inst.setMatrixAt(i, mat4); }
      inst.position.set(AX, 0, AZ);   // v2.27: city-local instances
      group.add(inst);
    }
  }

  function addTrees(list, host) {   // v2.42: optional host group (suburb LOD)
    if (!list.length) return;
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(.22, .3, 2.3, 6),
      new THREE.MeshLambertMaterial({ color: 0x6b4f3a }), list.length);
    const can = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.0, 1),
      new THREE.MeshLambertMaterial({ color: 0x4db062 }), list.length);
    const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    list.forEach((v, i) => {
      const sc = .8 + (i % 5) * .12;
      mat4.compose(new THREE.Vector3(v[0] - AX, 1.15, v[1] - AZ), q.identity(), s.set(1, 1, 1));
      trunk.setMatrixAt(i, mat4);
      mat4.compose(new THREE.Vector3(v[0] - AX, 2.3 + 1.6 * sc, v[1] - AZ), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.4) % 6.28), s.set(sc, sc * 1.15, sc));
      can.setMatrixAt(i, mat4);
    });
    can.castShadow = true;
    trunk.position.set(AX, 0, AZ); can.position.set(AX, 0, AZ);   // v2.27
    (host || group).add(trunk, can);
  }

  // ---------- street furniture + parked cars ------------------------
  function buildProps(city) {
    const rnd = _mulberry(hashStr('P' + (city.key || city.name)));
    const mobF = isMob ? .5 : 1;
    const Y = new THREE.Vector3(0, 1, 0);

    // -- street lamps (pole + arm + head, arm reaching over the road) --
    const lamps = [];
    for (const rd of roads) {
      if (rd.ped || rd.country) continue;   // v2.14: lamps are street furniture
      const step = rd.cls >= 2 ? 26 : 38;      // sparser on residential lanes
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 18) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        let side = 1;
        for (let d = 9; d < len - 4; d += step) {
          const off = rd.w / 2 + 2.6;
          const x = ax + ux * d - uz * off * side, z = az + uz * d + ux * off * side;
          const s0 = side; side = -side;
          if (pointInBuilding(x, z)) continue;
          if (plotAt(x, z)) continue;         // v2.09: keep lamps off vendor spots
          if (!offAsphalt(x, z, 1.4)) continue;      // v2.07: poles never in a crossing road
          const tx = uz * s0, tz = -ux * s0;            // toward the road
          lamps.push([x, z, Math.atan2(-tz, tx)]);
        }
      }
    }
    if (lamps.length) {
      const n = Math.min(lamps.length, Math.floor(460 * mobF));
      const poleM = new THREE.MeshLambertMaterial({ color: 0x363b41 });
      const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(.06, .09, 5.6, 7), poleM, n);
      const arm = new THREE.InstancedMesh(new THREE.BoxGeometry(.95, .08, .08), poleM, n);
      const head = new THREE.InstancedMesh(new THREE.BoxGeometry(.6, .15, .22),
        new THREE.MeshLambertMaterial({ color: 0xf2f4e6, emissive: 0x55523c }), n);
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      for (let i = 0; i < n; i++) {
        const [x, z, th] = lamps[i];
        const cs = Math.cos(th), sn = Math.sin(th);
        q.setFromAxisAngle(Y, th);
        mat4.compose(new THREE.Vector3(x - AX, 2.96, z - AZ), q, new THREE.Vector3(1, 1, 1)); pole.setMatrixAt(i, mat4);
        mat4.compose(new THREE.Vector3(x + .45 * cs - AX, 5.51, z - .45 * sn - AZ), q, new THREE.Vector3(1, 1, 1)); arm.setMatrixAt(i, mat4);
        mat4.compose(new THREE.Vector3(x + .86 * cs - AX, 5.44, z - .86 * sn - AZ), q, new THREE.Vector3(1, 1, 1)); head.setMatrixAt(i, mat4);
      }
      pole.position.set(AX, 0, AZ); arm.position.set(AX, 0, AZ); head.position.set(AX, 0, AZ);   // v2.27
      group.add(pole, arm, head);
    }

    // -- fire hydrants --
    const hyds = [];
    for (const rd of roads) {
      if (rd.ped || rd.country) continue;   // v2.14: hydrants are urban plumbing
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 30) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        for (let d = 14; d < len - 6; d += 70) {
          if (rnd() < .6) continue;
          const side = rnd() < .5 ? 1 : -1;
          const off = rd.w / 2 + 3.0;
          const x = ax + ux * d - uz * off * side, z = az + uz * d + ux * off * side;
          if (pointInBuilding(x, z)) continue;
          if (plotAt(x, z)) continue;       // v2.09: keep hydrants off vendor spots
          if (LANDGEO.ready && LANDGEO.isWaterWorld(x, z)) continue;   // v2.20: dry ground only
          hyds.push([x, z]);
        }
      }
    }
    if (hyds.length) {
      const n = Math.min(hyds.length, Math.floor(90 * mobF));
      const body = new THREE.InstancedMesh(new THREE.CylinderGeometry(.14, .17, .72, 8),
        new THREE.MeshLambertMaterial({ color: 0xb03a2e }), n);
      const cap = new THREE.InstancedMesh(new THREE.CylinderGeometry(.09, .09, .16, 8),
        new THREE.MeshLambertMaterial({ color: 0x8f2b22 }), n);
      const mat4 = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        mat4.identity(); mat4.setPosition(hyds[i][0] - AX, .52, hyds[i][1] - AZ); body.setMatrixAt(i, mat4);
        mat4.setPosition(hyds[i][0] - AX, .96, hyds[i][1] - AZ); cap.setMatrixAt(i, mat4);
      }
      body.position.set(AX, 0, AZ); cap.position.set(AX, 0, AZ);   // v2.27
      group.add(body, cap);
    }

    // -- trash bins beside every other lamp --
    if (lamps.length) {
      const bins = [];
      for (let i = 0; i < lamps.length; i += 2) {
        const [x, z, th] = lamps[i];
        bins.push([x + Math.cos(th) * .9, z - Math.sin(th) * .9]);   // toward the road a touch
      }
      const n = Math.min(bins.length, Math.floor(160 * mobF));
      const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(.26, .3, .85, 8),
        new THREE.MeshLambertMaterial({ color: 0x3d444a }), n);
      const mat4 = new THREE.Matrix4();
      for (let i = 0; i < n; i++) { mat4.identity(); mat4.setPosition(bins[i][0] - AX, .58, bins[i][1] - AZ); inst.setMatrixAt(i, mat4); }
      inst.position.set(AX, 0, AZ);   // v2.27: city-local instances
      group.add(inst);
    }

    // -- sidewalk benches (parks already contributed theirs) --
    for (const rd of roads) {
      if (rd.ped || rd.country) continue;   // v2.14: benches wait for sidewalks
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 40) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        for (let d = 18; d < len - 8; d += 44) {
          if (rnd() < .7) continue;
          const side = rnd() < .5 ? 1 : -1;
          const off = rd.w / 2 + 2.7;
          const x = ax + ux * d - uz * off * side, z = az + uz * d + ux * off * side;
          if (pointInBuilding(x, z)) continue;
          if (plotAt(x, z)) continue;       // v2.09: keep benches off vendor spots
          if (!offAsphalt(x, z, 1.4)) continue;      // v2.07: not in a crossing road
          benchScratch.push([x, z, Math.atan2(uz * side, -ux * side)]);   // face the road
        }
      }
    }
    if (benchScratch.length) {
      const n = benchScratch.length;
      const seat = new THREE.InstancedMesh(new THREE.BoxGeometry(1.7, .09, .48),
        new THREE.MeshLambertMaterial({ color: 0x86664c }), n);
      const back = new THREE.InstancedMesh(new THREE.BoxGeometry(1.7, .55, .07),
        new THREE.MeshLambertMaterial({ color: 0x7a5c44 }), n);
      const leg = new THREE.InstancedMesh(new THREE.BoxGeometry(.08, .48, .4),
        new THREE.MeshLambertMaterial({ color: 0x2e3236 }), n * 2);
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      benchScratch.forEach((v, i) => {
        const [x, z, th] = v;
        const fx = Math.sin(th), fz = Math.cos(th);          // bench front
        q.setFromAxisAngle(Y, th);
        mat4.compose(new THREE.Vector3(x - AX, .48, z - AZ), q, new THREE.Vector3(1, 1, 1)); seat.setMatrixAt(i, mat4);
        e.set(-.21, th, 0, 'YXZ');
        mat4.compose(new THREE.Vector3(x - fx * .24 - AX, .84, z - fz * .24 - AZ),
          new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(1, 1, 1)); back.setMatrixAt(i, mat4);
        const sx = Math.cos(th), sz = -Math.sin(th);         // local +X in world
        mat4.compose(new THREE.Vector3(x + sx * .72 - AX, .24, z + sz * .72 - AZ), q, new THREE.Vector3(1, 1, 1)); leg.setMatrixAt(i * 2, mat4);
        mat4.compose(new THREE.Vector3(x - sx * .72 - AX, .24, z - sz * .72 - AZ), q, new THREE.Vector3(1, 1, 1)); leg.setMatrixAt(i * 2 + 1, mat4);
      });
      seat.castShadow = true;
      seat.position.set(AX, 0, AZ); back.position.set(AX, 0, AZ); leg.position.set(AX, 0, AZ);   // v2.27
      group.add(seat, back, leg);
    }

    // -- parked cars along the curbs (yellow taxis in tier-3 cities) --
    const spots = [];
    const tier3 = (cityRec.tier || 2) === 3;
    for (const rd of roads) {
      if (rd.ped) continue;
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 16) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        let d = 6 + rnd() * 5;
        while (d < len - 8) {
          if (rnd() < (rd.country ? .93 : .6)) {   // v2.14: a farm truck now and then
            const side = rnd() < .5 ? 1 : -1;
            const off = rd.w / 2 + 1.25;
            const x = ax + ux * d - uz * off * side, z = az + uz * d + ux * off * side;
            if (Math.hypot(x - (cityAnchor ? cityAnchor.x : 0), z - (cityAnchor ? cityAnchor.z : 0)) < 640 && !pointInBuilding(x, z) && !plotAt(x, z) && offAsphalt(x, z, .9)) {
              let inGreen = false;
              for (const g of [...(city.greens || []), ...(city.waters || [])])
                if (g.poly && inPoly(x, z, g.poly)) { inGreen = true; break; }
              if (!inGreen) spots.push([x, z, Math.atan2(-uz, ux) + (rnd() - .5) * .06, tier3 && rnd() < .1]);
            }
          }
          d += 8 + rnd() * 7;
        }
      }
    }
    if (spots.length) {
      const n = Math.min(spots.length, Math.floor(240 * mobF));
      const bodyGeo = new THREE.BoxGeometry(4.05, 1.0, 1.76); bodyGeo.translate(0, .58, 0);
      const cabGeo = new THREE.BoxGeometry(2.35, .66, 1.5); cabGeo.translate(-.26, 1.36, 0);
      const whGeo = new THREE.CylinderGeometry(.3, .3, .2, 10); whGeo.rotateZ(Math.PI / 2);
      const body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
      const cab = new THREE.InstancedMesh(cabGeo, new THREE.MeshLambertMaterial({ color: 0x15181d }), n);
      const wheels = new THREE.InstancedMesh(whGeo, new THREE.MeshLambertMaterial({ color: 0x1d2024 }), n * 4);
      const PALETTE = [0xe8e8e6, 0xb9bdc1, 0x2e3134, 0x6f7479, 0x9e3b33, 0x39527a, 0x4a5560];
      const mat4 = new THREE.Matrix4(), rot = new THREE.Matrix4(), loc = new THREE.Matrix4();
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const [x, z, th, taxi] = spots[i];
        rot.makeRotationY(th);
        mat4.copy(rot); mat4.setPosition(x - AX, 0, z - AZ);
        body.setMatrixAt(i, mat4);
        cab.setMatrixAt(i, mat4);
        body.setColorAt(i, c.set(taxi ? 0xd9b53a : PALETTE[Math.floor(rnd() * PALETTE.length)]));
        for (let w = 0; w < 4; w++) {
          loc.makeTranslation(w < 2 ? 1.32 : -1.32, .3, w % 2 ? .79 : -.79);
          wheels.setMatrixAt(i * 4 + w, new THREE.Matrix4().multiplyMatrices(mat4, loc));
        }
      }
      body.castShadow = true;
      body.position.set(AX, 0, AZ); cab.position.set(AX, 0, AZ); wheels.position.set(AX, 0, AZ);   // v2.27
      group.add(body, cab, wheels);
    }
  }

  // ---------- spatial hashes ----------------------------------------
  const CELL = 26;
  function buildSpatialHash() {
    bHash = new Map(); rHash = new Map();
    buildingPolys.forEach((b, i) => {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      b.poly.forEach(v => { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); z0 = Math.min(z0, v[1]); z1 = Math.max(z1, v[1]); });
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
        for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
          const k = gx + ',' + gz;
          if (!bHash.has(k)) bHash.set(k, []);
          bHash.get(k).push(i);
        }
    });
    roads.forEach((rd, ri) => {
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        for (let gx = Math.floor(Math.min(ax, bx) / CELL); gx <= Math.floor(Math.max(ax, bx) / CELL); gx++)
          for (let gz = Math.floor(Math.min(az, bz) / CELL); gz <= Math.floor(Math.max(az, bz) / CELL); gz++) {
            const k = gx + ',' + gz;
            if (!rHash.has(k)) rHash.set(k, []);
            rHash.get(k).push(ri);
          }
      }
    });
  }

  function pointInBuilding(x, z) {
    if (!bHash) return null;
    const arr = bHash.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (!arr) return null;
    for (const i of arr) if (inPoly(x, z, buildingPolys[i].poly)) return buildingPolys[i];
    return null;
  }
  function inPoly(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  }
  function roadsNear(x, z, r) {
    if (!rHash) return [];
    const out = new Set();
    const cr = Math.ceil(r / CELL);
    for (let gx = -cr; gx <= cr; gx++) for (let gz = -cr; gz <= cr; gz++) {
      const arr = rHash.get((Math.floor(x / CELL) + gx) + ',' + (Math.floor(z / CELL) + gz));
      if (!arr) continue;
      for (const ri of arr) {
        const rd = roads[ri];
        for (let i = 0; i < rd.pts.length - 1; i++) {
          const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
          if (segDist(x, z, ax, az, bx, bz) < r) { out.add(ri); break; }
        }
      }
    }
    return [...out];
  }
  function distToRoad(x, z) {
    if (!rHash) return { d: 1e9, rd: null };
    let best = 1e9, bestRd = null;
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      const arr = rHash.get((Math.floor(x / CELL) + gx) + ',' + (Math.floor(z / CELL) + gz));
      if (!arr) continue;
      for (const ri of new Set(arr)) {
        const rd = roads[ri];
        for (let i = 0; i < rd.pts.length - 1; i++) {
          const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
          const d = segDist(x, z, ax, az, bx, bz);
          if (d < best) { best = d; bestRd = rd; }
        }
      }
    }
    return { d: best, rd: bestRd };
  }
  function segDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1;
    let t = ((px - ax) * dx + (pz - az) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
  }
  // v2.07 — true when (x,z) clears the asphalt of EVERY road by m meters
  // (nearest-road test): catches props planted along one street that
  // would otherwise land inside a crossing street at intersections.
  function offAsphalt(x, z, m) {
    const h = distToRoad(x, z);
    if (h.rd && h.d <= h.rd.w / 2 + m) return false;
    // v2.20 DRY LAND: nothing street-side stands in the water either
    if (LANDGEO.ready && LANDGEO.isWaterWorld(x, z)) return false;
    return true;
  }

  // ---------- purchasable plots (v2.09: SIDEWALK SPOTS) ----------------
  // Plots used to be big 17x22 lawn lots set back from the street, capped
  // at 24 per city. Now they are compact food-cart spots marked RIGHT ON
  // the raised sidewalk beside every road — where a street cart belongs —
  // and the cap lifts to 150 per city (70 on phones). The whole plot layer
  // is 3 draw calls: one instanced pad mesh (per-instance green, tints
  // when owned), one merged dashed-border LineSegments (vertex colors flip
  // to gold), one Points cloud of $ markers (camera-facing billboards,
  // sunk below ground once owned).
  function dollarTex() {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.font = '900 46px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 7; ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('$', 32, 35);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  let plotViz = null;   // { pads, dashCol, dollarPos, cGreen, cOwned }

  function buildPlots(city) {
    plotRecs = [];
    plotViz = null;
    plotGroup = new THREE.Group();
    group.add(plotGroup);
    const rnd = _mulberry(hashStr('p' + (city.key || city.name)));
    const tierMult = { 1: 1, 2: 1.35, 3: 1.8 }[city.tier || 2];
    const axc = cityAnchor ? cityAnchor.x : 0, azc = cityAnchor ? cityAnchor.z : 0;
    const seen = [];
    const PW = 3.4, PD = 9.5;                 // across the walk / along the road
    const MAXN = isMob ? 70 : 150;            // v2.09: was 24 — way more spots
    let n = 0;
    outer:
    for (let rdx = 0; rdx < city.roads.length; rdx++) {
      const rd = city.roads[rdx];
      if (rd.ped) continue;
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 30) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        for (let d = 13; d < len - 13; d += 24) {
          for (const side of [1, -1]) {       // v2.09: both sides of the street
            if (n >= MAXN) break outer;
            if (rnd() < .2) continue;
            const off = rd.w / 2 + (rd.country ? 2.9 : 1.75);   // v2.14: roadside shoulder in the country
            const cx = ax + ux * d - uz * off * side;
            const cz = az + uz * d + ux * off * side;
            if (Math.hypot(cx - axc, cz - azc) > 640) continue;
            // every pad corner clears every road's asphalt (bends + crossings)
            let ok = true;
            const hw = PW / 2, hd = PD / 2;
            for (let ci = 0; ci < 4 && ok; ci++) {
              const sx = (ci & 1 ? hw : -hw), sz = (ci & 2 ? hd : -hd);
              const px = cx + sx * uz + sz * ux, pz = cz - sx * ux + sz * uz;
              const h = distToRoad(px, pz);
              if (h.rd && h.d < h.rd.w / 2 - .12) ok = false;
            }
            if (!ok) continue;
            // keep the spot clear of buildings (3x3 sample over the rect)
            for (let sx = -1; sx <= 1 && ok; sx++) for (let sz = -1; sz <= 1 && ok; sz++)
              if (pointInBuilding(cx + sx * PW * .36, cz + sz * PD * .36)) ok = false;
            if (!ok) continue;
            // no other road crossing the plot
            const near = roadsNear(cx, cz, 10);
            if (near.some(ri => ri !== rdx)) continue;
            // not inside greens/waters
            for (const g of [...(city.greens || []), ...(city.waters || [])])
              if (g.poly && inPoly(cx, cz, g.poly)) { ok = false; break; }
            if (!ok) continue;
            // v2.19: no vendor pads in the water
            if (LANDGEO.ready && LANDGEO.isWaterWorld(cx, cz)) continue;
            if (seen.some(s => Math.hypot(s[0] - cx, s[1] - cz) < 15)) continue;
            seen.push([cx, cz]);
            const rotY = Math.atan2(ux, uz);  // spot's long axis along the road
            const price = Math.round((ECON.plotBase * tierMult * (1 + Math.hypot(cx - axc, cz - azc) / 900) * .3) / 25) * 25;
            plotRecs.push({ id: (city.key || 'c') + '-' + n, x: cx, z: cz, rot: rotY, w: PW, d: PD, price, owned: false, cityKey: city.key });
            n++;
          }
        }
      }
    }
    if (n) buildPlotViz();
    return plotRecs;
  }

  // instanced plot layer: pads + dashed borders + floating $ markers
  function buildPlotViz() {
    const N = plotRecs.length;
    const cGreen = new THREE.Color(0x48bb78), cOwned = new THREE.Color(0x2f8f5b);
    // pads — one InstancedMesh, per-instance color
    const padGeo = new THREE.PlaneGeometry(1, 1); padGeo.rotateX(-Math.PI / 2);
    const pads = new THREE.InstancedMesh(padGeo,
      new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: .55 }), N);
    pads.receiveShadow = true;
    // dashed borders — one merged LineSegments, vertex colors
    const dPos = new Float32Array(N * 8 * 3), dCol = new Float32Array(N * 8 * 3);
    // $ markers — one Points cloud (camera-facing billboards)
    const $Pos = new Float32Array(N * 3);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    plotRecs.forEach((p, i) => {
      p.inst = i; p.v0 = i * 8;
      const c = Math.cos(p.rot), s = Math.sin(p.rot);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
      m4.compose(new THREE.Vector3(p.x - AX, .185, p.z - AZ), q, sc.set(p.w, 1, p.d));
      pads.setMatrixAt(i, m4);
      pads.setColorAt(i, cGreen);
      const hw = p.w / 2 - .5, hd = p.d / 2 - .5;
      const cor = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      for (let k = 0; k < 4; k++) {
        const [x1, z1] = cor[k], [x2, z2] = cor[(k + 1) % 4];
        const seg = [[x1, z1], [x2, z2]];
        for (let v = 0; v < 2; v++) {
          const vi = p.v0 + k * 2 + v;
          const lx = seg[v][0], lz = seg[v][1];
          dPos[vi * 3] = (p.x - AX) + lx * c + lz * s;
          dPos[vi * 3 + 1] = .21;
          dPos[vi * 3 + 2] = (p.z - AZ) - lx * s + lz * c;
          dCol[vi * 3] = 1; dCol[vi * 3 + 1] = 1; dCol[vi * 3 + 2] = 1;
        }
      }
      $Pos[i * 3] = p.x - AX; $Pos[i * 3 + 1] = 4.4; $Pos[i * 3 + 2] = p.z - AZ;
    });
    pads.instanceMatrix.needsUpdate = true;
    plotGroup.position.set(AX, 0, AZ);   // v2.27: the whole plot layer is city-local
    plotGroup.add(pads);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    dg.setAttribute('color', new THREE.BufferAttribute(dCol, 3));
    const dashes = new THREE.LineSegments(dg,
      new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 1.1, gapSize: .7, transparent: true, opacity: .95 }));
    dashes.computeLineDistances();
    plotGroup.add(dashes);
    const pg = new THREE.BufferGeometry();
    const dollarPos = new THREE.BufferAttribute($Pos, 3);
    pg.setAttribute('position', dollarPos);
    const dollars = new THREE.Points(pg, new THREE.PointsMaterial({
      map: _dollarTex || (_dollarTex = dollarTex()), transparent: true, depthWrite: false,
      size: 8.5, sizeAttenuation: true,
    }));
    plotGroup.add(dollars);
    plotViz = { pads, dashes, dollarPos, cGreen, cOwned };
  }

  // v2.09: buy-side visual flip — pad tints, dashes go gold, the $ marker
  // sinks out of sight, and a gold ring marks the cart spot. The ring is
  // per-plot (owned plots only, a handful at most).
  function setPlotOwned(rec) {
    rec.sold = true;
    if (!plotViz || rec.inst === undefined) return;
    const i = rec.inst;
    plotViz.pads.setColorAt(i, plotViz.cOwned);
    plotViz.pads.instanceColor.needsUpdate = true;
    const col = plotViz.dashes.geometry.attributes.color;
    for (let v = rec.v0; v < rec.v0 + 8; v++) col.setXYZ(v, .96, .8, .455);
    col.needsUpdate = true;
    plotViz.dollarPos.setY(i, -999);
    plotViz.dollarPos.needsUpdate = true;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.15, 26),
      new THREE.MeshBasicMaterial({ color: 0xf5cc74, transparent: true, opacity: .85, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(rec.x - AX, .2, rec.z - AZ);   // v2.27: city-local, like the layer
    plotGroup.add(ring);
    rec.ring = ring;
  }

  // ---------- v2.14 — OPEN COUNTRY: pasture renderer -------------------
  // soft green meadow ground (module singleton)
  function grassTexture() {
    const PX = 256;
    const cv = document.createElement('canvas'); cv.width = PX; cv.height = PX;
    const ctx = cv.getContext('2d');
    // v2.33: pasture grass joins the CR olive family + contrast mottle
    ctx.fillStyle = '#6d8c49'; ctx.fillRect(0, 0, PX, PX);
    const rnd = _mulberry(4242);
    for (let i = 0; i < 34; i++) {                            // meadow blotches
      ctx.fillStyle = rnd() < .5 ? 'rgba(62,88,36,.26)' : 'rgba(148,178,96,.24)';
      const r = 10 + rnd() * 42;
      ctx.beginPath(); ctx.ellipse(rnd() * PX, rnd() * PX, r, r * (.5 + rnd() * .5), rnd() * 3, 0, 6.29); ctx.fill();
    }
    for (let i = 0; i < 620; i++) {                            // grass speckle
      ctx.fillStyle = rnd() < .5 ? 'rgba(40,64,22,.14)' : 'rgba(178,204,124,.13)';
      ctx.fillRect(rnd() * PX, rnd() * PX, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.repeat.set(26, 26);
    return tex;
  }

  // green highway signboard texture: CITY NAME + real km by road
  function gateSignTexture(name, km) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 168;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#1d6f42'; ctx.fillRect(0, 0, 512, 168);
    ctx.strokeStyle = '#e8f2e6'; ctx.lineWidth = 8; ctx.strokeRect(10, 10, 492, 148);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f4faf2';
    ctx.font = '700 58px -apple-system,Segoe UI,Arial';
    ctx.fillText(name.toUpperCase(), 256, 66);
    ctx.font = '600 34px -apple-system,Segoe UI,Arial';
    ctx.fillStyle = '#bcd8c2';
    ctx.fillText(Math.round(km).toLocaleString('en-US') + ' km', 256, 126);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // city gates: gravel pull-off + two posts + a green signboard facing the
  // junction. Walk (or click) into the sign and you arrive in that city.
  function buildGates(city) {
    gates = (city.gates || []).map(g => ({ ...g, r: 9 }));
    const postM = new THREE.MeshLambertMaterial({ color: 0x5a6068 });
    for (const g of gates) {
      const grp = new THREE.Group();
      const BW = 6.8, BH = 2.24;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(BW, BH, .18),
        new THREE.MeshLambertMaterial({ color: 0x154f30 }));
      panel.position.y = 3.3;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(BW - .3, BH - .3),
        new THREE.MeshLambertMaterial({ map: gateSignTexture(g.city.name, g.km) }));
      face.position.set(0, 3.3, .1);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(BW - .3, BH - .3),
        new THREE.MeshLambertMaterial({ color: 0x1d6f42 }));
      back.position.set(0, 3.3, -.1); back.rotation.y = Math.PI;
      const p1 = new THREE.Mesh(new THREE.CylinderGeometry(.09, .12, 4.5, 8), postM);
      p1.position.set(-(BW / 2 - .5), 2.25, 0);
      const p2 = new THREE.Mesh(new THREE.CylinderGeometry(.09, .12, 4.5, 8), postM);
      p2.position.set(BW / 2 - .5, 2.25, 0);
      [panel, p1, p2].forEach(m => { m.castShadow = true; });
      grp.add(panel, face, back, p1, p2);
      // gravel pull-off where the road meets the sign
      const pad = new THREE.Mesh(new THREE.CircleGeometry(7.5, 22),
        new THREE.MeshLambertMaterial({ color: 0x8f8a7c }));
      pad.rotation.x = -Math.PI / 2; pad.position.y = .014;
      grp.add(pad);
      grp.position.set(g.x, 0, g.z);
      grp.rotation.y = Math.atan2(-g.x, -g.z);   // the board faces the junction
      group.add(grp);
    }
  }


  // ---------- v2.42 NEIGHBORHOODS: houses around every city -----------
  // "Make houses and neighborhoods around the cities." Every catalog
  // city now wears a suburb ring: six curved collector rings and
  // sixteen radial lanes from the town edge out to ~2.4 km (they join
  // the street list before the dry-land clip, so shorelines trim them
  // like any imported street), and house lots along every street —
  // bright lawns, driveways, porches, gable roofs with dormers and
  // chimneys — merged into a handful of city-local meshes, one draw
  // call each. Every house registers as a building, so the v2.41
  // inspector opens it too (houses list their ROOMS). The chunk pass's
  // wild content (belt trees, groves, paddocks, rocks, ponds) moves out
  // past the ring, so nothing wild grows in the yards.
  const SUB_R0 = 865, SUB_R1 = 2360;   // the ring (CITY_R 745 + verge → +1615)
  let suburbRec = null;
  let suburbGroup = null;              // v2.42: distance-LOD host (houses/trees/cars)
  const SUB_TREES = ['Maple', 'Oak', 'Cedar', 'Elm', 'Pine', 'Birch', 'Willow', 'Aspen', 'Rowan', 'Poplar', 'Hawthorn', 'Juniper'];
  const SUB_KINDS = ['Lane', 'Street', 'Drive', 'Court', 'Way', 'Terrace', 'Circle', 'Road'];

  function addSuburbRoads(meta, ax, az) {
    const rnd = _mulberry(hashStr('sub' + (meta.key || meta.name)));
    const out = [];
    const rot = rnd() * 6.2832;                    // the whole ring turns per city
    // six collector rings (cls 2): polygonal circles, a point every ≤44 m,
    // radii wobbling ±18 m so no ring ever reads as a perfect circle
    for (let i = 0; i < 6; i++) {
      const r = 880 + i * 280 + (rnd() - .5) * 70;
      const n = Math.max(48, Math.ceil(6.2832 * r / 44));
      const a0 = rot + i * .22, pts = [];
      for (let k = 0; k <= n; k++) {
        const a = a0 + k / n * 6.2832;
        const rr = r + Math.sin(a * 3 + i * 1.7) * 18;
        pts.push([ax + Math.cos(a) * rr, az + Math.sin(a) * rr]);
      }
      out.push({ pts, w: 11.5, cls: 2, sub: 1,
        name: (i + 1) + ' ' + SUB_TREES[Math.floor(rnd() * SUB_TREES.length)] + ' Ring' });
    }
    // sixteen radial lanes (cls 1), each with its own gentle bow
    for (let i = 0; i < 16; i++) {
      const a = rot + i / 16 * 6.2832 + (rnd() - .5) * .06;
      const bow = (rnd() - .5) * 70;
      const pts = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10, r = SUB_R0 + t * (SUB_R1 - SUB_R0);
        const aa = a + Math.sin(t * 3.1416) * (bow / Math.max(r, 1));
        pts.push([ax + Math.cos(aa) * r, az + Math.sin(aa) * r]);
      }
      out.push({ pts, w: 8.5, cls: 1, sub: 1,
        name: SUB_TREES[Math.floor(rnd() * SUB_TREES.length)] + ' ' + SUB_KINDS[Math.floor(rnd() * SUB_KINDS.length)] });
    }
    return out;
  }

  // ---------- v2.63 ONE NETWORK: every road reaches every other -------
  // "I want all the roads connected. It is ok if the roads have to
  // curve." Two structural gaps used to strand whole neighborhoods:
  // the VERGE (downtown streets end at the plate edge ~720 m out, the
  // suburb radials only start at 865 m — a 150–200 m ribbon of grass
  // between the grid and the rings, so the suburbs read as a separate
  // world), and the SHORELINE SPLIT (the dry-land clip cuts rings and
  // lanes into arcs, and a piece with no surviving junction floats
  // alone — same for short OSM service stubs). This pass runs AFTER the
  // clip, BEFORE anything downstream (meshes, plots, houses, hashes,
  // NPC routes all derive from the connected list):
  //   A. VERGE BRIDGES — every suburb-road tip in the inner annulus
  //      gets a curved lane down to the nearest real street, so each
  //      radial visibly ties into the downtown grid.
  //   B. FOLD — any component still separate is joined to the largest
  //      one by the shortest valid curved connector.
  // Connector paths are sampled every ~9 m and must stay dry and clear
  // of every building (bbox + 5.5 m — conservative, so nothing ever
  // slices a wall). Water-separated islands that admit no dry path are
  // left alone (console.warn) — a lane across a bay needs a bridge, and
  // that is the inter-city road system's job, not the city's.
  const LINK_NAMES = ['Link Way', 'Union Lane', 'Junction Drive', 'Crossing Street', 'Knot Lane', 'Switchback Street'];
  function connectRoadNetwork(meta, ax, az) {
    const out = { added: 0, left: 0 };
    if (roads.length < 2) return out;
    const rnd = _mulberry(hashStr('cn' + (meta.key || meta.name || 'c')));

    // ---- 14 m sample grid over every road (spatial hash) ------------
    const CELL = 56, grid = new Map(), samples = [];
    const addSample = (ri, x, z, dx, dz) => {
      samples.push({ ri, x, z, dx, dz });
      const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
      let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(samples.length - 1);
    };
    roads.forEach((r, ri) => {
      const p = r.pts;
      for (let i = 0; i < p.length; i++) {
        if (i < p.length - 1) {
          const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
          const L = Math.hypot(dx, dz) || 1;
          const n = Math.min(80, Math.floor(L / 14));
          addSample(ri, p[i][0], p[i][1], dx / L, dz / L);
          for (let k = 1; k < n; k++) addSample(ri, p[i][0] + dx * k / n, p[i][1] + dz * k / n, dx / L, dz / L);
        } else addSample(ri, p[i][0], p[i][1], 0, 1);
      }
    });
    const near = (x, z, rad, fn) => {
      for (let cx = Math.floor((x - rad) / CELL); cx <= Math.floor((x + rad) / CELL); cx++)
        for (let cz = Math.floor((z - rad) / CELL); cz <= Math.floor((z + rad) / CELL); cz++) {
          const a = grid.get(cx + ',' + cz); if (!a) continue;
          for (let si = 0; si < a.length; si++) fn(samples[a[si]]);
        }
    };

    // ---- union-find: roads touch when half widths + 5 m overlap -----
    const uf = roads.map((_, i) => i);
    const find = i => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) uf[a] = b; };
    for (const s of samples) {
      const rs = roads[s.ri];
      near(s.x, s.z, 26, t => {
        if (t.ri === s.ri) return;
        if (Math.hypot(t.x - s.x, t.z - s.z) <= (rs.w + roads[t.ri].w) / 2 + 5) uni(s.ri, t.ri);
      });
    }

    // ---- obstacle tests: water + buildings ---------------------------
    const wet = LANDGEO.ready ? (x, z) => LANDGEO.isWaterWorld(x, z) : null;
    const bbs = buildingPolys.map(b => {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const q of b.poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
      return { x0: x0 - 5.5, x1: x1 + 5.5, z0: z0 - 5.5, z1: z1 + 5.5 };
    });
    const blocked = (x, z) => {
      if (wet && wet(x, z)) return true;
      for (const b of bbs) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
      return false;
    };

    // ---- the curved connector ----------------------------------------
    // Cubic bezier leaving P along its road's course and arriving at Q
    // along Q's (both bow senses), then mid-perp quadratic bows, then
    // the straight line — first dry, wall-clear path wins.
    const cubic = (p0, p1, p2, p3) => {
      const pts = [];
      const steps = Math.max(8, Math.ceil(Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 9));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        pts.push([
          u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
      }
      return pts;
    };
    const quad = (p0, p1, p2) => {
      const pts = [];
      const steps = Math.max(8, Math.ceil(Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) / 9));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        pts.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
      }
      return pts;
    };
    const tryPath = pts => {
      for (const p of pts) if (blocked(p[0], p[1])) return null;
      // v2.64 NO RIDING ON TOP OF ANOTHER ROAD: interior samples must
      // clear every lane's corridor unless they CROSS it near-perpendic-
      // ularly (a legitimate junction). Near-parallel + close = overlapping
      // ribbons — the exact artifact this build removes. The first/last
      // ~18 m are exempt: that is the connector's own departure/arrival.
      for (let i = 2; i < pts.length - 2; i++) {
        const p = pts[i];
        const ddx = pts[i + 1][0] - pts[i - 1][0], ddz = pts[i + 1][1] - pts[i - 1][1];
        const dl = Math.hypot(ddx, ddz) || 1;
        let bad = false;
        near(p[0], p[1], 30, s => {
          if (bad) return;
          const rr = roads[s.ri];
          if (Math.hypot(s.x - p[0], s.z - p[1]) > (7.5 + rr.w) / 2 - 2) return;
          if (Math.abs((ddx / dl) * s.dz - (ddz / dl) * s.dx) < .5) bad = true;   // riding along it
        });
        if (bad) return null;
      }
      return pts;
    };
    // Cubic bezier leaving P along tp and arriving at Q ACROSS ITS LANE
    // (v2.64: the arrival tangent is Q's perpendicular, not Q's course —
    // arriving along the course made the connector merge INTO Q's asphalt
    // for up to k meters, two ribbons stacked in one street). Both bow
    // senses, then mid-perp quadratic bows, then the straight line —
    // first dry, wall-clear, overlap-free path wins.
    const buildPath = (P, Q, tp) => {
      const d = Math.hypot(Q.x - P.x, Q.z - P.z) || 1;
      const k = Math.min(90, Math.max(16, d * .3));
      let tqx = -(Q.dz || 0), tqz = (Q.dx || 0);              // perpendicular to Q's course
      if (tqx * (P.x - Q.x) + tqz * (P.z - Q.z) < 0) { tqx = -tqx; tqz = -tqz; }   // face P's side
      const cands = [];
      for (const s of [1, -1])
        cands.push(cubic([P.x, P.z], [P.x + tp[0] * k * s, P.z + tp[1] * k * s],
          [Q.x + tqx * k * s, Q.z + tqz * k * s], [Q.x, Q.z]));
      const mx = (P.x + Q.x) / 2, mz = (P.z + Q.z) / 2;
      const nx = -(Q.z - P.z) / d, nz = (Q.x - P.x) / d;
      for (const b of [.2, .38]) for (const s of [1, -1])
        cands.push(quad([P.x, P.z], [mx + nx * d * b * s, mz + nz * d * b * s], [Q.x, Q.z]));
      cands.push([[P.x, P.z], [Q.x, Q.z]]);
      for (const c of cands) { const r = tryPath(c); if (r) return r; }
      return null;
    };
    const pushConnector = (dense, pRi, qRi) => {
      const dec = [dense[0]];
      let acc = 0;
      for (let k = 1; k < dense.length - 1; k++) {
        acc += Math.hypot(dense[k][0] - dec[dec.length - 1][0], dense[k][1] - dec[dec.length - 1][1]);
        if (acc >= 40) { dec.push(dense[k]); acc = 0; }
      }
      dec.push(dense[dense.length - 1]);
      const mid = dec[Math.floor(dec.length / 2)];
      const sub = Math.hypot(mid[0] - ax, mid[1] - az) > 760 ? 1 : 0;
      const name = sub
        ? SUB_TREES[Math.floor(rnd() * SUB_TREES.length)] + ' ' + SUB_KINDS[Math.floor(rnd() * SUB_KINDS.length)]
        : LINK_NAMES[Math.floor(rnd() * LINK_NAMES.length)];
      roads.push({ pts: dec, w: 7.5, cls: 1, sub, name, link: 1 });
      const ri = roads.length - 1;
      uni(ri, pRi); uni(ri, qRi);
      // samples for the new lane (later searches + phase B see it)
      for (let i = 0; i < dec.length - 1; i++) {
        const dx = dec[i + 1][0] - dec[i][0], dz = dec[i + 1][1] - dec[i][1];
        const L = Math.hypot(dx, dz) || 1;
        const n = Math.min(40, Math.floor(L / 14));
        addSample(ri, dec[i][0], dec[i][1], dx / L, dz / L);
        for (let k = 1; k < n; k++) addSample(ri, dec[i][0] + dx * k / n, dec[i][1] + dz * k / n, dx / L, dz / L);
      }
      out.added++;
      return ri;
    };

    // ---- phase A: the verge — every suburb tip reaches town ----------
    // v2.64 ONE BRIDGE PER NEIGHBORHOOD: a closed ring fires this pass at
    // BOTH ends — the same physical point — and clustered radial tips all
    // used to dive for the same street endpoint, stacking two or three
    // parallel ribbons on one line. Origins dedupe on a 30 m grid, land-
    // ings spread along the street edge on a 25 m grid, and a closed
    // loop only bridges once.
    const bridgedOrigins = [], landedAt = new Set();
    const keyOf = (x, z, g) => Math.round(x / g) + ',' + Math.round(z / g);
    for (const r of roads.slice()) {
      if (!r.sub || r.link || r.pts.length < 2) continue;
      for (const e of [0, r.pts.length - 1]) {
        const p = r.pts[e];
        if (e > 0 && Math.hypot(p[0] - r.pts[0][0], p[1] - r.pts[0][1]) < 30) continue;   // closed loop: one end
        if (Math.hypot(p[0] - ax, p[1] - az) > SUB_R0 + 90) continue;      // outer tips are cul-de-sacs by design
        if (bridgedOrigins.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 30)) continue;   // cluster served
        let best = null, bd = 1e9;
        near(p[0], p[1], 360, s => {
          if (roads[s.ri].sub) return;
          if (landedAt.has(keyOf(s.x, s.z, 25))) return;                    // spread landings along the edge
          const d = Math.hypot(s.x - p[0], s.z - p[1]);
          if (d < bd) { bd = d; best = s; }
        });
        if (!best || bd <= 9) continue;                                     // already kisses a street
        const o = e === 0 ? r.pts[1] : r.pts[r.pts.length - 2];
        const L = Math.hypot(p[0] - o[0], p[1] - o[1]) || 1;
        const tp = [(p[0] - o[0]) / L, (p[1] - o[1]) / L];                   // continue the lane's course
        const path = buildPath({ x: p[0], z: p[1] }, best, tp);   // v2.64: arrival is perpendicular inside buildPath
        if (path) {
          pushConnector(path, roads.indexOf(r), best.ri);
          bridgedOrigins.push([p[0], p[1]]);
          landedAt.add(keyOf(best.x, best.z, 25));
        }
      }
    }

    // ---- phase B: fold any remaining separate component in -----------
    const comps = () => {
      const m = new Map();
      roads.forEach((_, i) => { const c = find(i); if (!m.has(c)) m.set(c, []); m.get(c).push(i); });
      return [...m.values()];
    };
    const roadLen = idx => idx.reduce((s, i) => {
      const p = roads[i].pts;
      for (let j = 1; j < p.length; j++) s += Math.hypot(p[j][0] - p[j - 1][0], p[j][1] - p[j - 1][1]);
      return s;
    }, 0);
    let groups = comps().sort((a, b) => roadLen(b) - roadLen(a));
    while (groups.length > 1) {
      const net = new Set(groups[0]);
      const netSamp = samples.filter(s => net.has(s.ri));
      let joined = false;
      for (let gi = 1; gi < groups.length && !joined; gi++) {
        const cs = new Set(groups[gi]);
        const cSamp = samples.filter(s => cs.has(s.ri));
        // nearest (comp point, network point) pairs, best first
        const pairs = [];
        for (const s of cSamp) {
          if (pairs.length > 400) break;
          for (const t of netSamp) {
            const d = Math.hypot(t.x - s.x, t.z - s.z);
            if (d < 700) pairs.push({ s, t, d });
          }
        }
        pairs.sort((a, b) => a.d - b.d);
        for (let pi = 0; pi < pairs.length && pi < 50 && !joined; pi++) {
          const { s, t } = pairs[pi];
          // v2.64: s and t sit MID-road here — leaving along the road's
          // own course would run the connector ON the street for the
          // whole tangent stretch. Depart across it instead.
          let dpx = -s.dz, dpz = s.dx;
          if (dpx * (t.x - s.x) + dpz * (t.z - s.z) < 0) { dpx = -dpx; dpz = -dpz; }
          const path = buildPath(s, t, [dpx, dpz]);
          if (path) { pushConnector(path, s.ri, t.ri); joined = true; }
        }
        if (joined) { groups = comps().sort((a, b) => roadLen(b) - roadLen(a)); }
      }
      if (!joined) {
        console.warn('[netroads] left isolated by water/ buildings:', groups.slice(1).map(g => g.map(i => roads[i].name).slice(0, 3)));
        out.left += groups.length - 1;
        break;
      }
    }
    return out;
  }

  function buildSuburbs(city) {
    suburbRec = { roads: 0, houses: 0, trees: 0, lamps: 0, cars: 0, verts: 0 };
    const subRoads = roads.filter(r => r.sub);
    if (!subRoads.length) return;
    suburbRec.roads = subRoads.length;
    suburbGroup = new THREE.Group();   // v2.42: gated by view distance (see the WORLD.update wrap)
    const rnd = _mulberry(hashStr('sb' + (city.key || city.name)));
    const axc = cityAnchor ? cityAnchor.x : 0, azc = cityAnchor ? cityAnchor.z : 0;
    const MAXH = isMob ? 420 : (city.tier === 3 ? 950 : city.tier === 1 ? 640 : 820);
    const wall = { pos: [], norm: [], uv: [], col: [] };   // style-2 punched-residential walls
    const roof = { pos: [], norm: [], uv: [], col: [] };   // pitches, gables, dormers, chimneys, doors
    const flat = { pos: [], norm: [], uv: [], col: [] };   // lawns + driveways
    const trees = [], lamps = [], cars = [];
    const UP = [0, 1, 0];

    // street-oriented box (5 faces) — porches, dormers, chimneys
    const boxSub = (cx, cz, y0, y1, hu, hd, colr, ux, uz) => {
      const px = -uz, pz = ux;
      const F = (du, dv, y) => [cx + ux * du + px * dv, y, cz + uz * du + pz * dv];
      pushQuadN(roof, F(hu, hd, y0), F(hu, hd, y1), F(hu, -hd, y1), F(hu, -hd, y0), colr, [ux, 0, uz]);
      pushQuadN(roof, F(-hu, hd, y0), F(-hu, -hd, y0), F(-hu, -hd, y1), F(-hu, hd, y1), colr, [-ux, 0, -uz]);
      pushQuadN(roof, F(-hu, hd, y0), F(-hu, hd, y1), F(hu, hd, y1), F(hu, hd, y0), colr, [px, 0, pz]);
      pushQuadN(roof, F(-hu, -hd, y0), F(hu, -hd, y0), F(hu, -hd, y1), F(-hu, -hd, y1), colr, [-px, 0, -pz]);
      pushQuadN(roof, F(-hu, hd, y1), F(-hu, -hd, y1), F(hu, -hd, y1), F(hu, hd, y1), colr, [0, 1, 0]);
    };

    // gable roof along the street axis + chimney + a dormer on the street slope
    const subRoof = (hx, hz, ux, uz, HW, HD, yTop, tint, shinC, sr, side) => {
      const px = -uz, pz = ux;
      const hU = HW / 2 + .38, hV = HD / 2 + .38;
      const rise = Math.min(2.6, hV * .72);
      const E = (du, dv) => [hx + ux * du + px * dv, yTop, hz + uz * du + pz * dv];
      const e1 = E(hU, hV), e2 = E(-hU, hV), e3 = E(-hU, -hV), e4 = E(hU, -hV);
      const r1 = [hx + ux * hU, yTop + rise, hz + uz * hU], r2 = [hx - ux * hU, yTop + rise, hz - uz * hU];
      pushQuadN(roof, e1, r1, r2, e2, shinC, [px, .5, pz]);        // +v slope
      pushQuadN(roof, e3, r2, r1, e4, shinC, [-px, .5, -pz]);      // -v slope
      pushTri(roof, e1, e4, r1, jit(tint, .93), [ux, .4, uz]);     // gable end walls
      pushTri(roof, e2, e3, r2, jit(tint, .93), [-ux, .4, -uz]);
      if (sr() < .6) {                                             // chimney near the ridge
        const cu = (sr() < .5 ? 1 : -1) * (hU - 1.4) * .62;
        const chx = hx + ux * cu, chz = hz + uz * cu;
        boxSub(chx, chz, yTop + rise - .55, yTop + rise + 1.25, .32, .32, jit(colOf(0x8a4a3c), .9 + sr() * .2), ux, uz);
        pushQuadN(roof, [chx - ux * .36 - px * .36, yTop + rise + 1.25, chz - uz * .36 - pz * .36],
          [chx + ux * .36 - px * .36, yTop + rise + 1.25, chz + uz * .36 - pz * .36],
          [chx + ux * .36 + px * .36, yTop + rise + 1.42, chz + uz * .36 + pz * .36],
          [chx - ux * .36 + px * .36, yTop + rise + 1.42, chz - uz * .36 + pz * .36], colOf(0x3a3a3c), [0, 1, 0]);
      }
      if (HW > 10.5 && sr() < .5) {                                // dormer on the street-facing slope
        const dv = -side * hV * .48;
        const base = yTop + rise * (1 - Math.abs(dv) / hV) - .22;
        const dx = hx + px * dv, dz = hz + pz * dv;
        boxSub(dx, dz, base, base + 1.7, .62, .66, jit(tint, 1), ux, uz);
        const fx = dx - px * side * .72, fz = dz - pz * side * .72; // downhill face
        pushQuadN(roof,
          [fx - ux * .4, base + .35, fz - uz * .4], [fx + ux * .4, base + .35, fz + uz * .4],
          [fx + ux * .4, base + 1.35, fz + uz * .4], [fx - ux * .4, base + 1.35, fz - uz * .4],
          colOf(0x2c333d), [-px * side, .25, -pz * side]);
      }
    };

    // one perimeter wall band — punched-residential UVs, the city's own math
    const wallBandSub = (p, yA, yB, tint, uOff, vOff) => {
      let per = 0;
      for (let i = 0; i < p.length; i++) {
        const a = p[i], c2 = p[(i + 1) % p.length];
        const dx = c2[0] - a[0], dz = c2[1] - a[1], len = Math.hypot(dx, dz);
        if (len < .05) continue;
        const nx = dz / len, nz = -dx / len;
        const u0 = per / WIN + uOff, u1 = (per + len) / WIN + uOff;
        pushQuad(wall,
          [a[0], yA, a[1]], [a[0], yB, a[1]], [c2[0], yB, c2[1]], [c2[0], yA, c2[1]],
          [nx, 0, nz], [u0, vOff], [u0, (yB - yA) / WIN + vOff], [u1, (yB - yA) / WIN + vOff], [u1, vOff], tint);
        per += len;
      }
    };

    // ---- lots along every suburb street -----------------------------
    let placed = 0;
    const lotGrid = new Map();                     // 40 m cells → lot rects (overlap guard)
    const G = 40;
    const overlaps = (x, z, hw, hd) => {
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        const arr = lotGrid.get((Math.floor(x / G) + gx) + ',' + (Math.floor(z / G) + gz));
        if (!arr) continue;
        for (const L of arr) if (Math.abs(L[0] - x) < L[2] + hw && Math.abs(L[1] - z) < L[3] + hd) return true;
      }
      return false;
    };
    // v2.63: curb-to-town lanes run near downtown blocks — a house lot
    // must not swallow an imported building. Coarse 80 m cells hold the
    // building bboxes; a lot is rejected when its rect meets one.
    const BG = 80, bGrid = new Map();
    for (const b of buildingPolys) {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const q of b.poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
      for (let gx = Math.floor(x0 / BG); gx <= Math.floor(x1 / BG); gx++)
        for (let gz = Math.floor(z0 / BG); gz <= Math.floor(z1 / BG); gz++) {
          const k = gx + ',' + gz;
          if (!bGrid.has(k)) bGrid.set(k, []);
          bGrid.get(k).push([x0, x1, z0, z1]);
        }
    }
    const onBuilding = (x, z, hw, hd) => {
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        const arr = bGrid.get((Math.floor(x / BG) + gx) + ',' + (Math.floor(z / BG) + gz));
        if (!arr) continue;
        for (const b of arr) if (x + hw > b[0] && x - hw < b[1] && z + hd > b[2] && z - hd < b[3]) return true;
      }
      return false;
    };
    // inner streets first, so the house cap fills town-outward
    const ordered = subRoads.slice().sort((a, b) => {
      const dOf = rd => { let m = 1e9; for (const p of rd.pts) m = Math.min(m, Math.hypot(p[0] - axc, p[1] - azc)); return m; };
      return dOf(a) - dOf(b);
    });
    for (const rd of ordered) {
      const LOTW = 21 + rnd() * 6;
      let arc = 0, next = rnd() * 9;               // cumulative arc walk (buildEdgePlots' pattern)
      for (let i = 0; i < rd.pts.length - 1 && placed < MAXH; i++) {
        const A = rd.pts[i], B = rd.pts[i + 1];
        const segL = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const ux = (B[0] - A[0]) / segL, uz = (B[1] - A[1]) / segL;
        const px = -uz, pz = ux;
        while (next + LOTW <= arc + segL && placed < MAXH) {
          const d = next + LOTW / 2 - arc;         // lot center along this segment
          next += LOTW;
          for (const side of [1, -1]) {
            if (placed >= MAXH) break;
            const rr = Math.hypot(A[0] + ux * d - axc, A[1] + uz * d - azc);
            const fill = rr < SUB_R0 + 620 ? .92 : rr < SUB_R0 + 1180 ? .7 : .52;
            if (rnd() > fill) continue;
            const depth = 26 + rnd() * 8;
            const off0 = rd.w / 2 + 1.75 + 1.2;    // past the sidewalk
            const lotHW = LOTW / 2 - .7, lotHD = depth / 2;
            const ov = off0 + depth / 2;
            const lx = A[0] + ux * d + px * ov * side, lz = A[1] + uz * d + pz * ov * side;
            const LP = (u, v) => [A[0] + ux * (d + u) + px * v * side, A[1] + uz * (d + u) + pz * v * side];
            // dry lot (corners + center) — the v2.19 rule
            if (LANDGEO.ready) {
              const cs = [LP(-lotHW, off0), LP(lotHW, off0), LP(-lotHW, off0 + depth), LP(lotHW, off0 + depth), [lx, lz]];
              if (cs.some(c2 => LANDGEO.isWaterWorld(c2[0], c2[1]))) continue;
            }
            // v2.63: never on an imported downtown building
            if (onBuilding(lx, lz, lotHW, lotHD)) continue;
            // clear of every street's asphalt — crossings stay open
            const dq = distToRoad(lx, lz);
            if (dq.rd && dq.d < dq.rd.w / 2 + 4) continue;
            // no inter-city road under the yard
            if (WORLD.nearRoad && WORLD.nearRoad(lx, lz, 30)) continue;
            // no neighbor lot
            if (overlaps(lx, lz, lotHW, lotHD)) continue;
            const gkk = Math.floor(lx / G) + ',' + Math.floor(lz / G);
            if (!lotGrid.has(gkk)) lotGrid.set(gkk, []);
            lotGrid.get(gkk).push([lx, lz, lotHW, lotHD]);
            // ---- the house ------------------------------------------
            const HW = 8.5 + rnd() * 4.5, HD = 6.5 + rnd() * 3;
            const hh = rnd() < .3 ? 7 + rnd() * .9 : 4.4 + rnd() * 1.5;
            const back = rnd() * Math.max(2, depth - HD - 8);
            const hv = off0 + 6.5 + back + HD / 2;
            const hx = A[0] + ux * d + px * hv * side, hz = A[1] + uz * d + pz * hv * side;
            const srnd = _mulberry(hashStr('h' + (city.key || 'c') + placed));
            const tint = jit(colOf(PAL_WARM[Math.floor(srnd() * PAL_WARM.length)]), 1.24 + srnd() * .16);
            const shinC = jit(colOf(SHINGLES[Math.floor(srnd() * SHINGLES.length)]), .9 + srnd() * .2);
            const uOff = Math.floor(srnd() * 16), vOff = Math.floor(srnd() * 4);
            let hp = [
              [hx - ux * HW / 2 - px * HD / 2, hz - uz * HW / 2 - pz * HD / 2],
              [hx + ux * HW / 2 - px * HD / 2, hz + uz * HW / 2 - pz * HD / 2],
              [hx + ux * HW / 2 + px * HD / 2, hz + uz * HW / 2 + pz * HD / 2],
              [hx - ux * HW / 2 + px * HD / 2, hz - uz * HW / 2 + pz * HD / 2]];
            if (_polyArea(hp) < 0) hp.reverse();
            wallBandSub(hp, .15, .15 + hh, tint, uOff, vOff);
            subRoof(hx, hz, ux, uz, HW, HD, .15 + hh, tint, shinC, srnd, side);
            // door + porch on the street face
            const fpx = -px * side, fpz = -pz * side;
            const doorU = (srnd() - .5) * (HW - 3.2);
            const dcx = hx + ux * doorU + fpx * (HD / 2 + .04);
            const dcz = hz + uz * doorU + fpz * (HD / 2 + .04);
            pushQuad(roof,
              [dcx - ux * .55, .15, dcz - uz * .55], [dcx - ux * .55, 2.2, dcz - uz * .55],
              [dcx + ux * .55, 2.2, dcz + uz * .55], [dcx + ux * .55, .15, dcz + uz * .55],
              [fpx, 0, fpz], [0, 0], [0, 1], [1, 1], [1, 0], jit(colOf(0x5f4632), .9 + srnd() * .25));
            boxSub(hx + ux * doorU + fpx * (HD / 2 + .8), hz + uz * doorU + fpz * (HD / 2 + .8),
              .12, .34, 1.5, .8, jit(colOf(0x8f8a80), .95 + srnd() * .12), ux, uz);
            // driveway: street edge → house wall, clear of the door
            const drvU = doorU + (doorU < 0 ? 1 : -1) * (HW / 2 - 1.6);
            const v0 = off0 - .8, v1 = hv - HD / 2 + .8;
            const drvC = [A[0] + ux * (d + drvU), A[1] + uz * (d + drvU)];
            const dA = [drvC[0] + px * v1 * side + ux * 1.35, drvC[1] + pz * v1 * side + uz * 1.35];
            const dB = [drvC[0] + px * v1 * side - ux * 1.35, drvC[1] + pz * v1 * side - uz * 1.35];
            const dC = [drvC[0] + px * v0 * side - ux * 1.35, drvC[1] + pz * v0 * side - uz * 1.35];
            const dD = [drvC[0] + px * v0 * side + ux * 1.35, drvC[1] + pz * v0 * side + uz * 1.35];
            const dcol = jit(colOf(0x9a958a), .93 + srnd() * .12);
            if (side > 0) pushQuad(flat, [dA[0], .066, dA[1]], [dB[0], .066, dB[1]], [dC[0], .066, dC[1]], [dD[0], .066, dD[1]], UP, [0, 0], [1, 0], [1, 1], [0, 1], dcol);
            else pushQuad(flat, [dA[0], .066, dA[1]], [dD[0], .066, dD[1]], [dC[0], .066, dC[1]], [dB[0], .066, dB[1]], UP, [0, 0], [1, 0], [1, 1], [0, 1], dcol);
            // lawn: the whole lot, under everything
            const lawnC = jit(colOf(0x6cc066), .9 + srnd() * .2);
            const cA = LP(lotHW, off0 + depth), cB = LP(-lotHW, off0 + depth), cC = LP(-lotHW, off0 - .2), cD = LP(lotHW, off0 - .2);
            if (side > 0) pushQuad(flat, [cA[0], .07, cA[1]], [cB[0], .07, cB[1]], [cC[0], .07, cC[1]], [cD[0], .07, cD[1]], UP, [0, 0], [1, 0], [1, 1], [0, 1], lawnC);
            else pushQuad(flat, [cA[0], .07, cA[1]], [cD[0], .07, cD[1]], [cC[0], .07, cC[1]], [cB[0], .07, cB[1]], UP, [0, 0], [1, 0], [1, 1], [0, 1], lawnC);
            // register: the v2.41 inspector opens houses too (rooms, not floors)
            buildingPolys.push({ poly: hp, h: hh, bkey: 'sb' + (city.key || 'c') + placed, area: HW * HD, x: hx, z: hz, t: {}, sub: 1 });
            placed++;
            // yard trees at the back corners (addTrees' own guards apply)
            if (srnd() < .6) {
              const tu = (srnd() < .5 ? 1 : -1) * (lotHW - 2);
              trees.push(LP(tu, off0 + depth - 3.2));
              if (srnd() < .35) trees.push(LP(-tu, off0 + depth - 3.2));
            }
            // a car in the driveway now and then
            if (srnd() < .12) {
              const cv = v0 + 4.4;
              cars.push([drvC[0] + px * cv * side, drvC[1] + pz * cv * side, Math.atan2(px * side, pz * side), srnd()]);
            }
          }
        }
        arc += segL;
      }
    }

    // ---- ring lamps (own sparse pass; the downtown lamp budget is untouched)
    for (const rd of subRoads) {
      if (rd.cls < 2) continue;
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const A = rd.pts[i], B = rd.pts[i + 1];
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (len < 20) continue;
        const ux = (B[0] - A[0]) / len, uz = (B[1] - A[1]) / len;
        let side = 1;
        for (let dd = 14; dd < len - 6; dd += 64) {
          const off = rd.w / 2 + 2.6;
          const x = A[0] + ux * dd - uz * off * side, z = A[1] + uz * dd + ux * off * side;
          const s0 = side; side = -side;
          if (LANDGEO.ready && LANDGEO.isWaterWorld(x, z)) continue;
          const tx = uz * s0, tz = -ux * s0;            // toward the road
          lamps.push([x, z, Math.atan2(-tz, tx)]);
        }
      }
    }

    // ---- assemble: city-local merged meshes, the established pattern --
    const mkS = (arr, tex, two) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial(
        tex ? { map: tex, vertexColors: true } : { vertexColors: true, side: two ? THREE.DoubleSide : THREE.FrontSide }));
      m.position.set(AX, 0, AZ);   // v2.27: city-local geometry
      return m;
    };
    if (wall.pos.length) { const m = mkS(wall, getWinTex(2)); m.castShadow = true; m.receiveShadow = true; suburbGroup.add(m); }
    if (roof.pos.length) { const m = mkS(roof, null); m.castShadow = true; suburbGroup.add(m); }
    if (flat.pos.length) { const m = mkS(flat, null, true); m.receiveShadow = true; group.add(m); }   // lawns/drives: always on (flat + cheap — the pattern from above)
    suburbRec.verts = (wall.pos.length + roof.pos.length + flat.pos.length) / 3 | 0;
    // yard trees — the city's own instancing pass, inside the LOD group
    if (trees.length) { addTrees(trees, suburbGroup); suburbRec.trees = trees.length; }
    if (lamps.length) {
      const n = Math.min(lamps.length, Math.floor(isMob ? 140 : 240));
      const poleM = new THREE.MeshLambertMaterial({ color: 0x363b41 });
      const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(.06, .09, 5.6, 7), poleM, n);
      const arm = new THREE.InstancedMesh(new THREE.BoxGeometry(.95, .08, .08), poleM, n);
      const head = new THREE.InstancedMesh(new THREE.BoxGeometry(.6, .15, .22),
        new THREE.MeshLambertMaterial({ color: 0xf2f4e6, emissive: 0x55523c }), n);
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Yv = new THREE.Vector3(0, 1, 0), sv = new THREE.Vector3(1, 1, 1);
      for (let i = 0; i < n; i++) {
        const [x, z, th] = lamps[i];
        const cs = Math.cos(th), sn = Math.sin(th);
        q.setFromAxisAngle(Yv, th);
        mat4.compose(new THREE.Vector3(x - AX, 2.96, z - AZ), q, sv); pole.setMatrixAt(i, mat4);
        mat4.compose(new THREE.Vector3(x + .45 * cs - AX, 5.51, z - .45 * sn - AZ), q, sv); arm.setMatrixAt(i, mat4);
        mat4.compose(new THREE.Vector3(x + .86 * cs - AX, 5.44, z - .86 * sn - AZ), q, sv); head.setMatrixAt(i, mat4);
      }
      pole.position.set(AX, 0, AZ); arm.position.set(AX, 0, AZ); head.position.set(AX, 0, AZ);
      suburbGroup.add(pole, arm, head);
      suburbRec.lamps = n;
    }
    if (cars.length) {
      const n = Math.min(cars.length, isMob ? 36 : 70);
      const bodyGeo = new THREE.BoxGeometry(4.05, 1.0, 1.76); bodyGeo.translate(0, .58, 0);
      const cabGeo = new THREE.BoxGeometry(2.35, .66, 1.5); cabGeo.translate(-.26, 1.36, 0);
      const whGeo = new THREE.CylinderGeometry(.3, .3, .2, 10); whGeo.rotateZ(Math.PI / 2);
      const body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
      const cab = new THREE.InstancedMesh(cabGeo, new THREE.MeshLambertMaterial({ color: 0x15181d }), n);
      const wheels = new THREE.InstancedMesh(whGeo, new THREE.MeshLambertMaterial({ color: 0x1d2024 }), n * 4);
      const CARP = [0xe8e8e6, 0xb9bdc1, 0x2e3134, 0x6f7479, 0x9e3b33, 0x39527a, 0x4a5560];
      const mat4 = new THREE.Matrix4(), rot = new THREE.Matrix4(), loc = new THREE.Matrix4();
      const cc = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const [x, z, th, r4] = cars[i];
        rot.makeRotationY(th);
        mat4.copy(rot); mat4.setPosition(x - AX, 0, z - AZ);
        body.setMatrixAt(i, mat4);
        cab.setMatrixAt(i, mat4);
        body.setColorAt(i, cc.set(CARP[Math.floor(r4 * CARP.length) % CARP.length]));
        for (let w = 0; w < 4; w++) {
          loc.makeTranslation(w < 2 ? 1.32 : -1.32, .3, w % 2 ? .79 : -.79);
          wheels.setMatrixAt(i * 4 + w, new THREE.Matrix4().multiplyMatrices(mat4, loc));
        }
      }
      body.castShadow = true;
      body.position.set(AX, 0, AZ); cab.position.set(AX, 0, AZ); wheels.position.set(AX, 0, AZ);
      suburbGroup.add(body, cab, wheels);
      suburbRec.cars = n;
    }
    group.add(suburbGroup);
    // rebuild the hashes — houses are buildings now (clicks, trees, props)
    buildSpatialHash();
    suburbRec.houses = placed;
  }

  // a barn (or two) set back off a country road — walls join the collision
  // footprint so you can't walk through them
  function buildPastureBarns(city) {
    const rnd = _mulberry(hashStr('B' + (city.key || city.name)));
    const n = rnd() < .3 ? 2 : 1;
    for (let b = 0; b < n; b++) {
      const rd = city.roads[Math.floor(rnd() * city.roads.length)];
      if (!rd || !rd.pts || rd.pts.length < 2) continue;
      const i = Math.floor(rnd() * (rd.pts.length - 1));
      const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const d = Math.min(len - 60, 100 + rnd() * (len - 160 > 0 ? len - 160 : 60));
      const side = rnd() < .5 ? 1 : -1;
      const off = 26 + rnd() * 16;
      const cx = ax + ux * d - uz * off * side;
      const cz = az + uz * d + ux * off * side;
      if (Math.hypot(cx - (cityAnchor ? cityAnchor.x : 0), cz - (cityAnchor ? cityAnchor.z : 0)) > 640) continue;
      if (LANDGEO.ready && LANDGEO.isWaterWorld(cx, cz)) continue;   // v2.19: barn on dry ground
      const W = 9 + rnd() * 3, Dp = 6.5 + rnd() * 2;
      buildingPolys.push({ poly: [[cx - W / 2, cz - Dp / 2], [cx + W / 2, cz - Dp / 2], [cx + W / 2, cz + Dp / 2], [cx - W / 2, cz + Dp / 2]],
        h: 7, bkey: 'barn' + b, t: {} });
      const grp = new THREE.Group();
      const wall = new THREE.Mesh(new THREE.BoxGeometry(W, 4.6, Dp),
        new THREE.MeshLambertMaterial({ color: 0xa8402f }));
      wall.position.y = 2.3; wall.castShadow = true; wall.receiveShadow = true;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4),
        new THREE.MeshLambertMaterial({ color: 0x4d4038 }));
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(W * .74, 3, Dp * .92);
      roof.position.y = 4.6 + 1.5; roof.castShadow = true;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3.2),
        new THREE.MeshLambertMaterial({ color: 0xe8e4dc }));
      door.position.set(0, 1.7, Dp / 2 + .02);
      grp.add(wall, roof, door);
      grp.position.set(cx, 0, cz);
      grp.rotation.y = Math.atan2(ax + ux * d - cx, az + uz * d - cz);   // door faces the road
      group.add(grp);
    }
  }

  // hay fields, groves + lone trees (v2.07 road-clearance guarantee),
  // rocks, bushes, hay bales, fences along the country roads
  function buildPastureExtras(city) {
    const rnd = _mulberry(hashStr('F' + (city.key || city.name)));
    const mobF = isMob ? .6 : 1;
    const gateClear = (x, z) => gates.every(g => Math.hypot(x - g.x, z - g.z) > 14);
    // v2.19: fields/groves/rocks center on the SETTLEMENT (they used to
    // ring world origin — the Gulf of Guinea — leaving the homestead
    // bare) and nothing is placed on water.
    const PAX = cityAnchor ? cityAnchor.x : 0, PAZ = cityAnchor ? cityAnchor.z : 0;
    const dry = (x, z) => !(LANDGEO.ready && LANDGEO.isWaterWorld(x, z));

    // ---- hay field patches: soft color washes over the meadow ----
    const fields = { pos: [], norm: [], uv: [], col: [] };
    const FPC = [0x93c46e, 0xa9c96e, 0x86bb62, 0xbac46e, 0x7fb35f, 0xc4bb66].map(colOf);
    const nF = Math.round((11 + rnd() * 7) * mobF);
    for (let f = 0; f < nF; f++) {
      const cx = PAX + (rnd() * 2 - 1) * 570, cz = PAZ + (rnd() * 2 - 1) * 570;
      if (!dry(cx, cz)) continue;
      const R = 60 + rnd() * 130;
      if (Math.hypot(cx - (cityAnchor ? cityAnchor.x : 0), cz - (cityAnchor ? cityAnchor.z : 0)) < 110) continue;                 // keep the junction open
      const col = jit(FPC[Math.floor(rnd() * FPC.length)], .93 + rnd() * .14);
      const n = 9 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const a0 = i / n * 6.2832, a1 = (i + 1) / n * 6.2832;
        const r0 = R * (.58 + rnd() * .5), r1 = R * (.58 + rnd() * .5);
        pushFlat(fields, [cx + Math.cos(a0) * r0, .05, cz + Math.sin(a0) * r0],
          [cx + Math.cos(a1) * r1, .05, cz + Math.sin(a1) * r1], [cx, .05, cz], col);
      }
    }
    if (fields.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(fields.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(fields.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(fields.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(fields.col, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.position.set(AX, 0, AZ);   // v2.27: city-local geometry
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    // ---- groves + lone trees ----
    const trees = [];
    const nG = Math.round((6 + rnd() * 4) * mobF);
    for (let gi = 0; gi < nG; gi++) {
      const gx = PAX + (rnd() * 2 - 1) * 500, gz = PAZ + (rnd() * 2 - 1) * 500;
      if (Math.hypot(gx - PAX, gz - PAZ) < 120) continue;
      if (!dry(gx, gz)) continue;
      const n = 5 + Math.floor(rnd() * 10);
      for (let i = 0; i < n; i++) {
        const a = rnd() * 6.2832, rr = 14 + rnd() * 34;
        trees.push([gx + Math.cos(a) * rr, gz + Math.sin(a) * rr]);
      }
    }
    for (let i = 0; i < Math.round(34 * mobF); i++) {          // lone sentinels
      const a = rnd() * 6.2832, rr = 130 + rnd() * 430;
      trees.push([PAX + Math.cos(a) * rr, PAZ + Math.sin(a) * rr]);
    }
    const keptTrees = [];
    let droppedTrees = 0;
    for (const t of trees) {
      if (offAsphalt(t[0], t[1], 1.4) && !plotAt(t[0], t[1]) && gateClear(t[0], t[1]) && dry(t[0], t[1])) keptTrees.push(t);
      else droppedTrees++;
    }
    treeList = keptTrees;
    treeStats = { kept: keptTrees.length, dropped: droppedTrees };
    addTrees(keptTrees);

    // ---- rocks + bushes + hay bales (instanced) ----
    const rocks = [], bushes = [], bales = [];
    for (let i = 0; i < Math.round(26 * mobF); i++) {
      const a = rnd() * 6.2832, rr = 60 + rnd() * 520;
      const x = PAX + Math.cos(a) * rr, z = PAZ + Math.sin(a) * rr;
      if (dry(x, z) && offAsphalt(x, z, 1.6) && !plotAt(x, z) && gateClear(x, z)) rocks.push([x, z, .5 + rnd() * 1.3, rnd() * 6.28]);
    }
    for (let i = 0; i < Math.round(46 * mobF); i++) {
      const a = rnd() * 6.2832, rr = 40 + rnd() * 560;
      const x = PAX + Math.cos(a) * rr, z = PAZ + Math.sin(a) * rr;
      if (dry(x, z) && offAsphalt(x, z, 1.2) && !plotAt(x, z)) bushes.push([x, z, .7 + rnd() * .8]);
    }
    for (let i = 0; i < Math.round((6 + rnd() * 8) * mobF); i++) {
      const a = rnd() * 6.2832, rr = 150 + rnd() * 380;
      const x = PAX + Math.cos(a) * rr, z = PAZ + Math.sin(a) * rr;
      if (dry(x, z) && offAsphalt(x, z, 2.2) && !plotAt(x, z) && gateClear(x, z)) bales.push([x, z, rnd() * 6.28]);
    }
    {
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
      if (rocks.length) {
        const inst = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
          new THREE.MeshLambertMaterial({ color: 0x9a9d99 }), rocks.length);
        rocks.forEach((v, i) => {
          q.setFromAxisAngle(Y, v[3]);
          mat4.compose(new THREE.Vector3(v[0] - AX, v[2] * .32, v[1] - AZ), q, sc.set(v[2], v[2] * .8, v[2]));
          inst.setMatrixAt(i, mat4);
        });
        inst.castShadow = true;
        inst.position.set(AX, 0, AZ);   // v2.27: city-local instances
        group.add(inst);
      }
      if (bushes.length) {
        const inst = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1),
          new THREE.MeshLambertMaterial({ color: 0x3f7f45 }), bushes.length);
        bushes.forEach((v, i) => {
          mat4.compose(new THREE.Vector3(v[0] - AX, v[2] * .4, v[1] - AZ), q.identity(), sc.set(v[2], v[2] * .66, v[2]));
          inst.setMatrixAt(i, mat4);
        });
        inst.position.set(AX, 0, AZ);   // v2.27
        group.add(inst);
      }
      if (bales.length) {
        const geo = new THREE.CylinderGeometry(.8, .8, 1.5, 12); geo.rotateZ(Math.PI / 2);
        const inst = new THREE.InstancedMesh(geo,
          new THREE.MeshLambertMaterial({ color: 0xc9a86a }), bales.length);
        bales.forEach((v, i) => {
          q.setFromAxisAngle(Y, v[2]);
          mat4.compose(new THREE.Vector3(v[0] - AX, .8, v[1] - AZ), q, sc.set(1, 1, 1));
          inst.setMatrixAt(i, mat4);
        });
        inst.castShadow = true;
        inst.position.set(AX, 0, AZ);   // v2.27
        group.add(inst);
      }
    }

    // ---- fences along the country roads (posts + two rails per span) ----
    const posts = [], rails = [];
    for (const rd of roads) {
      if (!rd.country) continue;
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 40) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        for (const side of [1, -1]) {
          const off = rd.w / 2 + 6.6;
          for (let d = 18; d < len - 16; d += 4.3) {
            const x = ax + ux * d - uz * off * side, z = az + uz * d + ux * off * side;
            if (plotAt(x, z)) continue;
            if (gates.some(g => Math.hypot(x - g.x, z - g.z) < 18)) continue;
            posts.push([x, z]);
            if (d + 4.3 < len - 16) {
              const x2 = ax + ux * (d + 4.3) - uz * off * side, z2 = az + uz * (d + 4.3) + ux * off * side;
              rails.push([x, z, x2, z2]);
            }
          }
        }
      }
    }
    if (posts.length) {
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
      const postM = new THREE.MeshLambertMaterial({ color: 0x7a5c44 });
      const pInst = new THREE.InstancedMesh(new THREE.BoxGeometry(.14, 1.2, .14), postM, posts.length);
      posts.forEach((v, i) => {
        mat4.compose(new THREE.Vector3(v[0] - AX, .6, v[1] - AZ), q.identity(), sc.set(1, 1, 1));
        pInst.setMatrixAt(i, mat4);
      });
      pInst.castShadow = true;
      pInst.position.set(AX, 0, AZ);   // v2.27
      group.add(pInst);
      const railM = new THREE.MeshLambertMaterial({ color: 0x8a6a4e });
      const rInst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, .07, .09), railM, rails.length * 2);
      rails.forEach((v, i) => {
        const th = Math.atan2(v[2] - v[0], v[3] - v[1]);
        q.setFromAxisAngle(Y, th);
        for (const h of [.52, .96]) {
          mat4.compose(new THREE.Vector3((v[0] + v[2]) / 2 - AX, h, (v[1] + v[3]) / 2 - AZ), q, sc.set(4.45, 1, 1));
          rInst.setMatrixAt(i * 2 + (h > .7 ? 1 : 0), mat4);
        }
      });
      rInst.position.set(AX, 0, AZ);   // v2.27
      group.add(rInst);
    }
  }

  // distant hill ring instead of a skyline — open country to the horizon
  function buildHills() {
    const rnd = _mulberry(hashStr('h' + (cityRec.key || cityRec.name || 'x')));
    const hax = cityAnchor ? cityAnchor.x : 0, haz = cityAnchor ? cityAnchor.z : 0;
    const n = isMob ? 26 : 44;
    // v2.19: hills stand on dry land only — no rocky islets ringing a
    // seaside or lakeside city (the water around a shore city is real).
    const spots = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.2832 + rnd() * .1;
      const r = 1050 + rnd() * 380;
      const x = hax + Math.cos(a) * r, z = haz + Math.sin(a) * r;
      const w = 190 + rnd() * 300, h = 46 + rnd() * 96;
      const zf = .7 + rnd() * .5, f = .18 + rnd() * .3;
      if (LANDGEO.ready && LANDGEO.isWaterWorld(x, z)) continue;
      spots.push({ x, z, w, h, zf, f });
    }
    if (!spots.length) return;
    const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8, 0, 6.2832, 0, 1.35),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), spots.length);
    const mat4 = new THREE.Matrix4();
    const liftC = new THREE.Color(0x9cc47a), base = new THREE.Color(0x619a44), c = new THREE.Color();   // v2.35: pasture hills — the lerp only varies lightness inside the green family (no blue fade, no haze)
    spots.forEach((s, i) => {
      mat4.makeScale(s.w, s.h, s.w * s.zf);
      mat4.setPosition(s.x - AX, -6, s.z - AZ);
      inst.setMatrixAt(i, mat4);
      inst.setColorAt(i, c.copy(base).lerp(liftC, s.f * .8));
    });
    inst.position.set(AX, 0, AZ);   // v2.27: city-local instances
    group.add(inst);
  }

  // v2.14 gate pickers: click (gateAt) / walk-in (gateNear)
  function gateAt(x, z) {
    for (const g of gates) if (Math.hypot(x - g.x, z - g.z) <= g.r) return g;
    return null;
  }
  function gateNear(x, z, r) {
    for (const g of gates) if (Math.hypot(x - g.x, z - g.z) <= r) return g;
    return null;
  }

  // ---------- v2.19 SHORELINE CITIES: the ground plate -----------------
  // The old plate was one full 1490 m square — over a coast or lakeshore
  // that meant a slab of "city ground" floating on the water. The plate
  // is tiled now and only dry tiles are laid, so the city's footprint
  // ends where the water begins — the shore shapes the city, like in the
  // real world. (The planet's land shield still shows between the last
  // tile and the waterline, so nothing floats.)
  function shorePlate(ax, az, size, y, tex) {
    if (!LANDGEO.ready) {
      const base = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
        new THREE.MeshLambertMaterial({ map: tex }));
      base.rotation.x = -Math.PI / 2; base.position.set(ax, y, az);
      base.renderOrder = 1.6;   // v2.37 flat-ground ladder: city plate (literal — this module sits outside the WORLD closure that owns the RO_* constants)
      base.receiveShadow = true;
      return base;
    }
    const N = 20, T = size / N;
    const pos = [], uv = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x0 = ax - size / 2 + i * T, z0 = az - size / 2 + j * T;
      const x1 = x0 + T, z1 = z0 + T;
      // a tile is laid only where it is solid ground at every corner + center
      if (LANDGEO.isWaterWorld(x0, z0) || LANDGEO.isWaterWorld(x1, z0) ||
          LANDGEO.isWaterWorld(x0, z1) || LANDGEO.isWaterWorld(x1, z1) ||
          LANDGEO.isWaterWorld((x0 + x1) / 2, (z0 + z1) / 2)) continue;
      const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N;
      // v2.27: emitted ANCHOR-LOCAL; the mesh carries the anchor
      const lx0 = x0 - ax, lz0 = z0 - az, lx1 = x1 - ax, lz1 = z1 - az;
      pos.push(lx0, y, lz1, lx1, y, lz1, lx1, y, lz0, lx0, y, lz1, lx1, y, lz0, lx0, y, lz0);
      uv.push(u0, v1, u1, v1, u1, v0, u0, v1, u1, v0, u0, v0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => i % 3 === 1 ? 1 : 0), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex }));
    mesh.position.set(ax, 0, az);   // v2.27: city-local geometry
    mesh.renderOrder = 1.6;   // v2.37 flat-ground ladder: city plate (literal — outside the WORLD closure)
    mesh.receiveShadow = true;
    return mesh;
  }

  // ---------- assemble ---
  // v2.04 — FAST CITY ENTRY: the build now yields to the browser between
  // phases (rAF, 90ms safety cap) and reports live status, so the veil
  // shows progress instead of freezing on "Entering…" for a full second+.
  const _tick = () => new Promise(r => {
    let done = false;
    const f = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(f);           // visible tab: ~16ms, veil repaints
    setTimeout(f, 90);                  // hidden/background tab safety cap
  });

  async function build(cityData, cityMeta, anchor, onStatus) {
    dispose();
    // v2.15 ONE WORLD: anchor = the city's fixed world position. Imported
    // data is city-LOCAL meters — shift a copy into world coordinates so
    // every city, pasture and road coexists in the single world scene.
    const ax = (anchor && anchor.x) || 0, az = (anchor && anchor.z) || 0;
    cityAnchor = { x: ax, z: az };
    AX = ax; AZ = az;   // v2.27: every emitted vertex is city-local from here on
    cityRec = { ...cityData, ...cityMeta };
    group = new THREE.Group();
    const shift = pts => pts.map(p => [p[0] + ax, p[1] + az]);
    roads = cityData.roads.map(r => ({ ...r, pts: shift(r.pts) }));
    // v2.42 NEIGHBORHOODS: the suburb ring streets join the street list
    // BEFORE the dry-land clip below, so a shoreline trims them exactly
    // like any imported street (a ring crossing a bay comes back as dry
    // arcs, the asphalt pulled back from the waterline).
    if (!cityData.pasture) {
      try { roads.push(...addSuburbRoads(cityMeta, ax, az)); } catch (e) { console.error('[suburbroads]', e); }
    }
    buildingPolys = (cityData.buildings || []).map(b => ({ ...b, poly: shift(b.poly) }));
    let greensShift = (cityData.greens || []).map(g => ({ ...g, poly: shift(g.poly) }));
    const watersShift = (cityData.waters || []).map(g => ({ ...g, poly: shift(g.poly) }));
    // ---- v2.20 DRY LAND: the city forms AROUND its water ---------------
    // Streets stop BEFORE the waterline: each crossing is found by
    // bisection, then pulled back half a road width + verge so the
    // visible asphalt ends on dry ground. Roads are DENSIFIED to <=12 m
    // first — real OSM ways run hundreds of meters between two vertices,
    // and a straight segment used to jump clean across a bay or inlet
    // between two dry endpoints. Buildings and parks touching water are
    // dropped. Everything downstream — plots, cars, lamps, trees, hashes,
    // NPC routes — derives from these clipped lists, so nothing is left
    // standing in the water.
    if (LANDGEO.ready) {
      const wet = (x, z) => LANDGEO.isWaterWorld(x, z);
      const densify = (pts, step) => {         // no segment longer than step
        if (pts.length < 2) return pts.slice();
        const out = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.min(240, Math.floor(L / step));
          for (let k = 1; k <= n; k++) {
            const t = k / (n + 1);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          }
          out.push(b);
        }
        return out;
      };
      const shorePt = (p, q) => {              // boundary between wet p and dry q
        let a = p, b = q, wa = wet(p[0], p[1]);
        for (let k = 0; k < 9; k++) {
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (wet(m[0], m[1]) === wa) a = m; else b = m;
        }
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      };
      // shore point pulled back onto land by half a road width + verge,
      // so the asphalt stops before the water starts (never swallows
      // the interior point it pulls toward)
      const pulled = (shore, interior, w) => {
        const dx = interior[0] - shore[0], dz = interior[1] - shore[1];
        const L = Math.hypot(dx, dz) || 1;
        const m = Math.min(w / 2 + 2.5, L * .45);
        return [shore[0] + dx / L * m, shore[1] + dz / L * m];
      };
      const splitDry = pts => {                // maximal runs of dry points
        const out = [];
        let run = null;
        for (let i = 0; i < pts.length; i++) {
          if (!wet(pts[i][0], pts[i][1])) {
            if (!run) { run = { i0: i, pts: [] }; out.push(run); }
            run.pts.push(pts[i]);
          } else run = null;
        }
        return out;
      };
      const keptRoads = [];
      for (const r of roads) {
        const dp = densify(r.pts, 12);
        for (const seg of splitDry(dp)) {
          const out = seg.pts.slice();
          if (seg.i0 > 0) out.unshift(pulled(shorePt(dp[seg.i0 - 1], dp[seg.i0]), seg.pts[0], r.w));
          const iEnd = seg.i0 + seg.pts.length - 1;
          if (iEnd < dp.length - 1) out.push(pulled(shorePt(dp[iEnd], dp[iEnd + 1]), seg.pts[seg.pts.length - 1], r.w));
          if (out.length >= 2) {
            // v2.22: decimate back to real street-segment lengths (~44 m).
            // The 12 m densification above exists only for accurate
            // shoreline clipping — leaked into the road data it starved
            // every length-gated placer (vendor plots, lamps, cars,
            // hydrants, benches, trucks, fences), so nothing spawned.
            const dec = [out[0]];
            let acc2 = 0;
            for (let k = 1; k < out.length - 1; k++) {
              acc2 += Math.hypot(out[k][0] - dec[dec.length - 1][0], out[k][1] - dec[dec.length - 1][1]);
              if (acc2 >= 44) { dec.push(out[k]); acc2 = 0; }
            }
            dec.push(out[out.length - 1]);
            keptRoads.push({ ...r, pts: dec });
          }
        }
      }
      roads = keptRoads;
      const solid = poly => {                  // bbox corners + edge mids + centroid dry
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, cx = 0, cz = 0;
        for (const p of poly) {
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
          z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
          cx += p[0]; cz += p[1];
        }
        cx /= poly.length; cz /= poly.length;
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        return !wet(x0, z0) && !wet(x1, z0) && !wet(x1, z1) && !wet(x0, z1) &&
          !wet(mx, z0) && !wet(x1, mz) && !wet(mx, z1) && !wet(x0, mz) && !wet(cx, cz);
      };
      buildingPolys = buildingPolys.filter(b => solid(b.poly));
      greensShift = greensShift.filter(g => solid(g.poly));
    }
    // v2.63 ONE NETWORK — knot every road into one connected web before
    // anything downstream derives from the list (meshes, plots, houses,
    // NPC routes). Curved connectors only: they must stay dry and clear
    // of buildings, so nothing ever slices a wall or fords a bay.
    onStatus && onStatus('Knotting the road network…'); await _tick();
    let netRec = { added: 0, left: 0 };
    try { netRec = connectRoadNetwork(cityMeta, ax, az); } catch (e) { console.error('[netroads]', e); }
    if (netRec.added || netRec.left)
      console.log('[netroads] +' + netRec.added + ' connectors, ' + netRec.left + ' left isolated');
    const shifted = { ...cityData, ...cityMeta, roads, buildings: buildingPolys, greens: greensShift, waters: watersShift };
    suites = [];
    benchScratch = [];
    isMob = matchMedia('(pointer:coarse)').matches;

    // ---------- v2.14 — OPEN COUNTRY: the settle-anywhere pasture --------
    // No buildings, no skyline, no street grid: grass ground, country
    // lanes with gravel verges, hay fields, groves, ponds, barns, fences
    // — and the same roadside vendor-spot layer the cities have.
    // (v2.15: no gate signposts — the one world's real roads replaced them.)
    if (cityData.pasture) {
      group.add(shorePlate(ax, az, 1490, .012, getGrassTex()));
      onStatus && onStatus('Laying out the country roads…'); await _tick();
      buildRoads(shifted);
      onStatus && onStatus('Raising the barn…'); await _tick();
      buildPastureBarns(shifted);
      buildSpatialHash();          // rHash (roads) + barn walls — before plots
      onStatus && onStatus('Marking roadside spots…'); await _tick();
      buildPlots(shifted);
      onStatus && onStatus('Watering the fields…'); await _tick();
      buildGreensWater(shifted);  // pond only out here
      onStatus && onStatus('Growing the pastures…'); await _tick();
      buildProps(shifted);
      buildPastureExtras(shifted);
      buildHills();
      return group;
    }

    group.add(shorePlate(ax, az, 1490, .012, getGroundTex()));
    onStatus && onStatus('Laying out the street grid…'); await _tick();
    buildRoads(shifted);
    onStatus && onStatus('Raising ' + (cityData.buildings || []).length + ' buildings…'); await _tick();
    buildBuildings(shifted);
    onStatus && onStatus('Marking real estate…'); await _tick();
    buildPlots(shifted);          // before greens/props → trees & cars can avoid plots
    // v2.42: houses + neighborhoods around the city. Runs AFTER 'Marking
    // real estate…' on purpose — the v2.40/41 shell-capture window closes
    // on that status, so these meshes never receive the dollhouse planes.
    onStatus && onStatus('Building the neighborhoods…'); await _tick();
    buildSuburbs(shifted);        // houses register as buildings; hash rebuilt inside
    onStatus && onStatus('Planting parks…'); await _tick();
    buildGreensWater(shifted);
    onStatus && onStatus('Parking cars & street furniture…'); await _tick();
    buildProps(shifted);
    // v2.16 CLEAN HORIZON: no fake backdrop skyline — beyond the city's
    // ground plane the real one world (country, roads, distant cities)
    // takes over, exactly as the player asked.
    return group;
  }

  function dispose() {
    if (group) {
      const keep = [..._winTexs.filter(Boolean), _asphTex, _groundTex, _shopTex, _grassTex];
      group.traverse(o => {
        if (o.geometry && o.geometry !== undefined) { try { o.geometry.dispose(); } catch (e) { } }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => {
          if (m && m.map && !keep.includes(m.map) && m.map !== _dollarTex) { try { m.map.dispose(); } catch (e) { } }
          if (m && m !== _winMat) { try { m.dispose(); } catch (e) { } }
        });
      });
    }
    group = null; roads = []; plotRecs = []; suites = []; buildingPolys = []; benchScratch = []; pitchedRects = []; bHash = rHash = null; treeList = []; treeStats = null;
    gates = [];   // v2.14
    suburbRec = null; suburbGroup = null;   // v2.42
    cityRec = null; cityAnchor = null;   // v2.15: no stale city state after dispose
  }
  let _winMat = null;

  function nearestRoadName(x, z) {
    const { rd } = distToRoad(x, z);
    return rd && rd.name ? rd.name : '';
  }
  function pointOnRoad(x, z) {
    if (!rHash) return { x: 0, z: 0, rd: null, d: 1e9 };
    let best = 1e9, bx = 0, bz = 0, brd = null;
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      const arr = rHash.get((Math.floor(x / CELL) + gx) + ',' + (Math.floor(z / CELL) + gz));
      if (!arr) continue;
      for (const ri of new Set(arr)) {
        const rd = roads[ri];
        for (let i = 0; i < rd.pts.length - 1; i++) {
          const [ax, az] = rd.pts[i], [bx2, bz2] = rd.pts[i + 1];
          const dx = bx2 - ax, dz = bz2 - az, L2 = dx * dx + dz * dz || 1;
          let t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
          const px = ax + t * dx, pz = az + t * dz;
          const d = Math.hypot(x - px, z - pz);
          if (d < best) { best = d; bx = px; bz = pz; brd = rd; }
        }
      }
    }
    return { x: bx, z: bz, rd: brd, d: best };
  }
  function randomRoadPoint(rnd) {
    // v2.19: no roads at all (everything clipped off at a shoreline) ->
    // stand beside the anchor, which is on dry land — never at world
    // origin, which is open ocean on the real Earth.
    if (!roads.length) return { x: (cityAnchor ? cityAnchor.x : 0) + 24, z: (cityAnchor ? cityAnchor.z : 0), rd: null };
    const rd = roads[Math.floor(rnd() * roads.length)];
    const i = Math.floor(rnd() * (rd.pts.length - 1));
    const t = rnd();
    const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, rd };
  }
  function plotAt(x, z) {
    for (const p of plotRecs) {
      const dx = x - p.x, dz = z - p.z;
      // world→local: inverse of rotation.y=θ (local→world is lx·cosθ+lz·sinθ, -lx·sinθ+lz·cosθ)
      const c = Math.cos(p.rot), s = Math.sin(p.rot);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= p.w / 2 && Math.abs(lz) <= p.d / 2) return p;
    }
    return null;
  }

  return {
    build, dispose,
    get group() { return group; },
    get roads() { return roads; },
    get plots() { return plotRecs; },
    get suites() { return suites; },
    pointInBuilding, inPoly, distToRoad, roadsNear, nearestRoadName, pointOnRoad, randomRoadPoint, plotAt, setPlotOwned,
    gateAt, gateNear,          // v2.14: country gates (click / walk-in)
    get gates() { return gates; },   // v2.14
    get stats() { return buildStats; },
    get trees() { return treeList; },          // v2.07: final planted positions
    get treeStats() { return treeStats; },     // v2.07: {kept, dropped} road-clearance census
    get half() { return (cityRec && cityRec.half) || 720; },
    get rec() { return cityRec; },
    get anchor() { return cityAnchor; },
    get buildingPolys() { return buildingPolys; },   // v2.21: world-space, water-filtered — the dense-core spawn reads this
    get suburb() { return suburbRec; },              // v2.42: the neighborhood census (houses/verts/trees…)
    get suburbGroup() { return suburbGroup; },       // v2.42: distance-LOD host
  };
})();

window.CITY = CITY;

