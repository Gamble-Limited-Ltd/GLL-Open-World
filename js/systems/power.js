// ====================================================================
// js/systems/power.js — the Grid (Stage 7c): kWh meters, the POWER
// panel, daily billing, cut-offs. The last WORLD.update patch.
// ====================================================================
import { fmt$, fmt$2 } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { spend, uiBalance } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { ECO } from '../systems/eco.js';

// ======== section: 59_power.js ========
// ====================================================================
// v2.59 — THE GRID. The ask: "Businesses need electricity to run. Add
// a power meter per business; usage is billed per in-game day at a
// grid price from a utility. If bills go unpaid, the business shuts
// down until paid. Add a power usage panel."
// THE UTILITY: GLL Power & Light sells the kilowatt-hours at a grid
// price anchored at 40¢/kWh that drifts on the same game-day beat as
// every market (±8% a day, clamped ×0.55–×1.70) — watch the ▲▼ day
// change on the POWER panel and mind the spike days.
// THE METER: every cart business draws 0.4 kW to keep the lights on
// and the fridge cold, plus 0.15 kW per hired vendor — kilowatt-hours
// accrue in game time (24 grid hours a game day), one meter per
// business, frozen while the power is cut.
// THE BILL: each game-day beat the meter times the grid price comes
// due wages-style — paid out of the balance; a bill the balance can't
// cover cuts that business off (the bill stands as arrears) and the
// shutdown is real: no customers spawn, no sale goes through, no
// night-shift vendor income, until you pay.
// THE PANEL: the POWER button (bottom bar) opens THE GRID — today's
// price with the day change, one row per business (live meter, draw,
// estimated bill, ON/CUT, PAY), totals and PAY ALL up top. The
// business panel itself carries the meter block and PAY & RECONNECT,
// the Empire panel gains a Grid section, and the night shift bills
// every elapsed game day (an unstaffed cart powers down for the
// night — closed is closed).
// THE SAVE: a `pow` field in the pack (grid multiplier + per-business
// meters, keyed by plot id — a scrapped cart leaves no meter behind),
// sanitized on load; pack stays v5, older builds ignore it. The
// Works' own power ($0.25 a tonne) is untouched.
// ====================================================================
export const PWR = (() => {
  const DAY = 90;                            // seconds per game day — the beat everything settles on
  const PAR = 0.40;                          // grid price par, $/kWh
  const STEP = .08, LO = .55, HI = 1.70;     // the drift band every market uses
  const BASE_KW = 0.4, VEND_KW = 0.15;       // the draw: lights + fridge, and a little per vendor
  const HPS = 24 / DAY;                      // game-hours per real-second (24 h over a 90 s day)
  let dayT = 0, dayN = 0;
  let panelT = null;                         // the live re-render while THE GRID is open

  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  // ---- state helpers (all lazy — a save load can replace STATE) ------
  function ensure() {
    if (!STATE.pow || typeof STATE.pow !== 'object') STATE.pow = { g: { m: 1, pm: 1 }, b: {} };
    if (!STATE.pow.g || typeof STATE.pow.g !== 'object') STATE.pow.g = { m: 1, pm: 1 };
    const g = STATE.pow.g;
    if (!isFinite(+g.m) || +g.m <= 0) g.m = 1;
    g.m = Math.max(LO, Math.min(HI, +g.m));
    if (!isFinite(+g.pm) || +g.pm <= 0) g.pm = 1;
    g.pm = Math.max(LO, Math.min(HI, +g.pm));
    if (!STATE.pow.b || typeof STATE.pow.b !== 'object') STATE.pow.b = {};
    for (const k in STATE.pow.b) {          // sweep dead meters (a scrapped cart leaves nothing to read)
      if (!biz().some(p => p.id === k)) delete STATE.pow.b[k];
    }
    return STATE.pow;
  }
  const biz = () => (STATE.plots || []).filter(p => p && p.cart);
  function rec(p) {
    ensure();
    let e = STATE.pow.b[p.id];
    if (!e || typeof e !== 'object' || !isFinite(+e.m)) { e = { m: 0, cut: 0, due: 0 }; STATE.pow.b[p.id] = e; }
    if (!isFinite(+e.due)) e.due = 0;
    e.cut = e.cut ? 1 : 0;
    return e;
  }
  const draw = p => +(BASE_KW + VEND_KW * Math.min(5, (p.crew || []).length)).toFixed(2);
  const mult = () => { const g = STATE.pow && STATE.pow.g; return (g && isFinite(+g.m) && +g.m > 0) ? +g.m : 1; };
  const pmv = () => { const g = STATE.pow && STATE.pow.g; return (g && isFinite(+g.pm) && +g.pm > 0) ? +g.pm : 1; };
  const price = () => PAR * mult();
  const pct = () => { const p = pmv(); return p ? (mult() / p - 1) * 100 : 0; };
  const isCut = p => { const e = STATE.pow && STATE.pow.b && STATE.pow.b[p && p.id || p]; return !!(e && e.cut); };
  function bizName(p) {
    const cui = (window.ECO ? ECO.CUISINES : []).find(c => c && p.cart && c.id === p.cart.cuisine);
    return (cui ? cui.emoji + ' ' + cui.name : 'Food') + ' cart · ' + ((window.ECO && ECO.cityNameOf) ? ECO.cityNameOf(p) : (p.cityName || 'the road'));
  }

  // ---- the meter: kilowatt-hours accrue while the lights are on ------
  function tick(dt) {
    if (STATE.mode === 'boot') return;
    ensure();
    dayT += dt;
    for (const p of biz()) { const e = rec(p); if (!e.cut) e.m = +(e.m + draw(p) * dt * HPS).toFixed(3); }
    if (dayT >= DAY) { dayT -= DAY; try { day(); } catch (er) { console.error('[power]', er); } }
  }

  // ---- the bill: each game day, the meter times the grid price -------
  function day() {
    ensure();
    dayN++;
    const g = STATE.pow.g;
    g.pm = g.m;
    const wob = ((hash('grid' + dayN) % 1000) / 1000 - .5) * STEP;
    g.m = Math.max(LO, Math.min(HI, g.m * (1 + wob)));
    let billed = 0, cutN = 0, firstCut = null, arrears = 0;
    for (const p of biz()) {
      const e = rec(p);
      if (e.cut) continue;                   // already dark — the meter is frozen
      const bill = +(e.m * price()).toFixed(2);
      if (!(bill > 0)) { e.m = 0; continue; }
      if (STATE.money >= bill) { STATE.money = +(STATE.money - bill).toFixed(2); billed += bill; }
      else { e.cut = 1; e.due = bill; cutN++; if (!firstCut) firstCut = bizName(p); arrears += bill; }
      e.m = 0;
    }
    if (billed > 0 || cutN > 0) {
      try { uiBalance(); } catch (er) { }
      try { saveGame(); } catch (er) { }
      if (cutN > 0) { try { toast('⚡ <b>POWER CUT at ' + firstCut + (cutN > 1 ? ' and ' + (cutN - 1) + ' more' : '') + '</b> — the bill was ' + fmt$(arrears) + ' and the balance fell short. Pay at the <b>POWER</b> panel (bottom bar) to reconnect.', 'warn'); } catch (er) { } }
      try { renderIfOpen(); } catch (er) { }
    }
  }

  // ---- reconnect: pay the arrears and the lights come back on --------
  function pay(id) {
    ensure();
    const p = biz().find(x => x.id === id);
    if (!p) return { ok: false, why: 'no business' };
    const e = rec(p);
    if (!e.cut) return { ok: false, why: 'not cut' };
    if (!spend(e.due)) { try { toast('<b>Not enough money.</b> The arrears at ' + bizName(p) + ' are ' + fmt$(e.due) + '.', 'warn'); } catch (er) { } return { ok: false, why: 'cash' }; }
    e.cut = 0; e.due = 0; e.m = 0;
    try { saveGame(); } catch (er) { }
    try { toast('⚡ <b>Power restored</b> at ' + bizName(p) + ' — the lights are back on and the customers with them.'); } catch (er) { }
    try { renderIfOpen(); } catch (er) { }
    return { ok: true };
  }
  function payAll() {
    ensure();
    const cuts = biz().filter(p => rec(p).cut);
    if (!cuts.length) { try { toast('Nothing to pay — every meter is turning.'); } catch (er) { } return { ok: true, paid: 0 }; }
    let n = 0;
    for (const p of cuts) { if (pay(p.id).ok) n++; }
    return { ok: true, paid: n, left: biz().filter(p => rec(p).cut).length };
  }

  // ---- the night shift: power comes due while you sleep too ----------
  // (whole days only, the same beat the crews dig on — an unstaffed cart
  // powers down for the night, and the partial meter left over from the
  // last live session bills at the next live game-day beat, so nothing
  // is ever billed twice)
  function nightSettle(days) {
    ensure();
    const out = { billed: 0, cut: [] };
    if (!(days > 0)) return out;
    const px = price();
    for (const p of biz()) {
      if (!(p.crew || []).length) continue;   // unstaffed overnight — closed, powered down
      const e = rec(p);
      if (e.cut) continue;                    // already dark — nothing draws
      const bill = +(draw(p) * 24 * days * px).toFixed(2);
      if (!(bill > 0)) continue;
      if (STATE.money >= bill) { STATE.money = +(STATE.money - bill).toFixed(2); out.billed += bill; }
      else { e.cut = 1; e.due = bill; out.cut.push(bizName(p)); }
    }
    if (out.billed > 0 || out.cut.length) { try { uiBalance(); } catch (er) { } }
    out.billed = +out.billed.toFixed(2);
    return out;
  }

  // ---- THE GRID: the power usage panel ---------------------------------
  function rowHTML(p) {
    const e = rec(p), px = price(), kw = draw(p);
    if (e.cut) return '<div class="pg-row cut"><div class="pg-name"><b>' + bizName(p) + '</b><span><b style="color:#FC8181">POWER CUT</b> — ' + fmt$(e.due) + ' in arrears · no customers, no income until paid</span></div><button class="tpbtn" data-pg="' + p.id + '">PAY ' + fmt$(e.due) + '</button></div>';
    return '<div class="pg-row"><div class="pg-name"><b>' + bizName(p) + '</b><span>' + kw.toFixed(2) + ' kW draw · meter ' + e.m.toFixed(1) + ' kWh · ≈ ' + fmt$(e.m * px) + ' at today\u2019s price</span></div><span class="pg-on">ON</span></div>';
  }
  function render() {
    ensure();
    const sum = document.getElementById('pg-sum'), list = document.getElementById('pg-list');
    if (!sum || !list) return;
    const b = biz();
    const kw = b.reduce((s, p) => s + (rec(p).cut ? 0 : draw(p)), 0);
    const kwh = b.reduce((s, p) => s + rec(p).m, 0);
    const due = b.reduce((s, p) => s + rec(p).due, 0);
    const cuts = b.filter(p => rec(p).cut).length;
    const pc = pct();
    sum.innerHTML =
      '<div class="kv"><span class="k">TODAY\u2019S PRICE</span><span class="v' + (pc >= 0 ? ' g' : '') + '">' + fmt$2(price()) + '/kWh ' + (pc >= 0 ? '▲' : '▼') + Math.abs(pc).toFixed(1) + '% — par $0.40, moves every game day</span></div>' +
      '<div class="kv"><span class="k">YOUR BUSINESSES</span><span class="v">' + b.length + (b.length === 1 ? ' cart' : ' carts') + ' · ' + kw.toFixed(2) + ' kW · ' + kwh.toFixed(1) + ' kWh on the meters' + (cuts ? ' · <b style="color:#FC8181">' + cuts + ' CUT OFF</b>' : '') + '</span></div>' +
      '<div class="kv"><span class="k">NEXT BILLS</span><span class="v">≈ ' + fmt$(kwh * price()) + (due > 0 ? ' + ' + fmt$(due) + ' arrears' : '') + ' — billed each game day at the grid price</span></div>';
    list.innerHTML = b.length ? b.map(rowHTML).join('') : '<p style="margin-top:8px">No businesses yet — park a food cart on a plot you own and its meter starts turning.</p>';
  }
  function wire() {
    const list = document.getElementById('pg-list');
    if (list) list.querySelectorAll('[data-pg]').forEach(btn => { btn.onclick = () => { try { pay(btn.dataset.pg); } catch (er) { } try { render(); wire(); } catch (er) { } }; });
    const all = document.getElementById('pg-all');
    if (all) all.onclick = () => { try { payAll(); } catch (er) { } try { render(); wire(); } catch (er) { } };
    const x = document.getElementById('pg-x');
    if (x) x.onclick = closeModal;
  }
  function renderIfOpen() { if (document.getElementById('pg-list')) { render(); wire(); } }
  function open() {
    ensure();
    openModal('THE GRID — GLL Power & Light', `
      <p>Every business you run draws power around the clock. The meter spins, the utility bills it <b>each game day</b> at the grid price — and a bill the balance can't cover <b>cuts the power</b>: no customers, no income, until you pay.</p>
      <div id="pg-sum"></div>
      <div id="pg-list" style="max-height:42vh;overflow:auto;padding-right:2px"></div>
      <p style="margin-top:10px">The grid price moves every game day (±8% around 40¢/kWh, clamped ×0.55–×1.70). Each cart draws 0.4 kW plus 0.15 kW per vendor — power comes due while you're away too (an unstaffed cart powers down for the night; a staffed one keeps the meter turning). The Works pour their own power at $0.25 a tonne, untouched.</p>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="pg-all" style="flex:1">PAY ALL BILLS</button><button class="btn" id="pg-x" style="flex:1">CLOSE</button></div>`);
    render(); wire();
    if (panelT) clearInterval(panelT);
    panelT = setInterval(() => {
      if (document.getElementById('modalwrap').classList.contains('hidden') || !document.getElementById('pg-list')) { clearInterval(panelT); panelT = null; return; }
      try { render(); wire(); } catch (er) { }
    }, 2000);
  }

  // ---- the business panel's power block (openBusiness renders it) ----
  function bizRowHTML(p) {
    try {
      ensure();
      const e = rec(p), px = price(), kw = draw(p);
      if (e.cut) {
        return '<div class="msec" style="margin-top:14px">Power — GLL Power &amp; Light</div>' +
          '<div class="kv"><span class="k">METER</span><span class="v"><b style="color:#FC8181">POWER CUT</b> — ' + kw.toFixed(2) + ' kW draw, frozen</span></div>' +
          '<div class="kv"><span class="k">ARREARS</span><span class="v" style="color:#FC8181">' + fmt$(e.due) + ' — no customers, no income until paid</span></div>' +
          '<button class="btn good" id="bs-pay" style="width:100%;margin-top:10px">PAY &amp; RECONNECT — ' + fmt$(e.due) + '</button>';
      }
      return '<div class="msec" style="margin-top:14px">Power — GLL Power &amp; Light</div>' +
        '<div class="kv"><span class="k">METER</span><span class="v">' + e.m.toFixed(1) + ' kWh · ' + kw.toFixed(2) + ' kW draw</span></div>' +
        '<div class="kv"><span class="k">GRID PRICE</span><span class="v">' + fmt$2(px) + '/kWh today (par $0.40 · moves daily)</span></div>' +
        '<div class="kv"><span class="k">NEXT BILL</span><span class="v">≈ ' + fmt$(e.m * px) + ' so far — billed each game day</span></div>';
    } catch (er) { return ''; }
  }

  // ---- the Empire panel section (one glance at the meters) ------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    ensure();
    const b = biz();
    const kw = b.reduce((s, p) => s + (rec(p).cut ? 0 : draw(p)), 0);
    const kwh = b.reduce((s, p) => s + rec(p).m, 0);
    const cuts = b.filter(p => rec(p).cut).length;
    const pc = pct();
    const html = '<div class="msec" style="margin-top:14px">The Grid — power &amp; light</div>' +
      '<div class="kv"><span class="k">' + b.length + ' business' + (b.length === 1 ? '' : 'es') + ' · ' + kw.toFixed(2) + ' kW · ' + kwh.toFixed(1) + ' kWh on the meters' + (cuts ? ' · <b style="color:#FC8181">' + cuts + ' CUT OFF</b>' : '') + ' · grid ' + (pc >= 0 ? '▲' : '▼') + Math.abs(pc).toFixed(1) + '% today</span><button class="tpbtn" id="em-pw">OPEN</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    const btn = document.getElementById('em-pw');
    if (btn) btn.onclick = () => { try { open(); } catch (er) { } };
  }

  // ---- styles ------------------------------------------------------------
  try {
    const st = document.createElement('style');
    st.textContent = [
      '#pg-list{display:flex;flex-direction:column}',
      '.pg-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:9px;',
      ' background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);margin-top:6px}',
      '.pg-row.cut{background:rgba(252,129,129,.10);border-color:rgba(252,129,129,.45)}',
      '.pg-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.pg-name b{font-size:12px;letter-spacing:.4px}',
      '.pg-name span{font-size:9.5px;color:var(--mut)}',
      '.pg-on{flex:none;font-size:9.5px;font-weight:800;letter-spacing:1.2px;color:#48BB78}',
      '.pg-row .tpbtn{margin:0;white-space:nowrap}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }

  ensure();   // seed a fresh save's grid at par

  return {
    open, empireInto, tick, nightSettle, pay, payAll, isCut, draw, price, mult, PAR,
    bizRow: bizRowHTML, biz: () => biz().slice(),
    // QA: run whole game-days of drift + billing instantly (same math as the beat)
    qaDay(n) { for (let i = 0; i < (n || 1); i++) { try { day(); } catch (er) { } } return this.state(); },
    state() {
      ensure();
      return {
        dayN, px: +price().toFixed(3), m: +mult().toFixed(3), pm: +pmv().toFixed(3), pc: +pct().toFixed(2),
        money: Math.round(STATE.money),
        biz: biz().map(p => { const e = rec(p); return { id: p.id, name: bizName(p), kW: +draw(p).toFixed(2), kwh: +e.m.toFixed(1), cut: e.cut ? 1 : 0, due: +e.due.toFixed(2) }; }),
      };
    },
  };
})();
window.PWR = PWR;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the Empire panel gains the Grid section (after every other)
const __pwrEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __pwrEmpire();
  try { PWR.empireInto(); } catch (e) { console.error('[power]', e); }
};
// 2. the update chain: original -> world forest -> open house ->
//    suburbs -> title deeds -> patchwork -> machines -> landlord ->
//    exchange -> works -> ground up -> furniture -> THE GRID. Every
//    call is try/caught so a power error can never touch the world.
const __pwrOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __pwrOrigUpdate(dt, px, pz, camDist);
  try { PWR.tick(dt); } catch (e) { console.error('[power]', e); }
  return req;
};


