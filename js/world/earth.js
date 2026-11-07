// ====================================================================
// js/world/earth.js — the orbit globe (Stage 6): highway network
// (ROUTES), country shapes (COUNTRY), the EARTH scene with
// hover/dive. Imports OSM directly — both are self-contained at
// load; every cross reference is call-time only, exactly as the
// original single script resolved them through closure scope.
// ====================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CITIES, COL, R } from '../config.js';
import { coordStr, gcKmLL, hashStr, latLonToVec3, vec3ToLatLon } from '../util.js';
import { STATE } from '../state.js';
import { hideTooltip, showTooltip, toast } from '../ui/dom.js';
import { LAND, LANDGEO, landCorridorLL } from '../core.js';
import { OSM } from '../world/osm.js';

// ======== section: 20_earth.js ========
// ======== section: 20_earth.js ========
// ====================================================================
// v2.0 — EARTH: the bright toy globe, 64 real city nodes, dive-in
// ====================================================================



// (v2.14) the LAND mask sampler + landCorridorLL now live in 10_core.js —
// one shared source of truth for the globe hover/settle AND the OSM
// pasture gate placement.


// ---------------- v2.12/v2.14 — WORLD HIGHWAY NETWORK (data only) ----
// The land-connectivity model: a road exists between two cities when the
// straight great-circle corridor between them stays on land (15km of give
// at each end, sampled against the shared land mask). Each connected group
// becomes a network: MST trunks + short mesh links. Deterministic.
// v2.14: STILL COMPUTED — it powers the all-land QA invariant and mirrors
// the corridor test the pasture gates use — but it is NO LONGER DRAWN on
// the globe. The player asked for a clean planet in orbit; the roads you
// can actually WALK live at street level in the settled pasture regions.
export const ROUTES = (() => {
  const stats = { direct: 0, edges: 0, km: 0, components: 0, isolated: 0 };
  let edges = [];      // [{a, b, km}] — city keys, km rounded

  function landCorridor(a, b, km) {
    return landCorridorLL(a.lat, a.lon, b.lat, b.lon);
  }

  function build() {
    if (!LAND.ok()) return;
    const n = CITIES.length;
    const direct = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const km = gcKmLL(CITIES[i].lat, CITIES[i].lon, CITIES[j].lat, CITIES[j].lon);
      if (km > 9500) continue;             // beyond any land corridor
      if (landCorridor(CITIES[i], CITIES[j], km)) direct.push({ i, j, km });
    }
    stats.direct = direct.length;
    // ---- connected components (union-find over direct edges) ----
    const par = CITIES.map((_, i) => i);
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    direct.forEach(e => { par[find(e.i)] = find(e.j); });
    const comps = new Map();
    CITIES.forEach((c, i) => {
      const r = find(i);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(i);
    });
    // ---- minimum spanning tree per multi-city component (Prim) ----
    const adj = new Map();
    direct.forEach(e => {
      if (!adj.has(e.i)) adj.set(e.i, []);
      if (!adj.has(e.j)) adj.set(e.j, []);
      adj.get(e.i).push([e.j, e.km]); adj.get(e.j).push([e.i, e.km]);
    });
    const mst = new Set();
    comps.forEach(list => {
      if (list.length < 2) return;
      const inT = [list[0]], inS = new Set(inT);
      while (inT.length < list.length) {
        let best = null;
        for (const u of inT) for (const ev of (adj.get(u) || [])) {
          if (!inS.has(ev[0]) && (best === null || ev[1] < best[2])) best = [u, ev[0], ev[1]];
        }
        if (!best) break;
        inT.push(best[1]); inS.add(best[1]);
        mst.add(Math.min(best[0], best[1]) + '-' + Math.max(best[0], best[1]));
      }
    });
    // ---- extras: every short direct link that is not already a trunk ----
    const drawn = new Set(mst);
    direct.forEach(e => {
      const k = e.i + '-' + e.j;
      if (e.km < 1100 && !drawn.has(k)) drawn.add(k);
    });
    // ---- v2.14: NO DRAWING. The network stays data + QA only; the
    // walkable roads between cities are built at street level (see the
    // pasture gates in 30_osm/40_city) instead of painted on the globe ----
    drawn.forEach(k => {
      const p = k.split('-');
      const i = +p[0], j = +p[1];
      const km = direct.find(e => e.i === i && e.j === j).km;
      edges.push({ a: CITIES[i].key, b: CITIES[j].key, km: Math.round(km) });
      stats.km += km;
    });
    stats.edges = edges.length;
    stats.km = Math.round(stats.km);
    stats.components = [...comps.values()].filter(l => l.length > 1).length;
    stats.isolated = [...comps.values()].filter(l => l.length === 1).length;
  }

  // E2E invariant: every drawn road joins two catalog cities and its whole
  // corridor is on land — exactly the promise the network makes
  function check() {
    let bad = 0;
    edges.forEach(e => {
      const a = CITIES.find(c => c.key === e.a), b = CITIES.find(c => c.key === e.b);
      if (!a || !b || !landCorridor(a, b, gcKmLL(a.lat, a.lon, b.lat, b.lon))) bad++;
    });
    return { edges: edges.length, bad };
  }

  return { build, check, get stats() { return stats; }, get edges() { return edges; } };
})();
// ---------------- v2.11 — WORLD ATLAS: country outlines + names -------
// Natural Earth 110m country borders (public domain), quantized to int16
// absolutes, embedded by the build as base64 (same pattern as the land
// mask). Outlines: ONE LineSegments for every border on the planet.
// Names: one canvas sprite per country at its largest-ring centroid,
// tiered by size — big names always readable, smaller ones fade in as you
// fly closer, everything fades around the horizon.
export const COUNTRY = (() => {
  const stats = { n: 0, segs: 0, labels: 0, visible: 0, visT1: 0, visT2: 0, visT3: 0 };
  let sprites = [];

  function decode() {
    const b64 = (typeof window !== 'undefined' && window.__COUNTRY_GEO_B64) || '';
    let meta = (typeof window !== 'undefined' && window.__COUNTRY_META_JSON) || [];
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = []; } }
    if (!b64 || !Array.isArray(meta) || !meta.length) return null;
    const bin = atob(b64);
    const dv = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
    let o = 0;
    const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
    const i16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };
    const nC = u16();
    const geos = [];
    for (let c = 0; c < nC; c++) {
      const nR = u16();
      const rings = [];
      for (let r = 0; r < nR; r++) {
        const n = u16();
        const pts = [[i16(), i16()]];          // absolute quantized lon/lat
        for (let p = 1; p < n; p++) pts.push([i16(), i16()]);
        rings.push(pts);
      }
      geos.push(rings);
    }
    return { meta, geos };
  }

  function labelSprite(text, tier) {
    const fs = tier === 1 ? 30 : tier === 2 ? 25 : 21;
    const label = text.toUpperCase();
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const font = '800 ' + fs + 'px -apple-system,Segoe UI,Arial';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(label).width) + 16;
    cv.width = w; cv.height = Math.ceil(fs * 1.5);
    const c2 = cv.getContext('2d');
    c2.font = font; c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.lineJoin = 'round';
    c2.strokeStyle = 'rgba(6,13,9,.92)'; c2.lineWidth = Math.max(3, fs * .2);
    c2.strokeText(label, w / 2, cv.height / 2 + 1);
    c2.fillStyle = '#F4FAF2';
    c2.fillText(label, w / 2, cv.height / 2 + 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  }

  function build(scene) {
    const data = decode();
    if (!data) return;
    // ---- outlines: every border segment in ONE LineSegments ----
    const RB = R * 1.0016;
    const v = [];
    const push = (q, t) => {
      const lon = q * 180 / 32767, lat = t * 90 / 32767;
      const phi = (lon + 180) * Math.PI / 180, th = (90 - lat) * Math.PI / 180;
      v.push(-RB * Math.cos(phi) * Math.sin(th), RB * Math.cos(th), RB * Math.sin(phi) * Math.sin(th));
    };
    // shared borders appear in BOTH adjacent countries' rings — dedupe by
    // normalized endpoint pair so every border draws once at equal weight
    const seen = new Set();
    const seg = (a, b) => {
      const k = (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]))
        ? a[0] + ',' + a[1] + '|' + b[0] + ',' + b[1]
        : b[0] + ',' + b[1] + '|' + a[0] + ',' + a[1];
      if (seen.has(k)) return;
      seen.add(k);
      push(a[0], a[1]); push(b[0], b[1]);
    };
    data.geos.forEach(rings => rings.forEach(pts => {
      for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
    }));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0xEAF4E6, transparent: true, opacity: .68, depthWrite: false }));
    scene.add(lines);
    stats.segs = v.length / 6;
    // ---- name sprites at each country's largest-ring centroid ----
    data.meta.forEach(m => {
      const sp = labelSprite(m[0], m[3]);
      sp.position.copy(latLonToVec3(m[2], m[1], R * 1.03));
      sp.userData = {
        tier: m[3],
        aspect: sp.material.map.image.width / sp.material.map.image.height,
        h: m[3] === 1 ? 5.9 : m[3] === 2 ? 4.6 : 3.8,
        maxD: m[3] === 1 ? 1e9 : m[3] === 2 ? 385 : 262,
        dir: sp.position.clone().normalize(),
      };
      sp.visible = false;
      scene.add(sp);
      sprites.push(sp);
    });
    stats.n = data.meta.length;
    stats.labels = sprites.length;
  }

  const _cd = new THREE.Vector3();
  function update(camera) {
    const camDist = camera.position.length();
    _cd.copy(camera.position).normalize();
    let vis = 0, v1 = 0, v2 = 0, v3 = 0;
    for (let i = 0; i < sprites.length; i++) {
      const s = sprites[i], u = s.userData, k = camDist / 300;
      s.scale.set(u.h * u.aspect * k, u.h * k, 1);
      const facing = u.dir.dot(_cd);
      const ff = THREE.MathUtils.clamp((facing - .26) * 3.4, 0, 1);
      const zf = THREE.MathUtils.clamp((u.maxD - camDist) / 55, 0, 1);
      const op = ff * zf;
      s.material.opacity = op;
      s.visible = op > .02;
      if (s.visible) { vis++; if (u.tier === 1) v1++; else if (u.tier === 2) v2++; else v3++; }
    }
    stats.visible = vis; stats.visT1 = v1; stats.visT2 = v2; stats.visT3 = v3;
  }

  return { build, update, get stats() { return stats; } };
})();


export const EARTH = (() => {
  let scene, controls, renderer, camera;
  let cityMeshes = [], labelSprites = [], nodeGroup, rings = new Map();
  let hoverCity = null, hoverLand = null, clock = 0, diveT = null;
  let globeMesh = null;

  // ---- globe texture from the Natural Earth 1440x720 land mask ----
  function buildGlobeTexture() {
    const W = 1440, H = 720;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // ocean gradient (subtle equatorial warmth)
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COL.ocean2); g.addColorStop(.5, COL.ocean); g.addColorStop(1, COL.ocean2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // land
    let b64 = (typeof window !== 'undefined' && window.__LAND_MASK_B64) || '';
    if (b64) {
      const bin = atob(b64);
      const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const rowShift = (y / H) < .333 ? -1 : (y / H) > .666 ? 1 : 0; // polar tint
        for (let x = 0; x < W; x++) {
          const i = y * W + x, byte = bin.charCodeAt(i >> 3), bit = (byte >> (7 - (i & 7))) & 1;
          const o = i * 4;
          if (bit) {
            const t = rowShift === 0 ? 0 : 1;
            img.data[o] = 0x58 - t * 14; img.data[o + 1] = 0x91 - t * 6; img.data[o + 2] = 0x3C + t * 10;   // v2.35: pasture land, matches the in-world grass base #58913c
          } else { img.data[o] = 0x2C; img.data[o + 1] = 0x7B; img.data[o + 2] = 0xB9; }
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    // v2.18: the great lakes, painted where they really are
    if (LANDGEO.ok()) {
      ctx.fillStyle = '#2C7BB9';
      for (const lk of LANDGEO.lakes) {
        ctx.beginPath();
        for (let i = 0; i < lk.ring.length; i++) {
          const x = (lk.ring[i][0] + 180) / 360 * W, y = (90 - lk.ring[i][1]) / 180 * H;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath(); ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function labelSprite(text) {
    const cv = document.createElement('canvas');
    const font = '700 30px -apple-system,Segoe UI,Arial';
    const ctx = cv.getContext('2d');
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 26;
    cv.width = w; cv.height = 44;
    const c2 = cv.getContext('2d');
    c2.font = font;
    c2.fillStyle = 'rgba(13,17,23,.55)';
    c2.strokeStyle = 'rgba(255,255,255,.14)'; c2.lineWidth = 2;
    const r = 9;
    c2.beginPath(); c2.roundRect(1, 1, w - 2, 42, r); c2.fill(); c2.stroke();
    c2.fillStyle = '#E2E8F0';
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillText(text, w / 2, 23);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    return sp;
  }

  function init(rend, cam) {
    renderer = rend; camera = cam;
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#0D1117');

    // stars
    const sg = new THREE.BufferGeometry();
    const sp = [];
    for (let i = 0; i < 700; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(600 + Math.random() * 500);
      sp.push(v.x, v.y, v.z);
    }
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x9fb3c8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: .75 })));

    // lights — bright flat daylight
    scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x24303c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-300, 240, 160);
    scene.add(sun);

    // globe
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(R, 96, 64),
      new THREE.MeshLambertMaterial({ map: buildGlobeTexture() }));
    scene.add(globe);
    globeMesh = globe;   // v2.12: raycast target for settle-anywhere
    // atmosphere rim
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.045, 64, 48),
      new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: .075, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(atmo);

    // v2.11 — WORLD ATLAS: outlines + names of every country
    COUNTRY.build(scene);
    // v2.12/v2.14 — WORLD HIGHWAY NETWORK: computed + verified, NOT drawn
    ROUTES.build();

    // city nodes
    nodeGroup = new THREE.Group(); scene.add(nodeGroup);
    const nodeGeo = new THREE.SphereGeometry(1, 14, 10);
    CITIES.forEach(c => {
      const size = c.tier === 3 ? 2.6 : c.tier === 2 ? 1.9 : 1.4;
      const m = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: COL.node }));
      m.position.copy(latLonToVec3(c.lat, c.lon, R + 1.2));
      m.scale.setScalar(size);
      m.userData.city = c;
      nodeGroup.add(m); cityMeshes.push(m);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.4, .38, 8, 28),
        new THREE.MeshBasicMaterial({ color: COL.owned, transparent: true, opacity: .95 }));
      ring.position.copy(m.position);
      ring.lookAt(new THREE.Vector3(0, 0, 0));
      ring.visible = false;
      nodeGroup.add(ring); rings.set(c.key, ring);
      const lab = labelSprite(c.name);
      lab.position.copy(m.position.clone().multiplyScalar(1.075));
      lab.userData.base = lab.position.clone();
      nodeGroup.add(lab); labelSprites.push(lab);
    });

    // controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true; controls.dampingFactor = .08;
    controls.minDistance = 132; controls.maxDistance = 460;
    controls.rotateSpeed = .55;
    controls.zoomSpeed = .5;   // gentler wheel zoom on the globe
    camera.position.set(0, 90, 260);

    // picking
    const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
    const dom = renderer.domElement;
    let hovT = 0;   // v2.04: hover-dwell prefetch timer
    dom.addEventListener('pointermove', e => {
      if (diveT || STATE.mode !== 'globe') return;
      ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(cityMeshes, false)[0];
      hoverCity = hit ? hit.object.userData.city : null;
      // v2.12: OPEN LAND — any dry land on the globe is settleable
      hoverLand = null;
      if (!hoverCity && globeMesh) {
        const gh = ray.intersectObject(globeMesh, false)[0];
        if (gh) {
          const ll = vec3ToLatLon(gh.point);
          if (LAND.at(ll.lat, ll.lon)) hoverLand = ll;
        }
      }
      dom.style.cursor = (hoverCity || hoverLand) ? 'pointer' : '';
      // v2.04: dwell on a node for 400ms → start downloading its streets
      // now, so the dive is instant by the time the player clicks
      clearTimeout(hovT);
      if (hoverCity) hovT = setTimeout(() => {
        if (hoverCity && !diveT && STATE.mode === 'globe') OSM.prefetch(hoverCity);
      }, 400);
      if (hoverCity) {
        const popd = { 3: 8 + (hashStr(hoverCity.key) * 14), 2: 2 + (hashStr(hoverCity.key) * 6), 1: .4 + (hashStr(hoverCity.key) * 1.6) }[hoverCity.tier];
        showTooltip(e.clientX, e.clientY, {
          t: hoverCity.name,
          s: (popd >= 1 ? popd.toFixed(1) + 'M' : Math.round(popd * 1000) + 'K') + ' people · real streets',
          p: 'OPEN FOR BUSINESS', a: '', l: 'Click to enter the city',
        });
      } else if (hoverLand) {
        showTooltip(e.clientX, e.clientY, {
          t: 'OPEN LAND',
          s: coordStr(hoverLand.lat, hoverLand.lon) + ' · the one world',
          p: 'ALL LAND IS CONNECTED', a: '', l: 'Click to land here — roads lead to the cities',
        });
      } else hideTooltip();
    });
    // v2.12: a click that traveled >7px was an orbit drag, not a tap —
    // never settle or dive by accident after spinning the globe
    let downX = 0, downY = 0;
    dom.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
    dom.addEventListener('click', e => {
      if (diveT || STATE.mode !== 'globe') return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 7) return;
      clearTimeout(hovT);
      if (hoverCity) { EARTH.diveTo(hoverCity); return; }
      // v2.15: clicking open LAND lands you in the countryside of the ONE
      // WORLD at that spot — never a teleport into a city you didn't pick.
      if (hoverLand && EARTH.onLandPick) EARTH.onLandPick(hoverLand.lat, hoverLand.lon);
    });
    return EARTH;
  }

  // ---- dive: tween camera to the node, then hand over to the city ---
  function diveTo(city, onArrived) {
    if (diveT) return;
    controls.enabled = false; hideTooltip();
    const target = latLonToVec3(city.lat, city.lon, R + 4.5);
    const startPos = camera.position.clone();
    const startTgt = controls.target.clone();
    const t0 = performance.now(), DUR = 1250;
    diveT = { city, onArrived };
    function step() {
      if (!diveT) return;
      const k = Math.min(1, (performance.now() - t0) / DUR);
      const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOut
      camera.position.lerpVectors(startPos, target, e);
      controls.target.lerpVectors(startTgt, target.clone().multiplyScalar(.2), e);
      if (k >= 1) { const cb = diveT.onArrived; diveT = null; controls.enabled = true; cb && cb(diveTo.city || city, city); }
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---- v2.12: settle open land — dive in and make it buildable ----
  // The whole planet is a buildable area now: any dry-land point gets a
  // 'll-lat_lon' city key (the same convention as searched places, so the
  // Empire panel's TRAVEL + the teleport fallback chain handle it for free),
  // a Frontier name, tier-1 pricing, and the full street/plot pipeline —
  // real OSM streets where they exist, open pasture country out in the wilds
// (v2.14: country roads + city gates, not a fake city grid).
  function settle(lat, lon) {
    if (diveT || STATE.mode !== 'globe') return false;
    if (!LAND.at(lat, lon)) { toast('<b>That\'s open ocean.</b> Pick dry land — or a glowing city.', 'warn'); return false; }
    hideTooltip();
    if (EARTH.onLandPick) { EARTH.onLandPick(lat, lon); return true; }
    return false;
  }

  function setOwned(keys, hereKey) {
    // v2.12: settled frontier spots (and searched places) carry their
    // coords inside the key — give each one a small outpost ring on the
    // globe so your empire is visible planet-wide
    keys.forEach(k => {
      if (rings.has(k) || !nodeGroup) return;
      const m = /^ll(-?[0-9]+(?:[.][0-9]+)?)_(-?[0-9]+(?:[.][0-9]+)?)$/.exec(k);
      if (!m) return;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.4, .46, 8, 24),
        new THREE.MeshBasicMaterial({ color: COL.owned, transparent: true, opacity: .95 }));
      ring.position.copy(latLonToVec3(+m[1], +m[2], R + 1.2));
      ring.lookAt(new THREE.Vector3(0, 0, 0));
      ring.visible = false;
      nodeGroup.add(ring); rings.set(k, ring);
    });
    rings.forEach((ring, key) => {
      const owned = keys.has(key);
      ring.visible = owned || key === hereKey;
      ring.material.color.set(key === hereKey ? COL.here : COL.owned);
    });
  }

  function update(dt) {
    clock += dt;
    if (!diveT && controls.enabled) {
      // gentle idle spin of the node pulse (globe itself static for readability)
    }
    const pulse = 1 + Math.sin(clock * 2.4) * .14;
    cityMeshes.forEach(m => m.scale.setScalar((m.userData.city.tier === 3 ? 2.6 : m.userData.city.tier === 2 ? 1.9 : 1.4) * pulse));
    // labels: constant-ish screen size + hide behind globe
    const camDist = camera.position.length();
    labelSprites.forEach(s => {
      const d = s.userData.base.length();
      s.scale.set(d * .155 * (camDist / 300), d * .064 * (camDist / 300), 1);
      const facing = s.userData.base.clone().normalize().dot(camera.position.clone().normalize());
      s.material.opacity = THREE.MathUtils.clamp((facing - .18) * 3.2, 0, 1);
    });
    // v2.11: country names — tiered by size, fading with facing + zoom
    COUNTRY.update(camera);
    if (controls.enabled) controls.update();
  }

  function activate() {
    controls.enabled = true;
    camera.position.set(camera.position.x || 0, Math.max(camera.position.y, 60), Math.max(camera.position.z, 200));
    if (camera.position.length() < 132) camera.position.setLength(240);
    controls.target.set(0, 0, 0);
  }
  function deactivate() { controls.enabled = false; hideTooltip(); }

  return { init, update, activate, deactivate, diveTo, setOwned, settle,
    landAt: (lat, lon) => LAND.at(lat, lon),
    get scene() { return scene; }, get controls() { return controls; }, get diving() { return !!diveT; }, get countries() { return COUNTRY.stats; },
    get roads() { return { stats: ROUTES.stats, edges: ROUTES.edges, check: ROUTES.check }; },
    get rings() { return rings; } };
})();
window.EARTH = EARTH;

