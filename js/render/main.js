// ====================================================================
// js/render/main.js — the ONE WORLD scene setup (Stage 7b):
// renderer/camera/canvas, sky, enterWorld / landAtWorld /
// returnToGlobe and the city-walk handoffs. worldScene/sun/skyDome
// are exported `let` — writes stay here, importers read the live
// binding (same as the original's shared script scope).
// ====================================================================
import * as THREE from 'three';
import { CAM_FAR, CITIES, DEG_M } from '../config.js';
import { hashStr, latLonToWorld } from '../util.js';
import { STATE } from '../state.js';
import { loadGame, saveGame } from '../save.js';
import { uiBalance } from '../systems/economy.js';
import { hideTooltip, toast, veilOff, veilOn } from '../ui/dom.js';
import { LANDGEO } from '../core.js';
import { OSM } from '../world/osm.js';
import { EARTH } from '../world/earth.js';
import { WORLD, camCtl } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';
import { TUT } from '../systems/tutorial.js';

// ======== section: 90_main.js ========
window.addEventListener('error', e => { (window.__errs = window.__errs || []).push((e.message || 'err') + ' @line' + (e.lineno || '?') + ':' + (e.colno || '?')); });
// ====================================================================
// v2.16 — MAIN: the ONE WORLD with a CLEAN HORIZON. Boot landing, globe↔world travel, the
// single world scene, city streaming as you walk between cities, world
// camera + click-to-walk, minimap + big map, HUD wiring, the game loop,
// saves, QA probe. Keeps v2.03–v2.14 features: fast entry, starter
// guide, tight controls, clear streets, happy customers, sidewalk spots,
// instant travel, world atlas, click to walk.
// ====================================================================

// ---------------- renderer / camera ---------------------------------
export const canvas = document.getElementById('gl');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(2, window.deviceRatio || window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // v2.03: soft toy-matte shadows
renderer.outputColorSpace = THREE.SRGBColorSpace;

// v2.15: far plane spans the whole one world so real distant land and
// streaming cities stay visible on the horizon (log depth keeps the
// streets crisp); v2.16 removed the FAKE distant skylines and letters.
export const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 2, CAM_FAR);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------- the ONE WORLD scene --------------------------------
export let worldScene = null, sun = null, skyDome = null;
// v2.36: THE LEASH IS GONE — "remove the distance cap that I can move my
// camera from my player". The camera focus roams the whole planet (the
// world-bounds clamp is all that remains); pasture chunks, world edges and
// skyline pre-builds stream around the VIEW (WORLD.update), and FIND ME /
// [C] / any walk order snaps it home.
export function clampPan(x, z) {
  return WORLD.clampToBounds(x, z);
}

// v2.35 ZERO FOG: the user's verdict on the v2.34 edge band — the last
// 121.9→129.4 km pale wash still read as "light blue in the lake" in
// their screenshot. There is NO scene.fog at all now. The far-plane clip
// melts OPTICALLY instead: the sky dome's horizon band IS the water blue
// (#3479bd), so wherever the 130 km clip cuts the sea, the dome behind
// it is the same color — a seamless blue-on-blue join with no fog, no
// band, no wash, crisp to the edge at every zoom.
let _skyTex = null;
function skyTexture() {
  if (_skyTex) return _skyTex;
  const cv = document.createElement('canvas'); cv.width = 2; cv.height = 256;
  const ctx = cv.getContext('2d');
  const gr = ctx.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#7cb0d0');     // zenith — soft azure (CR clear day)
  gr.addColorStop(.34, '#9cc2d8');   // mid sky — azure paling
  gr.addColorStop(.46, '#7fa8cc');   // the sky deepens toward the horizon
  gr.addColorStop(.5, '#3479bd');    // horizon = the water blue — the far-plane clip melts here, no fog
  gr.addColorStop(1, '#3479bd');     // below the horizon (the far sea blends into this)
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  _skyTex = t;
  return t;
}

function buildWorldScene() {
  worldScene = new THREE.Scene();
  // v2.35 ZERO FOG — the user's verdict on the v2.34 edge band: even the
  // last 121.9→129.4 km melt still showed as "light blue in the lake".
  // scene.fog is now null, period. The 130 km far-plane clip melts
  // optically: the sky dome's horizon band is the SAME blue as the water
  // (#3479bd), so the clipped sea edge runs into matching dome — no fog,
  // no wash, no shard, crisp to the edge at every zoom.
  worldScene.background = new THREE.Color(0x3479bd);
  worldScene.fog = null;
  // gradient sky dome (azure zenith → pale-azure horizon), rides with the camera
  skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }));
  skyDome.scale.setScalar(CAM_FAR * .88);
  skyDome.renderOrder = -1;
  worldScene.add(skyDome);
  worldScene.add(new THREE.HemisphereLight(0xf0f7fa, 0x97a184, 2.5));   // sky fill, warm green-earth bounce
  sun = new THREE.DirectionalLight(0xfff3df, 2.1);              // v2.33: a touch brighter — CR's flat bright noon
  sun.position.set(-170, 180, 95);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -240; sun.shadow.camera.right = 240;
  sun.shadow.camera.top = 240; sun.shadow.camera.bottom = -240;
  sun.shadow.camera.near = 20; sun.shadow.camera.far = 1200;
  sun.shadow.bias = -0.0006;
  sun.shadow.radius = 5;
  worldScene.add(sun);
  worldScene.add(sun.target);
}

// ---------------- travel ---------------------------------------------
// enterWorld: orbit dive / map click / search / instant travel → build
// the city chunk of the ONE world at the city's fixed world position.
let pendingArrival = null;   // STATE plot to land beside after the city builds

export async function enterWorld(meta, opts = {}) {
  if (STATE.mode === 'diving' || STATE.mode === 'boot') return;
  // v2.10: INSTANT TRAVEL dives without returning to orbit — leave the
  // active region exactly the way returnToGlobe does.
  // v2.25: the teardown is guarded — a bug in ANY of these used to
  // reject enterWorld silently: no veil, no toast, no error, the old
  // city just stayed and it read as "no other city ever loads".
  if (STATE.mode === 'city') {
    try {
      saveGame();
      ECO.clearCarts();
      TUT.onLeaveCity();
      ACTORS.reset();
      if (ACTORS.player && ACTORS.player.group.parent) ACTORS.player.group.parent.remove(ACTORS.player.group);
      WORLD.clearCity();
      document.getElementById('servebar').classList.add('hidden');
    } catch (e) {
      console.error('[enterWorld] teardown', e);
    }
  }
  STATE.mode = 'diving';
  veilOn((pendingArrival ? '⚡ Traveling to your plot in ' : 'Entering ') + meta.name + '…');
  hideTooltip();
  try {
    // v2.04: a fetch already running (hover prefetch / dive kick) is reused
    const data = await OSM.buildCity(meta, s => {
      document.getElementById('veils').textContent = s;
    });
    EARTH.deactivate();
    if (!worldScene) buildWorldScene();
    WORLD.ensure(worldScene);
    const anchor = await WORLD.setCity(data, meta, s => {
      document.getElementById('veils').textContent = s;
    });
    ACTORS.reset();
    ACTORS.initPlayer();
    if (!ACTORS.player.group.parent) worldScene.add(ACTORS.player.group);
    // place player: beside a teleported-to plot / exact saved world spot /
    // pasture crossroads / a road point near the anchor
    const rnd = (n => () => (n = (n * 2654435761) % 4294967296) / 4294967296)(hashStr(meta.key || meta.name) + 7);
    let spot = null, arrived = null;
    if (opts.at) spot = opts.at;
    else if (pendingArrival) {
      const pa = pendingArrival; pendingArrival = null;
      const rec = CITY.plots.find(r => r.id === pa.id) ||
        CITY.plots.find(r => Math.hypot(r.x - pa.x, r.z - pa.z) < 15);
      if (rec) { spot = ECO.plotStand(rec); arrived = { pa, rec }; }
    }
    if (!spot && typeof STATE.playerW === 'number' && typeof STATE.playerZ === 'number' &&
      Math.hypot(STATE.playerW - anchor.x, STATE.playerZ - anchor.z) < 880) {
      spot = { x: STATE.playerW, z: STATE.playerZ };
    }
    if (!spot && data.pasture) {   // v2.14: land at the crossroads
      const r0 = (CITY.roads[0] || {}).pts;
      spot = (r0 && r0.length) ? { x: r0[0][0], z: r0[0][1] } : { x: 0, z: 0 };
    }
    if (!spot) {
      // v2.21 REAL CITIES: land in the DENSE CORE — the street point
      // nearest the rendered buildings' mass center. The anchor itself
      // hugs the shoreline for coastal cities (snapped to dry land),
      // and the v2.20 water clip leaves that fringe with streets but
      // few buildings — spawning there reads as "there is no city".
      // pointOnRoad's 26 m hash window can miss inside a block, so the
      // polylines are scanned directly (vertices sit <=12 m apart).
      const bl = CITY.buildingPolys || [];
      let cx = anchor.x, cz = anchor.z;
      if (bl.length) {
        let sx = 0, sz = 0;
        for (const b of bl) {
          const p = b.poly || [];
          if (!p.length) continue;
          let bx = 0, bz = 0;
          for (const v of p) { bx += v[0]; bz += v[1]; }
          sx += bx / p.length; sz += bz / p.length;
        }
        cx = sx / bl.length; cz = sz / bl.length;
      }
      let best = null;
      for (const rd of (CITY.roads || [])) {
        const pts = rd.pts || [];
        for (let i = 0; i < pts.length; i++) {
          const d = Math.hypot(pts[i][0] - cx, pts[i][1] - cz);
          if (!best || d < best.d) best = { x: pts[i][0], z: pts[i][1], d, rd };
        }
      }
      spot = (best && best.d < 400) ? best : CITY.randomRoadPoint(rnd);
    }
    // v2.19: never arrive standing in the water (an old save by a shore)
    if (spot && LANDGEO.ready && LANDGEO.isWaterWorld(spot.x, spot.z)) {
      const rp = CITY.randomRoadPoint(rnd);
      if (rp && !LANDGEO.isWaterWorld(rp.x, rp.z)) spot = rp;
    }
    ACTORS.placePlayer(spot.x, spot.z);
    if (arrived) ACTORS.player.group.rotation.y = Math.atan2(arrived.rec.x - spot.x, arrived.rec.z - spot.z);
    camCtl.az = Math.PI * .25; camCtl.el = 1.25; camCtl.dist = 110; camCtl.distT = arrived ? 64 : 110;
    camCtl.follow = true;
    camCtl.tx = spot.x; camCtl.tz = spot.z;
    // life
    const isMobile = matchMedia('(pointer:coarse)').matches;
    ACTORS.spawnCitizens(isMobile ? 22 : 46, meta.key || meta.name);
    ECO.setRegion(meta.key || 'rural');
    if (arrived) ECO.arrivalPulse(spot.x, spot.z);
    // HUD
    document.getElementById('cityname').textContent = meta.name;
    STATE.city = meta;
    STATE.lastCityKey = meta.key || null;
    STATE.mode = 'city';
    TUT.onEnterCity();          // v2.05: starter guide records its spawn point
    EARTH.setOwned(new Set(STATE.plots.map(p => p.cityKey)), STATE.lastCityKey);
    uiBalance();
    if (arrived) toast('⚡ Teleported to your <b>' + (arrived.pa.cart ? ECO.plotLabel(arrived.pa) : 'sidewalk spot') + '</b> in ' + meta.name + '.', 'warn');
    else toast('Welcome to <b>' + meta.name + '</b>' +
      (data.source === 'osm' && !data.fromCache ? ' — real streets imported live from OpenStreetMap' :
        data.fromCache ? ' — cached real streets' : '') +
      '<br>The real Earth is all yours — oceans, lakes and land routes where they belong.', 'warn');
  } catch (e) {
    console.error('[enterWorld]', e);
    toast('<b>Could not enter the city.</b> ' + (e && e.message || ''), 'err');
    pendingArrival = null;
    STATE.mode = 'globe';
    EARTH.activate();
  }
  veilOff();
}

// landAtWorld: click open land on the globe (or big map) → land in the
// open countryside at the matching world spot. If a city happens to be
// close, you arrive at that city instead — no surprise teleports.
export async function landAtWorld(wx, wz, label) {
  if (STATE.mode === 'diving' || STATE.mode === 'boot') return;
  const near = WORLD.nearestCityInfo(wx, wz);
  if (near.d < WORLD.BUILD_DIST) {
    return enterWorld({ key: near.city.key, name: near.city.name, lat: near.city.lat, lon: near.city.lon, tier: near.city.tier });
  }
  // v2.18: lakes read as land on the coarse globe mask, and nobody
  // lands at sea — a wet pick snaps to the nearest dry shore
  if (LANDGEO.ready && LANDGEO.isWaterWorld(wx, wz)) {
    const nl = LANDGEO.nearestLandWorld(wx, wz, DEG_M * 1.18);
    if (!nl) { toast('<b>That\'s open water.</b> Pick dry land — or a glowing city.', 'warn'); return; }
    wx = nl.x; wz = nl.z;
  }
  STATE.mode = 'diving';
  veilOn('Landing in the open country…');
  hideTooltip();
  await new Promise(r => setTimeout(r, 260));
  try {
    EARTH.deactivate();
    if (!worldScene) buildWorldScene();
    WORLD.ensure(worldScene);
    WORLD.clearCity();          // countryside = no detailed city chunk
    ACTORS.reset();
    ACTORS.initPlayer();
    if (!ACTORS.player.group.parent) worldScene.add(ACTORS.player.group);
    const [x, z] = WORLD.clampToBounds(wx, wz);
    ACTORS.placePlayer(x, z);
    camCtl.az = Math.PI * .25; camCtl.el = 1.25; camCtl.dist = 110; camCtl.distT = 110;
    camCtl.follow = true;
    camCtl.tx = x; camCtl.tz = z;
    ECO.setRegion('rural');
    STATE.city = null;
    STATE.mode = 'city';
    EARTH.setOwned(new Set(STATE.plots.map(p => p.cityKey)), null);
    document.getElementById('cityname').textContent = 'Open Country';
    uiBalance();
    toast((label ? label + ' — ' : '') + 'You land in open country. <b>' + near.city.name +
      '</b> is ' + (near.d / 1000).toFixed(1) + ' km away — follow the roads.', 'warn');
  } catch (e) {
    console.error('[landAtWorld]', e);
    STATE.mode = 'globe';
    EARTH.activate();
  }
  veilOff();
}

// walkIntoCity: triggered by WORLD streaming when you approach a city
// on foot. Cached cities pop in instantly; first visits import streets.
export async function walkIntoCity(city) {
  const meta = { key: city.key, name: city.name, lat: city.lat, lon: city.lon, tier: city.tier };
  const wasCached = OSM.cachePeek(meta.key);
  veilOn('Walking into ' + city.name + (wasCached ? '…' : ' — importing its real streets…'));
  try {
    const data = await OSM.buildCity(meta, s => {
      document.getElementById('veils').textContent = s;
    });
    const pp = ACTORS.player ? ACTORS.player.group.position : { x: 0, z: 0 };
    if (Math.hypot(pp.x - city.wx, pp.z - city.wz) > WORLD.BUILD_DIST + 250) {
      // player turned around during the import — leave it for later
      WORLD.pending = null;
      veilOff();
      return;
    }
    await WORLD.setCity(data, meta, s => {
      document.getElementById('veils').textContent = s;
    });
    // v2.23: streaming a city in used to CANCEL the walk (ACTORS.reset
    // clears the goal) — a cross-country trip died at the city limits.
    const keepGoal = ACTORS.goal ? { x: ACTORS.goal.x, z: ACTORS.goal.z } : null;
    ACTORS.reset();
    ACTORS.initPlayer();
    if (!ACTORS.player.group.parent) worldScene.add(ACTORS.player.group);
    if (keepGoal && Math.hypot(keepGoal.x - ACTORS.player.group.position.x,
        keepGoal.z - ACTORS.player.group.position.z) > 120) {
      ACTORS.setGoal(keepGoal.x, keepGoal.z);
    }
    const isMobile = matchMedia('(pointer:coarse)').matches;
    ACTORS.spawnCitizens(isMobile ? 22 : 46, meta.key);
    ECO.setRegion(meta.key);
    STATE.city = meta;
    STATE.lastCityKey = meta.key;
    document.getElementById('cityname').textContent = meta.name;
    EARTH.setOwned(new Set(STATE.plots.map(p => p.cityKey)), STATE.lastCityKey);
    toast('You walk into <b>' + city.name + '</b>' +
      (data.source === 'osm' && !data.fromCache ? ' — real streets imported live from OpenStreetMap' :
        data.fromCache ? ' — cached real streets' : ''), 'warn');
  } catch (e) {
    console.error('[walkIntoCity]', e);
    toast('<b>Could not import ' + city.name + '.</b> Try again in a moment.', 'err');
  }
  WORLD.pending = null;
  veilOff();
}

export function leftCity() {
  ECO.setRegion('rural');
  STATE.city = null;
  document.getElementById('cityname').textContent = 'Open Country';
  toast('You leave the city behind — open pastures ahead. Roads lead to the next towns.');
}

export function returnToGlobe() {
  if (STATE.mode !== 'city') return;
  veilOn('Returning to orbit…');
  setTimeout(() => {
    saveGame();
    ACTORS.reset();
    if (ACTORS.player && ACTORS.player.group.parent) ACTORS.player.group.parent.remove(ACTORS.player.group);
    WORLD.clearCity();          // free the detail chunk; terrain stays for quick returns
    ECO.clearCarts();
    TUT.onLeaveCity();          // v2.05: drop the guide beacon
    STATE.mode = 'globe';
    STATE.city = null;
    EARTH.setOwned(new Set(STATE.plots.map(p => p.cityKey)), STATE.lastCityKey);
    EARTH.activate();
    document.getElementById('cityname').textContent = 'Planet Orbit';
    document.getElementById('streetname').textContent = '';
    document.getElementById('bb-loc').textContent = 'orbit';
    document.getElementById('minimap').classList.add('hidden');
    hideTooltip();
    veilOff();
  }, 350);
}

// ---------------- v2.10: instant travel to owned plots ----------------
// ECO's Empire panel calls this hook. v2.15: same region → snap player +
// camera; another city → dive and land beside the spot; a rural plot →
// walk straight to its spot on the country road.
ECO.bindTravel(req => {
  if (req.cityKey === undefined) {
    ACTORS.placePlayer(req.x, req.z);
    if (req.fx !== undefined) ACTORS.player.group.rotation.y = Math.atan2(req.fx - req.x, req.fz - req.z);
    camCtl.tx = req.x; camCtl.tz = req.z;          // camera cuts with you
    camCtl.follow = true;
    camCtl.distT = Math.min(camCtl.distT, 70);     // glide in for a look at the cart
    toast('⚡ Teleported to your <b>' + (req.plot && req.plot.cart ? ECO.plotLabel(req.plot) : 'vending spot') + '</b>.', 'warn');
    ECO.arrivalPulse(req.x, req.z);
    return;
  }
  if (req.cityKey === 'rural') {   // v2.15: roadside plots in the open country
    if (STATE.mode !== 'city') { toast('Enter the world first.', 'warn'); return; }
    ACTORS.clearGoal();
    ACTORS.placePlayer(req.plot.x, req.plot.z);
    camCtl.tx = req.plot.x; camCtl.tz = req.plot.z;
    camCtl.follow = true;
    camCtl.distT = 70;
    toast('⚡ Teleported to your <b>' + (req.plot.cart ? ECO.plotLabel(req.plot) : 'roadside plot') + '</b> in the countryside.', 'warn');
    ECO.arrivalPulse(req.plot.x, req.plot.z);
    return;
  }
  const c = CITIES.find(x => x.key === req.cityKey);
  let meta = c ? { key: c.key, name: c.name, lat: c.lat, lon: c.lon, tier: c.tier } : null;
  if (!meta) {   // searched cities keep their coords in the key itself
    const m = /^ll(-?[0-9]+(?:[.][0-9]+)?)_(-?[0-9]+(?:[.][0-9]+)?)$/.exec(req.cityKey || '');
    if (m) meta = { key: req.cityKey, name: (req.plot && req.plot.cityName) || req.cityKey, lat: +m[1], lon: +m[2], searched: true };
  }
  if (!meta) { toast('<b>That city can no longer be found</b> — search for it again.', 'warn'); return; }
  pendingArrival = req.plot;
  enterWorld(meta);
});

// globe: click open LAND → land in the wild there (v2.15)
EARTH.onLandPick = (lat, lon) => {
  const p = latLonToWorld(lat, lon);
  landAtWorld(p.x, p.z, 'Open country');
};

// ---------------- boot ------------------------------------------------
export const bootEl = document.getElementById('boot');
export const pnameEl = document.getElementById('pname');
export const enterBtn = document.getElementById('enter');
const hadSave = loadGame();
if (hadSave && STATE.name) {
  pnameEl.value = STATE.name;
  enterBtn.textContent = 'CONTINUE';
  const reset = document.createElement('button');
  reset.className = 'go';
  reset.style.cssText = 'background:transparent;color:#6B7280;box-shadow:none;border:1px solid #4A5568';
  reset.textContent = 'NEW GAME';
  reset.onclick = () => {
    localStorage.removeItem('openworld-v2');
    location.reload();
  };
  document.querySelector('#boot .row').appendChild(reset);
}

