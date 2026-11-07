// ====================================================================
// js/world/actors.js — the player + citizens (Stage 6): movement,
// input, camera.
// ====================================================================
import * as THREE from 'three';
import { _mulberry, hashStr } from '../util.js';
import { toast } from '../ui/dom.js';
import { LANDGEO } from '../core.js';
import { WORLD } from '../world/world.js';
import { CITY } from '../world/city.js';

// ======== section: 50_actors.js ========
// ======== section: 50_actors.js ========
// ====================================================================
// v2.0 — ACTORS: chibi figures (blue-body/white-head Capital Rift
// avatars), the player controller (v2.17: tap-to-move ONLY — WASD and
// the touch joystick pan the bird's-eye camera instead), ambient
// citizens patrolling real sidewalks, cart meshes.
// ====================================================================
export const ACTORS = (() => {
  const SHIRTS = [0x3182ce, 0x4a6fa5, 0x7a5c9e, 0x9e5c6b, 0x5c9e7a, 0xb0814f, 0x6b7280, 0x8f6b52, 0x2f8f8f, 0x8a8f4a];
  const SKINS = [0xf7fafc, 0xfdebd0, 0xfad7a1, 0xe8b88a, 0xc98d5f, 0x9c6b43];
  let figures = [];          // all animated chibis
  let citizens = [];
  let player = null;
  const keys = {};
  const joy = { active: false, dx: 0, dz: 0 };

  // shared geometry cache
  const G = {
    head: new THREE.SphereGeometry(.34, 14, 12),
    torso: new THREE.CylinderGeometry(.30, .33, .64, 12),
    leg: new THREE.CylinderGeometry(.10, .09, .46, 8),
    arm: new THREE.CylinderGeometry(.075, .07, .48, 8),
    blob: new THREE.CircleGeometry(.42, 14),
  };

  function makeChibi(opts = {}) {
    const shirt = opts.shirt ?? 0x3182ce;
    const pants = opts.pants ?? 0x2b6cb0;
    const skin = opts.skin ?? 0xf7fafc;
    const scale = opts.scale ?? 1;
    const g = new THREE.Group();
    const mShirt = new THREE.MeshLambertMaterial({ color: shirt });
    const mPants = new THREE.MeshLambertMaterial({ color: pants });
    const mSkin = new THREE.MeshLambertMaterial({ color: skin });

    const head = new THREE.Mesh(G.head, mSkin); head.position.y = 1.52;
    const torso = new THREE.Mesh(G.torso, mShirt); torso.position.y = .98;
    const legL = new THREE.Group(), legR = new THREE.Group();
    const lm = new THREE.Mesh(G.leg, mPants); lm.position.y = -.23;
    const rm = new THREE.Mesh(G.leg, mPants); rm.position.y = -.23;
    legL.add(lm); legR.add(rm);
    legL.position.set(-.14, .46, 0); legR.position.set(.14, .46, 0);
    const armL = new THREE.Group(), armR = new THREE.Group();
    const la = new THREE.Mesh(G.arm, mShirt); la.position.y = -.22;
    const ra = new THREE.Mesh(G.arm, mShirt); ra.position.y = -.22;
    armL.add(la); armR.add(ra);
    armL.position.set(-.40, 1.22, 0); armR.position.set(.40, 1.22, 0);
    armL.rotation.z = .12; armR.rotation.z = -.12;
    const blob = new THREE.Mesh(G.blob, new THREE.MeshBasicMaterial({ color: 0x1a365d, transparent: true, opacity: .32 }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = .02;
    [head, torso, lm, rm, la, ra].forEach(m => { m.castShadow = true; });
    g.add(head, torso, legL, legR, armL, armR, blob);
    g.scale.setScalar(scale);

    const fig = {
      group: g, legL, legR, armL, armR, head, torso,
      walking: false, phase: Math.random() * 6.28, speed: 1,
      setWalk(w) { this.walking = w; },
      faceTo(x, z) { g.rotation.y = Math.atan2(x - g.position.x, z - g.position.z); },
    };
    figures.push(fig);
    return fig;
  }

  function removeFig(fig) {
    const i = figures.indexOf(fig);
    if (i >= 0) figures.splice(i, 1);
    if (fig.group.parent) fig.group.parent.remove(fig.group);
  }

  // v2.08: shortest-arc smooth turn — figures pivot at a capped rate
  // instead of snapping 180° the instant their target changes (the old
  // snap made a shuffling queue look twitchy/glitchy)
  function turnToward(fig, targ, dt, rate = 9) {
    let d = targ - fig.group.rotation.y;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const m = rate * dt;
    fig.group.rotation.y += Math.max(-m, Math.min(m, d));
  }
  // move a figure toward a target this frame; returns true on arrival
  function walkTo(fig, tx, tz, speed, dt) {
    const dx = tx - fig.group.position.x, dz = tz - fig.group.position.z;
    const d = Math.hypot(dx, dz);
    if (d < .4) { fig.setWalk(false); return true; }
    const v = Math.min(speed * dt, d);
    fig.group.position.x += dx / d * v;
    fig.group.position.z += dz / d * v;
    turnToward(fig, Math.atan2(dx, dz), dt);
    fig.setWalk(true);
    return false;
  }
  // stand still but rotate to face a point (queue waits facing the cart)
  function turnTo(fig, tx, tz, dt) {
    turnToward(fig, Math.atan2(tx - fig.group.position.x, tz - fig.group.position.z), dt, 6);
  }

  // ---------------- ambient citizens --------------------------------
  function spawnCitizens(count, cityKey) {
    clearCitizens();
    const rnd = _mulberry(hashStr('c' + (cityKey || 'x')));
    for (let i = 0; i < count; i++) {
      const fig = makeChibi({
        shirt: SHIRTS[Math.floor(rnd() * SHIRTS.length)],
        pants: 0x2f3a4a,
        skin: SKINS[Math.floor(rnd() * SKINS.length)],
        scale: .92 + rnd() * .16,
      });
      const spot = CITY.randomRoadPoint(rnd);
      fig.group.position.set(spot.x, 0, spot.z);
      fig.speed = 1.35 + rnd() * .85;
      const walker = {
        fig, road: spot.rd, seg: 0, t: rnd(), dir: rnd() < .5 ? 1 : -1,
        side: rnd() < .5 ? 1 : -1, think: 0,
      };
      if (CITY.group) CITY.group.add(fig.group);
      citizens.push(walker);
    }
  }
  function clearCitizens() {
    citizens.forEach(w => removeFig(w.fig));
    citizens = [];
  }

  function updateCitizens(dt) {
    for (const w of citizens) {
      const rd = w.road;
      if (!rd || rd.pts.length < 2) { w.road = null; w.think = .5; continue; }
      // walk along polyline with sidewalk offset
      const a = rd.pts[w.seg], b = rd.pts[Math.min(w.seg + 1, rd.pts.length - 1)];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / segLen, uz = (b[1] - a[1]) / segLen;
      const off = rd.w / 2 + 1.9;
      w.t += w.dir * (w.fig.speed / segLen) * dt;
      if (w.t >= 1) { w.t = 0; w.seg++; w.dir = 1; if (w.seg >= rd.pts.length - 1) { w.seg = Math.max(0, rd.pts.length - 2); w.dir = -1; w.t = 1; } }
      else if (w.t <= 0) { w.t = 1; w.seg--; w.dir = -1; if (w.seg < 0) { w.seg = 0; w.dir = 1; w.t = 0; } }
      const px = a[0] + (b[0] - a[0]) * w.t - uz * off * w.side;
      const pz = a[1] + (b[1] - a[1]) * w.t + ux * off * w.side;
      walkTo(w.fig, px, pz, w.fig.speed, dt);
    }
  }

  // ---------------- player -------------------------------------------
  function initPlayer() {
    if (player) return player;
    player = makeChibi({ shirt: 0x3182ce, pants: 0x2b6cb0, skin: 0xf7fafc, scale: 1.08 });
    const badge = new THREE.Mesh(new THREE.BoxGeometry(.16, .1, .02),
      new THREE.MeshLambertMaterial({ color: 0xf5cc74 }));
    badge.position.set(.12, 1.18, .34);
    player.group.add(badge);
    return player;
  }
  function placePlayer(x, z) {
    if (!player) initPlayer();
    player.group.position.set(x, 0, z);
    clearGoal();   // v2.13: a snap/teleport retires any walk destination
  }

  // input — v2.06 CONTROLS FIX
  // Bug: a keyup lost to window blur (alt-tab, browser chrome, a native
  // dialog, focus moving to another frame) left keys['w'] stuck true and
  // the player kept ghost-walking after the key was released. Hardened:
  //  1. movement keys tracked by PHYSICAL code (e.code) — layout-proof
  //     WASD and down/up can never disagree via case changes
  //  2. Shift reconciled from every event's getModifierState — sprint
  //     engages even if the Shift keydown predates game focus, and
  //     self-heals the moment state goes stale
  //  3. ALL input clears on blur / focus / tab-hidden — a lost keyup can
  //     never leave the avatar moving. You move ONLY while holding a key.
  const KEYCODE = {
    KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
    ArrowUp: 'arrowup', ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
  };
  const kName = e => KEYCODE[e.code] || (e.key ? e.key.toLowerCase() : '');
  window.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    keys[kName(e)] = true;
    if (e.getModifierState) keys['shift'] = e.getModifierState('Shift');
  });
  window.addEventListener('keyup', e => {
    keys[kName(e)] = false;
    if (e.getModifierState) keys['shift'] = e.getModifierState('Shift');
  });
  const clearKeys = () => { for (const k in keys) keys[k] = false; };
  window.addEventListener('blur', clearKeys);
  window.addEventListener('focus', clearKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearKeys(); });

  // touch joystick
  function setupJoystick() {
    const joyEl = document.getElementById('joy');
    const nub = document.getElementById('joynub');
    let pid = null, cx = 0, cy = 0;
    joyEl.addEventListener('pointerdown', e => {
      pid = e.pointerId; joyEl.setPointerCapture(pid);
      const r = joyEl.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      joy.active = true; move(e);
    });
    const move = e => {
      if (e.pointerId !== pid || !joy.active) return;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const d = Math.min(42, Math.hypot(dx, dy)) || 1;
      const nx = dx / (Math.hypot(dx, dy) || 1), ny = dy / (Math.hypot(dx, dy) || 1);
      joy.dx = nx * (d / 42); joy.dz = ny * (d / 42);
      nub.style.left = (33 + nx * (d / 42) * 30) + 'px';
      nub.style.top = (33 + ny * (d / 42) * 30) + 'px';
    };
    joyEl.addEventListener('pointermove', move);
    const up = e => {
      if (e.pointerId !== pid) return;
      pid = null; joy.active = false; joy.dx = joy.dz = 0;
      nub.style.left = '33px'; nub.style.top = '33px';
    };
    joyEl.addEventListener('pointerup', up);
    joyEl.addEventListener('pointercancel', up);
    joyEl.addEventListener('lostpointercapture', up);   // v2.06: stuck-joystick guard
  }
  setupJoystick();

  // ---------------- v2.13 — CLICK TO MOVE -----------------------------
  // v2.17: this is now the ONLY way the character moves. Tap a spot on
  // the ground and the tycoon walks there on their own: a green ring
  // marks the destination and ripples once you arrive. Walls slide
  // instead of cancelling, a no-progress watchdog ends hopeless walks,
  // taps on rooftops reroute to the nearest street, and teleports /
  // city changes drop the destination so nobody chases a stale
  // coordinate. Keys/joystick steer the camera, not the character.
  let goal = null;          // {x, z} walk destination
  let marker = null;        // destination ring+dot group
  let markerDone = 0;       // >0 -> arrival ripple countdown (seconds)
  let stuckT = 0, progX = 0, progZ = 0;   // v2.17 wall-watchdog

  function disposeMarker() {
    if (!marker) return;
    if (marker.parent) marker.parent.remove(marker);
    marker.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    marker = null;
  }
  function clearGoal() {          // cancel: watchdog / teleport
    goal = null; markerDone = 0; disposeMarker();
  }
  function arriveGoal() {         // reached it: play the ripple, stop
    goal = null;
    if (marker) markerDone = .5;
  }
  // v2.17: tapped a rooftop/footprint → the nearest point on any street
  // of the active city chunk (full scan — taps are rare)
  function nearestStreetPoint(x, z) {
    let best = 1e9, bx = x, bz = z;
    for (const rd of CITY.roads) {
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx2, bz2] = rd.pts[i + 1];
        const dx = bx2 - ax, dz = bz2 - az, L2 = dx * dx + dz * dz || 1;
        let t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        const px = ax + t * dx, pz = az + t * dz;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) { best = d; bx = px; bz = pz; }
      }
    }
    return best < 1e9 ? { x: bx, z: bz } : null;
  }
  // v2.25: LEAVE THE CITY ALONG ITS STREETS. A far goal's road route
  // begins at the inter-city road's city-end vertex; the straight line
  // there from a downtown spawn crosses building blocks, the
  // slide/detour wiggle grinds at ~1 m/s (a 4.7 km trip reads as
  // "no other city ever loads"). This router hops street point to
  // street point along clear segments with monotone progress — sampled
  // every ~55 m along each segment, because OSM vertices alone sit
  // hundreds of meters apart on long ways. Bounded: 96 hops.
  function streetHops(px, pz, tx, tz) {
    if (!CITY.roads || !CITY.roads.length) return null;
    const d0 = Math.hypot(tx - px, tz - pz);
    if (d0 < 140) return null;                    // practically at the road head already
    const segClear = (ax, az, bx, bz) => {
      const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 6));
      for (let i = 0; i <= n; i++) {
        if (blockedAt(ax + (bx - ax) * i / n, az + (bz - az) * i / n)) return false;
      }
      return true;
    };
    const hops = [];
    let cx = px, cz = pz, cd = d0;
    for (let k = 0; k < 96 && cd > 120; k++) {
      let best = null;
      for (const rd of CITY.roads) {
        const pts = rd.pts;
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0], az = pts[i][1], bx2 = pts[i + 1][0], bz2 = pts[i + 1][1];
          const sl = Math.hypot(bx2 - ax, bz2 - az);
          if (sl < 1) continue;
          const n = Math.max(1, Math.ceil(sl / 55));   // dense samples along the way
          for (let j = 0; j <= n; j++) {
            const vx = ax + (bx2 - ax) * j / n, vz = az + (bz2 - az) * j / n;
            const hd = Math.hypot(vx - cx, vz - cz);
            if (hd < 14 || hd > 130) continue;    // hop length window
            const td = Math.hypot(tx - vx, tz - vz);
            if (td > cd - 18) continue;           // must make real progress
            if (best && td >= best.td) continue;
            if (!segClear(cx, cz, vx, vz)) continue;
            best = { x: vx, z: vz, td };
          }
        }
      }
      if (!best) break;                           // no clear street hop — open country / stall
      hops.push({ x: best.x, z: best.z });
      cx = best.x; cz = best.z; cd = best.td;
    }
    return hops.length ? hops : null;
  }
  function setGoal(x, z) {
    if (!player || !player.group.parent) return false;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;   // junk in — no goal out
    let [gx, gz] = WORLD.clampToBounds(x, z);
    if (CITY.pointInBuilding(gx, gz)) {
      // v2.17: walls are not destinations — but their street is
      const w = nearestStreetPoint(gx, gz);
      if (!w) return false;
      gx = w.x; gz = w.z;
    }
    // v2.18: open water is not a destination either — tap the sea and
    // you walk to the last dry shore point on the way there
    if (LANDGEO.ready && LANDGEO.isWaterWorld(gx, gz)) {
      const px0 = player.group.position.x, pz0 = player.group.position.z;
      const dd = Math.hypot(gx - px0, gz - pz0) || 1;
      let shore = null;
      for (let t = 0; t <= 1.0001; t += 22 / dd) {
        const sx = px0 + (gx - px0) * Math.min(t, 1), sz = pz0 + (gz - pz0) * Math.min(t, 1);
        // v2.22: bridge decks count as walkable — a tap across a sea
        // bridge targets the far shore instead of stopping at the near one
        if (!LANDGEO.isWaterWorld(sx, sz) || WORLD.nearRoad(sx, sz, 14)) shore = { x: sx, z: sz };
        else if (shore) break;
      }
      if (!shore) { toast('<b>That\'s open water.</b> Pick a spot on land.', 'warn'); return false; }
      gx = shore.x; gz = shore.z;
    }
    const gd0 = Math.hypot(gx - player.group.position.x, gz - player.group.position.z);
    goal = { x: gx, z: gz, far: gd0 > 60 };   // v2.17: long travel taps are jogged
    // v2.23: a far goal across water follows the inter-city roads — the
    // straight line would end at the shore. Bridges count (walkable decks).
    goal.route = WORLD.routeTo(player.group.position.x, player.group.position.z, gx, gz);
    // v2.25: prepend street hops so the FIRST leg leaves town along the
    // city's own streets instead of dead-sticking against downtown blocks.
    if (goal.route && goal.route.length) {
      const hops = streetHops(player.group.position.x, player.group.position.z,
        goal.route[0].x, goal.route[0].z);
      if (hops) goal.route = hops.concat(goal.route);
    }
    stuckT = 0; progX = player.group.position.x; progZ = player.group.position.z;
    detour = null;
    // v2.17: detours may spend this much extra distance on going around
    // obstacles — pathological walks end instead of cycling forever
    let budgetD = gd0;
    if (goal.route) {
      budgetD = 0;
      let lx = player.group.position.x, lz = player.group.position.z;
      for (const w of goal.route) { budgetD += Math.hypot(w.x - lx, w.z - lz); lx = w.x; lz = w.z; }
    }
    detourBudget = 250 + 2 * budgetD;
    markerDone = 0;
    disposeMarker();
    const mat = new THREE.MeshBasicMaterial({ color: 0x8ff0ae, transparent: true, opacity: .95, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(.55, .82, 36), mat);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(.16, 18), mat);
    ring.rotation.x = -Math.PI / 2; dot.rotation.x = -Math.PI / 2;
    marker = new THREE.Group();
    marker.add(ring, dot);
    marker.position.set(gx, .18, gz);
    player.group.parent.add(marker);
    return true;
  }

  // v2.17: combined camera-pan input for the main loop (screen-space:
  // x = right+, z = down+; W pushes the view up-screen). The character
  // itself is NOT moved by keys — only by setGoal (tap-to-move).
  function navInput() {
    let x = 0, z = 0;
    if (keys['w'] || keys['arrowup']) z -= 1;
    if (keys['s'] || keys['arrowdown']) z += 1;
    if (keys['a'] || keys['arrowleft']) x -= 1;
    if (keys['d'] || keys['arrowright']) x += 1;
    if (joy.active) { x += joy.dx; z += joy.dz; }
    const mag = Math.hypot(x, z);
    return { x, z, mag: Math.min(1, mag), active: mag > .08, run: !!keys['shift'] };
  }

  // v2.17 — TAP-ONLY MOVEMENT. No more WASD walking: the character
  // walks only toward the tapped goal. Buildings block with axis
  // sliding; when corner-trapped the walker routes around obstacles
  // (preferring the street point nearest the goal — roads wrap blocks —
  // then perpendicular sidesteps), and a distance-budgeted watchdog
  // ends walks that can't get anywhere so no goal runs forever.
  let detour = null, detourSide = 1, detourBudget = 0;
  // v2.18: a spot you may not occupy — a wall OR open water. The coast
  // is a wall too: slides and detours respect it like any building.
  const blockedAt = (x, z) =>
    CITY.pointInBuilding(x, z) ||
    ((LANDGEO.ready && LANDGEO.isWaterWorld(x, z)) && !WORLD.nearRoad(x, z, 14));   // v2.22: bridge decks are walkable (14 m: road samples sit ~22 m apart)
  function updatePlayer(dt) {
    if (!player) return;
    if (!goal) { detour = null; player.setWalk(false); player.sprint = false; return; }
    const sprinting = !!keys['shift'];
    const run = sprinting ? 10.5 : (goal.far ? 8.4 : 6.2);   // v2.17: far taps travel at a jog
    const p = player.group.position;
    const routed = !detour && goal.route && goal.route.length;
    const wp = detour || (routed ? goal.route[0] : goal);
    let dx = wp.x - p.x, dz = wp.z - p.z;
    let d = Math.hypot(dx, dz);
    if (d < (detour ? .6 : routed ? 2.2 : .45)) {
      if (detour) {   // rounded the obstacle — resume the direct line
        detour = null; stuckT = 0; progX = p.x; progZ = p.z;
        dx = goal.x - p.x; dz = goal.z - p.z; d = Math.hypot(dx, dz);
      } else if (goal.route && goal.route.length) {   // v2.23: next waypoint
        goal.route.shift(); stuckT = 0; progX = p.x; progZ = p.z;
        const nw = goal.route.length ? goal.route[0] : goal;
        dx = nw.x - p.x; dz = nw.z - p.z; d = Math.hypot(dx, dz);
      } else {
        arriveGoal();
        player.setWalk(false); player.sprint = false;
        return;
      }
    }
    const step = Math.min(run * dt, d);
    const ux = dx / d, uz = dz / d;
    let moved = false;
    const [cx, cz] = WORLD.clampToBounds(p.x + ux * step, p.z + uz * step);
    if (!blockedAt(cx, cz) && !blockedAt(cx + ux * .5, cz + uz * .5)) {
      p.x = cx; p.z = cz; moved = true;
    } else {
      // blocked: slide along the wall — try each axis on its own
      if (Math.abs(ux) > .01) {
        const [sx] = WORLD.clampToBounds(p.x + Math.sign(ux) * step, p.z);
        if (!blockedAt(sx, p.z) && !blockedAt(sx + Math.sign(ux) * .5, p.z)) { p.x = sx; moved = true; }
      }
      if (!moved && Math.abs(uz) > .01) {
        const [, sz] = WORLD.clampToBounds(p.x, p.z + Math.sign(uz) * step);
        if (!blockedAt(p.x, sz) && !blockedAt(p.x, sz + Math.sign(uz) * .5)) { p.z = sz; moved = true; }
      }
    }
    turnToward(player, Math.atan2(dx, dz), dt);
    player.setWalk(moved);
    player.phaseSpeed = run;
    player.sprint = sprinting;
    // watchdog: no real progress → route around the obstacle. Detours
    // draw from a distance budget (set in setGoal) so pathological
    // walks end instead of cycling forever; total dead-stuck time still
    // hard-cancels at 1.6s.
    if (Math.hypot(p.x - progX, p.z - progZ) > .5) { progX = p.x; progZ = p.z; stuckT = 0; }
    else stuckT += dt;
    if (!moved && !detour && stuckT > .45) {
      let cand = null;
      // 1) the street point nearest the GOAL — roads wrap blocks, so it
      //    is the reliable way around whatever is in the way
      const rp = nearestStreetPoint(goal.x, goal.z);
      if (rp && Math.hypot(rp.x - p.x, rp.z - p.z) > 6 &&
        !blockedAt((rp.x + p.x) / 2, (rp.z + p.z) / 2)) cand = { x: rp.x, z: rp.z };
      // 2) otherwise sidestep perpendicular, preferring the forward-ish
      //    walkable side (alternating when both are open)
      if (!cand) {
        const gd = Math.hypot(goal.x - p.x, goal.z - p.z) || 1;
        const gx = (goal.x - p.x) / gd, gz = (goal.z - p.z) / gd;
        const L = 30;
        for (const s of [detourSide, -detourSide]) {
          const [wx, wz] = WORLD.clampToBounds(p.x + (-gz * s) * L, p.z + (gx * s) * L);
          if (blockedAt(wx, wz)) continue;
          const midX = p.x + (wx - p.x) * .5, midZ = p.z + (wz - p.z) * .5;
          if (blockedAt(midX, midZ)) continue;
          const fwd = (wx - p.x) * gx + (wz - p.z) * gz;
          if (!cand || fwd > cand.fwd) cand = { x: wx, z: wz, fwd, s };
        }
        if (cand) detourSide = -cand.s;
      }
      if (cand) {
        detourBudget -= Math.hypot(cand.x - p.x, cand.z - p.z);
        if (detourBudget < -60) {
          clearGoal(); detour = null; player.setWalk(false); player.sprint = false;
          toast('The walk gave up — the route kept blocking. Press the gold pill again, or take the world map [M].', 'warn');   // v2.25: never die silently
          return;
        }
        detour = { x: cand.x, z: cand.z };
        stuckT = 0; progX = p.x; progZ = p.z;
      }
    }
    if (stuckT > 1.6) {
      clearGoal(); detour = null; player.setWalk(false); player.sprint = false;
      toast('The walk stalled — tap a nearer spot, or press the gold pill to set out again.', 'warn');   // v2.25: never die silently
    }
  }

  // ---------------- animation ----------------------------------------
  function update(dt) {
    // v2.13: destination marker — pulses while walking, ripples out on arrival
    if (marker) {
      if (markerDone > 0) {
        markerDone -= dt;
        const k = Math.max(0, markerDone) / .5;
        marker.scale.setScalar(1 + (1 - k) * 1.8);
        marker.children.forEach(c => { c.material.opacity = .95 * k; });
        if (markerDone <= 0) disposeMarker();
      } else marker.scale.setScalar(1 + Math.sin(performance.now() * .006) * .1);
    }
    for (const f of figures) {
      if (f.walking) {
        f.phase += dt * (f.phaseSpeed || 6) * 1.6;
        const s = Math.sin(f.phase);
        f.legL.rotation.x = s * .55;
        f.legR.rotation.x = -s * .55;
        f.armL.rotation.x = -s * .4;
        f.armR.rotation.x = s * .4;
        f.group.position.y = Math.abs(Math.sin(f.phase)) * .045;
      } else {
        f.legL.rotation.x *= .8; f.legR.rotation.x *= .8;
        f.armL.rotation.x *= .8; f.armR.rotation.x *= .8;
        f.group.position.y *= .8;
      }
    }
  }

  // ---------------- food cart mesh ------------------------------------
  function makeCart(cuisine) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.05, 1.15),
      new THREE.MeshLambertMaterial({ color: cuisine.color }));
    body.position.y = .95; body.castShadow = true;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, .09, .5),
      new THREE.MeshLambertMaterial({ color: 0xe8e4dc }));
    counter.position.set(0, 1.5, .38);
    const wheelG = new THREE.CylinderGeometry(.3, .3, .12, 12);
    const wheelM = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    const w1 = new THREE.Mesh(wheelG, wheelM); w1.rotation.z = Math.PI / 2; w1.position.set(-.75, .3, .62);
    const w2 = new THREE.Mesh(wheelG, wheelM); w2.rotation.z = Math.PI / 2; w2.position.set(.75, .3, .62);
    // striped umbrella
    const umb = new THREE.Mesh(new THREE.ConeGeometry(1.55, .62, 10),
      new THREE.MeshLambertMaterial({ color: cuisine.umbrella || 0xffffff }));
    umb.position.y = 3.0; umb.castShadow = true;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 1.9, 8),
      new THREE.MeshLambertMaterial({ color: 0xd8d8d6 }));
    pole.position.y = 2.15;
    g.add(body, counter, w1, w2, umb, pole);
    return g;
  }

  function reset() {
    clearCitizens();
    clearGoal();   // v2.13: retire the walk destination with the city
    figures = figures.filter(f => f === player);
  }

  return {
    makeChibi, removeFig, walkTo, turnTo, makeCart,
    spawnCitizens, clearCitizens, updateCitizens,
    initPlayer, placePlayer, updatePlayer, update, reset, setGoal, clearGoal, navInput,
    get player() { return player; },
    get input() { return keys; },   // v2.06: live view of key state (QA)
    get goal() { return goal; },   // v2.13: click-to-move destination (QA)
    get figures() { return figures; },
  };
})();

window.ACTORS = ACTORS;

