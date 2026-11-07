// ====================================================================
// js/world/osm.js — the Overpass/OSM street importer + local cache
// (Stage 6).
// ====================================================================
import { _mulberry, hashStr } from '../util.js';

// ======== section: 30_osm.js ========
// ======== section: 30_osm.js ========
// ====================================================================
// v2.0 — OSM: import real-world streets/buildings/greens via Overpass,
// project to local meters, cache, and generate a faithful procedural
// fallback city when the live map can't be reached. Map data
// © OpenStreetMap contributors (ODbL) — attribution ships in the UI.
// v2.04 — FAST CITY ENTRY: mirror-racing fetch (primary first, all
// mirrors after 1.8s, 9.5s cap), an in-flight promise memo so a dive
// reuses a fetch already started on hover/click, session prefetch
// dedup, and a 6-city cache. Entry no longer waits mirror-by-mirror.
// ====================================================================
export const OSM = (() => {
  const M_LAT = 110540, M_LONFN = lat => 111320 * Math.cos(lat * Math.PI / 180);
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  const ROAD_CLS = {
    motorway: [3, 18], trunk: [3, 17], primary: [3, 16.5],
    secondary: [2, 13], tertiary: [2, 11.5],
    residential: [1, 9.5], unclassified: [1, 9], living_street: [1, 8.5], pedestrian: [1, 11],
  };
  const HALF = 720;            // import half-extent in meters (~1.4km square)

  const proj = (lat, lon, clat, clon) => [
    (lon - clon) * M_LONFN(clat),
    -(lat - clat) * M_LAT,
  ];

  // ---------------- Overpass fetch (v2.04: staggered mirror race) -----
  // Primary mirror gets a 1.8s head start (polite: the happy path is a
  // single request). If it hasn't answered by then, ALL mirrors fire and
  // race — first valid payload wins, losers are aborted. Hard cap 9.5s
  // → procedural fallback (was: sequential tries × 22s timeout each).
  function fetchOverpass(bbox) {
    const q = `[out:json][timeout:25];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"](${bbox});
  way["building"](${bbox});
  way["leisure"~"^(park|garden|pitch|playground)$"](${bbox});
  way["landuse"~"^(grass|recreation_ground|village_green)$"](${bbox});
  way["natural"="water"](${bbox});
  way["waterway"="riverbank"](${bbox});
);
out geom;`;
    return new Promise(resolve => {
      const ctl = new AbortController();
      let settled = false, fired = 1, failed = 0, winnerEp = null;
      const t0 = performance.now();
      const finish = v => {
        if (settled) return;
        settled = true;
        clearTimeout(stagT); clearTimeout(capT);
        try { ctl.abort(); } catch (e) { }
        resolve(v ? { json: v, ms: Math.round(performance.now() - t0), ep: winnerEp } : null);
      };
      const attempt = ep => {
        fetch(ep, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: ctl.signal,
        }).then(r => r.ok ? r.json() : null)
          .then(j => {
            if (settled) return;
            if (j && j.elements && j.elements.length > 5) { winnerEp = ep; finish(j); }
            else if (++failed >= fired && fired >= ENDPOINTS.length) finish(null);
          })
          .catch(() => { if (!settled && ++failed >= fired && fired >= ENDPOINTS.length) finish(null); });
      };
      attempt(ENDPOINTS[0]);
      const stagT = setTimeout(() => {
        for (let i = 1; i < ENDPOINTS.length; i++) { fired++; attempt(ENDPOINTS[i]); }
      }, 1800);
      const capT = setTimeout(() => finish(null), 13000);   // v2.21: dense downtowns need the time
    });
  }

  // ---------------- parse + project ----------------
  function parseOSM(json, clat, clon) {
    const roads = [], buildings = [], greens = [], waters = [];
    for (const el of json.elements || []) {
      if (el.type !== 'way' || !el.geometry) continue;
      const pts = el.geometry.map(g => proj(g.lat, g.lon, clat, clon));
      const t = el.tags || {};
      if (t.highway) {
        const cls = ROAD_CLS[t.highway] || [1, 9];
        // keep reasonable segment counts (drop micro-fragments)
        roads.push({ pts, w: cls[1], cls: cls[0], ped: t.highway === 'pedestrian', name: t.name || '' });
      } else if (t.building) {
        if (pts.length < 4) continue;
        let h = parseFloat(t.height);
        if (!isFinite(h)) {
          const lv = parseFloat(t['building:levels']);
          h = isFinite(lv) ? lv * 3.2 : NaN;
        }
        buildings.push({ poly: pts, h, bkey: el.id, t });
      } else if (t.leisure || t.landuse) {
        if (pts.length >= 4) greens.push({ poly: pts });
      } else if (t.natural === 'water' || t.waterway === 'riverbank') {
        if (pts.length >= 4) waters.push({ poly: pts });
      }
    }
    return { roads, buildings, greens, waters };
  }

  // heights for buildings without tags (deterministic by bkey)
  function fillHeights(buildings, seedCityKey) {
    let sum = 0;
    buildings.forEach(b => {
      const a = Math.abs(polyArea(b.poly));
      sum += a;
      if (!isFinite(b.h)) {
        const r = _h(b.bkey, 7);
        const r2 = _h(b.bkey, 13);
        if (a > 2200) b.h = 28 + r * 66;         // big footprint → office tower
        else if (a > 900) b.h = 12 + r * 26;
        else b.h = 5 + r * 13 + (r2 > .8 ? 12 : 0);
      }
      b.h = Math.min(120, Math.max(4, b.h));
      b.area = a;
    });
    return sum;
  }
  const _h = (id, s) => { let h = (id | 0) ^ 0x9e3779b9 ^ (s * 2654435761); h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h ^= h >>> 13; return ((h >>> 0) % 1000) / 1000; };

  function polyArea(poly) {
    let a = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % n];
      a += x1 * z2 - x2 * z1;
    }
    return a / 2;
  }

  // ---------------- cache ----------------
  function cacheKey(id) { return 'ow2-osm-' + id; }
  function cacheGet(id) {
    try {
      const raw = localStorage.getItem(cacheKey(id));
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (d.fmt !== 3) return null;
      return d;
    } catch (e) { return null; }
  }
  function cachePut(id, data) {
    try {
      const raw = JSON.stringify({ ...data, fmt: 3, ts: Date.now() });
      if (raw.length > 3.6e6) return;    // too big for localStorage
      // prune: keep newest 6 ow2-osm-* entries (v2.04: was 4 — faster
      // re-entry for players hopping between a few cities)
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('ow2-osm-')) keys.push([k, JSON.parse(localStorage.getItem(k) || '{}').ts || 0]);
      }
      keys.sort((a, b) => b[1] - a[1]);
      keys.slice(6).forEach(([k]) => localStorage.removeItem(k));
      localStorage.setItem(cacheKey(id), raw);
    } catch (e) { /* quota */ }
  }

  // ---------------- in-flight memo (v2.04) ---------------------------
  // One network fetch per city no matter how many callers ask while it
  // is running (hover prefetch → dive kick → enterCity all share it).
  const _inflight = new Map();   // id -> { p, subs }
  const _prefetched = new Set(); // ids prefetched this session (one shot)

  function buildCity(meta, onStatus) {
    const id = meta.key || ('ll' + meta.lat.toFixed(3) + '_' + meta.lon.toFixed(3));
    const hit = _inflight.get(id);
    if (hit) { if (onStatus) hit.subs.push(onStatus); return hit.p; }
    const subs = onStatus ? [onStatus] : [];
    const emit = s => subs.forEach(f => { try { f(s); } catch (e) { } });
    const p = _buildCity(id, meta, emit).finally(() => _inflight.delete(id));
    _inflight.set(id, { p, subs });
    return p;
  }

  // fire-and-forget: warm the cache before the player commits (hover on
  // the globe, dive kick, boot prefetch of the last visited city)
  function prefetch(meta) {
    try {
      const id = meta.key || ('ll' + meta.lat.toFixed(3) + '_' + meta.lon.toFixed(3));
      if (_prefetched.has(id) || _inflight.has(id)) return;
      if (cacheGet(id)) return;             // already local
      _prefetched.add(id);
      buildCity(meta).catch(() => { });
    } catch (e) { }
  }

  // ---------------- public: build a city ----------------
  async function _buildCity(id, meta, onStatus) {
    // meta: {key, name, lat, lon} — either a catalog city or a searched spot
    const cached = cacheGet(id);
    if (cached) return { ...cached, source: 'osm', fromCache: true, net: null };

    const mLat = M_LONFN(meta.lat);
    const s = HALF / M_LAT / 2, w = HALF / mLat / 2;
    const bbox = `${(meta.lat - s).toFixed(5)},${(meta.lon - w).toFixed(5)},${(meta.lat + s).toFixed(5)},${(meta.lon + w).toFixed(5)}`;
    onStatus && onStatus('Importing ' + meta.name + ' from the real world…');
    const got = await fetchOverpass(bbox);
    if (got) {
      const d = parseOSM(got.json, meta.lat, meta.lon);
      fillHeights(d.buildings, meta.key);
      if (d.roads.length < 8) { /* too sparse — fall through to generator */ }
      else {
        const out = { id, key: meta.key, name: meta.name, lat: meta.lat, lon: meta.lon, half: HALF, ...d };
        cachePut(id, out);
        return { ...out, source: 'osm', fromCache: false, net: { ms: got.ms, ep: got.ep } };
      }
    }
    // v2.14 OPEN COUNTRY: a catalog city with no map data falls back to a
    // generated street grid — but an open-land settle (or a searched spot in
    // the wilds) is PASTURE now: fields, groves, ponds, barns, country roads
    // out to the nearest land-connected cities. No more fake city in the
    // middle of nowhere.
    if (isFrontier(meta)) {
      onStatus && onStatus('Surveying the open country around ' + meta.name + '…');
      return generatePasture(meta);
    }
    onStatus && onStatus('Live map unreachable — generating ' + meta.name + '…');
    return generateCity(meta);
  }

  // ---------------- procedural fallback ----------------
  function generateCity(meta) {
    const seed = hashStr((meta.key || meta.name) + '');
    const rnd = _mulberry(seed);
    const roads = [], buildings = [], greens = [], waters = [];
    const H = HALF * 0.92;
    // main avenues (E-W cls 3 + N-S cls 3) through center
    roads.push({ pts: [[-H, 0], [H, 0]], w: 16.5, cls: 3, name: 'Main Avenue' });
    roads.push({ pts: [[0, -H], [0, H]], w: 16.5, cls: 3, name: 'Central Street' });
    // grid
    let x = -H + 70;
    let col = 0;
    while (x < H - 40) {
      const av = col % 3 === 0;
      roads.push({ pts: [[x, -H], [x, H]], w: av ? 13 : 9.5, cls: av ? 2 : 1, name: av ? (1 + col) + 'th Avenue' : (1 + col) + 'th Street' });
      x += av ? 105 : 82; col++;
    }
    let z = -H + 60; let row = 0;
    while (z < H - 40) {
      const av = row % 4 === 0;
      roads.push({ pts: [[-H, z], [H, z]], w: av ? 13 : 9.5, cls: av ? 2 : 1, name: (1 + row) + (row % 10 === 0 ? 'st' : row % 10 === 1 ? 'nd' : row % 10 === 2 ? 'rd' : 'th') + ' Street' });
      z += av ? 95 : 74; row++;
    }
    // blocks between roads → buildings + greens
    const xs = roads.filter(r => r.pts.length === 2 && r.pts[0][0] === r.pts[1][0]).map(r => r.pts[0][0]).sort((a, b) => a - b);
    const zs = roads.filter(r => r.pts.length === 2 && r.pts[0][1] === r.pts[1][1]).map(r => r.pts[0][1]).sort((a, b) => a - b);
    let bkey = 1;
    const parkAt = Math.floor(rnd() * Math.max(1, (xs.length - 1) * (zs.length - 1)));
    let block = 0;
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++, block++) {
      const x0 = xs[i] + 7.5, x1 = xs[i + 1] - 7.5, z0 = zs[j] + 7.5, z1 = zs[j + 1] - 7.5;
      if (x1 - x0 < 26 || z1 - z0 < 26) continue;
      const cd = Math.hypot((x0 + x1) / 2, (z0 + z1) / 2) / H;   // 0 center → 1 edge
      if (block === parkAt || (cd > .55 && rnd() < .05)) {
        greens.push({ poly: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });
        continue;
      }
      // subdivide the block into 1–3 lots
      const nLots = 1 + Math.floor(rnd() * 3);
      const wide = (x1 - x0) > (z1 - z0);
      for (let l = 0; l < nLots; l++) {
        let bx0, bx1, bz0, bz1;
        if (wide) {
          const span = (x1 - x0) / nLots;
          bx0 = x0 + span * l + 4; bx1 = x0 + span * (l + 1) - 4;
          bz0 = z0 + 4 + rnd() * 6; bz1 = z1 - 4 - rnd() * 6;
        } else {
          const span = (z1 - z0) / nLots;
          bz0 = z0 + span * l + 4; bz1 = z0 + span * (l + 1) - 4;
          bx0 = x0 + 4 + rnd() * 6; bx1 = x1 - 4 - rnd() * 6;
        }
        if (bx1 - bx0 < 12 || bz1 - bz0 < 12) continue;
        const a = (bx1 - bx0) * (bz1 - bz0);
        let h;
        const r = rnd();
        if (cd < .3) h = r < .3 ? 55 + rnd() * 55 : 22 + r * 30;   // downtown core
        else if (cd < .6) h = r < .15 ? 35 + rnd() * 30 : 12 + r * 18;
        else h = 6 + r * 12;
        buildings.push({ poly: [[bx0, bz0], [bx1, bz0], [bx1, bz1], [bx0, bz1]], h, bkey: seed + (bkey++), area: a });
      }
    }
    return { id: 'gen-' + (meta.key || seed), key: meta.key, name: meta.name, lat: meta.lat, lon: meta.lon, half: HALF, roads, buildings, greens, waters, source: 'gen' };
  }

  // ---------------- v2.14/v2.15 — OPEN COUNTRY: the pasture generator ----
  // Far from any mapped streets the world is countryside: grass, hay
  // fields, groves, a pond, a barn. v2.15: searched wild spots become a
  // quiet homestead with two crossing country lanes — gate signposts are
  // gone, the ONE WORLD's real inter-city roads replaced them.
  function isFrontier(meta) {
    return meta.frontier === true || /^ll-?\d/.test((meta.key || '') + '');
  }

  function generatePasture(meta) {
    const seed = hashStr((meta.key || meta.name) + '');
    const rnd = _mulberry(seed);
    const roads = [], buildings = [], greens = [], waters = [];
    // v2.15: no gate signposts — the ONE WORLD's real inter-city roads
    // replaced them. A settled/searched wild spot is a quiet homestead:
    // two country lanes crossing at the center.
    const bowA = (rnd() * 2 - 1) * 60, bowB = (rnd() * 2 - 1) * 60;
    roads.push({ pts: [[-640, 30 - rnd() * 60], [-bowA, 0], [640, -(30 + rnd() * 60)]],
      w: 10.5, cls: 2, country: true, name: 'Country Lane' });
    roads.push({ pts: [[30 - rnd() * 60, -640], [0, bowB], [-(30 + rnd() * 60), 640]],
      w: 10.5, cls: 2, country: true, name: 'Settler Road' });
    // ---- a pond, more often than not ----
    if (rnd() < .45) {
      const pa = rnd() * 6.2832, pd = 170 + rnd() * 230, pr = 24 + rnd() * 30;
      const cx = Math.cos(pa) * pd, cz = Math.sin(pa) * pd;
      let clear = true;                                    // keep the water off every road
      for (const rd of roads) for (let i = 0; i < rd.pts.length - 1 && clear; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / L2));
        if (Math.hypot(cx - (ax + t * dx), cz - (az + t * dz)) < pr + 34) clear = false;
      }
      if (clear) {
        const poly = [];
        for (let i = 0; i < 9; i++) {
          const a = i / 9 * 6.2832, rr = pr * (.72 + rnd() * .45);
          poly.push([cx + Math.cos(a) * rr, cz + Math.sin(a) * rr]);
        }
        waters.push({ poly });
      }
    }
    return {
      id: 'pas-' + (meta.key || seed), key: meta.key, name: meta.name,
      lat: meta.lat, lon: meta.lon, half: HALF,
      roads, buildings, greens, waters,
      source: 'pasture', pasture: true,
    };
  }

  // ---------------- Nominatim place search ----------------
  async function searchPlaces(q) {
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&addressdetails=0&q=' + encodeURIComponent(q);
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) return [];
      const arr = await res.json();
      return arr.map(r => ({ name: r.name || q, display: (r.display_name || '').split(',').slice(0, 3).join(','), lat: +r.lat, lon: +r.lon, kind: r.type }));
    } catch (e) { return []; }
  }

  return { buildCity, prefetch, generateCity, searchPlaces, polyArea, proj, HALF,
    cachePeek: id => !!cacheGet(id || ''),
    cacheData: id => cacheGet(id || '') || null,   // v2.26: skylines read the cached real city
    get inflight() { return _inflight.size; } };
})();



window.OSM = OSM;

