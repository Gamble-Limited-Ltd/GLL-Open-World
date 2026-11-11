// ====================================================================
// js/systems/eco.js — the street economy (Stage 7a): plots, carts,
// vendors, crews, offices, the serve loop, the Empire panel.
// PWR/LORD are late-bound below (original closure-scope resolution).
// ====================================================================
import * as THREE from 'three';
import { CITIES, CUISINES, ECON, NAMES } from '../config.js';
import { _ihash, _mulberry, fmt$, hashStr } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';

// ---- late binding (boot binds after every module evaluates) --------
export let PWR, LORD;
export function __late(b) { ({ PWR, LORD } = b); }

// ======== section: 60_economy.js ========
// ======== section: 60_economy.js ========
// ====================================================================
// v2.10 — INSTANT TRAVEL: every owned plot in the Empire panel gets
// a TELEPORT button — same city snaps you beside the cart, another
// city dives you straight in and lands at the spot.
// v2.0 — ECONOMY: street plots, food carts, customer queues, star
// crews, office leasing, live P&L business panels. Capital Rift's
// street-business loop on real-world streets.
// v2.08 — HAPPY CUSTOMERS: served customers walk away and despawn
// (departures list), the queue turns smoothly and waits facing the
// cart. The v2.0x-2.07 bug: serveCustomer() set state 'leaving' and
// spliced the customer out of cart.customers in the same breath, so
// the leaving-updater never saw them again — they froze at the slot
// with a permanent walk-in-place animation, never despawned, and the
// next customer walked straight into them (the glitchy pile-up).
// ====================================================================

export const ECO = (() => {
  let carts = [];             // runtime cart objects for the ACTIVE region
  let floats = [];            // rising $ sprites
  let spawnT = 3;
  let serveContext = null;    // plot whose cart is in player's reach
  let panelTimer = null;
  let officeAccrue = 0;
  let region = null;          // v2.15: active region KEY (cityKey or 'rural')

  // ---------------- v2.15 region context (city or open country) -------
  // The ONE WORLD has street spots inside cities AND cheap roadside plots
  // along the country roads. The active region follows the PLAYER: inside
  // a built city's footprint → that city; otherwise → the countryside.
  function container() { return (CITY.rec && CITY.group) || WORLD.group; }
  function containerFor(rec) { return (rec && rec.rural) ? WORLD.group : container(); }
  function plotAt(x, z) {
    const p = CITY.rec ? CITY.plotAt(x, z) : null;
    return p || WORLD.plotAt(x, z);      // rural plots clickable from anywhere
  }
  function findPlotRec(id) {
    let r = CITY.rec ? CITY.plots.find(x => x.id === id) : null;
    if (r) return r;
    return WORLD.plots().find(x => x.id === id);
  }
  function regionPlots(ck) {
    if (ck === 'rural') return WORLD.plots();
    return (CITY.rec && CITY.rec.key === ck) ? CITY.plots : [];
  }
  function regionName() {
    if (region === 'rural') return 'Countryside';
    const c = CITY.rec && CITY.rec.key === region ? CITY.rec.name : null;
    return c || 'Countryside';
  }
  function roadPoint(rnd) {
    if (CITY.rec) return CITY.randomRoadPoint(rnd);
    const p = ACTORS.player ? ACTORS.player.group.position : { x: 0, z: 0 };
    return WORLD.randomRoadPoint(rnd, p.x, p.z);
  }
  function setRegion(ck) {
    if (!ck || region === ck) return;
    region = ck;
    clearCarts();
    const taken = new Set();
    STATE.plots.filter(p => p.cityKey === ck).forEach(p => {
      // v2.09: plot ids reshuffled with the sidewalk spots — fall back to
      // the nearest new spot so older saves keep their carts on the street
      const rec = regionPlots(ck).find(r => r.id === p.id) ||
        regionPlots(ck).find(r => !taken.has(r.id) && Math.hypot(r.x - p.x, r.z - p.z) < 15);
      if (rec) {
        taken.add(rec.id);
        markPlotOwned(rec);
        if (p.cart) spawnCart(p, rec);
      }
    });
  }

  // ---------------- recruits (deterministic per plot+slot) ----------
  function recruit(plotId, slot) {
    const h = hashStr(plotId + '#' + slot);
    const stars = 1 + (_ihash(h & 1023, slot, 77) * 5 | 0);   // v2.54 CREW CALL: restored verbatim from the v2.00 source — this line was lost in a v2.1x rebuild, and its absence made recruit() throw (stars is not defined), which silently killed every food-cart business panel on click
    return { name: NAMES[h % NAMES.length], stars: Math.min(5, stars) };
  }
  const hireFee = stars => Math.round(300 * (.5 + stars * .25));

  // ---------------- floats -------------------------------------------
  function floatText(text, x, z, color = '#48BB78') {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.font = '900 34px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.fillStyle = color; ctx.fillText(text, 64, 32);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(5, 2.5, 1);
    sp.position.set(x, 2.6, z);
    const grp = container();
    if (!grp) return;
    grp.add(sp);
    floats.push({ sp, t: 0 });
  }
  function updateFloats(dt) {
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += dt;
      f.sp.position.y += dt * 1.4;
      f.sp.material.opacity = Math.max(0, 1 - f.t / 1.6);
      if (f.t > 1.6) {
        if (f.sp.parent) f.sp.parent.remove(f.sp);
        f.sp.material.map.dispose(); f.sp.material.dispose();
        floats.splice(i, 1);
      }
    }
  }

  // ---------------- owned plot visuals --------------------------------
  function markPlotOwned(rec) {
    if (rec && (rec.rural || rec.lot)) {   // v2.15: roadside plots carry their own mesh · v2.67 THE ARCHITECT: so do city lots
      rec.sold = true;
      if (rec.mesh) {
        rec.mesh.traverse(o => {
          if (o instanceof THREE.Sprite) o.visible = false;
          if (o.material && o.material.color && o.material.opacity === .9) o.material.color.set(0x2f8f5b);
          if (o instanceof THREE.Line) o.material.color.set(0xf5cc74);
        });
      }
      return;
    }
    CITY.setPlotOwned(rec);        // v2.09: the whole flip lives in CITY now
  }

  // ---------------- v2.10 — INSTANT TRAVEL -----------------------------
  // Every owned plot gets a TELEPORT button in the Empire panel. Same
  // city: the player + camera snap to a standing spot on the pad beside
  // the cart (inside serve range). Other city (or orbit): MAIN dives into
  // that city and lands beside the spot. MAIN installs the hook so ECO
  // never needs the camera / travel layer.
  let travelHook = null;
  function bindTravel(fn) { travelHook = fn; }

  const pulses = [];            // arrival ring pulses (teleport marker)
  function arrivalPulse(x, z) {
    const grp = container();
    if (!grp) return;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.5, 40),
      new THREE.MeshBasicMaterial({ color: 0xf6d365, transparent: true, opacity: .95, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, .27, z);
    grp.add(ring);
    pulses.push({ ring, t: 0 });
  }
  function updatePulses(dt) {
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]; p.t += dt;
      const k = p.t / .9;
      if (k >= 1) { if (p.ring.parent) p.ring.parent.remove(p.ring); p.ring.geometry.dispose(); p.ring.material.dispose(); pulses.splice(i, 1); continue; }
      p.ring.scale.setScalar(1 + k * 5.5);
      p.ring.material.opacity = .95 * (1 - k);
    }
  }
  // standing spot on the pad, past the cart's end and clear of the queue
  // line — inside serve range the instant you land
  function plotStand(rec) {
    const c = Math.cos(rec.rot), s = Math.sin(rec.rot);
    const lx = 0, lz = 2.6;
    return { x: rec.x + lx * c + lz * s, z: rec.z - lx * s + lz * c };
  }
  function cityNameOf(p) {
    if (p.cityKey === 'rural') return 'Countryside';
    const c = CITIES.find(x => x.key === p.cityKey);
    return (c && c.name) || p.cityName || p.cityKey;
  }
  function plotLabel(p) {
    const cui = p.cart ? CUISINES.find(c => c.id === p.cart.cuisine) : null;
    return cui ? cui.emoji + ' ' + cui.name + ' cart' : 'Empty spot';
  }
  function teleportToPlot(p) {
    if (!p) return false;
    if (!travelHook) { toast('Travel unavailable right now.', 'warn'); return false; }
    if (STATE.mode === 'diving') { toast('Almost there — hold on…', 'warn'); return false; }
    const here = CITY.rec && CITY.rec.key;
    let rec = null;
    if (here === p.cityKey) {
      rec = CITY.plots.find(r => r.id === p.id) ||
        CITY.plots.find(r => !r.sold && Math.hypot(r.x - p.x, r.z - p.z) < 15);
    }
    if (!rec && p.cityKey === 'rural') {   // v2.15: roadside plots live in the world
      rec = WORLD.plots().find(r => r.id === p.id) ||
        WORLD.plots().find(r => !r.sold && Math.hypot(r.x - p.x, r.z - p.z) < 15);
    }
    closeModal();
    if (rec) {
      const st = plotStand(rec);
      travelHook({ x: st.x, z: st.z, fx: rec.x, fz: rec.z, plot: p });
      return true;
    }
    travelHook({ cityKey: p.cityKey, plot: p });   // other city / orbit
    return true;
  }

  // build runtime carts for the active region from save
  function restoreCity() { if (CITY.rec && CITY.rec.key) setRegion(CITY.rec.key); }

  function clearCarts() {
    carts.forEach(c => {
      if (c.mesh && c.mesh.parent) c.mesh.parent.remove(c.mesh);
      (c.customers || []).forEach(cu => ACTORS.removeFig(cu.fig));
      (c.leaving || []).forEach(cu => ACTORS.removeFig(cu.fig));   // v2.08
      (c.vendors || []).forEach(v => ACTORS.removeFig(v.fig));
    });
    carts = [];
    floats.forEach(f => { if (f.sp.parent) f.sp.parent.remove(f.sp); f.sp.material.map.dispose(); f.sp.material.dispose(); });
    floats = [];
    pulses.forEach(p => { if (p.ring.parent) p.ring.parent.remove(p.ring); });   // v2.10: drop travel pulses
    pulses.length = 0;
  }

  // ---------------- cart + customers ---------------------------------
  function spawnCart(plotState, plotRec) {
    const cuisine = CUISINES.find(c => c.id === plotState.cart.cuisine) || CUISINES[0];
    const mesh = ACTORS.makeCart(cuisine);
    mesh.position.set(plotRec.x, 0, plotRec.z);
    mesh.rotation.y = plotRec.rot + Math.PI / 2;   // v2.09: cart long axis along the curb
    const grp = containerFor(plotRec) || container();
    if (!grp) return null;
    grp.add(mesh);
    const cart = {
      plot: plotState, rec: plotRec, cuisine, mesh, grp,
      customers: [], leaving: [], vendors: [], served: 0, revenueLog: [],
      queueSlots: (() => {
        // v2.09 sidewalk layout: the line runs down the walk beside the cart
        const off = [];
        for (let i = 0; i < 5; i++) off.push([1.45, 0.2 - i * 1.5]);
        return off;
      })(),
    };
    // queue slot world positions (relative to plot rotation)
    cart.slotWorld = i => {
      const [lx, lz] = cart.queueSlots[i];
      const c = Math.cos(plotRec.rot), s = Math.sin(plotRec.rot);
      return [plotRec.x + lx * c + lz * s, plotRec.z - lx * s + lz * c];
    };
    // restore vendors
    (plotState.crew || []).forEach((cr, i) => addVendor(cart, cr, i));
    carts.push(cart);
    return cart;
  }

  function addVendor(cart, cr, slot) {
    const fig = ACTORS.makeChibi({ shirt: 0xf2f0ee, pants: 0x8a8f96, skin: 0xfdebd0, scale: .98 });
    const c = Math.cos(cart.rec.rot), s = Math.sin(cart.rec.rot);
    const lx = -1.35, lz = -.8 + slot * .9;   // v2.09: behind the cart on the walk
    fig.group.position.set(cart.rec.x + lx * c + lz * s, 0, cart.rec.z - lx * s + lz * c);
    fig.group.rotation.y = cart.rec.rot + Math.PI / 2;
    fig.setWalk(false);
    const vgrp = cart.grp || container();
    if (!vgrp) return;
    vgrp.add(fig.group);
    cart.vendors.push({ ...cr, fig, t: Math.random() * 4 });
  }

  function spawnCustomer(cart) {
    if (cart.customers.length >= 5) return;
    const slot = cart.customers.length;
    const [qx, qz] = cart.slotWorld(slot);
    const rnd = _mulberry((Math.random() * 1e9) | 0);
    const spot = roadPoint(rnd);
    // spawn within 16–40m of the cart (rural carts have no streets nearby)
    let sx = spot.x, sz = spot.z;
    const d = Math.hypot(sx - cart.rec.x, sz - cart.rec.z);
    if (d < 18 || d > 90) {
      const a = rnd() * 6.28, r = 16 + rnd() * 22;
      sx = cart.rec.x + Math.cos(a) * r; sz = cart.rec.z + Math.sin(a) * r;
    }
    const fig = ACTORS.makeChibi({
      shirt: [0x3182ce, 0x9e5c6b, 0x5c9e7a, 0x7a5c9e, 0xb0814f][(Math.random() * 5) | 0],
      pants: 0x2f3a4a, skin: [0xf7fafc, 0xfdebd0, 0xfad7a1, 0xe8b88a][(Math.random() * 4) | 0],
      scale: .92 + Math.random() * .14,
    });
    fig.group.position.set(sx, 0, sz);
    fig.speed = 1.9 + Math.random() * .7;
    const cgrp = cart.grp || container();
    if (!cgrp) return;
    cgrp.add(fig.group);
    cart.customers.push({ fig, state: 'toQueue', slot, patience: ECON.custPatience, t: 0 });
  }

  function pickMenuItem(cuisine) {
    const total = cuisine.menu.reduce((s, m) => s + m[2], 0);
    let r = Math.random() * total;
    for (const m of cuisine.menu) { r -= m[2]; if (r <= 0) return m; }
    return cuisine.menu[0];
  }

  // v2.08 — hand a customer to the departures list: they pick a spot
  // down the street, walk away and despawn. Returns nothing; the
  // leaving-walker in updateCarts does the rest.
  function depart(cart, cu) {
    cu.state = 'leaving';
    cu.slot = -1;
    cu.age = 0;
    const rnd = _mulberry((Math.random() * 1e9) | 0);
    let tx = null, tz = 0;
    for (let k = 0; k < 6 && tx === null; k++) {
      const p = CITY.randomRoadPoint(rnd);
      const d = Math.hypot(p.x - cart.rec.x, p.z - cart.rec.z);
      if (d > 24 && d < 90) { tx = p.x; tz = p.z; }
    }
    if (tx === null) {           // no road point in range → ring fallback
      const a = rnd() * 6.28, r = 34 + rnd() * 26;
      tx = cart.rec.x + Math.cos(a) * r; tz = cart.rec.z + Math.sin(a) * r;
    }
    cu.target = [tx, tz];
    cart.leaving.push(cu);
  }

  function serveCustomer(cart, manual) {
    if (window.PWR && PWR.isCut(cart.plot)) return false;   // v2.59 THE GRID: a cut-off cart serves nobody
    const cu = cart.customers[0];
    if (!cu || cu.state !== 'waiting') return false;
    const item = pickMenuItem(cart.cuisine);
    const tip = ECON.serveTipMin + Math.random() * (ECON.serveTipMax - ECON.serveTipMin);
    const gross = item[1] + tip;
    earn(gross);
    cart.served++;
    // v2.05 starter guide: signal a successful MANUAL serve (E / SERVE btn)
    if (manual) window.dispatchEvent(new CustomEvent('ow:tut-serve'));
    cart.revenueLog.push([Date.now(), gross]);
    floatText('+$' + gross.toFixed(2), cart.rec.x + (Math.random() - .5) * 2, cart.rec.z + 1.4, '#48BB78', cart.grp);
    depart(cart, cu);
    // shift queue forward
    cart.customers.splice(0, 1);
    cart.customers.forEach((c, i) => { c.slot = i; c.state = 'toQueue'; });
    return true;
  }

  function updateCarts(dt) {
    // spawn
    const anyCart = carts.length > 0;
    if (anyCart) {
      spawnT -= dt;
      if (spawnT <= 0) {
        spawnT = ECON.custSpawnMin + Math.random() * (ECON.custSpawnMax - ECON.custSpawnMin);
        const live = window.PWR ? carts.filter(c => !PWR.isCut(c.plot)) : carts;   // v2.59 THE GRID: nobody lines up at a dark cart
        if (live.length) spawnCustomer(live[(Math.random() * live.length) | 0]);
      }
    }
    // customers
    for (const cart of carts) {
      for (let i = cart.customers.length - 1; i >= 0; i--) {
        const cu = cart.customers[i];
        if (cu.state === 'toQueue') {
          const [qx, qz] = cart.slotWorld(cu.slot);
          if (ACTORS.walkTo(cu.fig, qx, qz, cu.fig.speed, dt)) cu.state = 'waiting';
        } else if (cu.state === 'waiting') {
          cu.patience -= dt;
          // v2.08: settle facing the cart — a queue of customers, not
          // mannequins caught mid-stride facing random directions
          ACTORS.turnTo(cu.fig, cart.rec.x, cart.rec.z, dt);
          if (cu.patience <= 0) {
            depart(cart, cu);
            cart.customers.splice(i, 1);
            cart.customers.forEach((c, j) => { c.slot = j; if (c.state === 'waiting') c.state = 'toQueue'; });
          }
        }
      }
      // v2.08: departures — served / fed-up customers walk away and despawn
      for (let i = cart.leaving.length - 1; i >= 0; i--) {
        const cu = cart.leaving[i];
        cu.age += dt;
        if (ACTORS.walkTo(cu.fig, cu.target[0], cu.target[1], cu.fig.speed, dt) || cu.age > 45) {
          ACTORS.removeFig(cu.fig);
          cart.leaving.splice(i, 1);
        }
      }
      // vendors auto-serve
      for (const v of cart.vendors) {
        v.t += dt;
        v.fig.group.position.y = Math.sin(performance.now() / 400 + v.stars) * .015;
        const interval = Math.max(2.6, ECON.vendorInterval - v.stars * .55);
        if (v.t >= interval) {
          v.t = 0;
          if (cart.customers[0] && cart.customers[0].state === 'waiting') {
            serveCustomer(cart, false);
          }
        }
      }
    }
    // serve context (player near own cart?)
    serveContext = null;
    if (ACTORS.player) {
      for (const cart of carts) {
        const d = Math.hypot(ACTORS.player.group.position.x - cart.rec.x, ACTORS.player.group.position.z - cart.rec.z);
        if (d < 6.5) { serveContext = cart; break; }
      }
    }
    updateServeBar();
    // offices accrue (rate per 90s game-day)
    if (STATE.offices.length) {
      officeAccrue += dt;
      if (officeAccrue >= 1) {
        const secs = officeAccrue; officeAccrue = 0;
        let inc = 0;
        STATE.offices.forEach(o => inc += o.rate / 90);
        if (inc > 0) earn(inc * secs);
      }
    }
    updateFloats(dt);
  }

  // ---------------- serve bar UI ---------------------------------------
  const servebar = document.getElementById('servebar');
  const sq = document.getElementById('sq');
  const sp = document.getElementById('sp');
  function updateServeBar() {
    if (serveContext && serveContext.customers.some(c => c.state === 'waiting')) {
      const n = serveContext.customers.filter(c => c.state === 'waiting').length;
      const front = serveContext.customers[0];
      sq.innerHTML = '👥 <b>' + n + ' in line</b> at your ' + serveContext.cuisine.name + ' cart';
      sp.textContent = 'patience ' + Math.ceil(front ? front.patience : 0) + 's' +
        (serveContext.vendors.length ? ' · 👷 vendor serving' : '');
      servebar.classList.remove('hidden');
    } else if (serveContext) {
      sq.innerHTML = 'Your ' + serveContext.cuisine.name + ' cart — no one in line yet';
      sp.textContent = 'customers arrive every few seconds';
      servebar.classList.remove('hidden');
    } else servebar.classList.add('hidden');
  }
  window.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return; // v2.06: typing must not serve
    if (e.key.toLowerCase() === 'e' && serveContext && !e.repeat) {
      if (serveCustomer(serveContext, true)) { /* sale! */ }
    }
  });
  document.getElementById('servebtn').addEventListener('click', () => {
    if (serveContext) serveCustomer(serveContext, true);
  });

  // ---------------- picking --------------------------------------------
  function hoverInfo(x, z) {
    const plot = plotAt(x, z);
    if (plot) {
      const owned = STATE.plots.find(p => p.id === plot.id);
      if (owned && owned.cart) {
        const cui = CUISINES.find(c => c.id === owned.cart.cuisine);
        return { t: cui.name + ' cart', s: (plot.rural ? 'Roadside stand · ' : 'Street business · ') + regionName(), p: revPerMin(owned) >= 0 ? '+$' + revPerMin(owned).toFixed(0) + '/min' : '', a: (window.PWR && PWR.isCut(owned) ? '⚠ POWER CUT — pay at the POWER panel' : '✓ Open'), l: 'Click to manage' };   // v2.59 THE GRID
      }
      if (plot.lot) return owned   // v2.67 THE ARCHITECT
        ? { t: 'Your city lot', s: '15×20 m building lot · ' + regionName(), p: (window.BLD ? (BLD.list().filter(x => x.p.id === plot.id).length ? 'buildings standing' : 'empty — press BUILD') : ''), a: '✓ Owned', l: 'Click to manage · BUILD to raise buildings' }
        : { t: 'City Lot — buildable', s: Math.round(plot.w * plot.d) + ' m² · carries up to 8 buildings · ' + regionName(), p: fmt$(plot.price), a: '✓ Available to buy', l: 'Click to purchase' };
      if (owned) return { t: plot.rural ? 'Your roadside plot' : 'Your sidewalk spot', s: plot.rural ? 'Country-road vending plot' : 'Food-cart spot · ' + regionName(), p: '', a: '✓ Owned', l: 'Click to build' };
      return { t: plot.rural ? 'Roadside plot' : 'Sidewalk spot', s: Math.round(plot.w * plot.d) + ' m² · ' + (plot.rural ? 'open country' : regionName()), p: fmt$(plot.price), a: '✓ Available to buy', l: 'Click to purchase' };
    }
    const b = CITY.pointInBuilding(x, z);
    if (b) {
      const suite = CITY.suites.find(s => s.bkey === b.bkey);
      if (suite) {
        const mine = STATE.offices.find(o => o.bkey === suite.bkey);
        if (mine) return { t: suite.name, s: 'Size: ' + suite.sqm + 'm² | ' + suite.floors + ' floors', p: '$' + suite.rate + '.00 /day', a: '✓ Leased by you', l: 'Click to inspect · manage inside' };
        return { t: suite.name, s: 'Size: ' + suite.sqm + 'm² | ' + suite.floors + ' floors', p: '$' + suite.rate + '.00 /day', a: '✓ Available to rent', l: 'Click to inspect · lease inside' };
      }
      return { t: 'Private building', s: Math.round(b.h) + 'm · ' + Math.max(1, Math.round(b.h / 3.2)) + ' floors', p: '', a: '', l: 'Click to look inside' };
    }
    return null;
  }
  function clickAt(x, z) {
    const plot = plotAt(x, z);
    if (plot) {
      const owned = STATE.plots.find(p => p.id === plot.id);
      if (owned) { openBusiness(owned); return true; }
      openBuyPlot(plot); return true;
    }
    const b = CITY.pointInBuilding(x, z);
    if (b) {
      const suite = CITY.suites.find(s => s.bkey === b.bkey);
      if (suite) {
        const mine = STATE.offices.find(o => o.bkey === suite.bkey);
        if (mine) openOfficeMine(mine); else openLease(suite);
        return true;
      }
    }
    return false;
  }

  // ---------------- modals ---------------------------------------------
  function openBuyPlot(plot) {
    if (plot.lot) {   // v2.67 THE ARCHITECT: a buildable city lot — the copy stays honest
      openModal('City Lot — ' + (CITY.rec ? CITY.rec.name : 'City'), `
        <p>A <b>${Math.round(plot.w * plot.d)} m²</b> building lot, set back off the street — the only city ground that carries buildings. Up to eight of them rise here: catalog classics, or your own drafted designs (BUILD → DESIGN YOUR OWN).</p>
        <div class="kv"><span class="k">PRICE</span><span class="v g">${fmt$(plot.price)}</span></div>
        <div class="kv"><span class="k">BALANCE</span><span class="v">${fmt$(STATE.money)}</span></div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn good" id="bp-buy" style="flex:1">BUY LOT</button>
          <button class="btn" id="bp-x">CLOSE</button>
        </div>`);
    } else {
    openModal(plot.rural ? 'Roadside Plot — Open Country' : 'Sidewalk Spot — ' + (CITY.rec ? CITY.rec.name : 'City'), `
      <p>A <b>${Math.round(plot.w * plot.d)} m²</b> ${plot.rural ? 'vending plot on a country road — open for business anywhere in the world' : 'sidewalk vending spot — park your food cart right on the walk'}.</p>
      <div class="kv"><span class="k">PRICE</span><span class="v g">${fmt$(plot.price)}</span></div>
      <div class="kv"><span class="k">BALANCE</span><span class="v">${fmt$(STATE.money)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn good" id="bp-buy" style="flex:1">BUY PLOT</button>
        <button class="btn" id="bp-x">CLOSE</button>
      </div>`);
    }
    document.getElementById('bp-buy').onclick = () => {
      if (!spend(plot.price)) { toast('<b>Not enough money.</b> Sell some food first.', 'warn'); return; }
      const st = { id: plot.id, cityKey: plot.cityKey || (CITY.rec ? CITY.rec.key : 'rural'), cityName: plot.rural ? 'Countryside' : (CITY.rec ? CITY.rec.name : null), x: plot.x, z: plot.z, price: plot.price || 0, cart: null, crew: [], lot: !!plot.lot };   // v2.10: cityName for travel; v2.47 LANDLORD: price feeds the land market rate · v2.67 THE ARCHITECT: lot rides the plot pack
      STATE.plots.push(st);
      markPlotOwned(plot);
      saveGameSafe();
      closeModal();
      toast(plot.lot ? 'Lot bought — <b>' + fmt$(plot.price) + '</b>. Press <b>BUILD</b> to raise something of your own on it.'
        : 'Plot bought — <b>' + fmt$(plot.price) + '</b>. Click it again to park a food cart.');
    };
    document.getElementById('bp-x').onclick = closeModal;
  }

  function openBuild(plotState, plotRec) {
    const permit = STATE.plots.some(p => p.cart) ? 0 : ECON.permitCost;
    const grid = CUISINES.map(c => `
      <div class="cui" data-c="${c.id}"><div class="e">${c.emoji}</div><div class="n">${c.name}</div><div class="c">${fmt$(ECON.cartCost + permit)}</div></div>`).join('');
    openModal('Park a Food Cart', `
      <p>${plotRec && plotRec.lot ? 'A lot with room for both — the cart parks mid-lot, and up to <b>8 buildings</b> of yours rise around it (press <b>BUILD</b>). ' : ''}Choose your cuisine${permit ? ' — includes your first <b>$' + permit + '</b> street-vending permit' : ''}.</p>
      <div class="cuisine-grid">${grid}</div>
      <button class="btn good" id="bc-rent" style="width:100%;margin-top:14px">RENT OUT THE LAND — SET YOUR PRICE</button>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="bc-x" style="flex:1">CLOSE</button></div>`);
    document.querySelectorAll('.cui').forEach(el => {
      el.onclick = () => {
        if (window.LORD && LORD.isListed(plotState.id)) { toast('<b>This plot is on the rental market.</b> Take it off first (RENT OUT THE LAND \u2192 TAKE OFF MARKET).', 'warn'); return; }   // v2.47 LANDLORD
        const id = el.dataset.c;
        const cost = ECON.cartCost + permit;
        if (!spend(cost)) { toast('<b>Not enough money.</b>', 'warn'); return; }
        plotState.cart = { cuisine: id };
        spawnCart(plotState, plotRec);
        saveGameSafe();
        closeModal();
        toast(CUISINES.find(c => c.id === id).emoji + ' <b>' + CUISINES.find(c => c.id === id).name + ' cart parked!</b> Locals are already lining up.');
      };
    });
    document.getElementById('bc-x').onclick = closeModal;
    const bcr = document.getElementById('bc-rent');   // v2.47 LANDLORD: rent the empty plot out at your own price
    if (bcr) bcr.onclick = () => { try { LORD.open(plotState.id); } catch (er) { } };
  }

  function revPerMin(plotState) {
    const cart = carts.find(c => c.plot === plotState);
    if (!cart) return 0;
    const now = Date.now();
    cart.revenueLog = cart.revenueLog.filter(r => now - r[0] < 60000);
    return cart.revenueLog.reduce((s, r) => s + r[1], 0);
  }

  function openBusiness(plotState) {
    if (!plotState.cart) {
      // v2.47 LANDLORD: a tenanted plot manages its lease; an empty plot
      // with no local rec (restored far away) still manages the land rental
      if (window.LORD && (LORD.isTenanted(plotState.id) || !findPlotRec(plotState.id))) { try { LORD.open(plotState.id); } catch (er) { } return; }
      const rec = findPlotRec(plotState.id);
      if (rec) { openBuild(plotState, rec); return; }
    }
    const cart = carts.find(c => c.plot === plotState);
    if (!cart) return;
    const cui = cart.cuisine;
    const render = () => {
      const rpm = revPerMin(plotState);
      const jit = rpm * (0.94 + Math.random() * .12);
      const avgStars = cart.vendors.length ? (cart.vendors.reduce((s, v) => s + v.stars, 0) / cart.vendors.length).toFixed(1) : '—';
      const appeal = (cui.menu.reduce((s, m) => s + m[2], 0) / cui.menu.length * 100).toFixed(0);
      const menuRows = cui.menu.map(m => `
        <tr><td>${m[0]}</td><td class="m">$${m[1].toFixed(2)}</td><td style="width:34%">${Math.round(m[2] * 100)}%
        <div class="apbar"><i style="width:${m[2] * 100}%"></i></div></td></tr>`).join('');
      const slots = [0, 1, 2, 3, 4].map(i => {
        const v = cart.vendors[i];
        if (v) return `<div class="worker-row"><div class="w"><div class="nm">👷 ${v.name}</div>
          <div class="st">${'★'.repeat(v.stars)}${'☆'.repeat(5 - v.stars)}</div><div class="ro">vendor</div></div>
          <button class="btn bad" data-fire="${i}">FIRE</button></div>`;
        const r = recruit(plotState.id, i);
        return `<div class="worker-row"><div class="w"><div class="nm">Empty slot</div>
          <div class="st">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</div><div class="ro">next: ${r.name}</div></div>
          <button class="btn good" data-hire="${i}">HIRE $${hireFee(r.stars)}</button></div>`;
      }).join('');
      openModal(cui.emoji + ' ' + cui.name + ' Cart — Business' + (window.PWR && PWR.isCut(plotState) ? ' — POWER CUT' : ''), `   // v2.59 THE GRID
        <div id="pl"><span class="l">Live P&amp;L</span><span class="v">+$${Math.max(0, jit).toFixed(2)}/min</span></div>
        <div id="kpis">
          <div class="kpi"><div class="k">REV / MIN</div><div class="v g">$${rpm.toFixed(2)}</div></div>
          <div class="kpi"><div class="k">CUSTOMERS</div><div class="v">${cart.served}</div></div>
          <div class="kpi"><div class="k">CREW</div><div class="v">${cart.vendors.length}/5 · ${avgStars}★</div></div>
          <div class="kpi"><div class="k">APPEAL</div><div class="v">${appeal}%</div></div>
        </div>
        <div class="msec" style="margin-top:4px">Menu</div>
        <table class="menu"><tr><th>ITEM</th><th>PRICE</th><th>APPEAL</th></tr>${menuRows}</table>
        ${(window.PWR ? PWR.bizRow(plotState) : '')}   <!-- v2.59 THE GRID: the meter, the price, the bill -->
        <div class="msec" style="margin-top:14px">Crew — hires off the street</div>
        <div id="slots">${slots}</div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn bad" id="bs-scrap" style="flex:1">SCRAP CART ($1,000 back)</button>
          <button class="btn" id="bs-x" style="flex:1">CLOSE</button>
        </div>`);
      document.querySelectorAll('[data-hire]').forEach(b => {
        b.onclick = () => {
          const i = +b.dataset.hire;
          const r = recruit(plotState.id, i);
          if (!spend(hireFee(r.stars))) { toast('<b>Not enough money.</b>', 'warn'); return; }
          cart.plot.crew.push({ name: r.name, stars: r.stars });
          addVendor(cart, r, i);
          saveGameSafe();
          render();
          toast('Hired <b>' + r.name + '</b> (' + r.stars + '★) — they run the stand for you.');
        };
      });
      document.querySelectorAll('[data-fire]').forEach(b => {
        b.onclick = () => {
          const i = +b.dataset.fire;
          const v = cart.vendors[i];
          cart.vendors.splice(i, 1);
          cart.plot.crew.splice(i, 1);
          ACTORS.removeFig(v.fig);
          saveGameSafe();
          render();
          toast(v.name + ' walked off the job.', 'warn');
        };
      });
      const bpay = document.getElementById('bs-pay');   // v2.59 THE GRID: pay the arrears and reconnect
      if (bpay) bpay.onclick = () => { try { PWR.pay(plotState.id); } catch (er) { } render(); };
      document.getElementById('bs-scrap').onclick = () => {
        cart.plot.cart = null;
        cart.plot.crew = [];
        if (cart.mesh.parent) cart.mesh.parent.remove(cart.mesh);
        cart.customers.forEach(cu => ACTORS.removeFig(cu.fig));
        cart.leaving.forEach(cu => ACTORS.removeFig(cu.fig));
        cart.vendors.forEach(v => ACTORS.removeFig(v.fig));
        carts = carts.filter(c => c !== cart);
        earn(1000, false);
        saveGameSafe();
        closeModal();
        toast('Cart scrapped — <b>$1,000</b> salvaged.');
      };
      document.getElementById('bs-x').onclick = closeModal;
    };
    render();
    if (panelTimer) clearInterval(panelTimer);
    panelTimer = setInterval(() => {
      // stop when the modal closed OR when something else replaced the
      // business panel (e.g. the tutorial completion modal) — otherwise
      // this re-render would clobber whatever took its place
      if (document.getElementById('modalwrap').classList.contains('hidden') ||
          !document.getElementById('bs-scrap')) { clearInterval(panelTimer); panelTimer = null; return; }
      render();
    }, 2000);
  }

  function openLease(suite) {
    openModal(suite.name + ' — ' + (CITY.rec ? CITY.rec.name : ''), `
      <p>Floors of premium office space in a real <b>${CITY.rec ? CITY.rec.name : ''}</b> tower.</p>
      <div class="kv"><span class="k">SIZE</span><span class="v">${suite.sqm} m² · ${suite.floors} floors</span></div>
      <div class="kv"><span class="k">RENT</span><span class="v g">$${suite.rate}.00 /day</span></div>
      <div class="kv"><span class="k">BALANCE</span><span class="v">${fmt$(STATE.money)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn good" id="ol-go" style="flex:1">LEASE SUITE</button>
        <button class="btn" id="ol-x">CLOSE</button>
      </div>`);
    document.getElementById('ol-go').onclick = () => {
      if (STATE.offices.length >= 24) { toast('<b>Office cap reached</b> (24).', 'warn'); return; }
      const dep = suite.rate * 2;
      if (!spend(dep)) { toast('<b>Not enough money</b> for the $' + dep + ' deposit.', 'warn'); return; }
      STATE.offices.push({ id: 'of' + suite.bkey, cityKey: CITY.rec.key, bkey: suite.bkey, name: suite.name, sqm: suite.sqm, rate: suite.rate });
      saveGameSafe();
      closeModal();
      toast('Leased <b>' + suite.name + '</b> — collecting $' + suite.rate + '/day.');
    };
    document.getElementById('ol-x').onclick = closeModal;
  }
  function openOfficeMine(o) {
    openModal(o.name + ' — Your Office', `
      <div id="pl"><span class="l">Rent income</span><span class="v">+$${(o.rate / 90 * 60).toFixed(2)}/min</span></div>
      <div class="kv"><span class="k">SIZE</span><span class="v">${o.sqm} m²</span></div>
      <div class="kv"><span class="k">RATE</span><span class="v g">$${o.rate}.00 /day</span></div>
      ${(function () { try { return window.LORD ? LORD.tagLine(o.id, true) : ''; } catch (er) { return ''; } })()}   <!-- v2.47 LANDLORD -->
      <button class="btn good" id="om-sub" style="width:100%;margin-top:14px">RENT IT OUT — SET YOUR PRICE</button>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn bad" id="om-end" style="flex:1">END LEASE</button>
        <button class="btn" id="om-x">CLOSE</button>
      </div>`);
    document.getElementById('om-end').onclick = () => {
      STATE.offices = STATE.offices.filter(x => x !== o);
      saveGameSafe(); closeModal();
      toast('Lease ended. The deposit was non-refundable.', 'warn');
    };
    document.getElementById('om-x').onclick = closeModal;
    const oms = document.getElementById('om-sub');   // v2.47 LANDLORD: sublet the suite at your own price
    if (oms) oms.onclick = () => { try { LORD.open(o.id); } catch (er) { } };
  }

  function openEmpire() {
    const here = CITY.rec && CITY.rec.key;
    const pp = ACTORS.player ? ACTORS.player.group.position : null;
    const rows = STATE.plots.map((p, i) => {
      const local = here === p.cityKey && STATE.mode === 'city';
      const d = local && pp ? Math.round(Math.hypot(p.x - pp.x, p.z - pp.z)) : 0;
      return `<div class="kv"><span class="k">${plotLabel(p)} · ${cityNameOf(p)}${local ? ' · ' + d + 'm away' : ''}</span>
        <button class="tpbtn" data-tp="${i}">${local ? 'TELEPORT' : 'TRAVEL'}</button></div>`;
    }).join('');
    const ofc = STATE.offices.map(o => `<div class="kv"><span class="k">${o.name} · ${o.cityKey}</span><span class="v g">$${o.rate}/day</span></div>`).join('');
    const officeRate = STATE.offices.reduce((s, o) => s + o.rate / 90 * 60, 0);
    openModal('Your Empire — ' + STATE.name, `
      <div id="pl"><span class="l">Holdings</span><span class="v">${STATE.plots.length} plots · ${STATE.offices.length} offices</span></div>
      <div class="msec" style="margin-top:14px">Street plots — one-click travel</div>
      ${rows || '<p>No street plots yet. Find a green <b>$</b> parcel and click it.</p>'}
      <div class="msec" style="margin-top:14px">Offices — passive rent</div>
      ${ofc || '<p>No offices leased. Hover a tower and click to lease.</p>'}
      <div class="kv" style="margin-top:10px"><span class="k">OFFICE INCOME</span><span class="v g">+$${officeRate.toFixed(2)}/min</span></div>
      <div class="kv"><span class="k">WORLD GDP (YOU)</span><span class="v">$${Math.round(STATE.gdp).toLocaleString()}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="em-x" style="flex:1">CLOSE</button></div>`);
    document.querySelectorAll('[data-tp]').forEach(b => {
      b.onclick = () => { teleportToPlot(STATE.plots[+b.dataset.tp]); };
    });
    document.getElementById('em-x').onclick = closeModal;
  }

  function saveGameSafe() { try { saveGame(); } catch (e) { } }

  // v2.08: live queue metrics (QA + E2E)
  function queueStats() {
    let inLine = 0, leaving = 0, served = 0;
    for (const c of carts) {
      inLine += c.customers.length;
      leaving += (c.leaving || []).length;
      served += c.served;
    }
    return { inLine, leaving, served };
  }

  function update(dt) { if (STATE.mode === 'city') { updateCarts(dt); updatePulses(dt); } }

  return {
    CUISINES, restoreCity, setRegion, clearCarts, update, hoverInfo, clickAt,
    openBusiness, openEmpire, recruit, hireFee, revPerMin, queueStats,
    bindTravel, teleportToPlot, plotStand, plotLabel, cityNameOf, arrivalPulse,
    get region() { return region; },   // v2.10
    get serveContext() { return serveContext; },
    get carts() { return carts; },
  };
})();

window.ECO = ECO;

