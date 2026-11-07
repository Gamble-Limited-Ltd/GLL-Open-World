// ====================================================================
// js/systems/property.js — title deeds (Stage 7c): rooms/floors
// for sale or rent, holdings, tenants, travel. MACH/LORD/FURN
// are late-bound below.
// ====================================================================
import { CITIES } from '../config.js';
import { fmt$, hashStr } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD, camCtl } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';
import { enterWorld } from '../render/main.js';
import { OH } from '../systems/openhouse.js';

// ---- late binding (boot binds after every module evaluates) --------
export let MACH, LORD, FURN;
export function __late(b) { ({ MACH, LORD, FURN } = b); }

// ======== section: 47_property.js ========
// ====================================================================
// v2.43 — TITLE DEEDS. The ask: "allow people to buy or rent certain
// rooms or floors in the houses and buildings." The v2.41 inspector
// already picks a FLOOR (big buildings) or a ROOM (houses and small
// shops); this section turns every one of those picks into property
// with a price tag:
//   - every floor row / room row in the inspector panel now carries
//     its market rent, and your holdings wear a gold OWNED / green
//     RENTED tag (gold row tint, gold room glow);
//   - picking a floor or room reveals the DEAL BLOCK under the list:
//     BUY it outright — yours forever, tenants pay you double rent,
//     it counts toward your WORTH, sell it back any time for 60% —
//     or RENT it: a two-day deposit, the unit pays its rent every
//     day, end the lease whenever you like (the office-suite model,
//     at room and floor granularity);
//   - income accrues on the same beat as office suites ($rate per 90 s
//     game-day), every deed lists in the Empire panel with one-tap
//     TELEPORT / TRAVEL to its doorstep (the inspector even opens on
//     arrival), and it all persists in the save — a new optional
//     "rooms" pack field that older builds simply ignore (pack stays
//     v5, so the old plot migrations are untouched);
//   - prices are deterministic from the building's own key, so the
//     deal you saw yesterday is the deal you see today.
// Touchpoints outside this section (each annotated "v2.43"): the
// STATE/save/load room field, the WORTH ticker, three lines in the
// v2.41 inspector (deal container + row tags + gold glow), one help
// line, and the version surfaces. Every property call is try/caught
// so a mistake here can never touch the world. window.PROP is the
// QA surface.
// ====================================================================
export const PROP = (() => {
  const CAP = 60;            // holdings cap — bounds the accrual and the Empire list
  const BUY_MULT = 12;       // buy price = 12 days of rent
  const OWN_YIELD = 2;       // owned units earn DOUBLE rent (no landlord to pay)
  const DEPOSIT = 2;         // renting costs a 2-day deposit (the suite model)
  const SELL_BACK = .6;      // selling returns 60% of the buy price
  let acc = 0;               // income accrual accumulator (1 s ticks, like offices)
  let propArrival = null, arrivalT = 0;   // cross-city travel: open the inspector when the building stands

  // ---- robust building facts (barns register without area/x/z) -----
  function areaOf(b) {
    if (b && b.area) return b.area;
    try {
      const P = (b && b.poly) || [];
      if (P.length) {
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (const v of P) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); z0 = Math.min(z0, v[1]); z1 = Math.max(z1, v[1]); }
        return (x1 - x0) * (z1 - z0);
      }
    } catch (e) { }
    return 40;    // a sane fallback (a modest room)
  }
  function centerOf(b) {
    if (b && typeof b.x === 'number' && typeof b.z === 'number') return { x: b.x, z: b.z };
    try {
      const P = (b && b.poly) || [];
      if (P.length) {
        let sx = 0, sz = 0;
        for (const v of P) { sx += v[0]; sz += v[1]; }
        return { x: sx / P.length, z: sz / P.length };
      }
    } catch (e) { }
    return { x: 0, z: 0 };
  }
  function tier() { try { return Math.min(4, (CITY.rec && CITY.rec.tier) || 2); } catch (e) { return 2; } }

  // ---- deterministic pricing ----------------------------------------
  // A floor prices its whole plate (area ~ the footprint); a room is a
  // finished little home so it earns more per m². Same seed every visit.
  function rateOf(b, kind, index, area) {
    const a = Math.max(4, Math.round(area != null ? area : areaOf(b)));
    if (kind === 'floor')
      return Math.max(25, Math.round(a * .3 + tier() * 9 + hashStr('pf' + b.bkey + '#' + index) % 28));
    return Math.max(4, Math.round(a * .85 + hashStr('pr' + b.bkey + '#' + index) % 9));
  }
  const priceOf = rate => Math.round(rate * BUY_MULT);
  const incOf = r => (r.mode === 'owned' ? Math.round(r.rate * OWN_YIELD) : Math.round(r.rate));

  function status(bkey, kind, index) {
    const R = STATE.rooms || [];
    if (!R.length) return null;
    return R.find(r => r.bkey === bkey && r.kind === kind && r.index === index) || null;
  }
  const unitName = (kind, index) => kind === 'floor' ? (index === 0 ? 'Ground floor' : 'Floor ' + (index + 1)) : null;

  // ---- the purchase core (shared by the modal flow and QA) ----------
  // act = 'buy' | 'rent'. Returns {ok, why?, cost?, rate?, entry?}.
  function commit(b, kind, index, name, area, act) {
    const R = STATE.rooms || (STATE.rooms = []);
    if (status(b.bkey, kind, index)) return { ok: false, why: 'taken' };
    if (R.length >= CAP) return { ok: false, why: 'cap' };
    const rt = rateOf(b, kind, index, area);
    const cost = act === 'buy' ? priceOf(rt) : rt * DEPOSIT;
    if (!spend(cost)) return { ok: false, why: 'funds', cost, rate: rt };
    const c = centerOf(b), city = CITY.rec || {};
    const entry = {
      id: 'p' + b.bkey + '-' + kind.charAt(0) + index,
      cityKey: city.key || 'rural', cityName: city.name || null,
      bkey: b.bkey, kind, index, name,
      area: Math.max(1, Math.round(area)), rate: rt,
      mode: act === 'buy' ? 'owned' : 'rented',
      price: act === 'buy' ? cost : 0,
      x: c.x, z: c.z,
    };
    R.push(entry);
    try { saveGame(); } catch (e) { }
    try { OH.refresh(); } catch (e) { }
    return { ok: true, cost, rate: rt, entry };
  }

  // ---- the deal block (rendered INTO the v2.41 inspector panel) ----
  function forSaleHTML(name, area, rt) {
    return '<div id="ohp-dl">' + name.toUpperCase() + ' \u2014 FOR SALE OR RENT</div>' +
      '<div class="ohp-kv"><span>Area</span><b>' + Math.max(1, Math.round(area)) + ' m\u00b2</b></div>' +
      '<div class="ohp-kv"><span>Market rent</span><b>$' + rt + '/day</b></div>' +
      '<button class="btn good" data-pd="buy">BUY \u2014 ' + fmt$(priceOf(rt)) + ' (yours forever)</button>' +
      '<button class="btn primary" data-pd="rent">RENT \u2014 $' + rt + '/day \u00b7 deposit ' + fmt$(rt * DEPOSIT) + '</button>';
  }
  function mineHTML(o, name) {
    const inc = incOf(o);
    const mn = (o.machines || []).length, mi = (window.MACH ? MACH.incOfDay(o) : 0);   // v2.45 MACHINES
    const fn = (o.furn || []).length;   // v2.57 FURNITURE
    return '<div id="ohp-dl" style="color:' + (o.mode === 'owned' ? '#f5cc74' : '#7ee2a8') + '">' +
      name.toUpperCase() + ' \u2014 ' + (o.mode === 'owned' ? 'YOU OWN IT' : 'RENTED BY YOU') + '</div>' +
      '<div class="ohp-kv"><span>Income</span><b style="color:#48BB78">+$' + inc + '/day</b></div>' +
      (o.mode === 'owned'
        ? '<div class="ohp-kv"><span>Resale value</span><b>' + fmt$(Math.round(o.price * SELL_BACK)) + '</b></div>'
        : '<div class="ohp-kv"><span>Lease rate</span><b>$' + o.rate + '/day</b></div>') +
      '<div class="ohp-kv"><span>Machines</span><b>' + (mn ? mn + ' installed \u00b7 <span style="color:#48BB78">+$' + mi + '/day</span>' : 'none yet') + '</b></div>' +   // v2.45
      '<div class="ohp-kv"><span>Furniture</span><b>' + (fn ? fn + ' piece' + (fn === 1 ? '' : 's') + ' placed' : 'none yet') + '</b></div>' +   // v2.57 FURNITURE
      (function () { try { return window.LORD ? LORD.tagLine(o.id) : ''; } catch (er) { return ''; } })() +   // v2.47 LANDLORD
      '<button class="btn" data-pd="man">' + (o.mode === 'owned' ? 'MANAGE PROPERTY' : 'MANAGE LEASE') + '</button>' +
      '<button class="btn good" data-pd="mach">' + (mn ? 'MANAGE MACHINES \u00b7 ' + mn : 'INSTALL MACHINES') + '</button>' +   // v2.45
      '<button class="btn primary" data-pd="furn">FURNISH \u2014 THE FURNITURE SHOP</button>';   // v2.57 FURNITURE
  }
  function dealInto(el, b, L, sel) {
    if (!el || !b || !L) return;
    const hasUnits = L.nF >= 3 || (L.rooms && L.rooms.length > 0);
    if (!hasUnits) { el.classList.remove('on'); el.innerHTML = ''; return; }
    let html = '', kind = null, index = null;
    if (sel.floor != null && L.floorRanges && L.floorRanges[sel.floor]) {
      const i = sel.floor;
      kind = 'floor'; index = i;
      const own = status(b.bkey, 'floor', i);
      const rt = rateOf(b, 'floor', i, areaOf(b));
      html = own ? mineHTML(own, own.name || unitName('floor', i)) : forSaleHTML(unitName('floor', i), areaOf(b), rt);
    } else if (sel.room != null && L.rooms && L.rooms[sel.room]) {
      const i = sel.room, r = L.rooms[i];
      kind = 'room'; index = i;
      const a = Math.max(1, Math.round((r.x1 - r.x0) * (r.z1 - r.z0)));
      const own = status(b.bkey, 'room', i);
      const rt = rateOf(b, 'room', i, a);
      html = own ? mineHTML(own, own.name || r.name) : forSaleHTML(r.name, a, rt);
    } else {
      // nothing picked yet — a quiet hint that the picks are property
      html = '<div id="ohp-dl" style="color:#7dd3fc">SELECT A ' + (L.nF >= 3 ? 'FLOOR' : 'ROOM') +
        ' \u2014 THEN BUY OR RENT IT</div>';
    }
    el.innerHTML = html;
    el.classList.add('on');
    const buy = el.querySelector('[data-pd="buy"]'), rent = el.querySelector('[data-pd="rent"]'), man = el.querySelector('[data-pd="man"]');
    if (buy) buy.onclick = () => openDeal(b, L, kind, index, 'buy');
    if (rent) rent.onclick = () => openDeal(b, L, kind, index, 'rent');
    if (man) man.onclick = () => { const o = kind != null ? status(b.bkey, kind, index) : null; if (o) openManage(o); };
    const mach = el.querySelector('[data-pd="mach"]');   // v2.45 MACHINES: the machine shop on your own unit
    if (mach) mach.onclick = () => { if (window.MACH) { try { MACH.openShop(b.bkey, kind, index); } catch (er) { } } };
    const furn = el.querySelector('[data-pd="furn"]');   // v2.57 FURNITURE: the furniture shop on your own unit
    if (furn) furn.onclick = () => { if (window.FURN) { try { FURN.openShop(b.bkey, kind, index); } catch (er) { } } };
  }

  // ---- the deal modal (the game's own modal engine) ------------------
  function openDeal(b, L, kind, index, act) {
    const own = status(b.bkey, kind, index);
    if (own) { openManage(own); return; }
    let name, area;
    if (kind === 'floor') { name = unitName('floor', index); area = areaOf(b); }
    else {
      const r = L.rooms[index];
      if (!r) return;
      name = r.name; area = Math.max(1, Math.round((r.x1 - r.x0) * (r.z1 - r.z0)));
    }
    const rt = rateOf(b, kind, index, area);
    const buying = act === 'buy';
    const cost = buying ? priceOf(rt) : rt * DEPOSIT;
    const city = CITY.rec || {};
    openModal(name + ' \u2014 ' + (city.name || 'Property'), `
      <p>${buying
        ? 'Buy <b>' + name + '</b> outright in <b>' + (city.name || 'this city') + '</b> \u2014 it is yours forever: the tenants pay you <b>$' + Math.round(rt * OWN_YIELD) + '/day</b>, it counts toward your net worth, and you can sell it back any time for 60%.'
        : 'Rent <b>' + name + '</b> in <b>' + (city.name || 'this city') + '</b> \u2014 a two-day deposit, the unit pays you <b>$' + rt + '/day</b>, and you can end the lease whenever you like.'}</p>
      <div class="kv"><span class="k">SIZE</span><span class="v">${Math.max(1, Math.round(area))} m\u00b2</span></div>
      <div class="kv"><span class="k">${buying ? 'PRICE' : 'DEPOSIT'}</span><span class="v g">${fmt$(cost)}</span></div>
      <div class="kv"><span class="k">INCOME</span><span class="v g">+$${buying ? Math.round(rt * OWN_YIELD) : rt}/day</span></div>
      <div class="kv"><span class="k">BALANCE</span><span class="v">${fmt$(STATE.money)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn good" id="pd-go" style="flex:1">${buying ? 'BUY ' + name.toUpperCase() : 'RENT ' + name.toUpperCase()}</button>
        <button class="btn" id="pd-x">CLOSE</button>
      </div>`);
    document.getElementById('pd-go').onclick = () => {
      const res = commit(b, kind, index, name, area, act);
      if (!res.ok) {
        if (res.why === 'cap') toast('<b>Property cap reached</b> (' + CAP + '). Sell or end a lease first.', 'warn');
        else if (res.why === 'funds') toast('<b>Not enough money.</b> Serve some food first.', 'warn');
        else toast('That one is already yours.', 'warn');
        return;
      }
      closeModal();
      toast(buying
        ? 'Bought <b>' + name + '</b> for ' + fmt$(res.cost) + ' \u2014 collecting $' + Math.round(rt * OWN_YIELD) + '/day.'
        : 'Rented <b>' + name + '</b> \u2014 collecting $' + rt + '/day.');
    };
    document.getElementById('pd-x').onclick = closeModal;
  }

  // ---- manage / sell / end-lease --------------------------------------
  function openManage(o) {
    if (!o) return;
    const inc = incOf(o);
    openModal(o.name + ' \u2014 ' + (o.mode === 'owned' ? 'Your Property' : 'Your Lease'), `
      <div id="pl"><span class="l">Income</span><span class="v">+$${(inc / 90 * 60).toFixed(2)}/min</span></div>
      <div class="kv"><span class="k">CITY</span><span class="v">${o.cityName || o.cityKey}</span></div>
      <div class="kv"><span class="k">SIZE</span><span class="v">${o.area} m\u00b2</span></div>
      <div class="kv"><span class="k">RATE</span><span class="v g">$${o.rate}.00 /day</span></div>
      <div class="kv"><span class="k">MACHINES</span><span class="v">${(o.machines || []).length} installed \u00b7 +$${(window.MACH ? MACH.incOfDay(o) : 0)}/day</span></div>   <!-- v2.45 -->
      <div class="kv"><span class="k">FURNITURE</span><span class="v">${(o.furn || []).length} pieces \u00b7 ${fmt$(window.FURN ? FURN.valueOfUnit(o) : 0)} at catalog</span></div>   <!-- v2.57 -->
      ${o.mode === 'owned' ? '<div class="kv"><span class="k">RESALE VALUE</span><span class="v">' + fmt$(Math.round(o.price * SELL_BACK)) + '</span></div>' : ''}
      ${(function () { try { return window.LORD ? LORD.tagLine(o.id, true) : ''; } catch (er) { return ''; } })()}   <!-- v2.47 LANDLORD -->
      <button class="btn good" id="pm-rent" style="width:100%;margin-top:14px">${o.mode === 'owned' ? 'RENT IT OUT \u2014 SET YOUR PRICE' : 'SUBLET IT \u2014 SET YOUR PRICE'}</button>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn bad" id="pm-end" style="flex:1">${o.mode === 'owned' ? 'SELL \u2014 ' + fmt$(Math.round(o.price * SELL_BACK)) : 'END LEASE'}</button>
        <button class="btn primary" id="pm-mach">MACHINES</button>   <!-- v2.45 -->
        <button class="btn good" id="pm-furn">FURNISH</button>   <!-- v2.57 -->
        <button class="btn" id="pm-x">CLOSE</button>
      </div>`);
    document.getElementById('pm-end').onclick = () => {
      STATE.rooms = (STATE.rooms || []).filter(x => x !== o);
      if (o.mode === 'owned') {
        earn(Math.round(o.price * SELL_BACK), false);   // resale proceeds don't count toward GDP
        toast('Sold <b>' + o.name + '</b> for ' + fmt$(Math.round(o.price * SELL_BACK)) + '.');
      } else toast('Lease ended on <b>' + o.name + '</b>. The deposit was non-refundable.', 'warn');
      try { saveGame(); } catch (e) { }
      closeModal();
      try { OH.refresh(); } catch (e) { }
    };
    const pmr = document.getElementById('pm-rent');   // v2.47 LANDLORD: rent the unit out at your own price
    if (pmr) pmr.onclick = () => { try { LORD.open(o.id); } catch (er) { } };
    const pmm = document.getElementById('pm-mach');   // v2.45 MACHINES: open the shop for this holding
    if (pmm) pmm.onclick = () => { if (window.MACH) { try { closeModal(); MACH.openShopFor(o); } catch (er) { } } };
    const pmf = document.getElementById('pm-furn');   // v2.57 FURNITURE: open the furniture shop for this holding
    if (pmf) pmf.onclick = () => { if (window.FURN) { try { closeModal(); FURN.openShopFor(o); } catch (er) { } } };
    document.getElementById('pm-x').onclick = closeModal;
  }

  // ---- the Empire panel: your title deeds, one-tap travel ------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    const here = CITY.rec && CITY.rec.key;
    const R = STATE.rooms || [];
    const rows = R.map((r, i) => {
      const local = here === r.cityKey && STATE.mode === 'city';
      const mn = (r.machines || []).length;   // v2.45 MACHINES
      const fn = (r.furn || []).length;   // v2.57 FURNITURE
      return '<div class="kv"><span class="k">' + r.name + ' \u00b7 ' + (r.cityName || r.cityKey) +
        ' \u00b7 ' + (r.mode === 'owned' ? 'OWNED' : 'RENTED') + ' \u00b7 $' + (incOf(r) + (window.MACH ? MACH.incOfDay(r) : 0)) + '/day' + (mn ? ' \u00b7 ' + mn + ' mach' : '') + (fn ? ' \u00b7 ' + fn + ' furn' : '') + '</span>' +
        '<button class="tpbtn" data-pr="' + i + '">' + (local ? 'TELEPORT' : 'TRAVEL') + '</button></div>';
    }).join('');
    const inc = R.reduce((s, r) => s + incOf(r) + (window.MACH ? MACH.incOfDay(r) : 0), 0);
    const html = '<div class="msec" style="margin-top:14px">Rooms &amp; floors \u2014 your title deeds</div>' +
      (rows || '<p>No rooms or floors yet. Click any building or house, pick a floor or a room, then <b>BUY</b> or <b>RENT</b> it from the panel.</p>') +
      (rows ? '<div class="kv" style="margin-top:10px"><span class="k">PROPERTY INCOME</span><span class="v g">+$' + (inc / 90 * 60).toFixed(2) + '/min</span></div>' : '');
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    body.querySelectorAll('[data-pr]').forEach(b => {
      b.onclick = () => { travelTo(R[+b.dataset.pr]); };
    });
  }
  const __propEmpire = ECO.openEmpire.bind(ECO);
  ECO.openEmpire = function () {
    __propEmpire();
    try { empireInto(); } catch (e) { console.error('[property]', e); }
  };

  // ---- travel: one tap to the doorstep (the inspector opens on arrival)
  function travelTo(r) {
    if (!r) return;
    closeModal();
    const here = CITY.rec && CITY.rec.key;
    if (here === r.cityKey && STATE.mode === 'city') {
      let spot = { x: r.x, z: r.z + Math.max(10, Math.sqrt(r.area || 120) + 6) };
      try {   // snap to the nearest street vertex within 60 m — never inside a wall
        let best = null;
        for (const rd of (CITY.roads || [])) {
          const pts = rd.pts || [];
          for (let i = 0; i < pts.length; i++) {
            const d = Math.hypot(pts[i][0] - r.x, pts[i][1] - r.z);
            if (!best || d < best.d) best = { x: pts[i][0], z: pts[i][1], d };
          }
        }
        if (best && best.d < 60) spot = best;
      } catch (e) { }
      try { ACTORS.clearGoal(); } catch (e) { }
      ACTORS.placePlayer(spot.x, spot.z);
      camCtl.tx = spot.x; camCtl.tz = spot.z;
      camCtl.follow = true; camCtl.distT = 64;
      ECO.arrivalPulse(r.x, r.z);
      try { OH.force(r.bkey); } catch (e) { }   // the inspector opens on arrival
      toast('\u26a1 Teleported to your <b>' + r.name + '</b>.', 'warn');
      return;
    }
    // another city (or orbit): dive there and land at the doorstep
    const c = CITIES.find(x => x.key === r.cityKey);
    let meta = c ? { key: c.key, name: c.name, lat: c.lat, lon: c.lon, tier: c.tier } : null;
    if (!meta) {
      const m = /^ll(-?[0-9.]+)_(-?[0-9.]+)$/.exec(r.cityKey || '');
      if (m) meta = { key: r.cityKey, name: r.cityName || r.cityKey, lat: +m[1], lon: +m[2], searched: true };
    }
    if (!meta) { toast('<b>That city can no longer be found</b> \u2014 travel there from the map first.', 'warn'); return; }
    propArrival = r; arrivalT = 0;
    enterWorld(meta, { at: { x: r.x, z: r.z + Math.max(10, Math.sqrt(r.area || 120) + 6) } });
  }

  // ---- income accrual + arrival watch (the office-suite beat) ---------
  function tick(dt) {
    const R = STATE.rooms || [];
    if (STATE.mode !== 'city' || !R.length) { acc = 0; }
    else {
      acc += dt;
      if (acc >= 1) {
        const secs = acc; acc = 0;
        let inc = 0;
        for (const r of R) inc += incOf(r);
        if (inc > 0) earn(inc / 90 * secs);
      }
    }
    if (propArrival) {
      arrivalT += dt;
      if (arrivalT > 45) { propArrival = null; arrivalT = 0; return; }
      try {
        if (CITY.group && CITY.buildingPolys && CITY.buildingPolys.some(x => x.bkey === propArrival.bkey)) {
          const r = propArrival; propArrival = null; arrivalT = 0;
          OH.force(r.bkey);
        }
      } catch (e) { propArrival = null; arrivalT = 0; }
    }
  }

  return {
    tick, dealInto, travelTo, openManage, status, rateOf, priceOf, incOf,
    list: () => (STATE.rooms || []).slice(),
    count: () => (STATE.rooms || []).length,
    // QA: programmatic purchase/rent of the OPEN building's unit (no modal)
    buyAt(bkey, kind, index) {
      const B = (CITY.buildingPolys || []).find(x => x.bkey === bkey);
      if (!B) return { ok: false, why: 'no building ' + bkey };
      let name, area;
      if (kind === 'floor') { name = unitName('floor', index); area = areaOf(B); }
      else {
        const rc = OH.roomRect(index);
        if (!rc) return { ok: false, why: 'no open room ' + index };
        name = rc.name; area = rc.area;
      }
      return commit(B, kind, index, name, area, 'buy');
    },
    rentAt(bkey, kind, index) {
      const B = (CITY.buildingPolys || []).find(x => x.bkey === bkey);
      if (!B) return { ok: false, why: 'no building ' + bkey };
      let name, area;
      if (kind === 'floor') { name = unitName('floor', index); area = areaOf(B); }
      else {
        const rc = OH.roomRect(index);
        if (!rc) return { ok: false, why: 'no open room ' + index };
        name = rc.name; area = rc.area;
      }
      return commit(B, kind, index, name, area, 'rent');
    },
    sell(id) {   // QA: instant sell/end of a holding by id
      const R = STATE.rooms || [];
      const o = R.find(x => x.id === id);
      if (!o) return { ok: false, why: 'no holding ' + id };
      STATE.rooms = R.filter(x => x !== o);
      if (o.mode === 'owned') earn(Math.round(o.price * SELL_BACK), false);
      try { saveGame(); } catch (e) { }
      return { ok: true, got: o.mode === 'owned' ? Math.round(o.price * SELL_BACK) : 0 };
    },
    state() {
      return {
        holdings: (STATE.rooms || []).length,
        owned: (STATE.rooms || []).filter(r => r.mode === 'owned').length,
        rented: (STATE.rooms || []).filter(r => r.mode === 'rented').length,
        incomePerDay: (STATE.rooms || []).reduce((s, r) => s + incOf(r), 0),
        accrual: +acc.toFixed(2),
        arrival: propArrival ? propArrival.id : null,
      };
    },
  };
})();
window.PROP = PROP;   // QA surface

// ADDITIVE hook — the property income tick rides the same WORLD.update
// wrap chain the game already uses (original update -> world forest ->
// open house -> suburbs LOD -> TITLE DEEDS). Every call is try/caught
// so a property error can never touch the world.
const __propOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __propOrigUpdate(dt, px, pz, camDist);
  try { PROP.tick(dt); } catch (e) { console.error('[property]', e); }
  return req;
};

