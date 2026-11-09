// ====================================================================
// js/world/world.js — the ONE WORLD scene (Stage 6): terrain
// chunks, street streaming, plots. camCtl (command-camera state,
// a fixed literal with no earlier reads) moved here from 90_main.
// CITY is late-bound below (bound by boot before any interaction).
// ====================================================================
import * as THREE from 'three';
import { CITIES, DEG_M, ECON, WORLD_BOUNDS, WORLD_CONTS } from '../config.js';
import { _mulberry, hashStr, worldAnchorOf, cityDNA } from '../util.js';
import { STATE } from '../state.js';
import { LANDGEO, WORLD_EDGES } from '../core.js';
import { OSM } from '../world/osm.js';

// ---- late binding (boot binds after every module evaluates) --------
export let CITY;
export function __late(b) { ({ CITY } = b); }

// ======== section: 35_world.js ========
// ====================================================================
// v2.16 — WORLD: ONE continuous world. Every city, pasture, and road
// lives in a single scene at fixed world coordinates — you can walk
// from any point on the map to any other. Contains: the world ground,
// walkable inter-city country roads, procedural pastures (tree groves,
// fenced paddocks with cows & sheep, barns, hay bales, rocks, ponds,
// wildflower meadows), cheap rural business plots along the roads,
// city-chunk streaming, and the lat/lon → world mapping used for globe
// landings. (v2.16 CLEAN HORIZON: the fake distant-city skylines and
// the floating city-name / continent letter banners are GONE — the
// horizon now shows only what is really there; a tiny green beacon
// still marks cities where you own land.)
// ====================================================================

export const WORLD = (() => {
  const CH = 500;                    // pasture chunk size (m)
  const CITY_R = 745;                // city import extent radius
  const BUILD_DIST = 950;            // detailed city streams in
  const LEAVE_DIST = 2900;           // v2.42 base: streams out past the suburb ring (was 1250)
                                     // v2.65 CITY DNA: the LIVE leave distance is the active
                                     // city's own suburb edge + 540 (cityDNA(meta).subR1),
                                     // so a wide metro keeps standing while you cross its burbs
  // v2.65: distance past the nearest catalog city's suburb edge — the
  // per-city replacement for every flat `CITY_R + const` world gate
  const subEdge = c => cityDNA(c).subR1;
  const pastEdge = (x, z) => {
    const n = distToCity(x, z);
    return n.city ? n.d - subEdge(n.city) : n.d;
  };
  // v2.29 REAL JUNCTIONS: inter-city roads end at the first street of
  // the city they serve, not at the anchor. The last TAIL_CAP meters
  // of every land route before each city are a re-trimmable TAIL (a
  // per-end group) instead of baked tile ribbons, so the road's end
  // can follow whatever stands at the city right now — the distant
  // skyline's ×10 sprawl streets or the imported city's true streets.
  // 10.5 km covers the whole skyline approach (streets reach ±7.2 km,
  // corner-diagonal ~10.2 km). Bridges keep their near-full span (a
  // trimmed deck strands in open water — v2.22).
  const TAIL_CAP = 10500;
  // v2.30: the ribbon stack sits ABOVE every flat ground layer it can
  // meet at true scale — the land shield (y 0, ±4 cm grid depth error;
  // −.10 under the fine city pads), the city plate (.012, on the exact
  // pad), beaches (.07–.083) and the skyline plates (.05) — and BELOW
  // the sidewalk stack (.16), vendor plots (.105) and buildings.
  // v2.38: lakes (.8) now ride far ABOVE the ribbons — no road ever
  // crosses a lake (routes are water-gated; the 61 baked routes were
  // audited: zero lake-ring crossings), so the two never meet.
  const ROAD_Y = .095, SHOL_Y = .09, DASH_Y = .098;
  // v2.37 FLAT-GROUND LADDER: zooming to 23,000 km makes the log-depth
  // buffer resolve only ~12-23 m — every cm-scale gap below rounds to a
  // tie, so each flat layer now carries an explicit renderOrder that
  // matches its physical height (ocean 0 < shelf .5 < land 1 < belt 1.5
  // < city plate 1.6 < skyline 2 < beach 2.5 < lake 3 < rim 3.5 < road 4
  // < marks 4.2). Ties break toward the physically-higher surface at
  // every zoom; real gaps still win by depth where they resolve.
  // v2.38 exception: the lake PLANE sits at .8 (depth separation — see
  // LAKE_Y) but keeps ladder slot 3 — no higher layer ever overlaps a
  // lake (roads and rims are water-gated or submerged), so the order
  // holds.
  const RO_SHELF = .5, RO_LAND = 1, RO_BELT = 1.5, RO_PLATE = 1.6,
        RO_SKY = 2, RO_BEACH = 2.5, RO_LAKE = 3, RO_RIM = 3.5,
        RO_ROAD = 4, RO_MARK = 4.2;
  // v2.29: a junction tail's last meters ramp down onto the city's
  // street asphalt (y .030–.038 by class) — .046 clears every class by
  // ≥8 mm (the city's own curb/plate stack proves 8 mm safe in the
  // anchor-local frame) and stays ~11 cm under the sidewalks (.16).
  const TAIL_TAPER = 25, TAIL_STREET_Y = .046;
  // shared ribbon materials (tile ribbons + re-trimmable tails)
  let _roadMat = null, _markMat = null, _pylMat = null;
  const roadMatShared = () => _roadMat || (_roadMat = new THREE.MeshLambertMaterial({ map: ruralRoadTexture(), vertexColors: true }));
  const markMatShared = () => _markMat || (_markMat = new THREE.MeshLambertMaterial({ vertexColors: true }));
  const pylMatShared = () => _pylMat || (_pylMat = new THREE.MeshLambertMaterial({ color: 0x9aa2a9 }));
  const isMob = matchMedia('(pointer:coarse)').matches;
  const CHUNK_R = isMob ? 750 : 1050;

  let scene = null, group = null;
  let inited = false;
  let activeCity = null;             // { key, meta, anchor }
  let pendingCity = null;            // suppress re-requests while fetching
  let edges = [];                    // runtime edge recs
  let roadHash = new Map();          // cell -> [ax,az,bx,bz] road segments (v2.27)
  // v2.27: 1 km cells hold road SEGMENTS (rasterized along their length)
  // — at true scale poly points sit ~2.6 km apart, so point hashing
  // would miss the road between them. nearRoad does exact
  // point-to-segment distance over the 3×3 neighborhood.
  const RCELL = 1024;
  let chunks = new Map();            // 'cx,cz' -> group
  let chunkQueue = [];
  let markers = new Map();           // cityKey -> {group, dot} (owned beacon)
  let lastMarkerUpd = 0, lastChunkUpd = 0;
  let curRegion = 'rural';         // economy region key the player is in

  // ---------------- helpers -------------------------------------------
  const col = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  function distToCity(x, z) {
    let best = 1e9, bc = null;
    for (const c of CITIES) { const d = Math.hypot(x - c.wx, z - c.wz); if (d < best) { best = d; bc = c; } }
    return { d: best, city: bc };
  }
  function bez(A, C, B, t) {
    const u = 1 - t;
    return [u * u * A[0] + 2 * t * u * C[0] + t * t * B[0], u * u * A[1] + 2 * t * u * C[1] + t * t * B[1]];
  }

  // ---------------- textures ------------------------------------------
  let _grassTex = null;
  // v2.32 GREEN RIFT: the open land between cities is GRASS again — the
  // CR reference's world shots are mid olive-green (#6e8b4c..#708e4c in
  // pixel truth), flat and low-contrast up close, with light/dark green
  // patches that keep the land readable when zoomed far out.
  function grassTexture() {
    if (_grassTex) return _grassTex;
    // v2.35 GREEN PASTURES: the user's call — "I just want it to be
    // green pastures and blue lakes". The v2.33/34 base #6d8c49 was an
    // OLIVE (G-R = 31) that read khaki next to the old teal water; the
    // new base #58913c is a true fresh green (G-R = 57) in CR's own
    // land-plot family (#54783c..#6c8448) but greener, with the same
    // HIGH-CONTRAST three-scale mottle that survives multi-km zoom, on a
    // 1024px canvas over 184 m, plus warm tan flecks for dry-grass
    // micro-variation.
    const cv = document.createElement('canvas'); cv.width = cv.height = 1024;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#58913c'; ctx.fillRect(0, 0, 1024, 1024);
    const rnd = _mulberry(4321);
    // large organic blotches (~5-19 m): the far-zoom mottle
    for (let i = 0; i < 130; i++) {
      ctx.fillStyle = rnd() < .5
        ? `rgba(38,74,24,${.24 + rnd() * .16})`
        : `rgba(124,178,84,${.22 + rnd() * .15})`;
      ctx.beginPath();
      const bx = rnd() * 1024, by = rnd() * 1024, r0 = 28 + rnd() * 32, r1 = r0 * (1.4 + rnd() * .9);
      for (let a = 0; a <= 12; a++) {
        const th = a / 12 * 6.2832, rr = r0 + (r1 - r0) * (.5 + .5 * Math.sin(th * 3 + rnd() * 6));
        const px = bx + Math.cos(th) * rr, py = by + Math.sin(th) * rr;
        a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
    // medium patches (~1.2-5 m): the mid-zoom texture
    for (let i = 0; i < 1900; i++) {
      ctx.fillStyle = rnd() < .5
        ? `rgba(34,66,22,${.16 + rnd() * .18})`
        : `rgba(140,194,98,${.14 + rnd() * .16})`;
      ctx.beginPath();
      ctx.arc(rnd() * 1024, rnd() * 1024, 6 + rnd() * 18, 0, 6.29); ctx.fill();
    }
    // warm flecks (~0.3-1 m): CR's dry-grass micro-variation
    for (let i = 0; i < 340; i++) {
      ctx.fillStyle = rnd() < .6
        ? `rgba(138,122,66,${.12 + rnd() * .14})`
        : `rgba(168,152,88,${.10 + rnd() * .12})`;
      ctx.beginPath();
      ctx.arc(rnd() * 1024, rnd() * 1024, 2 + rnd() * 4, 0, 6.29); ctx.fill();
    }
    // fine grain (~10-40 cm): the near-field stipple
    for (let i = 0; i < 5200; i++) {
      ctx.fillStyle = rnd() < .5
        ? `rgba(24,50,16,${.10 + rnd() * .14})`
        : `rgba(146,202,106,${.10 + rnd() * .13})`;
      ctx.fillRect(rnd() * 1024, rnd() * 1024, 1 + rnd() * 2.4, 1 + rnd() * 2.4);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    _grassTex = t;
    return t;
  }
  let _ruralTex = null;
  // v2.32: darker near-black asphalt (CR roads read by VALUE contrast:
  // near-black band on bright grass), speckle kept subtle
  function ruralRoadTexture() {
    if (_ruralTex) return _ruralTex;
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#333230'; ctx.fillRect(0, 0, 128, 128);
    const rnd = _mulberry(777);
    for (let i = 0; i < 900; i++) {
      const v = 44 + rnd() * 40;
      ctx.fillStyle = `rgba(${v},${v - 2},${v - 6},${.25 + rnd() * .3})`;
      ctx.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    _ruralTex = t;
    return t;
  }

  // ---------------- merged-geometry builder ---------------------------
  // v2.27: optional (ox, oz) builds the merged geometry in a LOCAL frame
  // around that origin (float32-safe at 1:1 world scale); the caller
  // positions the returned mesh at (ox, 0, oz).
  const _nm3 = new THREE.Matrix3(), _v3a = new THREE.Vector3(), _v3b = new THREE.Vector3();
  const _mShift = new THREE.Matrix4();
  function GeoBuilder(ox, oz) {
    const off = (ox || 0) !== 0 || (oz || 0) !== 0;
    if (off) _mShift.makeTranslation(-(ox || 0), 0, -(oz || 0));
    const pos = [], norm = [], uv = [], colr = [];
    function addGeo(geo, mat4, color) {
      const p = geo.attributes.position, n = geo.attributes.normal, u = geo.attributes.uv;
      const idx = geo.index ? geo.index.array : null;
      const count = idx ? idx.length : p.count;
      _nm3.getNormalMatrix(mat4);
      const c = Array.isArray(color) ? color : col(color);
      for (let i = 0; i < count; i++) {
        const vi = idx ? idx[i] : i;
        _v3a.fromBufferAttribute(p, vi).applyMatrix4(mat4);
        if (off) _v3a.applyMatrix4(_mShift);
        _v3b.fromBufferAttribute(n, vi).applyMatrix3(_nm3).normalize();
        pos.push(_v3a.x, _v3a.y, _v3a.z);
        norm.push(_v3b.x, _v3b.y, _v3b.z);
        if (u) uv.push(u.getX(vi), u.getY(vi)); else uv.push(0, 0);
        colr.push(c[0], c[1], c[2]);
      }
    }
    function mesh() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      if (off) m.position.set(ox, 0, oz);   // v2.27: chunk-local frame
      m.castShadow = true; m.receiveShadow = true;
      return m;
    }
    return { addGeo, mesh, get count() { return pos.length / 3; } };
  }
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s3 = new THREE.Vector3();
  function trs(x, y, z, ry, sx, sy, sz, rx, rz) {
    _e.set(rx || 0, ry || 0, rz || 0);
    _q.setFromEuler(_e);
    return _m4.compose(_s3.set(x, y, z), _q, new THREE.Vector3(sx, sy, sz)).clone();
  }

  // ---------------- v2.18 ground: THE REAL EARTH -----------------------
  // Oceans, continents and lakes are the actual planet: one sea-level
  // water plane across the whole map, Natural Earth coastlines raised as
  // flat land shields with sandy skirts down past the waterline, and the
  // great lakes inset into the land. Cities, roads and pastures sit on
  // top at their true geographic coordinates.
  let _seaTex = null;
  // v2.35 BLUE LAKES: the ocean is flat CLEAN BLUE (#3479bd — the same
  // family as the orbit globe's own #2C7BB9 ocean, so the planet reads
  // blue from orbit AND at street level — the old teal read as 'green and
  // light blue mixed' in the user's Lake Michigan shot), wave-free glass
  // with a whisper of streak, light-blue shallow shelves along the coasts
  function seaTexture() {
    if (_seaTex) return _seaTex;
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#3479bd'; ctx.fillRect(0, 0, 256, 256);
    const rnd = _mulberry(4242);
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = 'rgba(255,255,255,' + (.03 + rnd() * .04) + ')';
      ctx.fillRect(rnd() * 256, rnd() * 256, 3 + rnd() * 9, 1 + rnd() * 2);
    }
    for (let i = 0; i < 800; i++) {
      ctx.fillStyle = 'rgba(8,38,80,' + (.05 + rnd() * .06) + ')';
      ctx.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 6, 1 + rnd() * 2);
    }
    // v2.33: soft open-water tonal drift — wide low-alpha bands so the
    // far ocean keeps gentle variation without reading as noise
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = rnd() < .5 ? 'rgba(18,52,104,.08)' : 'rgba(84,138,196,.07)';
      ctx.beginPath();
      ctx.ellipse(rnd() * 256, rnd() * 256, 30 + rnd() * 60, 10 + rnd() * 24, rnd() * 3, 0, 6.29); ctx.fill();
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    _seaTex = t;
    return t;
  }
  // ---------------- v2.27 TRUE SCALE: world tiles ------------------------
  // At 1:1 the world spans ±20 million meters — far past float32 vertex
  // precision — so the static planet builds as 8°×8° tiles (889 km each).
  // Every tile's geometry is TILE-LOCAL (|coords| ≤ ~460 km → centimeter
  // exact in float32) and the tile group carries the tile's absolute
  // position in double precision, where three.js keeps its matrices.
  // Coasts, lakes, rural roads, bridges and guard pylons all stream into
  // the tiles they pass through; buildEdges fills t.road/t.mark/t.pyl
  // after buildGround fills the land, then finalizeTiles() makes meshes.
  const TILE_DEG = 8;
  const tiles = new Map();       // 'tx,tz' -> tile record
  function tileRec(tx, tz) {
    const key = tx + ',' + tz;
    let t = tiles.get(key);
    if (t) return t;
    const clon = -180 + (tx + .5) * TILE_DEG, clat = 90 - (tz + .5) * TILE_DEG;
    t = {
      g: new THREE.Group(),
      ox: clon * DEG_M, oz: -clat * DEG_M,   // tile center, world meters (doubles)
      sk: { pos: [], norm: [], uv: [], col: [] },
      bh: { pos: [], col: [] }, sh: { pos: [], col: [] }, rm: { pos: [], col: [] },
      road: { pos: [], norm: [], uv: [], col: [] },
      mark: { pos: [], norm: [], uv: [], col: [] },
      pyl: [],
    };
    t.g.position.set(t.ox, 0, t.oz);
    group.add(t.g);
    tiles.set(key, t);
    return t;
  }
  function tileOfLL(lon, lat) {
    const tx = Math.min(44, Math.max(0, Math.floor((lon + 180) / TILE_DEG)));
    const tz = Math.min(22, Math.max(0, Math.floor((90 - lat) / TILE_DEG)));
    return [tx, tz];
  }
  // Sutherland–Hodgman: clip a [lon,lat] ring to a tile rectangle
  function clipRing(ring, lon0, lon1, lat0, lat1) {
    let pts = ring;
    const planes = [
      [p => p[0] >= lon0, (a, b) => [lon0, a[1] + (b[1] - a[1]) * (lon0 - a[0]) / (b[0] - a[0])]],
      [p => p[0] <= lon1, (a, b) => [lon1, a[1] + (b[1] - a[1]) * (lon1 - a[0]) / (b[0] - a[0])]],
      [p => p[1] >= lat0, (a, b) => [a[0] + (b[0] - a[0]) * (lat0 - a[1]) / (b[1] - a[1]), lat0]],
      [p => p[1] <= lat1, (a, b) => [a[0] + (b[0] - a[0]) * (lat1 - a[1]) / (b[1] - a[1]), lat1]],
    ];
    for (const [inside, xing] of planes) {
      if (pts.length < 3) return [];
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const cur = pts[i], nxt = pts[(i + 1) % pts.length];
        const ci = inside(cur), ni = inside(nxt);
        if (ci) out.push(cur);
        if (ci !== ni) out.push(xing(cur, nxt));
      }
      pts = out;
    }
    return pts.length >= 3 ? pts : [];
  }
  function ringTiles(ring) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const [tx0, tz0] = tileOfLL(x0, y1), [tx1, tz1] = tileOfLL(x1, y0);
    const out = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) out.push([tx, tz]);
    return out;
  }
  function finalizeTiles() {
    const skirtMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const beachMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const shelfMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const roadMat = roadMatShared();   // v2.29: shared with the re-trimmable tails
    const markMat = markMatShared();
    const pylGeo = new THREE.BoxGeometry(1.25, 3.9, 1.25);
    const pylMat = pylMatShared();
    const fullMesh = (t, arr, mat, order = 0) => {   // pos + norm + uv + col
      if (!arr.pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.renderOrder = order;   // v2.37 flat-ground ladder
      t.g.add(m);
    };
    const flatMesh = (t, arr, mat, order = 0) => {   // pos + col only, normals up
      if (!arr.pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.pos.map((_, i) => i % 3 === 1 ? 1 : 0), 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.renderOrder = order;   // v2.37 flat-ground ladder
      t.g.add(m);
    };
    tiles.forEach(t => {
      fullMesh(t, t.sk, skirtMat);
      flatMesh(t, t.bh, beachMat, RO_BEACH);
      flatMesh(t, t.sh, shelfMat, RO_SHELF);
      flatMesh(t, t.rm, rimMat, RO_RIM);
      fullMesh(t, t.road, roadMat, RO_ROAD);
      fullMesh(t, t.mark, markMat, RO_MARK);
      if (t.pyl.length) {
        const inst = new THREE.InstancedMesh(pylGeo, pylMat, t.pyl.length);
        const m4 = new THREE.Matrix4();
        t.pyl.forEach((p, i) => { m4.makeTranslation(p[0], -1.55, p[1]); inst.setMatrixAt(i, m4); });
        inst.receiveShadow = true;
        t.g.add(inst);
      }
      t.sk = t.bh = t.sh = t.rm = t.road = t.mark = t.pyl = null;   // build arrays freed
    });
  }
  function buildGround() {
    if (!LANDGEO.ok()) { buildGroundFlat(); return; }
    const WB = WORLD_BOUNDS;
    const W = WB.x1 - WB.x0, H = WB.z1 - WB.z0;
    const cx = (WB.x0 + WB.x1) / 2, cz = (WB.z0 + WB.z1) / 2;
    // ---- the ocean: one plane over the whole planet, a step below land --
    // (v2.27: a UNIT plane scaled in the transform — the vertex buffer
    // stays exactly representable in float32 at true world scale)
    const sea = seaTexture();
    sea.repeat.set(W / 64, H / 64);
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshLambertMaterial({ map: sea, color: 0xffffff }));   // v2.32: teal-blue sea, unfiltered
    ocean.rotation.x = -Math.PI / 2;
    ocean.scale.set(W, 1, H);
    ocean.position.set(cx, -1.35, cz);
    group.add(ocean);
    // ---- the land: coastlines as flat shields at y = 0 ------------------
    // v2.30 STABLE GROUND: the land of each tile is emitted as a 16×16 grid
    // of CELL polygons, not one ShapeGeometry per tile. A full-tile quad is
    // two 890 km triangles, and the GPU's perspective interpolation of the
    // logarithmic-depth varying across a triangle that size is only good to
    // a meter or two — every centimeter-scale layer riding the shield (the
    // 12 mm city plate, the 3–4 cm street asphalt, the 9.5 cm inter-city
    // road tails) lost whole patches to that noise: grass bled through
    // city floors in green z-fight stripes and the roads vanished for 10 km
    // past every town. 55 km cells cut the error to ~4 cm; the ±12 km
    // around every city rides the EXACT fine city pad (see buildCityPads),
    // and the coarse cells touching a city zone step down to −10 cm so
    // nothing under the pad can poke through it.
    const tex = grassTexture();
    tex.repeat.set(1 / 184, 1 / 184);   // v2.33: 1024px canvas over 184 m — same feature scale, half the repeat frequency (no wallpaper read)
    const landMat = new THREE.MeshLambertMaterial({
      map: tex, side: THREE.DoubleSide, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    // triangulate a [lon,lat] polygon into tile-local flat-up triangles
    // appended to buf {pos,norm,uv,col} at height y (exact ShapeGeometry-equivalent)
    // v2.33 NaN GUARD: 794 tile meshes shipped with NaN positions (degenerate
    // clips at tile/bounds edges → NaN bounding spheres → whole tiles culled
    // INVISIBLE — invisible chunks of the planet). Any non-finite vertex now
    // drops that triangle; a buffer that ends up empty is skipped entirely.
    const landTri = (t, poly, y, buf, tint) => {
      if (poly.length < 3) return;
      const pts = poly.map(p => [p[0] * DEG_M - t.ox, p[1] * DEG_M + t.oz]);
      const shape = new THREE.Shape();
      for (let i = 0; i < pts.length; i++) {
        if (!isFinite(pts[i][0]) || !isFinite(pts[i][1])) return;   // NaN guard
        if (i) shape.lineTo(pts[i][0], pts[i][1]); else shape.moveTo(pts[i][0], pts[i][1]);
      }
      const g = new THREE.ShapeGeometry(shape);
      const pa = g.attributes.position, ua = g.attributes.uv;
      // v2.36 INDEXED-GEOMETRY FIX — THE original lake-hole bug, present
      // since the Earth rewrite: ShapeGeometry returns an INDEXED geometry
      // (unique contour vertices + an index buffer of triangles), but this
      // loop used to walk position.count in steps of 3 as if it were a
      // flat triangle soup — so every polygon over 3 vertices kept ONLY
      // ITS FIRST TRIANGLE and silently dropped the rest. Coast fragments
      // and lake fragments have been rendering ~1/3 of their area all
      // along (the land survived on its whole-cell top-ups; the lakes
      // showed grass through the holes — "green in the lake" since v2.18).
      // Walk the INDEX buffer instead.
      const idx = g.index;
      const nTri = idx ? idx.count / 3 : pa.count / 3;
      // v2.32 UP-FACING TERRAIN: Natural Earth rings wind both ways and the
      // shape→world z-flip mirrors them, so most land cells and lake
      // surfaces triangulated DOWN-facing (85% of land triangles, 88% of
      // lake triangles). DoubleSide kept them visible but flipped their
      // normals to (0,-1,0) — the surface lost the sun AND the sky light
      // and rendered ~35% dark (the murky land / dark lake look since the
      // Earth rewrite). Guarantee every triangle faces UP here.
      for (let k = 0; k < nTri; k++) {
        const i = idx ? idx.getX(k * 3) : k * 3;
        const i1 = idx ? idx.getX(k * 3 + 1) : k * 3 + 1;
        const i2 = idx ? idx.getX(k * 3 + 2) : k * 3 + 2;
        const x0 = pa.getX(i), y0 = pa.getY(i);
        if (!isFinite(x0) || !isFinite(y0) ||
          !isFinite(pa.getX(i1)) || !isFinite(pa.getY(i1)) ||
          !isFinite(pa.getX(i2)) || !isFinite(pa.getY(i2))) continue;   // NaN guard
        const ny = (-pa.getY(i1) + y0) * (pa.getX(i2) - x0)
                 - (pa.getX(i1) - x0) * (-pa.getY(i2) + y0);
        const ord = ny < 0 ? [i, i2, i1] : [i, i1, i2];
        for (const j of ord) {
          // shape (x,y,0) -> tile-local world (x, y=height, -y=z)
          buf.pos.push(pa.getX(j), y, -pa.getY(j));
          buf.norm.push(0, 1, 0);
          buf.uv.push(ua.getX(j), ua.getY(j));
          buf.col.push(tint[0], tint[1], tint[2]);
        }
      }
      g.dispose();
    };
    // does this cell rect (lon/lat) come within a city's ±12 km fine pad?
    // (half a 55 km cell of slack — the drop must cover the pad's edge)
    const nearCityZone = (cLon0, cLat0, cLon1, cLat1) => {
      const mx = (cLon0 + cLon1) / 2 * DEG_M, mz = -(cLat0 + cLat1) / 2 * DEG_M;
      for (const c of CITIES) {
        if (Math.abs(mx - c.wx) < 12000 + 28000 && Math.abs(mz - c.wz) < 12000 + 28000) return true;
      }
      return false;
    };
    const cTop = col(0x58913c), cBot = col(0x27527f);   // v2.35: pasture-green edge → deep blue bank (matches the new grass + blue water)
    const SEA = -3.4;
    const cBeach = col(0xd8d1bc), cShelf = col(0x9ac6ea);   // v2.35: pale sand fringe + light-blue shallows (no aqua/green in the water family)
    // v2.33 INTERIOR LAND FILL: clipRing only produces geometry where the
    // RING passes through a cell — every INTERIOR cell of a continent (no
    // coastline inside it) clipped to nothing and was skipped, so the world
    // rendered only coastal fringes + city pads and the continental interior
    // fell through to the ocean plane. That was the real "the world looks
    // terrible" root cause. When the ring never crosses a cell, the cell is
    // entirely inside or entirely outside the continent — the land
    // classifier (vector-exact near coasts, raster in the deep interior)
    // settles it, and an inside cell fills its whole rectangle.
    const fillCell = (t, c0, c1, d0, d1, y, buf, tint) => {
      const x0 = c0 * DEG_M - t.ox, x1 = c1 * DEG_M - t.ox;
      const ya = d0 * DEG_M + t.oz, yb = d1 * DEG_M + t.oz;   // shape space (y = -world z)
      const Q = [[x0, ya], [x1, ya], [x1, yb], [x0, yb]];
      for (const tri of [[0, 1, 2], [0, 2, 3]]) for (const k of tri) {
        buf.pos.push(Q[k][0], y, -Q[k][1]);
        buf.norm.push(0, 1, 0);
        buf.uv.push(Q[k][0], Q[k][1]);
        buf.col.push(tint[0], tint[1], tint[2]);
      }
    };
    const LG_N = 16;
    const interiorFilled = new Set();   // 'tx,tz,i,j' — one whole-cell fill per cell across ALL rings
    // ---- v2.38 LAND VS LAKE: no land under the water, at any zoom --------
    // The land rings are outer-contour only — lake interiors are "land" to
    // the ring clipper (the cell lies inside the continent polygon), so
    // every land cell touching a lake emitted a full fragment of grass
    // UNDER the water. At street zoom the opaque lake plane at .8 m covers
    // it, but a 55 km land cell's log-depth interpolation error grows into
    // METERS by a few hundred km of altitude — past any separation the
    // lake could physically ride at — and grass bled back through the
    // water exactly in the 100–2000 km band the v2.37 zoom opens
    // (measured: half of Lake Michigan's deep-interior points render
    // pasture green at 300 km while a raycast puts blue water closest
    // along the same ray; hiding the land turns every one of them blue).
    // The only ordering that holds at EVERY altitude: the water is the
    // ONLY surface there. Cells that touch a lake's bbox now build from
    // the lake's own boot-time raster on a 6.9 km → 860 m → 215 m grid —
    // fully-wet rects are simply not emitted, dry rects fill, and
    // ocean-coast rects (dual-coast cells like Nicaragua's) keep the
    // exact ring fragment at the subrect scale.
    const lakeRaster = lk => {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of lk.ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const res = lk.ring.length < 200 ? .016 : .004;   // coarse rings (the Caspian's 110m) get a matching grid
      const w = Math.ceil((x1 - x0) / res) + 2, h = Math.ceil((y1 - y0) / res) + 2;
      const bits = new Uint8Array((w * h + 7) >> 3);
      for (let j = 0; j < h; j++) {
        const la = y0 + (j + .5) * res;
        const xs = [];
        for (let i = 0; i < lk.ring.length; i++) {
          const a = lk.ring[i], b = lk.ring[(i + 1) % lk.ring.length];
          if ((a[1] > la) !== (b[1] > la)) xs.push(a[0] + (b[0] - a[0]) * (la - a[1]) / (b[1] - a[1]));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const ia = Math.max(0, Math.ceil((xs[k] - x0) / res - .5));
          const ib = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / res - .5));
          for (let i = ia; i <= ib; i++) { const idx = j * w + i; bits[idx >> 3] |= 128 >> (idx & 7); }
        }
      }
      return { res, x0, y0, w, h, bits };
    };
    const lakeBBs = [], lakeRasByLk = new Map();
    for (const lk of LANDGEO.lakes) {
      if (lk.ring.length < 4) continue;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of lk.ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const ras = lakeRaster(lk);
      lakeBBs.push([x0, x1, y0, y1, ras]);
      lakeRasByLk.set(lk, ras);
    }
    const lakesHit = (c0, d0, c1, d1) => {
      // v2.38: +0.55° MARGIN — the 55 km whole-cell fills in the cells JUST
      // past a lake's bbox are the biggest triangles in the world, and at
      // far zoom their oblique screen footprint + log-depth error bleeds
      // green up to ~10 km back over the water (the Muskegon band). Those
      // cells take the grid too.
      // v2.38b: returns EVERY lake whose margined bbox hits the cell — a
      // straits cell (Michigan + Huron + Superior all nearby) must census
      // against the UNION, or the first lake's raster silently calls the
      // other lake's open water "dry" and fills it green (the Straits of
      // Mackinac regression).
      const M = .55, out = [];
      for (const e of lakeBBs) if (!(c1 < e[0] - M || c0 > e[1] + M || d1 < e[2] - M || d0 > e[3] + M)) out.push(e);
      return out;
    };
    // census of lake-raster cells (UNION over the hit lakes) in [a0,a1]x[b0,b1]
    const rasCensus = (Es, a0, a1, b0, b1) => {
      let wet = 0, tot = 0;
      for (const e of Es) {
        const r = e[4];
        const i0 = Math.max(0, Math.ceil((a0 - r.x0) / r.res - .5)), i1 = Math.min(r.w - 1, Math.floor((a1 - r.x0) / r.res - .5));
        const j0 = Math.max(0, Math.ceil((b0 - r.y0) / r.res - .5)), j1 = Math.min(r.h - 1, Math.floor((b1 - r.y0) / r.res - .5));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const idx = j * r.w + i;
          tot++; if (r.bits[idx >> 3] & (128 >> (idx & 7))) wet++;
        }
      }
      return { wet, tot };
    };
    const emitLakeCell = (t, c0, c1, d0, d1, y0, tint, buf, Es, poly, bx0, bx1, bz0, bz1, cellKey) => {
      const dry5 = (a0, a1, b0, b1) => {
        const m = (b0 + b1) / 2, mm = (a0 + a1) / 2;
        return !LANDGEO.isWaterLL(m, mm) && !LANDGEO.isWaterLL(b0, a0) && !LANDGEO.isWaterLL(b0, a1) &&
          !LANDGEO.isWaterLL(b1, a0) && !LANDGEO.isWaterLL(b1, a1);
      };
      const centerDry = (a0, a1, b0, b1) => !LANDGEO.isWaterLL((b0 + b1) / 2, (a0 + a1) / 2);
      for (let si = 0; si < 8; si++) for (let sj = 0; sj < 8; sj++) {
        const a0 = c0 + (c1 - c0) * si / 8, a1 = c0 + (c1 - c0) * (si + 1) / 8;
        const b0 = d0 + (d1 - d0) * sj / 8, b1 = d0 + (d1 - d0) * (sj + 1) / 8;
        const cs = rasCensus(Es, a0, a1, b0, b1);
        if (cs.tot > 0 && cs.wet === cs.tot) continue;            // bare water — the lake plane is the only surface
        if (cs.wet === 0) {
          // v2.38 NEAR-SHORE DRY R1: is the water within one R1 of here?
          // (dilated census). A dry 6.9 km quad this close to the water
          // still carries enough log-depth error at far zoom to bleed over
          // the lake — fall through to the 860 m grid instead.
          const dil = rasCensus(Es, a0 - .063, a1 + .063, b0 - .063, b1 + .063);
          if (dil.wet === 0) {
            if (dry5(a0, a1, b0, b1)) {
              const k = cellKey + '|g' + si + ',' + sj;
              if (!interiorFilled.has(k)) { interiorFilled.add(k); fillCell(t, a0, a1, b0, b1, y0, buf, tint); }
              continue;
            }
            // ocean-side wet (dual-coast cells): the exact fragment path at
            // the subrect scale — ocean coasts keep their v2.33 exactness
            if (!(a1 < bx0 || a0 > bx1 || b1 < bz0 || b0 > bz1)) {
              const cpoly = clipRing(poly, a0, a1, b0, b1);
              if (cpoly.length >= 3) landTri(t, cpoly, y0, buf, tint);
            }
            for (let ti = 0; ti < 4; ti++) for (let tj = 0; tj < 4; tj++) {
              const e0 = a0 + (a1 - a0) * ti / 4, e1 = a0 + (a1 - a0) * (ti + 1) / 4;
              const f0 = b0 + (b1 - b0) * tj / 4, f1 = b0 + (b1 - b0) * (tj + 1) / 4;
              if (dry5(e0, e1, f0, f1)) fillCell(t, e0, e1, f0, f1, y0 - .02, buf, tint);
            }
            continue;
          }
          // near-shore — drop into the R2 grid below
        }
        // lake shoreline inside this 6.9 km subrect → 860 m grid
        for (let ti = 0; ti < 8; ti++) for (let tj = 0; tj < 8; tj++) {
          const e0 = a0 + (a1 - a0) * ti / 8, e1 = a0 + (a1 - a0) * (ti + 1) / 8;
          const f0 = b0 + (b1 - b0) * tj / 8, f1 = b0 + (b1 - b0) * (tj + 1) / 8;
          const c2 = rasCensus(Es, e0, e1, f0, f1);
          if (c2.tot > 0 && c2.wet === c2.tot) continue;
          if (c2.wet === 0) {
            if (centerDry(e0, e1, f0, f1)) {
              const k = cellKey + '|g' + si + ',' + sj + '|' + ti + ',' + tj;
              if (!interiorFilled.has(k)) { interiorFilled.add(k); fillCell(t, e0, e1, f0, f1, y0, buf, tint); }
            }
            continue;
          }
          // shoreline → 215 m leaves
          for (let ui = 0; ui < 4; ui++) for (let uj = 0; uj < 4; uj++) {
            const g0 = e0 + (e1 - e0) * ui / 4, g1 = e0 + (e1 - e0) * (ui + 1) / 4;
            const h0 = f0 + (f1 - f0) * uj / 4, h1 = f0 + (f1 - f0) * (uj + 1) / 4;
            const c3 = rasCensus(Es, g0, g1, h0, h1);
            if (c3.tot > 0 && c3.wet === c3.tot) continue;
            if (centerDry(g0, g1, h0, h1)) {
              const k = cellKey + '|g' + si + ',' + sj + '|' + ti + ',' + tj + '|' + ui + ',' + uj;
              if (!interiorFilled.has(k)) { interiorFilled.add(k); fillCell(t, g0, g1, h0, h1, y0, buf, tint); }
            }
          }
        }
      }
    };
    for (const ring of LANDGEO.rings) {
      if (ring.length < 4) continue;
      for (const [tx, tz] of ringTiles(ring)) {
        const t = tileRec(tx, tz);
        const lon0 = -180 + tx * TILE_DEG, lon1 = lon0 + TILE_DEG;
        const lat1 = 90 - tz * TILE_DEG, lat0 = lat1 - TILE_DEG;
        let poly = clipRing(ring, lon0, lon1, lat0, lat1);
        // v2.33: a tile the ring never enters is either open ocean or
        // continental INTERIOR — the ring-clipped polygon is empty either
        // way, and the per-cell classifier sorts it out. Whole interior
        // tiles (central Asia, the Congo, the Amazon, Ohio…) used to build
        // NO land at all.
        if (poly.length < 3) poly = [];
        // polygon bbox for the coast-cell guard (empty poly → none)
        let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
        for (const p of poly) {
          bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]);
          bz0 = Math.min(bz0, p[1]); bz1 = Math.max(bz1, p[1]);
        }
        const buf = { pos: [], norm: [], uv: [], col: [] };
        for (let i = 0; i < LG_N; i++) for (let j = 0; j < LG_N; j++) {
          const c0 = lon0 + (lon1 - lon0) * i / LG_N, c1 = lon0 + (lon1 - lon0) * (i + 1) / LG_N;
          const d0 = lat0 + (lat1 - lat0) * j / LG_N, d1 = lat0 + (lat1 - lat0) * (j + 1) / LG_N;
          // v2.33 ROBUST CELL FILL. The old path clipped the ring to the
          // cell and built ONLY that fragment — but Sutherland–Hodgman on a
          // concave coastline (bays, estuaries, meadowlands) produces
          // fragments that don't cover the cell's dry land, and cells the
          // ring never crossed built nothing at all: whole states were
          // holes showing the ocean plane. Now: all five samples (center +
          // corners) dry → the whole cell fills; coast-touching cells keep
          // the exact fragment plus a 4×4 classifier top-up that patches
          // the concave holes 2 cm under the fragment plane.
          const cm = (d0 + d1) / 2, clm = (c0 + c1) / 2;
          const cellKey = tx + ',' + tz + '/' + i + '/' + j;
          const y0 = nearCityZone(c0, d0, c1, d1) ? -.10 : 0;
          const hv = hashStr(cellKey);
          const f = .92 + (hv % 160) / 1000, wg = .97 + (Math.floor(hv / 160) % 60) / 1000;
          const tint = [f * wg, f, f * (2 - wg)];
          // v2.38: cells touching a lake build from the raster-true grid —
          // no land under the water, at any zoom (see the hoisted block)
          const lke = lakesHit(c0, d0, c1, d1);
          if (lke.length) {
            emitLakeCell(t, c0, c1, d0, d1, y0, tint, buf, lke, poly, bx0, bx1, bz0, bz1, cellKey);
            continue;
          }
          const allDry = !LANDGEO.isWaterLL(cm, clm) && !LANDGEO.isWaterLL(d0, c0) &&
            !LANDGEO.isWaterLL(d0, c1) && !LANDGEO.isWaterLL(d1, c0) && !LANDGEO.isWaterLL(d1, c1);
          if (allDry) {
            if (!interiorFilled.has(cellKey)) {
              interiorFilled.add(cellKey);
              fillCell(t, c0, c1, d0, d1, y0, buf, tint);
            }
          } else {
            // coast-touching cell (a sample is wet) — exact fragment first
            let built = false;
            if (!(c1 < bx0 || c0 > bx1 || d1 < bz0 || d0 > bz1)) {
              const cpoly = clipRing(poly, c0, c1, d0, d1);
              if (cpoly.length >= 3) {
                landTri(t, cpoly, y0, buf, tint);
                built = true;
              }
            }
            // v2.33 concavity top-up: Sutherland–Hodgman fragments miss dry
            // land at concave coasts (estuaries, bays, meadowlands) — the
            // 35 km of holes west of New York. 4×4 subcells whose own five
            // samples are ALL dry fill 2 cm under the fragment plane: where
            // the fragment is right it simply wins, where it has holes the
            // subcell shows. A subcell with any wet sample touches the
            // coast and stays with the exact fragment (no seaward spill).
            for (let si = 0; si < 4; si++) for (let sj = 0; sj < 4; sj++) {
              const sc0 = c0 + (c1 - c0) * si / 4, sc1 = c0 + (c1 - c0) * (si + 1) / 4;
              const sd0 = d0 + (d1 - d0) * sj / 4, sd1 = d0 + (d1 - d0) * (sj + 1) / 4;
              const smx = (sc0 + sc1) / 2, smy = (sd0 + sd1) / 2;
              if (LANDGEO.isWaterLL(smy, smx) || LANDGEO.isWaterLL(sd0, sc0) ||
                LANDGEO.isWaterLL(sd0, sc1) || LANDGEO.isWaterLL(sd1, sc0) ||
                LANDGEO.isWaterLL(sd1, sc1)) continue;
              fillCell(t, sc0, sc1, sd0, sd1, y0 - .02, buf, tint);
            }
            if (!built && !LANDGEO.isWaterLL(cm, clm) && !interiorFilled.has(cellKey)) {
              // no fragment but the center is dry — land the clip dropped
              // (lake-corner cells clip away; the lake surface renders above)
              interiorFilled.add(cellKey);
              fillCell(t, c0, c1, d0, d1, y0, buf, tint);
            }
          }
        }
        if (buf.pos.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
          g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.norm, 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
          g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
          const m = new THREE.Mesh(g, landMat);
          m.renderOrder = RO_LAND;   // v2.37 flat-ground ladder
          m.receiveShadow = true;
          t.g.add(m);
        }
      }
      // world-space ring segments. All Natural Earth outer rings wind the
      // same way (positive signed area in world space): the interior lies
      // LEFT of travel, so SEAWARD is always the RIGHT perpendicular — one
      // rule for every segment of every coast, and the (A, B, C) triangle
      // order always faces up. v2.27: each segment's skirt/beach/shelf
      // live in the tile of its midpoint, in tile-local meters.
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const ax = a[0] * DEG_M, az = -a[1] * DEG_M, bx = b[0] * DEG_M, bz = -b[1] * DEG_M;
        const seg = Math.hypot(bx - ax, bz - az);
        if (seg < .01 || seg > DEG_M * 5.45) continue;   // degenerate seam edges
        const t = tileRec(...tileOfLL((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
        const lx = ax - t.ox, lz = az - t.oz, lbx = bx - t.ox, lbz = bz - t.oz;
        // coast skirt (DoubleSide — winding irrelevant)
        const P = [[lx, .04, lz], [lbx, .04, lbz], [lbx, SEA, lbz],
                   [lx, .04, lz], [lbx, SEA, lbz], [lx, SEA, lz]];
        const C = [cTop, cTop, cBot, cTop, cBot, cBot];
        for (let k = 0; k < 6; k++) {
          t.sk.pos.push(P[k][0], P[k][1], P[k][2]);
          t.sk.norm.push(0, 1, 0);
          t.sk.uv.push(0, 0);
          t.sk.col.push(C[k][0], C[k][1], C[k][2]);
        }
        // segment seaward normal = right perpendicular of travel
        const dx = bx - ax, dz = bz - az, dl = seg;
        const snx = dz / dl, snz = -dx / dl;
        const yb = .07 + (i % 2) * .013, ys = -1.30 + (i % 2) * .009;   // v2.30: beaches clear the coarse-grid depth error
        // beach: 26 m inland .. 14 m into the sea (straddles the waterline)
        const A = [lx - snx * 26, lz - snz * 26], B = [lbx - snx * 26, lbz - snz * 26];
        const Cc = [lbx + snx * 14, lbz + snz * 14], D = [lx + snx * 14, lz + snz * 14];
        // shallow shelf: 12 m .. 85 m seaward, just above the ocean plane
        const A2 = [lx + snx * 12, lz + snz * 12], B2 = [lbx + snx * 12, lbz + snz * 12];
        const C2 = [lbx + snx * 85, lbz + snz * 85], D2 = [lx + snx * 85, lz + snz * 85];
        const push = (arr, cArr, pts, y, Cc2) => {
          for (const p of pts) { arr.push(p[0], y, p[1]); cArr.push(Cc2[0], Cc2[1], Cc2[2]); }
        };
        push(t.bh.pos, t.bh.col, [A, B, Cc, A, Cc, D], yb, cBeach);
        push(t.sh.pos, t.sh.col, [A2, B2, C2, A2, C2, D2], ys, cShelf);
      }
    }
    // ---- the great lakes: inset water just above the land --------------
    const lakeMat = new THREE.MeshLambertMaterial({
      color: 0x3479bd, side: THREE.DoubleSide, vertexColors: true,   // v2.35: clean lake blue — same family as the sea and the orbit globe
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    // ---- v2.19: sandy rims just inside every lake waterline --------------
    // v2.38: the lake plane (.8) now rides far above this fringe — it
    // stays fully submerged (invisible at every zoom; subpixel at the
    // altitudes where depths tie) and is kept only as harmless ballast.
    const cRim = col(0xd8d1bc);   // v2.32: pale fringe to match the ocean beaches
    // v2.38 DEPTH SEPARATION: the lake plane rides .8 m above the land
    // shield (was 7.5 cm). The land under every lake is a 55 km-cell grid
    // whose vertices carry ±4 cm of float32 noise, and the view-distance
    // term grows with zoom — in the 100–700 km band the old 7.5 cm margin
    // could still interleave with the land's depth noise and bleed green
    // patches through the water (the "still green in the lake" reports).
    // 80 cm clears the worst-case combined noise by an order of magnitude
    // at every zoom where depth decides; past ~700 km the log-depth quantum
    // exceeds the gap and the v2.37 renderOrder ladder (lake 3 > land 1)
    // hands the surface to the water deterministically. The land stays
    // under the opaque lake, so nothing shows through anywhere.
    const LAKE_Y = .8;
    // ---- v2.36 TRUE LAKES surface ---------------------------------------
    // Coverage is layered so a hole is impossible: every 6.9 km subcell
    // whose 9 raster samples are all wet fills as one quad; every shore
    // subcell first lays down raster backstop runs (444 m cells, clamped
    // inside the subcell so neighbors never overlap) 2 cm under the
    // surface, THEN adds the exact vector fragment on top — but only
    // after the fragment is verified cell-by-cell against the raster
    // (covers >= 95% of the wet cells, spills onto <= 2 dry ones). The
    // Sutherland-Hodgman bowties that greened Green Bay can neither hole
    // the lake (runs carry the water) nor spill onto the shore (unverified
    // fragments are dropped).
    const wetR = (r, la, lo) => {
      const i = Math.floor((lo - r.x0) / r.res), j = Math.floor((la - r.y0) / r.res);
      if (i < 0 || j < 0 || i >= r.w || j >= r.h) return false;
      const idx = j * r.w + i;
      return !!(r.bits[idx >> 3] & (128 >> (idx & 7)));
    };
    // row-merged raster runs INSIDE [lo0,lo1]x[la0,la1] (clamped — no overlap)
    const rasterRuns = (r, t, lo0, lo1, la0, la1, y, buf) => {
      const i0 = Math.max(0, Math.ceil((lo0 - r.x0) / r.res - .5)), i1 = Math.min(r.w - 1, Math.floor((lo1 - r.x0) / r.res - .5));
      const j0 = Math.max(0, Math.ceil((la0 - r.y0) / r.res - .5)), j1 = Math.min(r.h - 1, Math.floor((la1 - r.y0) / r.res - .5));
      for (let j = j0; j <= j1; j++) {
        let run = -1;
        for (let i = i0; i <= i1 + 1; i++) {
          const idx = j * r.w + i;
          const wet = i <= i1 && !!(r.bits[idx >> 3] & (128 >> (idx & 7)));
          if (wet && run < 0) run = i;
          if (!wet && run >= 0) {
            const a = Math.max(r.x0 + run * r.res, lo0), b = Math.min(r.x0 + i * r.res, lo1);
            const ra = Math.max(r.y0 + j * r.res, la0), rb = Math.min(r.y0 + (j + 1) * r.res, la1);
            if (b > a && rb > ra) fillCell(t, a, b, ra, rb, y, buf, [1, 1, 1]);
            run = -1;
          }
        }
      }
    };
    // walk every raster cell whose center lies in the rect: cb(la, lo, isWet)
    const rasterCells = (r, lo0, lo1, la0, la1, cb) => {
      const i0 = Math.max(0, Math.ceil((lo0 - r.x0) / r.res - .5)), i1 = Math.min(r.w - 1, Math.floor((lo1 - r.x0) / r.res - .5));
      const j0 = Math.max(0, Math.ceil((la0 - r.y0) / r.res - .5)), j1 = Math.min(r.h - 1, Math.floor((la1 - r.y0) / r.res - .5));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const idx = j * r.w + i;
        cb(r.y0 + (j + .5) * r.res, r.x0 + (i + .5) * r.res, !!(r.bits[idx >> 3] & (128 >> (idx & 7))));
      }
    };
    // v2.36: a fragment may only ride ShapeGeometry when it is a SIMPLE
    // polygon — earcut silently drops lobes of a self-intersecting
    // (bowtie) clip, which is exactly how Green Bay kept showing grass.
    // Non-simple fragments fall back to the raster runs.
    const isSimple = poly => {
      const n = poly.length;
      if (n < 3) return true;
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
          if (i === 0 && j === n - 1) continue;      // first and last edges share a vertex
          const c = poly[j], d = poly[(j + 1) % n];
          const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
          if (d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 &&
            ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return false;
        }
      }
      return true;
    };
    for (const lk of LANDGEO.lakes) {
      if (lk.ring.length < 4) continue;
      let rbx0 = 1e9, rbx1 = -1e9, rbz0 = 1e9, rbz1 = -1e9;
      for (const p of lk.ring) { rbx0 = Math.min(rbx0, p[0]); rbx1 = Math.max(rbx1, p[0]); rbz0 = Math.min(rbz0, p[1]); rbz1 = Math.max(rbz1, p[1]); }
      const ras = lakeRasByLk.get(lk) || lakeRaster(lk);   // v2.38: reuse the hoisted raster (also drives the land grid)
      for (const [tx, tz] of ringTiles(lk.ring)) {
        const t = tileRec(tx, tz);
        const lon0 = -180 + tx * TILE_DEG, lon1 = lon0 + TILE_DEG;
        const lat1 = 90 - tz * TILE_DEG, lat0 = lat1 - TILE_DEG;
        const gx0 = Math.max(rbx0, lon0), gx1 = Math.min(rbx1, lon1);
        const gz0 = Math.max(rbz0, lat0), gz1 = Math.min(rbz1, lat1);
        if (gx1 <= gx0 || gz1 <= gz0) continue;
        const lbuf = { pos: [], norm: [], uv: [], col: [] };
        for (let i = 0; i < LG_N; i++) for (let j = 0; j < LG_N; j++) {
          const c0 = lon0 + (lon1 - lon0) * i / LG_N, c1 = lon0 + (lon1 - lon0) * (i + 1) / LG_N;
          const d0 = lat0 + (lat1 - lat0) * j / LG_N, d1 = lat0 + (lat1 - lat0) * (j + 1) / LG_N;
          if (c1 < gx0 || c0 > gx1 || d1 < gz0 || d0 > gz1) continue;
          for (let si = 0; si < 8; si++) for (let sj = 0; sj < 8; sj++) {
            const sc0 = c0 + (c1 - c0) * si / 8, sc1 = c0 + (c1 - c0) * (si + 1) / 8;
            const sd0 = d0 + (d1 - d0) * sj / 8, sd1 = d0 + (d1 - d0) * (sj + 1) / 8;
            // direct raster census of the subcell: every wet cell gets
            // water, no dry cell gets any — zero holes, zero corner spill
            let wetCnt = 0, tot = 0;
            rasterCells(ras, sc0, sc1, sd0, sd1, (la, lo, isWet) => { tot++; if (isWet) wetCnt++; });
            if (wetCnt === 0) continue;
            if (wetCnt === tot) { fillCell(t, sc0, sc1, sd0, sd1, LAKE_Y - .02, lbuf, [1, 1, 1]); continue; }
            // shore subcell: the exact vector fragment when it verifies
            // against the raster; the 444 m raster backstop runs only when
            // the fragment is missing or imperfect (keeps memory lean and
            // the edge exact wherever the clip holds)
            const fpoly = clipRing(lk.ring, sc0, sc1, sd0, sd1);
            let fragOK = false, fragPerfect = false;
            if (fpoly.length >= 3 && isSimple(fpoly)) {
              let wet = 0, cov = 0, spill = 0;
              rasterCells(ras, sc0, sc1, sd0, sd1, (la, lo, isWet) => {
                const inside = LANDGEO.pipLL(fpoly, lo, la);
                if (isWet) { wet++; if (inside) cov++; }
                else if (inside) spill++;
              });
              fragOK = wet > 0 && cov >= wet * .95 && spill <= 2;
              fragPerfect = fragOK && cov === wet;
            }
            if (!fragPerfect) rasterRuns(ras, t, sc0, sc1, sd0, sd1, LAKE_Y - .02, lbuf);
            if (fragOK) landTri(t, fpoly, LAKE_Y, lbuf, [1, 1, 1]);
          }
        }
        if (lbuf.pos.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(lbuf.pos, 3));
          g.setAttribute('normal', new THREE.Float32BufferAttribute(lbuf.norm, 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute(lbuf.uv, 2));
          g.setAttribute('color', new THREE.Float32BufferAttribute(lbuf.col, 3));
          const m = new THREE.Mesh(g, lakeMat);
          m.renderOrder = RO_LAKE;   // v2.37 flat-ground ladder: blue beats land at ANY zoom
          m.receiveShadow = true;
          t.g.add(m);
        }
      }
      // ring winding: interior (the water) lies LEFT of travel for
      // positive signed area — all Natural Earth rings but the Caspian.
      let sa = 0;
      for (let i = 0; i < lk.ring.length; i++) {
        const p = lk.ring[i], q = lk.ring[(i + 1) % lk.ring.length];
        sa += (p[0] * DEG_M) * (-q[1] * DEG_M) - (q[0] * DEG_M) * (-p[1] * DEG_M);
      }
      const sgn = sa > 0 ? 1 : -1;
      for (let i = 0; i < lk.ring.length; i++) {
        const a = lk.ring[i], b = lk.ring[(i + 1) % lk.ring.length];
        const ax = a[0] * DEG_M, az = -a[1] * DEG_M, bx = b[0] * DEG_M, bz = -b[1] * DEG_M;
        const seg = Math.hypot(bx - ax, bz - az);
        if (seg < .01 || seg > DEG_M * 5.45) continue;    // degenerate seam edges
        const t = tileRec(...tileOfLL((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
        const lx = ax - t.ox, lz = az - t.oz, lbx = bx - t.ox, lbz = bz - t.oz;
        const snx = (bz - az) / seg, snz = -(bx - ax) / seg;   // RIGHT of travel
        const wx = -snx * sgn, wz = -snz * sgn;         // toward the water
        const A = [lx, lz], B = [lbx, lbz];
        const C = [lbx + wx * 11, lbz + wz * 11], D = [lx + wx * 11, lz + wz * 11];
        // v2.32: rims are FrontSide — the old (A,B,C) order faced DOWN for
        // positive-area rings (89% of lakes), so the pale fringe was simply
        // CULLED and never rendered. Flip the quad order with sgn.
        const RIMQ = sgn > 0 ? [A, C, B, A, D, C] : [A, B, C, A, C, D];
        for (const p of RIMQ) { t.rm.pos.push(p[0], .09, p[1]); t.rm.col.push(cRim[0], cRim[1], cRim[2]); }
      }
    }

    // ---- v2.35: the forest belt -----------------------------------------
    // "trees around the cities in the green pastures". A woodland ring
    // around EVERY city: polar quads out to 3.3 km, dry land only, deep
    // woodland greens. v2.42: the belt's inner edge moves from CITY_R+170
    // to CITY_R+1900 — the neighborhoods (see buildSuburbDecal) own the
    // ring from CITY_R+120 to CITY_R+1615, and the woods pick up where
    // the last yard ends,
    // 9.5 mm over the land shield in the city's own anchor-local frame
    // (the exact frame as the fine pad — the 9.5 mm separation is real
    // at any range). This decal renders at EVERY zoom: from orbit the
    // ring reads as forest around the city; the chunk pass plants real
    // 3D trees in the same annulus once you walk its way.
    function buildForestBelt(c) {
      const pos = [], norm = [], colr = [];
      // v2.65 CITY DNA: the belt hugs the city's OWN suburb edge (subR1),
      // keeping the +285 m / 940 m margins the v2.42 tuning set — so
      // woods never grow inside a wide metro's ring, and a small town's
      // forest starts a full km sooner
      const E = subEdge(c);
      const R0 = E + 285, R1 = E + 940, BANDS = 9, SECT = 44;   // v2.42: past the suburbs
      const greens = [0x3d6f2c, 0x477d34, 0x356226, 0x528a3e];
      const step = (R1 - R0) / BANDS;
      for (let i = 0; i < BANDS; i++) {
        const r0 = R0 + i * step, r1 = r0 + step;
        for (let j = 0; j < SECT; j++) {
          const a0 = (j / SECT) * 6.2832 + (i % 2) * .07, a1 = ((j + 1) / SECT) * 6.2832 + (i % 2) * .07;
          const hv = hashStr(c.key + '/f' + i + '/' + j);
          // jittered inner/outer edges — no perfect circle reads as forest
          const jr0 = r0 + (hv % 130) - 65, jr1 = r1 + (Math.floor(hv / 130) % 130) - 65;
          if (jr1 - jr0 < 60) continue;
          const P = [[jr0, a0], [jr1, a0], [jr1, a1], [jr0, a1]].map(([r, a]) => [Math.cos(a) * r, Math.sin(a) * r]);
          // dry land only — the belt never floats on sea or lake
          if (LANDGEO.isWaterWorld(c.wx + (P[0][0] + P[2][0]) / 2, c.wz + (P[0][1] + P[2][1]) / 2) ||
              LANDGEO.isWaterWorld(c.wx + P[0][0], c.wz + P[0][1]) ||
              LANDGEO.isWaterWorld(c.wx + P[1][0], c.wz + P[1][1]) ||
              LANDGEO.isWaterWorld(c.wx + P[2][0], c.wz + P[2][1]) ||
              LANDGEO.isWaterWorld(c.wx + P[3][0], c.wz + P[3][1])) continue;
          const gc = col(greens[hv % 4]);
          const f = .92 + (Math.floor(hv / 520) % 15) / 100;
          for (const k of [0, 1, 2, 0, 2, 3]) {
            pos.push(P[k][0], .0095, P[k][1]);
            norm.push(0, 1, 0);
            colr.push(gc[0] * f, gc[1] * f, gc[2] * f);
          }
        }
      }
      if (!pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }));
      m.renderOrder = RO_BELT;   // v2.37 flat-ground ladder
      m.position.set(c.wx, 0, c.wz);   // city-anchor-local: exact depth
      m.receiveShadow = true;
      group.add(m);
    }
    // ---- v2.30: the fine city pads ---------------------------------------
    // ±12 km of 1.5 km land cells at EXACT y=0 in each city's anchor-local
    // frame (the same float32-safe frame as the city and the road tails).
    // The coarse 55 km grid still carries ~4 cm of depth error — plenty
    // for roads at 9.5 cm, hopeless for the 12 mm city plate — so the
    // plate, the streets and the road junctions ride this pad instead,
    // and the coarse cells under it are dropped to −10 cm (nearCityZone).

    // ---- v2.42: the suburb ground decal ---------------------------------
    // "houses and neighborhoods around the cities": a residential-green
    // ring under the neighborhood streets — lighter, lawn-toned greens
    // (the belt's deep woodland colors start where this ends), mottled
    // like yards, dry land only, the same anchor-local frame and
    // renderOrder as the belt. The city plate covers the inner part
    // while the full city stands; beyond it this is the ground the
    // houses stand on, and it renders at every zoom like the belt does.
    function buildSuburbDecal(c) {
      const pos = [], norm = [], colr = [];
      // v2.65 CITY DNA: the lawn ring runs to the city's OWN suburb edge
      const R0 = CITY_R + 120, R1 = subEdge(c), BANDS = 7, SECT = 44;
      const greens = [0x7cb45e, 0x8ec96a, 0x74b056, 0x86c262];
      const step = (R1 - R0) / BANDS;
      for (let i = 0; i < BANDS; i++) {
        const r0 = R0 + i * step, r1 = r0 + step;
        for (let j = 0; j < SECT; j++) {
          const a0 = (j / SECT) * 6.2832 + (i % 2) * .07, a1 = ((j + 1) / SECT) * 6.2832 + (i % 2) * .07;
          const hv = hashStr(c.key + '/s' + i + '/' + j);
          const jr0 = r0 + (hv % 90) - 45, jr1 = r1 + (Math.floor(hv / 90) % 90) - 45;
          if (jr1 - jr0 < 40) continue;
          const P = [[jr0, a0], [jr1, a0], [jr1, a1], [jr0, a1]].map(([r, a]) => [Math.cos(a) * r, Math.sin(a) * r]);
          if (LANDGEO.isWaterWorld(c.wx + (P[0][0] + P[2][0]) / 2, c.wz + (P[0][1] + P[2][1]) / 2) ||
              LANDGEO.isWaterWorld(c.wx + P[0][0], c.wz + P[0][1]) ||
              LANDGEO.isWaterWorld(c.wx + P[1][0], c.wz + P[1][1]) ||
              LANDGEO.isWaterWorld(c.wx + P[2][0], c.wz + P[2][1]) ||
              LANDGEO.isWaterWorld(c.wx + P[3][0], c.wz + P[3][1])) continue;
          const gc = col(greens[hv % 4]);
          const f = .94 + (Math.floor(hv / 520) % 12) / 100;
          for (const k of [0, 1, 2, 0, 2, 3]) {
            pos.push(P[k][0], .0095, P[k][1]);
            norm.push(0, 1, 0);
            colr.push(gc[0] * f, gc[1] * f, gc[2] * f);
          }
        }
      }
      if (!pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }));
      m.renderOrder = RO_BELT;   // v2.37 flat-ground ladder — same rung as the belt
      m.position.set(c.wx, 0, c.wz);   // city-anchor-local: exact depth
      m.receiveShadow = true;
      group.add(m);
    }
    if (LANDGEO.ready) {
      for (const c of CITIES) {
        buildForestBelt(c);
        buildSuburbDecal(c);   // v2.42: lawn-green ring under the neighborhoods
        const R = 12000, N = 16, T = 2 * R / N;
        const pos = [], norm = [], uv = [], col = [];   // v2.33: landMat is vertex-colored now — pads carry white
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
          const x0 = -R + i * T, z0 = -R + j * T, x1 = x0 + T, z1 = z0 + T;
          // a cell is laid only where it is solid ground everywhere
          if (LANDGEO.isWaterWorld(c.wx + x0, c.wz + z0) || LANDGEO.isWaterWorld(c.wx + x1, c.wz + z0) ||
              LANDGEO.isWaterWorld(c.wx + x0, c.wz + z1) || LANDGEO.isWaterWorld(c.wx + x1, c.wz + z1) ||
              LANDGEO.isWaterWorld(c.wx + (x0 + x1) / 2, c.wz + (z0 + z1) / 2)) continue;
          const u0 = x0, u1 = x1, v0 = -z1, v1 = -z0;
          pos.push(x0, 0, z1, x1, 0, z1, x1, 0, z0, x0, 0, z1, x1, 0, z0, x0, 0, z0);
          norm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
          uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
          for (let k = 0; k < 6; k++) col.push(1, 1, 1);
        }
        if (!pos.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const m = new THREE.Mesh(g, landMat);
        m.renderOrder = RO_LAND;   // v2.37 flat-ground ladder
        m.position.set(c.wx, 0, c.wz);   // city-anchor-local: exact depth
        m.receiveShadow = true;
        group.add(m);
      }
    }
  }
  // pre-Earth fallback ground (only if the coastline data failed to load)
  function buildGroundFlat() {
    const W = WORLD_BOUNDS.x1 - WORLD_BOUNDS.x0, H = WORLD_BOUNDS.z1 - WORLD_BOUNDS.z0;
    const cx = (WORLD_BOUNDS.x0 + WORLD_BOUNDS.x1) / 2, cz = (WORLD_BOUNDS.z0 + WORLD_BOUNDS.z1) / 2;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: grassTexture() }));
    m.scale.set(W, 1, H);   // v2.27: unit plane scaled — float32-exact verts
    m.renderOrder = RO_LAND;   // v2.37 flat-ground ladder
    m.position.set(cx, .006, cz);
    m.receiveShadow = true;
    group.add(m);
  }

  // ---------------- rural roads + rural plots -------------------------
  // v2.18: every road is a REAL land route — A*-routed across the planet's
  // coastlines at build time, projected to world meters. v2.27 TRUE SCALE:
  // resampling and hashing track DEG_M (a ~2.6 km cadence at 1:1 — the
  // same geographic fidelity the 11 m cadence gave the 550 m/° world),
  // ribbons stream into the world tiles, and any stretch the vector
  // coast says is water becomes a causeway with guard pylons. Island
  // cities are joined by sea bridges (pylons, no plots).
  const RSAMPLE = DEG_M / 50;         // route resample step (~2.2 km at 1:1)
  const RDECIM = DEG_M * 0.0236;      // polyline decimation (~2.6 km at 1:1)
  // ---- v2.29 REAL JUNCTIONS: street-aware road ends -------------------
  // A street layout (skyline ×10 sprawl or the imported city's true
  // streets) becomes a spatial hash of segments; the route is scanned
  // inward at 8 m steps to find the FIRST street it meets, refined to
  // the meter, and the road ends there — merged into the street band
  // instead of crossing the grid.
  const SCELL = 256, J_SCAN = 11000, J_STEP = 8;
  function cutAtArc(full, cum, L, s) {      // exact point + segment at arc length s
    s = Math.max(0, Math.min(L, s));
    let i = 0;
    while (i < full.length - 1 && cum[i + 1] < s) i++;
    if (i >= full.length - 1) return { p: full[full.length - 1].slice(), i };
    const t = Math.max(0, (s - cum[i]) / (cum[i + 1] - cum[i] || 1));
    return { p: [full[i][0] + (full[i + 1][0] - full[i][0]) * t,
                 full[i][1] + (full[i + 1][1] - full[i][1]) * t], i };
  }
  function streetGridFor(roads) {
    const g = new Map();
    for (const r of roads) {
      const pts = r.pts;
      if (!pts || pts.length < 2) continue;
      const w = r.w || 9;
      for (let i = 0; i < pts.length - 1; i++) {
        const seg = { ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1], w };
        const slen = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az) || 1;
        const n = Math.max(1, Math.ceil(slen / (SCELL / 2)));
        for (let k = 0; k <= n; k++) {
          const kx = Math.floor((seg.ax + (seg.bx - seg.ax) * k / n) / SCELL) + ',' +
            Math.floor((seg.az + (seg.bz - seg.az) * k / n) / SCELL);
          if (!g.has(kx)) g.set(kx, []);
          g.get(kx).push(seg);
        }
      }
    }
    return g;
  }
  // distance from (x,z) to the nearest street centerline, within
  // w/2 + margin — returns the street's width when hit, else 0
  function gridNear(g, x, z, margin) {
    const cx = Math.floor(x / SCELL), cz = Math.floor(z / SCELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = g.get((cx + i) + ',' + (cz + j));
      if (!arr) continue;
      for (const s of arr) {
        const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz || 1;
        let t = ((x - s.ax) * dx + (z - s.az) * dz) / L2;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)) < s.w / 2 + margin) return s.w;
      }
    }
    return 0;
  }
  // scan the route from OUTSIDE toward the city end (d = arc distance
  // from that city's anchor) and return the arc where the road should
  // END: the outermost street band it meets. Perpendicular crossings
  // end 1 m INSIDE the band (asphalt merged into the street); a route
  // that runs ALONG a street (axial approaches hug the generator's
  // Central Street line) ends at its FIRST TOUCH of the band instead,
  // so the road feeds into the street and never overlaps the grid.
  // 0 = no street met — run to the anchor (v2.28 behavior, safe fallback).
  function junctionEnd(tail, end, grid) {
    if (!grid || !grid.size) return 0;
    const at = d => cutAtArc(tail.full, tail.cum, tail.L, end === 'A' ? d : tail.L - d).p;
    let hit = -1;
    for (let d = Math.min(J_SCAN, tail.L - 1); d >= 0; d -= J_STEP) {
      const p = at(d);
      if (gridNear(grid, p[0], p[1], 4.5)) { hit = d; break; }
    }
    if (hit < 0) return 0;
    let dIn = hit, walked = 0;   // refine to the band's inner edge at 1 m
    while (dIn > 0 && walked <= 60) {
      const p = at(dIn - 1);
      if (!gridNear(grid, p[0], p[1], 4.5)) break;
      dIn -= 1; walked++;
    }
    if (walked > 60) {
      // shallow/parallel approach — the road keeps running alongside the
      // street: stop it where it first touches the band
      let dOut = hit, steps = 0;
      while (dOut < Math.min(J_SCAN, tail.L) && steps < 400) {
        const p = at(dOut + 1);
        if (!gridNear(grid, p[0], p[1], 4.5)) break;
        dOut += 1; steps++;
      }
      return Math.max(0, dOut + 1);
    }
    // perpendicular crossing: the hit threshold is w/2 + 4.5 (road
    // half-width + margin), so the street band's inner edge sits 4.5 m
    // further in — end the road 1 m INSIDE the band: +5.5 from dIn
    return Math.max(0, dIn + 5.5);
  }
  function buildEdges() {
    edges = [];
    roadHash = new Map();
    let rn = 1;
    for (const e of WORLD_EDGES) {
      const A = CITIES[e.a], B = CITIES[e.b];
      if (!A || !B) continue;
      const ll = (e.ll && e.ll.length > 1) ? e.ll : [[A.lon, A.lat], [B.lon, B.lat]];
      // v2.28 CONNECTED ROADS (1/2): the encoded route ends are the RAW
      // catalog coordinates — quantized to 0.01° when the routes were
      // baked (avg 117 m off at 1:1, worst 7.1 km, e.g. Toronto) — while
      // the city stands on its CURRENT anchor (shoreline-snapped at
      // boot). Run every route end to the anchor the city actually
      // occupies, or the road misses the town it serves.
      const llr = ll.slice();
      llr[0] = [A.wx / DEG_M, -A.wz / DEG_M];
      llr[llr.length - 1] = [B.wx / DEG_M, -B.wz / DEG_M];
      // project the land route (or the straight bridge span) to a fine
      // world polyline — dense points keep plots and road hashing exact
      const full = [];
      for (let i = 0; i < llr.length; i++) {
        const px = llr[i][0] * DEG_M, pz = -llr[i][1] * DEG_M;
        if (!i) { full.push([px, pz]); continue; }
        const q = full[full.length - 1];
        const d = Math.hypot(px - q[0], pz - q[1]);
        const n = Math.max(1, Math.ceil(d / RSAMPLE));
        for (let k = 1; k <= n; k++) full.push([q[0] + (px - q[0]) * k / n, q[1] + (pz - q[1]) * k / n]);
      }
      const cum = [0];
      for (let i = 1; i < full.length; i++) cum.push(cum[i - 1] + Math.hypot(full[i][0] - full[i - 1][0], full[i][1] - full[i - 1][1]));
      const L = cum[cum.length - 1];
      const cutAt = s => cutAtArc(full, cum, L, s);
      // v2.29 REAL JUNCTIONS: a land route ends at the first street of
      // the city it serves. Bridges keep their 60 m trim (a trimmed
      // deck strands in open water — v2.22). Each land route keeps a
      // re-trimmable TAIL: the baked tile ribbons stop TAIL_CAP short
      // of town and the per-end tail group carries the final stretch,
      // re-emitted when the standing city changes (skyline ↔ full).
      // The junction at boot answers the SKYLINE layout — the streets
      // you actually see when the full city is not built (cached real
      // data where this browser has it, the deterministic generator
      // otherwise — the same source buildSkyline uses).
      let pts, tail = null, bakePts = null;
      if (e.bridge) {
        if (L > 180) {
          const a = cutAt(60), b = cutAt(L - 60);
          pts = [a.p, ...full.slice(a.i + 1, b.i + 1), b.p];
        } else {
          pts = full.slice();         // very short span — keep it whole
        }
      } else {
        tail = { full, cum, L, A: { dEnd: 0, cap: 0, mesh: null }, B: { dEnd: 0, cap: 0, mesh: null } };
        tail.A.dEnd = junctionEnd(tail, 'A', skyGridFor(A));
        tail.B.dEnd = junctionEnd(tail, 'B', skyGridFor(B));
        const span = L - tail.A.dEnd - tail.B.dEnd;
        if (span > 2 * TAIL_CAP + 200) {
          tail.A.cap = tail.B.cap = TAIL_CAP;
        } else {
          tail.A.cap = tail.B.cap = Math.max(0, span / 2);
        }
        tail.A.dEnd = Math.min(tail.A.dEnd, Math.max(0, tail.A.cap - 30));
        tail.B.dEnd = Math.min(tail.B.dEnd, Math.max(0, tail.B.cap - 30));
        if (span < 220) {
          tail = null;                // degenerate tiny route — bake it whole
          pts = full.slice();
        } else {
          const a = cutAt(tail.A.dEnd), b = cutAt(L - tail.B.dEnd);
          pts = [a.p, ...full.slice(a.i + 1, b.i + 1), b.p];          // the whole road, junction to junction
          const ba = cutAt(tail.A.cap), bb = cutAt(L - tail.B.cap);
          bakePts = [ba.p, ...full.slice(ba.i + 1, bb.i + 1), bb.p];  // baked span, cap to cap
        }
      }
      const poly = [pts[0]];
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc >= RDECIM || i === pts.length - 1) { poly.push(pts[i]); acc = 0; }
      }
      const rec = {
        idx: edges.length, A, B, poly, bridge: !!e.bridge,
        name: (e.bridge ? 'Sea Bridge · ' : 'Route ' + (rn + 11) + ' · ') + A.name + ' – ' + B.name,
        group: null, plotRecs: [],
        bakePts: bakePts || poly,   // v2.29: span baked into the world tiles
        tail,                       // v2.29: re-trimmable city-end tails
        bbox: [1e9, -1e9, 1e9, -1e9],
      };
      rn += 3;
      poly.forEach(pt => {
        rec.bbox[0] = Math.min(rec.bbox[0], pt[0]); rec.bbox[1] = Math.max(rec.bbox[1], pt[0]);
        rec.bbox[2] = Math.min(rec.bbox[2], pt[1]); rec.bbox[3] = Math.max(rec.bbox[3], pt[1]);
      });
      // v2.29: the tails reach toward both anchors — keep them inside
      // the visibility bbox (the group gates on it every frame)
      for (const c of [A, B]) {
        rec.bbox[0] = Math.min(rec.bbox[0], c.wx); rec.bbox[1] = Math.max(rec.bbox[1], c.wx);
        rec.bbox[2] = Math.min(rec.bbox[2], c.wz); rec.bbox[3] = Math.max(rec.bbox[3], c.wz);
      }
      // v2.27: the edge group now holds only its roadside plots — the
      // ribbons themselves live in the world tiles
      rec.group = new THREE.Group();
      group.add(rec.group);
      buildEdgeMesh(rec);
      // hash this road's segments BEFORE placing its plots, so plots keep
      // clear of every road built so far. v2.27: at true scale the poly
      // points are ~2.6 km apart, so the hash stores SEGMENTS — each one
      // rasterized along its length into 1 km cells — and nearRoad
      // answers with exact point-to-segment distance.
      for (let i = 0; i < rec.poly.length - 1; i++) {
        const seg = [rec.poly[i][0], rec.poly[i][1], rec.poly[i + 1][0], rec.poly[i + 1][1]];
        const slen = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]) || 1;
        const nH = Math.max(1, Math.ceil(slen / (RCELL / 2)));
        const seen = new Set();
        for (let k = 0; k <= nH; k++) {
          const hx = seg[0] + (seg[2] - seg[0]) * k / nH, hz = seg[1] + (seg[3] - seg[1]) * k / nH;
          const k2 = Math.floor(hx / RCELL) + ',' + Math.floor(hz / RCELL);
          if (seen.has(k2)) continue;
          seen.add(k2);
          if (!roadHash.has(k2)) roadHash.set(k2, []);
          roadHash.get(k2).push(seg);
        }
      }
      buildEdgePlots(rec);
      edges.push(rec);
      // v2.29: the re-trimmable city-end tails (far/skyline junctions
      // at boot; setCity/clearCity re-emit them on regime change)
      if (tail) { emitTail(rec, 'A', 'far'); emitTail(rec, 'B', 'far'); }
    }
  }

  function nearRoad(x, z, r) {
    // exact distance to the nearest hashed road segment (r must stay
    // ≤ RCELL; every caller asks for ≤ 26 m)
    const gx = Math.floor(x / RCELL), gz = Math.floor(z / RCELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = roadHash.get((gx + i) + ',' + (gz + j));
      if (!arr) continue;
      for (const s of arr) {
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const L2 = dx * dx + dz * dz || 1;
        let t = ((x - s[0]) * dx + (z - s[1]) * dz) / L2;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (s[0] + t * dx), z - (s[1] + t * dz)) < r) return true;
      }
    }
    return false;
  }

  function buildEdgeMesh(rec) {
    // v2.27: ribbons stream into the world TILES (tile-local meters);
    // center dashes only within ~8 km of either city end; any segment
    // the vector coast calls water — bridge or not — gets guard pylons
    // and its deck rides just above the sea like the sea bridges.
    // v2.28 CONNECTED ROADS: the ribbon stack sits ABOVE every flat
    // ground layer it can meet at true scale — the land shield (y 0,
    // whose polygonOffset is a no-op under the logarithmic depth
    // buffer), the city ground plate (.012), beaches (.07–.083) and the
    // skyline plates (.05) — so the
    // asphalt can never z-fight under them (7–19 mm gaps lose to
    // float32 depth noise at world scale). v2.38: lakes (.8) ride far
    // above the ribbons, but no road crosses a lake (water-gated,
    // audited) so they never meet. It stays BELOW the sidewalk
    // stack (.16), vendor plots (.105) and every 3D building, so town
    // still occludes the road where it crosses blocks.
    // v2.29: this bakes the COUNTRYSIDE span only (junction caps — the
    // city-end tails live in re-trimmable groups, see emitTail).
    const cAsph = [1, 1, 1], cShol = col(0xc2b89e), cDash = col(0xdfd8c6);   // v2.32: CR distance read — light-tan shoulders + cream dashes sandwich the dark asphalt so roads stay legible at multi-km zoom (dashes are chunkier: 0.42 m × 4.8 m, no white-speckle moiré)
    const rib = (arr, ax, az, bx, bz, ux, uz, w, y, c, vTile) => {
      const px = -uz * w / 2, pz = ux * w / 2;
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const u1 = L / 7;
      const P = [[ax + px, y, az + pz], [bx + px, y, bz + pz], [bx - px, y, bz - pz], [ax - px, y, az - pz]];
      const UV = [[0, 0], [u1, 0], [u1, vTile], [0, vTile]];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        arr.pos.push(P[i][0], P[i][1], P[i][2]);
        arr.norm.push(0, 1, 0);
        arr.uv.push(UV[i][0], UV[i][1]);
        arr.col.push(c[0], c[1], c[2]);
      }
    };
    const poly = rec.bakePts || rec.poly;   // v2.29: bake the countryside span
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    const L = cum[poly.length - 1] || 1;
    const lonOf = x => x / DEG_M, latOf = z => -z / DEG_M;
    for (let i = 0; i < poly.length - 1; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[i + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const t = tileRec(...tileOfLL(lonOf((ax + bx) / 2), latOf((az + bz) / 2)));
      const ox = t.ox, oz = t.oz;
      const lax = ax - ox, laz = az - oz, lbx = bx - ox, lbz = bz - oz;
      rib(t.road, lax, laz, lbx, lbz, ux, uz, 9, ROAD_Y, cAsph, 1.07);
      for (const s of [1, -1]) {
        rib(t.road, lax - uz * 5.2 * s, laz + ux * 5.2 * s, lbx - uz * 5.2 * s, lbz - uz * 5.2 * s, ux, uz, 2, SHOL_Y, cShol, .24);
      }
      // v2.27: dashes near the cities only (within ~8 km of either end)
      if (Math.min(cum[i], L - cum[i]) < 8000) {
        for (let d = 40; d < len - 40; d += 96) {
          const mx = lax + ux * d, mz = laz + uz * d;
          rib(t.mark, mx, mz, mx + ux * 4.8, mz + uz * 4.8, ux, uz, .42, DASH_Y, cDash, .04);
        }
      } else {
        // v2.32 far-zoom detail: the deep-countryside span gets sparse
        // LONG dashes (14 m every 250 m) — CR's "staccato rhythm line" that
        // keeps a road readable as a road (not a river/border) at multi-km
        // zoom, at ~1/3 the vertex cost of the near-city dash density
        for (let d = 60; d < len - 60; d += 250) {
          const mx = lax + ux * d, mz = laz + uz * d;
          rib(t.mark, mx, mz, mx + ux * 14, mz + uz * 14, ux, uz, .5, DASH_Y, cDash, .04);
        }
      }
      // v2.18 sea bridges / v2.27 causeways: guard pylons wherever the
      // span crosses water (checked every other segment — the vector
      // coast gate is exact but not free)
      if (LANDGEO.ready && (rec.bridge || i % 2 === 0)) {
        const midWet = LANDGEO.isWaterWorld((ax + bx) / 2, (az + bz) / 2);
        if (midWet) {
          t.pyl.push([lax - dz / len * 3.4, laz + dx / len * 3.4]);
          t.pyl.push([lax + dz / len * 3.4, laz - dx / len * 3.4]);
        }
      }
    }
  }

  // ---------------- v2.29: re-trimmable road tails --------------------
  // One tail = the final stretch of a land route into its city, emitted
  // as its OWN group in the city-anchor-local frame (float32-safe at
  // 1:1, same as the skyline and city meshes) so it can be disposed and
  // re-emitted when the standing city changes:
  //   'far'  — the skyline stands: flat ribbon that ends tucked UNDER
  //            the ×10 sprawl street it meets (that asphalt sits at .3);
  //   'near' — the full city is built: the last TAIL_TAPER meters ramp
  //            down onto the street asphalt (y .030–.038) so the road
  //            merges into the grid as a junction instead of riding
  //            over it at .095 (the v2.28 look this replaces).
  function disposeTailGroup(g) {
    if (!g) return;
    g.traverse(o => { if (o.geometry) { try { o.geometry.dispose(); } catch (err) { } } });
    if (g.parent) g.parent.remove(g);
  }
  function emitTail(rec, end, mode) {
    const ti = rec.tail, E = ti[end];
    const city = end === 'A' ? rec.A : rec.B;
    disposeTailGroup(E.mesh);
    E.mesh = null;
    const sJun = end === 'A' ? E.dEnd : ti.L - E.dEnd;   // junction end
    const sCap = end === 'A' ? E.cap : ti.L - E.cap;     // where baking takes over
    if (E.cap - E.dEnd < 2) return;   // junction at/beyond the cap — no tail
    // polyline over the arc span, then junction-first
    const lo = Math.min(sJun, sCap), hi = Math.max(sJun, sCap);
    const a0 = cutAtArc(ti.full, ti.cum, ti.L, lo);
    const raw = [a0.p];
    for (let i = a0.i + 1; i < ti.full.length; i++) {
      if (ti.cum[i] <= lo) continue;
      if (ti.cum[i] >= hi) break;
      raw.push(ti.full[i]);
    }
    const b0 = cutAtArc(ti.full, ti.cum, ti.L, hi);
    raw.push(b0.p);
    const pts = sJun <= sCap ? raw : raw.slice().reverse();
    if (pts.length < 2) return;
    // v2.30 FRAME FIX: the tail group is translated to the city anchor,
    // so the vertices must be ANCHOR-LOCAL. v2.29 pushed the WORLD-
    // coordinate polyline into the translated group — every tail rendered
    // a full anchor (~10.8 million meters at Chicago) away from its road:
    // mesh:true, junctions measured right, and NO road visible within
    // 10.5 km of any city (the baked tile span starts at the cap, beyond
    // the fog). Replaced references, never mutated: ti.full stays world.
    for (let i = 0; i < pts.length; i++) pts[i] = [pts[i][0] - city.wx, pts[i][1] - city.wz];
    const cumT = [0];
    for (let i = 1; i < pts.length; i++) cumT.push(cumT[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const road = { pos: [], norm: [], uv: [], col: [] };
    const mark = { pos: [], norm: [], uv: [], col: [] };
    const pyl = [];
    const cAsph = [1, 1, 1], cShol = col(0xc2b89e), cDash = col(0xdfd8c6);   // v2.32: light shoulders + cream dashes (matches buildEdgeMesh)
    // ribbon quad with per-end heights (the near-mode taper slopes)
    const quad = (arr, ax, az, bx, bz, yA, yB, w, c, vTile) => {
      const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
      const px = -dz / L * w / 2, pz = dx / L * w / 2;
      const u1 = L / 7;
      const P = [[ax + px, yA, az + pz], [bx + px, yB, bz + pz], [bx - px, yB, bz - pz], [ax - px, yA, az - pz]];
      const UV = [[0, 0], [u1, 0], [u1, vTile], [0, vTile]];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        arr.pos.push(P[i][0], P[i][1], P[i][2]);
        arr.norm.push(0, 1, 0);
        arr.uv.push(UV[i][0], UV[i][1]);
        arr.col.push(c[0], c[1], c[2]);
      }
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const d0 = cumT[i], d1 = cumT[i + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const yAt = d => (mode === 'near' && d < TAIL_TAPER)
        ? TAIL_STREET_Y + (ROAD_Y - TAIL_STREET_Y) * (d / TAIL_TAPER)
        : ROAD_Y;
      quad(road, ax, az, bx, bz, yAt(d0), yAt(d1), 9, cAsph, 1.07);
      if (d0 >= TAIL_TAPER) {
        for (const s of [1, -1]) {
          quad(road, ax - uz * 5.2 * s, az + ux * 5.2 * s, bx - uz * 5.2 * s, bz + ux * 5.2 * s, SHOL_Y, SHOL_Y, 2, cShol, .24);
        }
      }
      // dashes within ~8 km of the road's end, clear of the junction mouth
      if (d0 >= 40 && d0 < 8000) {
        for (let d = 40; d < len - 40; d += 96) {
          const mx = ax + ux * d, mz = az + uz * d;
          quad(mark, mx, mz, mx + ux * 4.8, mz + uz * 4.8, DASH_Y, DASH_Y, .42, cDash, .04);
        }
      }
      // causeway guard pylons on wet stretches (every other segment)
      if (LANDGEO.ready && i % 2 === 0) {
        if (LANDGEO.isWaterWorld((ax + bx) / 2, (az + bz) / 2)) {
          pyl.push([ax - uz * 3.4, az + ux * 3.4]);
          pyl.push([ax + uz * 3.4, az - ux * 3.4]);
        }
      }
    }
    const g = new THREE.Group();
    const mkTailMesh = (arr, mat, order = 0) => {
      if (!arr.pos.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(arr.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = order;   // v2.37 flat-ground ladder
      m.receiveShadow = true;
      g.add(m);
    };
    mkTailMesh(road, roadMatShared(), RO_ROAD);
    mkTailMesh(mark, markMatShared(), RO_MARK);
    if (pyl.length) {
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1.25, 3.9, 1.25), pylMatShared(), pyl.length);
      const m4 = new THREE.Matrix4();
      pyl.forEach((p, i) => { m4.makeTranslation(p[0], -1.55, p[1]); inst.setMatrixAt(i, m4); });
      inst.receiveShadow = true;
      g.add(inst);
    }
    g.position.set(city.wx, 0, city.wz);   // city-anchor-local frame
    rec.group.add(g);
    E.mesh = g;
  }

  // v2.29: switch a city's road tails between the FAR layout (skyline
  // streets) and the NEAR one (the built city's true streets). setCity
  // calls this with CITY.roads once the full city stands; clearCity
  // calls it with null when the skyline takes the horizon back.
  function roadJunction(key, cityRoads) {
    if (!edges.length || !key) return;
    const c = CITIES.find(x => x.key === key);
    if (!c) return;                       // searched spots have no roads
    let grid, mode;
    if (cityRoads && cityRoads.length) { grid = streetGridFor(cityRoads); mode = 'near'; }
    else { grid = skyGridFor(c); mode = 'far'; }
    if (!grid || !grid.size) return;
    for (const rec of edges) {
      if (rec.bridge || !rec.tail) continue;
      const ends = [];
      if (rec.A.key === key) ends.push('A');
      if (rec.B.key === key) ends.push('B');
      for (const end of ends) {
        const E = rec.tail[end];
        E.dEnd = Math.min(junctionEnd(rec.tail, end, grid), Math.max(0, E.cap - 30));
        emitTail(rec, end, mode);
      }
    }
  }

  let _dollarMat = null;
  function dollarSprite() {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.font = '900 46px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 7; ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('$', 32, 35);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  }

  function buildEdgePlots(rec) {
    if (rec.bridge) return;   // v2.18: no roadside plots in the middle of the sea
    const rnd = _mulberry(hashStr('rp' + rec.idx + (rec.A.key || '')));
    const PW = 15, PD = 20;
    let n = 0;
    // walk the polyline by cumulative arc length (v2.27: plot slots sit
    // every ~250 m so a road's ten plots stay within a ~6 km walk of town)
    let dist = 0, next = 60 + rnd() * 90;
    for (let i = 0; i < rec.poly.length - 1 && n < 10; i++) {
      const [ax, az] = rec.poly[i], [bx, bz] = rec.poly[i + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      while (next <= dist + len) {
        const d = next - dist;
        next += 250;
        if (rnd() < .42) continue;                 // not every slot has a plot
        const side = rnd() < .5 ? 1 : -1;
        const off = 6.4 + PW / 2;
        const cx = ax + ux * d - uz * off * side;
        const cz = az + uz * d + ux * off * side;
        const near = distToCity(cx, cz);
        if (near.d < CITY_R + 70) continue;        // keep out of cities
        if (nearRoad(cx, cz, 9)) continue;         // not on another road
        if (LANDGEO.ready && LANDGEO.isWaterWorld(cx, cz)) continue;   // v2.18: dry land only
        if (rec.plotRecs.some(p => Math.hypot(p.x - cx, p.z - cz) < 55)) continue;
        const price = Math.round(ECON.plotBase * ECON.ruralFactor * (.8 + near.d / 10400) / 50) * 50;
        const rotY = Math.atan2(ux, uz);
        const g = new THREE.Group();
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(PW, PD),
          new THREE.MeshLambertMaterial({ color: 0x48bb78, transparent: true, opacity: .9 }));
        pad.rotation.x = -Math.PI / 2; pad.position.y = .105;
        g.add(pad);
        const hw = PW / 2 - .5, hd = PD / 2 - .5;
        const pts = [new THREE.Vector3(-hw, .13, -hd), new THREE.Vector3(hw, .13, -hd),
          new THREE.Vector3(hw, .13, hd), new THREE.Vector3(-hw, .13, hd), new THREE.Vector3(-hw, .13, -hd)];
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1.3, gapSize: .8, transparent: true, opacity: .95 }));
        line.computeLineDistances();
        g.add(line);
        const sp = new THREE.Sprite(_dollarMat || (_dollarMat = dollarSprite()));
        sp.scale.set(4, 4, 1); sp.position.y = 4.2;
        g.add(sp);
        g.position.set(cx, 0, cz);
        g.rotation.y = rotY;
        rec.group.add(g);
        rec.plotRecs.push({ id: 'r' + rec.idx + '-' + n, x: cx, z: cz, rot: rotY, w: PW, d: PD, price, mesh: g, cityKey: 'rural', rural: true });
        n++;
      }
      dist += len;
    }
  }

  // ---------------- pasture chunks ------------------------------------
  function buildChunk(ccx, ccz) {
    const key = ccx + ',' + ccz;
    if (chunks.has(key)) return;
    const rnd = _mulberry(hashStr('ch' + key));
    const x0 = ccx * CH, z0 = ccz * CH, xm = x0 + CH / 2, zm = z0 + CH / 2;
    // v2.27: chunk-local frame — merged geometry is built around the
    // chunk center and the group carries the absolute position
    const B = GeoBuilder(xm, zm);
    const mobF = isMob ? .55 : 1;
    const nearC = distToCity(xm, zm);
    const insideCity = nearC.d < CITY_R + CH * .72;
    // v2.18: pastures grow on real land only — a chunk whose whole
    // footprint is ocean or lake stays empty water
    if (LANDGEO.ready && LANDGEO.isWaterWorld(xm, zm) &&
      LANDGEO.isWaterWorld(x0, z0) && LANDGEO.isWaterWorld(x0 + CH, z0) &&
      LANDGEO.isWaterWorld(x0, z0 + CH) && LANDGEO.isWaterWorld(x0 + CH, z0 + CH)) return;

    // soft green tint patches (flat decor — fine near cities too)
    const patches = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < patches; i++) {
      const w = 120 + rnd() * 220, d = 90 + rnd() * 180;
      const px = x0 + 30 + rnd() * (CH - 60), pz = z0 + 30 + rnd() * (CH - 60);
      // v2.36: a patch RECT near the shore bleeds its corners over the
      // waterline — the whole footprint must stay dry (VLM caught a green
      // sliver floating in Green Bay)
      if (LANDGEO.ready && (LANDGEO.isWaterWorld(px, pz) ||
        LANDGEO.isWaterWorld(px - w / 2, pz - d / 2) || LANDGEO.isWaterWorld(px + w / 2, pz - d / 2) ||
        LANDGEO.isWaterWorld(px - w / 2, pz + d / 2) || LANDGEO.isWaterWorld(px + w / 2, pz + d / 2))) continue;
      // v2.30: a patch never sits under a city's ground plate. The plate
      // (.012) cleared the patch (.0095) by 2.5 mm — the logarithmic depth
      // buffer cannot hold that beyond a few hundred meters at 1:1, so the
      // green bled through the off-white plate in z-fight stripes (the
      // "glitchy floor under the cities"). 170 m covers the patch rect.
      if (distToCity(px, pz).d < CITY_R + 170) continue;
      const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
      // v2.32 GREEN RIFT: light/dark GREEN mottle — bigger patches, more
      // contrast, so the land keeps organic variation when zoomed far out
      const tint = rnd() < .34 ? col(0x7cb45e) : rnd() < .5 ? col(0x4c8438) : col(0x68a44a);
      B.addGeo(g, trs(px, .0095, pz, rnd() * 3.14, 1, 1, 1), tint);
    }
    // v2.31 CR: wildflowers removed — 0.55 m white specks alias into
    // "shard" artifacts at range (kept out in v2.32 too).

    // v2.35 FOREST BELT: real 3D trees in the woodland ring — a chunk that
    // touches any city's belt annulus (edge+285 … edge+940, the same ring
    // the tile-level decal paints — v2.65: per-city edges now) grows
    // CLUMPED STANDS of trees, not an orchard grid: a woodland reads as
    // clumps. 3-6 stands per 500 m chunk, each 9-18 trees across ~150 m,
    // so walking out of town crosses a real tree line before the open
    // pastures (~4x the first pass's sparse scatter, which read as 'a few
    // trees'). addTree's own guards still apply to every tree (off the
    // plate, off roads, dry land only).
    if (nearC.city && nearC.d < subEdge(nearC.city) + 940 + CH * .75) {
      const stands = Math.round((3 + rnd() * 3) * mobF);
      for (let s = 0; s < stands; s++) {
        const sx = x0 + rnd() * CH, sz = z0 + rnd() * CH;
        const sd = pastEdge(sx, sz);
        if (sd < 285 || sd > 940) continue;   // v2.42: past the suburbs · v2.65: per-city edge
        const cnt = 9 + Math.floor(rnd() * 10);
        for (let i = 0; i < cnt; i++) {
          const bx = sx + (rnd() - .5) * 150, bz = sz + (rnd() - .5) * 150;
          const bd = pastEdge(bx, bz);
          if (bd > 285 && bd < 940) addTree(B, bx, bz, .95 + rnd() * .65, rnd);   // v2.42 · v2.65
        }
      }
    }
    if (!insideCity) {
      const groves = Math.round((rnd() < .55 ? 1 + Math.floor(rnd() * 2) : 0) * mobF);
      for (let gi = 0; gi < groves; gi++) {
        const gx = x0 + 60 + rnd() * (CH - 120), gz = z0 + 60 + rnd() * (CH - 120);
        const cnt = 4 + Math.floor(rnd() * 7);
        for (let i = 0; i < cnt; i++) {
          addTree(B, gx + (rnd() - .5) * 90, gz + (rnd() - .5) * 90, .7 + rnd() * .9, rnd);
        }
      }
      const lone = Math.floor((rnd() < .6 ? 1 + rnd() * 5 : 0) * mobF);
      for (let i = 0; i < lone; i++) addTree(B, x0 + rnd() * CH, z0 + rnd() * CH, .6 + rnd() * .8, rnd);

      if (rnd() < .62) {   // fenced paddock with animals
        const w = 60 + rnd() * 90, d = 46 + rnd() * 70;
        const px = x0 + w / 2 + 20 + rnd() * Math.max(10, CH - w - 40);
        const pz = z0 + d / 2 + 20 + rnd() * Math.max(10, CH - d - 40);
        if (pastEdge(px, pz) > 335 && !nearRoad(px, pz, 26) &&   // v2.42: farms past the suburbs · v2.65: per-city edge
          !(LANDGEO.ready && (LANDGEO.isWaterWorld(px, pz) ||   // v2.36: whole footprint dry
            LANDGEO.isWaterWorld(px - w / 2, pz - d / 2) || LANDGEO.isWaterWorld(px + w / 2, pz - d / 2) ||
            LANDGEO.isWaterWorld(px - w / 2, pz + d / 2) || LANDGEO.isWaterWorld(px + w / 2, pz + d / 2)))) {
          buildPaddock(B, px, pz, w, d, rnd, mobF);
        }
      }
      const rocks = Math.floor((2 + rnd() * 6) * mobF);
      for (let i = 0; i < rocks; i++) {
        const rx = x0 + rnd() * CH, rz = z0 + rnd() * CH;
        if (pastEdge(rx, rz) < 335 || nearRoad(rx, rz, 8)) continue;   // v2.42 · v2.65
        if (LANDGEO.ready && LANDGEO.isWaterWorld(rx, rz)) continue;   // v2.18
        const s = .5 + rnd() * 1.6;
        const g = new THREE.IcosahedronGeometry(s, 0);
        B.addGeo(g, trs(rx, s * .35, rz, rnd() * 3.14, 1, .7 + rnd() * .5, 1), col(0x8a8578));
      }
      if (rnd() < .13) {   // pond
        const px = x0 + 60 + rnd() * (CH - 120), pz = z0 + 60 + rnd() * (CH - 120);
        if (pastEdge(px, pz) > 335 && !nearRoad(px, pz, 20) &&   // v2.42 · v2.65
          !(LANDGEO.ready && LANDGEO.isWaterWorld(px, pz))) {   // v2.18
          const g = new THREE.CircleGeometry(9 + rnd() * 9, 18); g.rotateX(-Math.PI / 2);
          B.addGeo(g, trs(px, .040, pz, 0, 1, 1, 1), col(0x3479bd));   // v2.44 PATCHWORK: above the farm quilt (.028) so ponds keep their water over the fields
        }
      }
    }
    if (B.count < 6) return;
    const mesh = B.mesh();            // carries (xm, 0, zm) itself — city-local frame
    const cg = new THREE.Group();
    cg.add(mesh);
    group.add(cg);
    chunks.set(key, cg);
  }

  function addTree(B, x, z, s, rnd) {
    // v2.42: no wild trees inside the city OR its suburb ring (yard trees
    // come from the suburb builder instead). v2.65: the ring is the
    // nearest city's OWN edge + the same 285 m margin.
    if (pastEdge(x, z) < 285 || nearRoad(x, z, 8)) return;
    if (LANDGEO.ready && LANDGEO.isWaterWorld(x, z)) return;   // v2.18: trees don't grow at sea
    const pine = rnd() < .42;
    const trunk = new THREE.CylinderGeometry(.22 * s, .3 * s, 2.2 * s, 6);
    B.addGeo(trunk, trs(x, 1.1 * s, z, rnd() * 3.14, 1, 1, 1), col(0x6b4f33));
    if (pine) {
      const c1 = new THREE.ConeGeometry(1.7 * s, 3.4 * s, 7);
      B.addGeo(c1, trs(x, 3.6 * s, z, rnd() * 3.14, 1, 1, 1), col(0x2f6b34));
    } else {
      const c1 = new THREE.IcosahedronGeometry(1.75 * s, 0);
      B.addGeo(c1, trs(x, 3.1 * s, z, rnd() * 3.14, 1, .95, 1), col(rnd() < .5 ? 0x3d7f36 : 0x4c8f3e));
    }
  }

  function buildPaddock(B, px, pz, w, d, rnd, mobF) {
    const hx = w / 2, hz = d / 2;
    const postG = new THREE.BoxGeometry(.16, 1.15, .16);
    const nPosts = Math.max(8, Math.floor((2 * (w + d)) / 4.2));
    const fcol = col(0x8a6f4d);
    for (let i = 0; i < nPosts; i++) {
      const t = (i / nPosts) * 4;    // walks the rectangle perimeter
      let fx, fz;
      if (t < 1) { fx = -hx + t * w; fz = -hz; }
      else if (t < 2) { fx = hx; fz = -hz + (t - 1) * d; }
      else if (t < 3) { fx = hx - (t - 2) * w; fz = hz; }
      else { fx = -hx; fz = hz - (t - 3) * d; }
      B.addGeo(postG, trs(px + fx, .58, pz + fz, 0, 1, 1, 1), fcol);
    }
    for (const [rx, rz, rw, rd] of [[0, -hz, w, 0], [0, hz, w, 0], [hx, 0, 0, d], [-hx, 0, 0, d]]) {
      for (const h of [.42, .88]) {
        const g = new THREE.BoxGeometry(rw ? rw : .06, .075, rd ? rd : .06);
        B.addGeo(g, trs(px + rx, h, pz + rz, 0, 1, 1, 1), col(0x9c7f57));
      }
    }
    const cows = rnd() < .55;
    const nAnim = Math.max(1, Math.round((1 + rnd() * 4) * mobF));
    for (let i = 0; i < nAnim; i++) {
      const ax = px + (rnd() - .5) * (w - 8), az = pz + (rnd() - .5) * (d - 8);
      addAnimal(B, ax, az, cows ? 'cow' : 'sheep', rnd);
    }
    const hay = Math.round(rnd() * 3 * mobF);
    for (let i = 0; i < hay; i++) {
      const hx2 = px + (rnd() < .5 ? hx + 2.4 : -hx - 2.4), hz2 = pz + (rnd() - .5) * d;
      const g = new THREE.CylinderGeometry(.8, .8, 1.3, 9);
      B.addGeo(g, trs(hx2, .8, hz2, 0, 1, 1, 1, Math.PI / 2), col(0xc9a44c));
    }
    if (rnd() < .3) {   // barn beside the paddock
      const bx = px + hx + 9, bz = pz + (rnd() - .5) * d * .5;
      if (distToCity(bx, bz).d > CITY_R + 60 && !nearRoad(bx, bz, 12)) {
        const body = new THREE.BoxGeometry(9, 4.4, 7);
        B.addGeo(body, trs(bx, 2.2, bz, rnd() * 3.14, 1, 1, 1), col(0x9e4b3a));
        const roof = new THREE.CylinderGeometry(5.2, 5.2, 9.6, 3, 1, false, 0, Math.PI);
        B.addGeo(roof, trs(bx, 5.6, bz, 0, 1, 1, 1, 0, Math.PI / 2), col(0x5b5f66));
        const door = new THREE.BoxGeometry(2.6, 3, .3);
        B.addGeo(door, trs(bx, 1.5, bz + 3.6, 0, 1, 1, 1), col(0x4a3326));
      }
    }
  }

  function addAnimal(B, x, z, kind, rnd) {
    const cow = kind === 'cow';
    const s = cow ? 1 : .72;
    const a = rnd() * 3.14;
    const body = new THREE.BoxGeometry(1.5 * s, .85 * s, .78 * s);
    B.addGeo(body, trs(x, .95 * s, z, a, 1, 1, 1), col(cow ? 0xe8e4dc : 0xd8d4c8));
    const head = new THREE.BoxGeometry(.5 * s, .5 * s, .46 * s);
    B.addGeo(head, trs(x + Math.sin(a) * .95 * s, 1.25 * s, z + Math.cos(a) * .95 * s, a, 1, 1, 1), col(cow ? 0xc9b8a4 : 0x555049));
    for (const [lx, lz] of [[-.55, -.3], [.55, -.3], [-.55, .3], [.55, .3]]) {
      const leg = new THREE.BoxGeometry(.16 * s, .6 * s, .16 * s);
      B.addGeo(leg, trs(x + lx * s, .3 * s, z + lz * s, 0, 1, 1, 1), col(cow ? 0xc9b8a4 : 0x555049));
    }
    if (cow && rnd() < .5) {
      const p = new THREE.BoxGeometry(.5 * s, .3 * s, .82 * s);
      B.addGeo(p, trs(x + (rnd() - .5) * .6, 1.05 * s, z, 0, 1, 1, 1), col(0x4a443e));
    }
  }

  function disposeChunk(key) {
    const cg = chunks.get(key);
    if (!cg) return;
    cg.traverse(o => { if (o.geometry) { try { o.geometry.dispose(); } catch (e) { } } });
    if (cg.parent) cg.parent.remove(cg);
    chunks.delete(key);
  }

  // ---------------- distant city beacons ------------------------------
  // v2.16 CLEAN HORIZON: the fake skyline boxes and the big floating
  // name banners are removed. What remains is a small green beacon
  // above each city where the player OWNS land — enough to spot your
  // holdings from afar without dressing the horizon in buildings that
  // aren't really there. City names live on the minimap / big map [M].
  // v2.22 WAYFINDING: a small beacon marks EVERY city — green where you
  // own land, sky-blue everywhere else — so a 5 km walk between cities
  // always has a visible destination. Beacons grow slightly with distance
  // (far = easier to spot, near = out of the way). A small map-style name
  // tag rides above each beacon and fades in ONLY when the camera is
  // zoomed out to study the region — street level stays clean (the big
  // letter billboards stay gone).
  function cityLabelTex(name) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(10,22,34,.62)';
    const r = 12, W = 256, H = 64;
    ctx.beginPath();
    ctx.moveTo(r, 2); ctx.lineTo(W - r, 2); ctx.quadraticCurveTo(W - 2, 2, W - 2, r + 2);
    ctx.lineTo(W - 2, H - r - 2); ctx.quadraticCurveTo(W - 2, H - 2, W - r, H - 2);
    ctx.lineTo(r, H - 2); ctx.quadraticCurveTo(2, H - 2, 2, H - r - 2);
    ctx.lineTo(2, r + 2); ctx.quadraticCurveTo(2, 2, r, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,225,255,.5)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = '700 26px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 5;
    ctx.fillStyle = '#eaf4ff';
    ctx.fillText(name, W / 2, H / 2 + 1);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function buildMarkers() {
    for (const c of CITIES) {
      const g = new THREE.Group();
      const dot = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x74b9e8, transparent: true, opacity: .78, fog: false, depthWrite: false }));
      dot.position.set(c.wx, 14, c.wz);
      g.add(dot);
      // v2.23: a tall light column too — the sphere sits at ground level,
      // which a bird's-eye camera pitched down never sees at multi-km
      // range. The pillar is visible from ANY angle and distance.
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 300, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x74b9e8, transparent: true, opacity: .15,
          fog: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      pil.position.set(c.wx, 150, c.wz);
      g.add(pil);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cityLabelTex(c.name), transparent: true, opacity: 0, fog: false, depthWrite: false }));
      label.scale.set(88, 22, 1);
      label.position.set(c.wx, 44, c.wz);
      g.add(label);
      group.add(g);
      markers.set(c.key, { group: g, dot, pil, label, city: c });
    }
  }

  // ---------------- v2.26 PRE-BUILT WORLD: distant-city skylines -------
  // Every catalog city already STANDS in the world at its real spot long
  // before the player arrives — no walk-in, no import needed to make it
  // EXIST. Each skyline is the city's true footprint (the real OSM data
  // when this browser has it cached, the deterministic local generator
  // otherwise — never a network call at build time), dry-land gated with
  // the same rules as the full build: nothing stands in water, asphalt
  // pulls back from the shoreline. Walking into a city (or arriving by
  // search / world map) still upgrades that spot to the fully detailed
  // city — plots, props, citizens — and leaving hands the horizon back to
  // the skyline, so the world never empties behind you. Not the old
  // v2.16 fake backdrop ring: these are the real 64 cities at their true
  // coordinates, consistent with what you walk into.
  let skyRoot = null;               // one group holding every skyline
  const skyBuilt = new Map();       // cityKey -> group
  let skyQueue = [];                // catalog cities not standing yet
  let skyLastT = 0;                 // throttle: one build per gate window
  let _skyMat = null;
  const SKY_GATE = isMob ? 110 : 45;    // ms between skyline builds
  // v2.27 TRUE SCALE: a catalog city's walkable core is its true ±360 m
  // OSM footprint — honest, but a dot on a 1:1 planet. The distant-city
  // skyline stands at METRO scale instead: the same true streets and
  // buildings spread ×10 around the anchor (roads and buildings keep
  // their true widths and heights) so from altitude a city reads as the
  // real sprawl of a metropolis — and walking in still upgrades the
  // dense true core you can actually play.
  // v2.65 CITY DNA: the spread is the CITY'S OWN — small towns read as
  // towns from orbit (×5.6–8.2), metros as true giants (×10.6–13).
  // SKY_SPREAD stays as the v2.64 reference value (what sub=1 rolls).
  const SKY_SPREAD = 10;

  function skyEnsure() {
    if (skyRoot) return;
    _skyMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    skyRoot = new THREE.Group();
    group.add(skyRoot);
    skyQueue = CITIES.slice();
  }
  function skyHide(key) { const g = skyBuilt.get(key); if (g) g.visible = false; }
  function skyShow(key) { const g = skyBuilt.get(key); if (g) g.visible = true; }

  function skyTick(px, pz, now) {
    if (!skyQueue.length || now - skyLastT < SKY_GATE) return;
    // nearest city first — the world fills in around you as you play
    let bi = 0, bd = Infinity;
    for (let i = 0; i < skyQueue.length; i++) {
      const c = skyQueue[i];
      const d = (px - c.wx) * (px - c.wx) + (pz - c.wz) * (pz - c.wz);
      if (d < bd) { bd = d; bi = i; }
    }
    const c = skyQueue.splice(bi, 1)[0];
    skyLastT = now;
    buildSkyline(c);   // even for the ACTIVE city: hidden while its full
                       // city stands, ready on the horizon when you leave
  }

  // v2.29: the skyline LAYOUT (data source + metro spread + dry-land
  // gate) is cached per city and shared with the road junctions — one
  // source of truth for what stands at a distant city. buildSkyline
  // meshes it; junctionEnd scans it for the road's far junction.
  const skyLayoutCache = new Map();   // cityKey -> {roads, buildings, greens, dsrc}
  const skyGrids = new Map();         // cityKey -> street grid of that layout
  function skyLayout(c, force) {
    if (!force && skyLayoutCache.has(c.key)) return skyLayoutCache.get(c.key);
    const meta = { key: c.key, name: c.name, lat: c.lat, lon: c.lon, tier: c.tier };
    let dsrc = 'osm';
    let data = null;
    try { data = OSM.cacheData(c.key); } catch (e) { }
    if (!data || !Array.isArray(data.roads) || !data.roads.length) { data = OSM.generateCity(meta); dsrc = 'gen'; }
    const ax = c.wx, az = c.wz;
    // v2.27: spread to metro scale AND keep the logic in world coords,
    // but the mesh itself is emitted ANCHOR-LOCAL (float32-safe at 1:1).
    // v2.65 CITY DNA: the spread is per-city (dna.spread).
    const spread = cityDNA(c).spread;
    const shift = pts => pts.map(p => [p[0] * spread + ax, p[1] * spread + az]);
    let roads = (data.roads || []).map(r => ({ ...r, pts: shift(r.pts) }));
    let buildings = (data.buildings || []).map(b => ({ ...b, poly: shift(b.poly) }));
    let greens = (data.greens || []).map(g => ({ ...g, poly: shift(g.poly) }));
    // ---- v2.20 DRY LAND, skyline edition: the same rule as the full
    // city build — nothing in the water, streets pull back from the
    // shoreline (compact variant: 24 m densification, ~60 m decimation)
    if (LANDGEO.ready) {
      const wet = (x, z) => LANDGEO.isWaterWorld(x, z);
      const densify = (pts, step) => {
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
      const shorePt = (p, q) => {
        let a = p, b = q, wa = wet(p[0], p[1]);
        for (let k = 0; k < 8; k++) {
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (wet(m[0], m[1]) === wa) a = m; else b = m;
        }
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      };
      const pulled = (shore, interior, w) => {
        const dx = interior[0] - shore[0], dz = interior[1] - shore[1];
        const L = Math.hypot(dx, dz) || 1;
        const m = Math.min(w / 2 + 2.5, L * .45);
        return [shore[0] + dx / L * m, shore[1] + dz / L * m];
      };
      const kept = [];
      for (const r of roads) {
        const dp = densify(r.pts, 24);
        const runs = [];
        let run = null;
        for (let i = 0; i < dp.length; i++) {
          if (!wet(dp[i][0], dp[i][1])) {
            if (!run) { run = { i0: i, pts: [] }; runs.push(run); }
            run.pts.push(dp[i]);
          } else run = null;
        }
        for (const seg of runs) {
          const out = seg.pts.slice();
          if (seg.i0 > 0) out.unshift(pulled(shorePt(dp[seg.i0 - 1], dp[seg.i0]), seg.pts[0], r.w));
          const iEnd = seg.i0 + seg.pts.length - 1;
          if (iEnd < dp.length - 1) out.push(pulled(shorePt(dp[iEnd], dp[iEnd + 1]), seg.pts[seg.pts.length - 1], r.w));
          if (out.length >= 2) {
            const dec = [out[0]];
            let acc = 0;
            for (let k = 1; k < out.length - 1; k++) {
              acc += Math.hypot(out[k][0] - dec[dec.length - 1][0], out[k][1] - dec[dec.length - 1][1]);
              if (acc >= 60) { dec.push(out[k]); acc = 0; }
            }
            dec.push(out[out.length - 1]);
            kept.push({ ...r, pts: dec });
          }
        }
      }
      roads = kept;
      const solid = poly => {
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
      const polyDry = poly => {
        for (const p of poly) if (wet(p[0], p[1])) return false;
        return true;
      };
      buildings = buildings.filter(b => b.poly && b.poly.length >= 3 && solid(b.poly) && polyDry(b.poly));
      greens = greens.filter(g => g.poly && g.poly.length >= 3 && solid(g.poly) && polyDry(g.poly));
    }
    const out = { roads, buildings, greens, dsrc };
    skyLayoutCache.set(c.key, out);
    skyGrids.delete(c.key);   // layout changed → the junction grid rebuilds
    return out;
  }
  // the skyline layout's street grid — what a far road junction answers to
  function skyGridFor(c) {
    let g = skyGrids.get(c.key);
    if (!g) { g = streetGridFor(skyLayout(c).roads); skyGrids.set(c.key, g); }
    return g;
  }

  function buildSkyline(c, force) {
    const old = skyBuilt.get(c.key);
    if (old && !force) return;
    if (old) disposeSkyGroup(old);
    if (!skyRoot) return;
    // v2.29: shared layout (cached real data / generator + metro spread
    // + dry-land gate) — the road junctions read the same streets
    const lay = skyLayout(c, force);
    const dsrc = lay.dsrc;
    const ax = c.wx, az = c.wz;
    let roads = lay.roads, buildings = lay.buildings, greens = lay.greens;
    // ---- the skyline mesh: ONE vertex-colored geometry per city -------
    // fog:false (like the city beacons) so a distant city reads through
    // the haze from any altitude; buildings keep their true footprints
    // and heights — downtown towers included. v2.27: all vertices are
    // ANCHOR-LOCAL; the group carries the absolute anchor position.
    const P = [], N = [], C = [];
    // flat up-facing triangle (plates, roads, parks, roofs)
    const tri = (a, b, c2, y, cc) => {
      for (const p of [a, b, c2]) { P.push(p[0] - ax, y, p[1] - az); N.push(0, 1, 0); C.push(cc[0], cc[1], cc[2]); }
    };
    const jit = (c2, f) => [c2[0] * f, c2[1] * f, c2[2] * f];
    const BASES = [0x8a857c, 0x7f7a72, 0x767d84, 0x918672, 0x6f7278, 0x83766a];   // v2.31: darker CR masses — silhouettes read against the bright taupe land
    // ground plate: dry tiles only, a hair above the land shield
    // (v2.27: the plate spans the METRO footprint — spread × 1490 m;
    //  v2.65: that spread is the city's own)
    const cPlate = col(0x7f7a6c);   // v2.33: warm urban gray, darker against the vivid grass — CR masses read DARK on bright land
    {
      const size = 1490 * cityDNA(c).spread, NT = 12, T = size / NT;
      for (let i = 0; i < NT; i++) for (let j = 0; j < NT; j++) {
        const x0 = ax - size / 2 + i * T, z0 = az - size / 2 + j * T;
        const x1 = x0 + T, z1 = z0 + T;
        if (LANDGEO.ready && (LANDGEO.isWaterWorld(x0, z0) || LANDGEO.isWaterWorld(x1, z0) ||
          LANDGEO.isWaterWorld(x0, z1) || LANDGEO.isWaterWorld(x1, z1) ||
          LANDGEO.isWaterWorld((x0 + x1) / 2, (z0 + z1) / 2))) continue;
        const f = .96 + (hashStr(c.key + i + ',' + j) % 100) / 1000 * .09;
        const cc = jit(cPlate, f);
        tri([x0, z1], [x1, z1], [x1, z0], .05, cc);
        tri([x0, z1], [x1, z0], [x0, z0], .05, cc);
      }
    }
    // parks: flat green patches
    const cGreen = col(0x4e7a44);
    for (const g of greens) {
      const n = g.poly.length;
      let cx = 0, cz = 0;
      for (const p of g.poly) { cx += p[0]; cz += p[1]; }
      cx /= n; cz /= n;
      const cc = jit(cGreen, .9 + (hashStr(c.key + 'g' + n) % 100) / 1000 * .25);
      for (let i = 0; i < n; i++) {
        tri([cx, cz], g.poly[i], g.poly[(i + 1) % n], .26, cc);
      }
    }
    // streets: asphalt ribbons, true widths, pulled back from water
    const cRoad = col(0x393c40);
    for (const r of roads) {
      const w = Math.min(17, Math.max(5, r.w || 9));
      const f = .9 + (hashStr(c.key + 'r' + (r.name || '')) % 100) / 1000 * .2;
      const cc = jit(cRoad, f);
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [a2, a3] = r.pts[i], [b2, b3] = r.pts[i + 1];
        const dx = b2 - a2, dz = b3 - a3, L = Math.hypot(dx, dz) || 1;
        let sw = w;
        if (LANDGEO.ready) {
          // v2.26: a dry centerline can still overhang the water by half
          // the ribbon width on shore-hugging streets — shrink the ribbon
          // until its corners are dry too (nothing renders in the water)
          const okW = w2 => {
            const qx = -dz / L * w2 / 2, qz = dx / L * w2 / 2;
            return !LANDGEO.isWaterWorld(a2 + qx, a3 + qz) && !LANDGEO.isWaterWorld(a2 - qx, a3 - qz) &&
              !LANDGEO.isWaterWorld(b2 + qx, b3 + qz) && !LANDGEO.isWaterWorld(b2 - qx, b3 - qz);
          };
          if (!okW(sw)) {
            if (okW(w / 2)) sw = w / 2;
            else if (okW(w / 4)) sw = w / 4;
            else if (okW(2.5)) sw = 2.5;
            else continue;   // hugging the waterline tighter than 2.5 m — drop the sliver
          }
        }
        const px = -dz / L * sw / 2, pz = dx / L * sw / 2;
        tri([a2 + px, a3 + pz], [b2 + px, b3 + pz], [b2 - px, b3 - pz], .3, cc);
        tri([a2 + px, a3 + pz], [b2 - px, b3 - pz], [a2 - px, a3 - pz], .3, cc);
      }
    }
    // buildings: true footprints extruded to true heights
    const cRoof = col(0x53565a);
    for (let bi2 = 0; bi2 < buildings.length; bi2++) {
      const b = buildings[bi2];
      const poly = b.poly, n = poly.length;
      if (n < 3) continue;
      const hv = hashStr(c.key + '|' + (b.bkey !== undefined ? b.bkey : 'b' + bi2));
      const wall = jit(col(BASES[hv % BASES.length]), .9 + Math.floor(hv / 7) % 100 / 1000 * .18);
      const roof = jit(cRoof, .9 + hv % 100 / 1000 * .2);
      let h = isFinite(b.h) ? b.h : 8 + hv % 100 / 100 * 26;
      h = Math.min(120, Math.max(4, h));
      h *= 4;   // v2.31: distance LOD — true-size walls are sub-pixel at multi-km
                // range (the "skylines read flat" report); ×4 keeps a readable
                // silhouette, and walk-in/travel swaps in the true-height city
      const y0 = .3, y1 = y0 + h;
      let cx = 0, cz = 0;
      for (const p of poly) { cx += p[0]; cz += p[1]; }
      cx /= n; cz /= n;
      for (let i = 0; i < n; i++) {
        const p1 = poly[i], p2 = poly[(i + 1) % n];
        // wall quad (two tris sharing the p1-bottom → p2-top diagonal),
        // horizontal edge normal — DoubleSide keeps the winding safe for
        // either footprint orientation
        const ex = p2[0] - p1[0], ez = p2[1] - p1[1];
        const el = Math.hypot(ex, ez) || 1;
        const nx = ez / el, nz = -ex / el;
        const vb = [wall[0], wall[1], wall[2]], vt = [wall[0] * .94, wall[1] * .94, wall[2] * .94];
        const vTri = (pA, yA, cA, pB, yB, cB, pC2, yC2, cC2) => {
          P.push(pA[0] - ax, yA, pA[1] - az); N.push(nx, 0, nz); C.push(cA[0], cA[1], cA[2]);
          P.push(pB[0] - ax, yB, pB[1] - az); N.push(nx, 0, nz); C.push(cB[0], cB[1], cB[2]);
          P.push(pC2[0] - ax, yC2, pC2[1] - az); N.push(nx, 0, nz); C.push(cC2[0], cC2[1], cC2[2]);
        };
        vTri(p1, y0, vb, p2, y0, vb, p2, y1, vt);
        vTri(p1, y0, vb, p2, y1, vt, p1, y1, vt);
        // roof fan
        tri([cx, cz], poly[i], poly[(i + 1) % n], y1, roof);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const mesh = new THREE.Mesh(geo, _skyMat);
    mesh.renderOrder = RO_SKY;   // v2.37 flat-ground ladder: distant city masses beat the land at any zoom
    const g = new THREE.Group();
    g.add(mesh);
    g.position.set(ax, 0, az);   // v2.27: anchor-local geometry, absolute group
    g.userData.skySrc = dsrc;
    skyRoot.add(g);
    skyBuilt.set(c.key, g);
    if (activeCity && activeCity.key === c.key) g.visible = false;
  }

  function disposeSkyGroup(g) {
    g.traverse(o => { if (o.geometry) { try { o.geometry.dispose(); } catch (e) { } } });
    if (g.parent) g.parent.remove(g);
  }

  // ---------------- city chunk streaming ------------------------------
  async function setCity(data, meta, onStatus) {
    clearCity();
    const c = CITIES.find(x => x.key === meta.key);
    let anchor = c ? { x: c.wx, z: c.wz } : (worldAnchorOf(meta.key) || { x: 0, z: 0 });
    // v2.19: a searched/settled spot whose anchor is in the water slides
    // to the nearest shore (catalog cities were snapped at boot)
    if (LANDGEO.ready && LANDGEO.isWaterWorld(anchor.x, anchor.z)) {
      const nl = LANDGEO.nearestLandWorld(anchor.x, anchor.z, DEG_M * 2.55);
      if (nl) anchor = nl;
    }
    const g = await CITY.build(data, meta, anchor, onStatus);
    scene.add(g);
    activeCity = { key: meta.key, meta, anchor };
    curRegion = meta.key;
    const mk = markers.get(meta.key);
    if (mk) mk.group.visible = false;
    skyHide(meta.key);     // v2.26: the full city replaces the skyline
    // v2.29: the roads meet the REAL streets while this city stands
    try { roadJunction(meta.key, CITY.roads); } catch (e) { console.error('[roadJunction]', e); }
    // v2.26: arriving with REAL map data upgrades that city's skyline
    // from the generator look to the true footprint — so the horizon
    // stays accurate after you leave (runs behind the travel veil)
    if (c && data && data.source === 'osm' && !data.pasture) {
      const sg = skyBuilt.get(meta.key);
      if (!sg || sg.userData.skySrc !== 'osm') buildSkyline(c, true);
    }
    return anchor;
  }
  function clearCity() {
    if (!activeCity) return null;
    if (CITY.group && CITY.group.parent) CITY.group.parent.remove(CITY.group);
    CITY.dispose();
    const mk = markers.get(activeCity.key);
    if (mk) mk.group.visible = true;
    skyShow(activeCity.key);   // v2.26: the skyline stands back up as you leave
    // v2.29: the junctions hand back to the skyline's streets
    const leavingKey = activeCity.key;
    try { roadJunction(leavingKey, null); } catch (e) { console.error('[roadJunction]', e); }
    const was = activeCity;
    activeCity = null;
    curRegion = 'rural';
    return was;
  }

  // ---------------- per-frame -----------------------------------------
  function update(dt, px, pz, camDist) {
    if (!inited) return null;
    const now = performance.now();
    let req = null;
    // v2.36: the detail neighborhood follows the VIEW. The pan leash is
    // gone, so pasture chunks, world edges and skyline pre-builds stream
    // around wherever the camera is actually looking (the character's
    // neighborhood while following, the panned focus while roaming);
    // city streaming below still tracks the PLAYER.
    const fx = camCtl.follow ? px : camCtl.tx, fz = camCtl.follow ? pz : camCtl.tz;
    skyTick(fx, fz, now);   // v2.26: pre-build the world's cities, nearest first

    if (now - lastChunkUpd > 400) {
      lastChunkUpd = now;
      for (const rec of edges) {
        const vis = fx > rec.bbox[0] - 12000 && fx < rec.bbox[1] + 12000 && fz > rec.bbox[2] - 12000 && fz < rec.bbox[3] + 12000;
        if (rec.group.visible !== vis) rec.group.visible = vis;
      }
      const c0x = Math.floor((fx - CHUNK_R) / CH), c1x = Math.floor((fx + CHUNK_R) / CH);
      const c0z = Math.floor((fz - CHUNK_R) / CH), c1z = Math.floor((fz + CHUNK_R) / CH);
      const want = new Set();
      for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) want.add(cx + ',' + cz);
      for (const key of [...chunks.keys()]) {
        if (want.has(key)) continue;
        const [cx, cz] = key.split(',').map(Number);
        if (Math.abs(cx * CH + CH / 2 - fx) > CHUNK_R + 450 || Math.abs(cz * CH + CH / 2 - fz) > CHUNK_R + 450) disposeChunk(key);
      }
      chunkQueue = [...want].filter(k => !chunks.has(k))
        .map(k => { const [cx, cz] = k.split(',').map(Number); return { k, cx, cz, d: Math.hypot(cx * CH + CH / 2 - fx, cz * CH + CH / 2 - fz) }; })
        .sort((a, b) => a.d - b.d);
    }
    for (let i = 0; i < 2 && chunkQueue.length; i++) {
      const job = chunkQueue.shift();
      buildChunk(job.cx, job.cz);
    }

    // city streaming + region tracking (the economy region follows the
    // player: inside a built city's footprint → that city; else → rural)
    const near = distToCity(px, pz);
    let dOwn = activeCity ? Math.hypot(px - activeCity.anchor.x, pz - activeCity.anchor.z) : 1e9;
    // v2.42: the region holds through the neighborhoods — carts don't
    // vanish while you walk the burbs. v2.65 CITY DNA: the hold runs to
    // THIS city's own suburb edge (was a flat CITY_R+1615).
    const holdR = activeCity ? cityDNA(activeCity.meta).subR1 : 0;
    const wantRegion = (activeCity && dOwn <= holdR) ? activeCity.key : 'rural';
    if (wantRegion !== curRegion) {
      curRegion = wantRegion;
      req = { type: 'region', region: wantRegion };
    }
    if (activeCity) {
      // v2.65: streams out past THIS city's suburb edge + 540 (was the
      // flat 2900 — same number whenever the DNA rolls sub=1)
      const leaveD = holdR + 540;
      if (dOwn > leaveD && near.d > BUILD_DIST) {
        clearCity();
        dOwn = 1e9;
        req = { type: 'leftCity' };
      } else if (near.d < BUILD_DIST && near.city && near.city.key !== activeCity.key
        && dOwn > CITY_R) {
        // v2.22 CITY SWAP: the player is within sight of a DIFFERENT city
        // while this one is still active. Leave can never fire here (it
        // needs near.d > BUILD_DIST), so swap straight to the new city.
        // Guard dOwn > CITY_R keeps a player standing mid-town from being
        // yanked to a neighbour — only a player past the edge swaps.
        clearCity();
        dOwn = 1e9;
        pendingCity = near.city;
        req = { type: 'enterCity', city: near.city };
      }
    } else if (!pendingCity && near.d < BUILD_DIST) {
      pendingCity = near.city;
      req = { type: 'enterCity', city: near.city };
    }

    if (now - lastMarkerUpd > 250) {
      lastMarkerUpd = now;
      const owned = new Set(STATE.plots.map(p => p.cityKey));
      // v2.27 TRUE SCALE: beacons, pillars and labels scale with ALTITUDE
      // so they stay readable from a 30 km study view while looking
      // city-sized from the ground. v2.37: kf stays capped for the
      // street-sized cues (pillars, labels), but the DOT scales with the
      // altitude uncapped (kd) so every city keeps a visible dot on the
      // 23,000 km whole-world view; labels fade out past ~2,000 km where
      // a capped 9.5 km tag would be subpixel mush.
      const kf = Math.max(1, Math.min(36, camDist / 850));
      const kd = Math.max(1, camDist / 850);   // v2.37: uncapped — dots visible from orbit
      markers.forEach((mk, key) => {
        if (activeCity && key === activeCity.key) { mk.group.visible = false; return; }
        const d = Math.hypot(px - mk.city.wx, pz - mk.city.wz);
        const vis = d > 620;
        mk.group.visible = vis;
        if (!vis) return;
        const own = owned.has(key);
        mk.dot.visible = true;                      // v2.22: every city has a beacon
        mk.dot.material.color.setHex(own ? 0x48bb78 : 0x74b9e8);   // v2.31: CR sky-blue markers (owned stays money-green)
        mk.dot.material.opacity = own ? .9 : .78;
        const ms = Math.min(4.2, 1 + d / 2200) * kd;   // far = easier to spot (dot rides kd: visible at ANY altitude)
        mk.dot.scale.setScalar(ms);
        if (mk.pil) {                                 // v2.23: tall light column
          mk.pil.material.color.setHex(own ? 0x48bb78 : 0x74b9e8);
          mk.pil.material.opacity = own ? .26 : .15;   // v2.31: softer pillar — reads as a waypoint, not a debug line
          mk.pil.scale.set(ms, Math.min(2.4 * kf, .9 + d / 2600), ms);
          mk.pil.position.y = 150 * Math.min(1, kf / 4);
        }
        if (mk.label) {
          const ls = Math.min(3, 1 + d / 3000) * kf;    // tags stay readable far out
          mk.label.scale.set(88 * ls, 22 * ls, 1);
          mk.label.position.y = 44 * Math.min(1, kf / 3);
          // v2.37: fade out past ~2,000 km — a capped 9.5 km tag is
          // subpixel mush from the whole-world view (the dots carry it)
          mk.label.material.opacity = (camDist > 560 && d > 880)
            ? .92 * THREE.MathUtils.clamp((2e6 - camDist) / 1.1e6, 0, 1) : 0;
        }
      });
    }
    return req;
  }

  // ---------------- queries -------------------------------------------
  function plotAt(x, z) {
    for (const rec of edges) {
      if (!rec.group.visible) continue;
      for (const p of rec.plotRecs) {
        const dx = x - p.x, dz = z - p.z;
        const c = Math.cos(p.rot), s = Math.sin(p.rot);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) <= p.w / 2 && Math.abs(lz) <= p.d / 2) return p;
      }
    }
    return null;
  }
  function plots() {
    const out = [];
    for (const rec of edges) if (rec.group.visible) out.push(...rec.plotRecs);
    return out;
  }
  function randomRoadPoint(rnd, px, pz) {
    const vis = edges.filter(e => e.group.visible);
    if (vis.length) {
      const rec = vis[Math.floor(rnd() * vis.length)];
      const i = Math.floor(rnd() * (rec.poly.length - 1));
      const t = rnd();
      const [ax, az] = rec.poly[i], [bx, bz] = rec.poly[i + 1];
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, rd: { name: rec.name } };
    }
    return { x: (px || 0) + 30, z: (pz || 0), rd: { name: '' } };
  }
  function nearestRoadInfo(x, z) {
    let best = 1e9, name = '';
    for (const rec of edges) {
      if (!rec.group.visible) continue;
      for (let i = 0; i < rec.poly.length; i++) {
        const d = Math.hypot(rec.poly[i][0] - x, rec.poly[i][1] - z);
        if (d < best) { best = d; name = rec.name; }
      }
    }
    return best < 260 ? { d: best, name } : null;
  }
  function nearestCityInfo(x, z) {
    const { d, city } = distToCity(x, z);
    return { d, city };
  }
  function clampToBounds(x, z) {
    return [THREE.MathUtils.clamp(x, WORLD_BOUNDS.x0 + 26, WORLD_BOUNDS.x1 - 26),
      THREE.MathUtils.clamp(z, WORLD_BOUNDS.z0 + 26, WORLD_BOUNDS.z1 - 26)];
  }

  // ---------------- minimap data ---------------------------------------
  function mapData() {
    return {
      bounds: WORLD_BOUNDS,
      cities: CITIES.map(c => ({
        x: c.wx, z: c.wz, name: c.name, tier: c.tier, key: c.key,
        owned: STATE.plots.some(p => p.cityKey === c.key),
        active: !!(activeCity && activeCity.key === c.key),
      })),
      // v2.18: the real routed road polylines (world coords, bridges flagged)
      // v2.29: name included — the QA probe matches tails to edges by it
      edges: edges.map(rec => ({ poly: rec.poly, bridge: rec.bridge, name: rec.name })),
      conts: WORLD_CONTS,
    };
  }

  // ---------------- init -----------------------------------------------
  function ensure(sc) {
    if (inited) return;
    scene = sc;
    group = new THREE.Group();
    sc.add(group);
    buildGround();
    buildEdges();
    finalizeTiles();     // v2.27: the filled tiles become meshes
    buildMarkers();
    skyEnsure();          // v2.26: the pre-built world starts filling in
    inited = true;
  }

  function disposeAll() {
    for (const key of [...chunks.keys()]) disposeChunk(key);
    chunkQueue = [];
    if (group && group.parent) group.parent.remove(group);
    group = null; inited = false; edges = []; markers = new Map();
    tiles.clear();      // v2.27: world tiles rebuild with the next ensure
    skyRoot = null; skyBuilt.clear(); skyQueue = CITIES.slice();   // v2.26
  }

  // ---------------- v2.23: road routing for long walks -----------------
  // A far tap (or the WALK-TO pill) whose straight line crosses real
  // water follows the inter-city roads instead of stopping at the shore:
  // cities are graph nodes, the routed road polylines are the edges, and
  // the walker gets the concatenated waypoint list — bridges included,
  // their decks are walkable. Returns null when a route can't help.
  function routeTo(px, pz, gx, gz) {
    if (!edges.length || !LANDGEO.ready) return null;
    const dist = Math.hypot(gx - px, gz - pz);
    if (dist < 2000) return null;              // near — walk it straight
    let wet = false;
    for (let t = .08; t <= .92 && !wet; t += (DEG_M * .0455) / dist) {
      if (LANDGEO.isWaterWorld(px + (gx - px) * t, pz + (gz - pz) * t)) wet = true;
    }
    if (!wet) return null;                        // dry straight line — no route needed
    let gc = null, gd = 1e9;
    for (const c of CITIES) { const d = Math.hypot(c.wx - gx, c.wz - gz); if (d < gd) { gd = d; gc = c; } }
    if (!gc || gd > DEG_M * 4.73) return null;    // wilderness goal — no road there
    let sc = null, sd = 1e9;
    for (const c of CITIES) { const d = Math.hypot(c.wx - px, c.wz - pz); if (d < sd) { sd = d; sc = c; } }
    if (!sc || sc.key === gc.key) return null;    // same city — shore rules apply
    const adj = new Map();
    for (const e of edges) {
      const a = e.A.key, b = e.B.key;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push({ to: b, e });
      adj.get(b).push({ to: a, e });
    }
    if (!adj.has(sc.key) || !adj.has(gc.key)) return null;
    const seen = new Set([sc.key]);
    let seq = null;
    const q = [{ city: sc.key, seq: [] }];
    while (q.length && !seq) {
      const cur = q.shift();
      for (const n of (adj.get(cur.city) || [])) {
        if (seen.has(n.to)) continue;
        seen.add(n.to);
        const ns = cur.seq.concat(n.e);
        if (n.to === gc.key) { seq = ns; break; }
        q.push({ city: n.to, seq: ns });
      }
    }
    if (!seq || !seq.length) return null;
    // waypoints along the edge sequence, entering the first road at the
    // vertex nearest the player
    const wps = [];
    let prev = sc.key;
    for (const e of seq) {
      let poly = e.poly;
      const fwd = e.A.key === prev;
      if (!fwd) poly = poly.slice().reverse();
      prev = fwd ? e.B.key : e.A.key;
      let start = 0;
      if (!wps.length) {
        let bd = 1e9;
        for (let i = 0; i < poly.length; i++) {
          const d = Math.hypot(poly[i][0] - px, poly[i][1] - pz);
          if (d < bd) { bd = d; start = i; }
        }
      }
      for (let i = start; i < poly.length; i++) wps.push({ x: poly[i][0], z: poly[i][1] });
    }
    wps.push({ x: gx, z: gz });
    return wps;
  }

  return {
    ensure, update, setCity, clearCity, disposeAll, routeTo,
    plotAt, plots, randomRoadPoint, nearestRoadInfo, clampToBounds,
    nearestCityInfo, mapData, nearRoad,
    skyStats: () => ({ built: skyBuilt.size, queue: skyQueue.length,
      standing: [...skyBuilt.values()].filter(g => g.visible).length }),
    skyAt: key => {
      const g = skyBuilt.get(key);
      if (!g) return null;
      const m = g.children[0];
      return { visible: g.visible, tris: m && m.geometry ? m.geometry.attributes.position.count / 3 : 0 };
    },
    // v2.29: junction state of every land route's city ends (QA + tuning)
    roadTails: () => edges.filter(r => r.tail).map(r => {
      const endPt = end => {
        const E = r.tail[end];
        const p = cutAtArc(r.tail.full, r.tail.cum, r.tail.L, end === 'A' ? E.dEnd : r.tail.L - E.dEnd).p;
        return [+p[0].toFixed(1), +p[1].toFixed(1)];
      };
      return {
        name: r.name,
        A: { dEnd: +r.tail.A.dEnd.toFixed(1), cap: r.tail.A.cap, mesh: !!r.tail.A.mesh, at: endPt('A') },
        B: { dEnd: +r.tail.B.dEnd.toFixed(1), cap: r.tail.B.cap, mesh: !!r.tail.B.mesh, at: endPt('B') },
      };
    }),
    set pending(v) { pendingCity = v; },
    get pending() { return pendingCity; },
    get activeCity() { return activeCity; },
    get group() { return group; },
    get chunkCount() { return chunks.size; },
    get edgeCount() { return edges.length; },
    BUILD_DIST, LEAVE_DIST,
  };
})();
window.WORLD = WORLD;


// v2.17 BIRD'S EYE command camera: `follow` keeps the view riding on
// the character; panning (drag / WASD / joystick) detaches it, and any
// tap-to-move command — or FIND ME / [C] — re-attaches it.
export const camCtl = { az: Math.PI * .25, el: 1.25, dist: 110, distT: 110, tx: 0, tz: 0, follow: true };
