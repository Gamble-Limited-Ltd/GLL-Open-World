// ====================================================================
// js/core.js — the shared land mask (LAND), coastline/lake geometry
// decoder (LANDGEO), world edges, land-corridor test, and the CITIES
// runtime enrichment (wx/wz + coastline slide) — Stage 6.
// ====================================================================
import { CITIES, DEG_M } from './config.js';

// ======== section: 10_core.js ========
// ======== section: 10_core.js ========
// ====================================================================
// v2.0 — CORE: config, state, save, HUD engine, city catalog
// ====================================================================


// ---------------- v2.14 — shared LAND mask + land corridor -------------
// The Natural Earth 1440x720 land mask (embedded by the build as
// window.__LAND_MASK_B64) decoded once into a bit array. v2.12 kept it in
// 20_earth.js; v2.14 moves it here so BOTH the globe (hover/settle) and the
// OSM layer (picking the road-connected cities for pasture gates) answer
// "is this lat/lon dry land?" from the same single source of truth.
export const LAND = (() => {
  const W = 1440, H = 720;
  let bits = null;
  function init() {
    if (bits) return true;
    const b64 = (typeof window !== 'undefined' && window.__LAND_MASK_B64) || '';
    if (!b64) return false;
    const bin = atob(b64);
    bits = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bits[i] = bin.charCodeAt(i);
    return true;
  }
  function at(lat, lon) {
    if (!init()) return true;              // no mask → never block anything
    let x = Math.floor(((lon + 180) / 360) * W); if (x < 0) x = 0; if (x >= W) x = W - 1;
    let y = Math.floor(((90 - lat) / 180) * H); if (y < 0) y = 0; if (y >= H) y = H - 1;
    const i = y * W + x;
    return ((bits[i >> 3] >> (7 - (i & 7))) & 1) === 1;
  }
  return { at, ok: init };
})();

// ---------------- v2.18 — EARTH GEOMETRY (coastlines, lakes, routes) --
// Natural Earth 110m land + lakes (public domain), quantized to int16 by
// the build and embedded next to the land mask. One decoder answers every
// "is this spot dry land, lake or ocean?" at world level and hands the
// world builder its rings.
export const LANDGEO = (() => {
  const rings = [], lakes = [], routes = [];
  let lakeBB = [], ringBB = [], coastMask = null;
  // v2.27 TRUE SCALE: the 1440x720 land raster has 0.25° cells — 27.8 km
  // at 1:1 — while the coastline MESH is built from these rings at ~1 km
  // resolution. Gating generation on the raster alone would put streets
  // tens of km out over a bay the player can clearly see. So: a boot-time
  // "coast proximity" bitmap (raster cells whose 3-cell neighborhood
  // touches any ring segment) splits every water question into a fast
  // raster opinion (open ocean / deep interior — where the raster cannot
  // be wrong) and the exact vector rings (near any coast — what the
  // player actually sees). Lakes were always vector-exact.
  const CM_R = 3;                       // coast-proximity stamp radius, cells
  let ringHash = new Map();             // 10° cell -> ring indices (bbox overlap)
  function buildCoastIndex() {
    ringBB = rings.map(ring => {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      return [x0, x1, y0, y1];
    });
    const RC = 10;                       // ring-hash cell, degrees
    ringHash = new Map();
    ringBB.forEach((b, ri) => {
      for (let gx = Math.floor(b[0] / RC); gx <= Math.floor(b[1] / RC); gx++)
        for (let gy = Math.floor(b[2] / RC); gy <= Math.floor(b[3] / RC); gy++) {
          const k = gx + ',' + gy;
          if (!ringHash.has(k)) ringHash.set(k, []);
          ringHash.get(k).push(ri);
        }
    });
    const W = 1440, H = 720;
    coastMask = new Uint8Array(W * H);
    const px = (lon, lat) => [Math.min(W - 1, Math.max(0, Math.floor((lon + 180) / 360 * W))),
      Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / 180 * H)))];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const [ax, ay] = px(a[0], a[1]), [bx, by] = px(b[0], b[1]);
        // stamp the segment's cell neighborhood (segments are short; the
        // bbox walk covers the segment itself)
        for (let gx = Math.min(ax, bx) - CM_R; gx <= Math.max(ax, bx) + CM_R; gx++)
          for (let gy = Math.min(ay, by) - CM_R; gy <= Math.max(ay, by) + CM_R; gy++)
            if (gx >= 0 && gx < W && gy >= 0 && gy < H) coastMask[gy * W + gx] = 1;
      }
    }
  }
  function dec(b64) {
    const bin = atob(b64);
    const dv = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
    return dv;
  }
  function init() {
    if (rings.length) return true;
    if (typeof window === 'undefined') return false;
    const lb = window.__LAND_GEO_B64, kb = window.__LAKE2_GEO_B64, rb = window.__ROAD_GEO_B64;
    if (!lb || !kb || !rb) return false;
    const dvL = dec(lb);
    const nL = window.__LAND_RING_N || [];
    let o = 0;
    for (const n of nL) {
      const ring = [];
      for (let i = 0; i < n; i++) {
        ring.push([dvL.getInt16(o, true) / 100, dvL.getInt16(o + 2, true) / 100]);  // [lon, lat]
        o += 4;
      }
      rings.push(ring);
    }
    const dvK = dec(kb);
    // v2.36 TRUE LAKES: anchor (/100) + per-point deltas (/1000 = 111 m)
    // — Natural Earth 10m outlines, real lake shapes at 1:1
    const metaK = window.__LAKE2_META_JSON || [];
    o = 0;
    for (const m of metaK) {
      const ring = [];
      const ax = dvK.getInt16(o, true) / 100, ay = dvK.getInt16(o + 2, true) / 100;
      o += 4;
      let cx = ax, cy = ay;
      for (let i = 0; i < m.n; i++) {
        cx += dvK.getInt16(o, true) / 1000;
        cy += dvK.getInt16(o + 2, true) / 1000;
        o += 4;
        ring.push([cx, cy]);
      }
      lakes.push({ name: m.name || 'Lake', ring });
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of ring) {
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      }
      lakeBB.push([x0, x1, y0, y1]);
    }
    const dvR = dec(rb);
    for (const r of (window.__ROADS_JSON || [])) {
      const pts = [];
      for (let i = 0; i < r.n; i++) {
        pts.push([dvR.getInt16((r.off + i) * 4, true) / 100, dvR.getInt16((r.off + i) * 4 + 2, true) / 100]);
      }
      routes.push({ a: r.a, b: r.b, bridge: !!r.br, pts });
    }
    buildCoastIndex();   // v2.27: vector coast truth for the 1:1 world
    return true;
  }
  function pipLL(ring, lon, lat) {          // ray cast over a [lon,lat] ring
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function isLakeLL(lat, lon) {
    if (!init()) return false;
    for (let i = 0; i < lakes.length; i++) {
      const b = lakeBB[i];
      if (lon < b[0] || lon > b[1] || lat < b[2] || lat > b[3]) continue;
      if (pipLL(lakes[i].ring, lon, lat)) return true;
    }
    return false;
  }
  function coastNearLL(lat, lon) {
    if (!coastMask) return false;
    const W = 1440, H = 720;
    let gx = Math.floor((lon + 180) / 360 * W); if (gx < 0) gx = 0; if (gx >= W) gx = W - 1;
    let gy = Math.floor((90 - lat) / 180 * H); if (gy < 0) gy = 0; if (gy >= H) gy = H - 1;
    return coastMask[gy * W + gx] === 1;
  }
  function landLL(lat, lon) {
    // exact point-in-ring, over only the rings whose bbox overlaps the
    // point's 10° hash cell (usually one or two)
    const arr = ringHash.get(Math.floor(lon / 10) + ',' + Math.floor(lat / 10));
    if (!arr) return false;
    for (const ri of arr) {
      const b = ringBB[ri];
      if (lon < b[0] || lon > b[1] || lat < b[2] || lat > b[3]) continue;
      if (pipLL(rings[ri], lon, lat)) return true;
    }
    return false;
  }
  function isWaterLL(lat, lon) {
    // v2.27 TRUE SCALE: near a coast the VECTOR rings decide — they are
    // the coast the player sees. Far from any coast the 0.25° raster
    // settles it (open ocean / deep interior — its half-cell error can't
    // matter there). Lakes stay vector-exact everywhere.
    if (!coastMask) return !LAND.at(lat, lon) || isLakeLL(lat, lon);
    if (!coastNearLL(lat, lon)) return !LAND.at(lat, lon) || isLakeLL(lat, lon);
    return !landLL(lat, lon) || isLakeLL(lat, lon);
  }
  function isWaterWorld(x, z) { return isWaterLL(-z / DEG_M, x / DEG_M); }
  // nearest dry land to a world point — spiral out in rings one land-raster
  // cell wide (v2.27: the step tracks DEG_M, so the snap travels the same
  // GEOGRAPHIC distance at any world scale — the shoreline a 550 m/° world
  // found 30 m away is the same shoreline 1:1 finds ~6 km away)
  function nearestLandWorld(x, z, maxR) {
    if (!isWaterWorld(x, z)) return { x, z };
    const STEP = DEG_M * 0.0545;
    const R = maxR || DEG_M * 1.64;
    for (let r = STEP; r <= R; r += STEP) {
      const n = Math.max(8, Math.round(6.2832 * r / STEP));
      for (let i = 0; i < n; i++) {
        const a = i / n * 6.2832;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (!isWaterWorld(px, pz)) return { x: px, z: pz };
      }
    }
    return null;
  }
  return { ok: init, rings, lakes, routes, isLakeLL, isWaterLL, isWaterWorld, nearestLandWorld, pipLL,
    get ready() { return rings.length > 0; } };
})();

// Straight great-circle corridor between two lat/lon points, sampled
// every ~0.4deg against the land mask (15km of give at each end so
// coastal cities keep their roads). Plain JS — no THREE — so the OSM
// module can use it for pasture gate placement.
export function landCorridorLL(lat1, lon1, lat2, lon2) {
  const v3 = (lat, lon) => {
    const phi = (lon + 180) * Math.PI / 180, th = (90 - lat) * Math.PI / 180;
    return [-Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th)];
  };
  const a = v3(lat1, lon1), b = v3(lat2, lon2);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const deg = Math.acos(dot) * 180 / Math.PI;
  const km = deg * 111.195;
  if (km > 9500) return false;            // beyond any land corridor
  const N = Math.max(16, Math.ceil(deg / .4));
  const skip = 15 / Math.max(1, km);      // roads reach the city's vicinity
  for (let i = 1; i < N; i++) {
    const t = i / N;
    if (t < skip || t > 1 - skip) continue;
    const qx = a[0] + (b[0] - a[0]) * t, qy = a[1] + (b[1] - a[1]) * t, qz = a[2] + (b[2] - a[2]) * t;
    const l = Math.hypot(qx, qy, qz) || 1;
    const lat = 90 - Math.acos(Math.max(-1, Math.min(1, qy / l))) * 180 / Math.PI;
    let lon = Math.atan2(qz / l, -qx / l) * 180 / Math.PI - 180;
    lon = ((lon + 540) % 360) - 180;
    if (!LAND.at(lat, lon)) return false;
  }
  return true;
}



CITIES.forEach(c => { c.wx = c.lon * DEG_M; c.wz = -c.lat * DEG_M; });
// ---- v2.19 SHORELINE CITIES -----------------------------------------
// A few catalog cities sit so close to their water that the exact
// coordinate lands IN it at this map's resolution (Toronto's center
// is inside Lake Ontario). Real cities sit ON the shore, hugging the
// water — so a wet anchor slides to the nearest dry land and stays
// there. Every other city keeps its true geographic spot untouched.
if (LANDGEO.ok()) CITIES.forEach(c => {
  if (LANDGEO.isWaterWorld(c.wx, c.wz)) {
    const nl = LANDGEO.nearestLandWorld(c.wx, c.wz, DEG_M * 4.73);
    if (nl) { c.wx = nl.x; c.wz = nl.z; }
  }
});

// inter-city roads (v2.18): REAL land routes — every road was A*-routed
// across the planet's actual coastlines at build time, so it follows dry
// land around seas and lakes; island cities are joined by straight sea
// bridges (br:1). Decoded from __ROAD_GEO_B64 by LANDGEO below.
export const WORLD_EDGES = (() => {
  if (!LANDGEO.ok()) return [];
  return LANDGEO.routes.map(r => ({ a: r.a, b: r.b, bridge: r.bridge, ll: r.pts }));
})();









