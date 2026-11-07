// ====================================================================
// js/systems/works.js — the Works (Stage 7c): refining machines
// turning ore into traded goods.
// ====================================================================
import { fmt$ } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend, uiBalance } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { ECO } from '../systems/eco.js';
import { MINE } from '../systems/mining.js';
import { EXCH } from '../systems/exchange.js';

// ======== section: 54_works.js ========
// ====================================================================
// v2.53 — THE WORKS. The ask: "Make machines that people can use to
// refine these resources into other resources." This is the machine
// half of the refining pair (53_exchange.js re-shipped alongside it
// so the refined goods trade on the market):
//   - twelve REFINING MACHINES, one per ore, from a $22,000
//     Briquette Press (560 t lignite/day → 400 t briquettes) to a
//     $64,000 Alloy Works (320 t nickel/day → 80 t superalloy) —
//     a Blast Furnace pours Steel from iron (3 t → 1 t), a Coke
//     Oven pours Coke from coal, a Glass Kiln pours Glass from
//     quartz, a Copper Smelter pours Cathode from copper;
//   - THE POUR: every 90 s game-day beat each machine draws ore
//     from the shared stockpile (up to its t/day) and pours refined
//     goods back into it — a short pile runs the line slower, the
//     same way a short crew runs a mine slower; power is billed at
//     $0.25 per tonne processed (never dipping the balance below
//     zero), and the pour saves with the game;
//   - BUYING: OPEN THE WORKS from the WORKS row on the MINE panel,
//     the THE WORKS button on the exchange board or the Empire
//     panel's Works section — each card states its feed, its pour,
//     the ore it needs and what's on hand; any machine scraps back
//     for 60% any time;
//   - THE GOODS: refined goods trade on the ORE exchange beside the
//     ores (24 rows, two groups), each around the par its machine
//     sets — Steel $58/t, Cathode $170/t, Superalloy $152/t — and
//     generally for more than the ore that went in; the pile counts
//     in WORTH at today's prices exactly like ore;
//   - persistence: the optional `works` field in the save pack
//     (pack stays v5 — older builds ignore it), sanitized on load;
//     the goods themselves ride the v2.52 `res`/`mkt` fields, whose
//     sanitizers already accept any resource key.
// Everything lives in this one additive section; the only outside
// touchpoints are annotated "v2.53" (STATE/save/load works, the
// help-modal REFINING line, the What's-New modal, the attrib footer
// and the version surfaces). window.WORKS is the QA surface. Every
// works call is try/caught.
// ====================================================================

export const WORKS = (() => {
  const DAY = 90;               // seconds per game day (the exchange/wages beat)
  const POWER = .25;            // $ per tonne processed (billed on the pour)
  const SELL_BACK = .6;         // scrap any machine back for 60%
  // the catalog — one machine per ore, cheapest first (the yard's
  // order); `n` is tonnes of ore per tonne of goods, `par` the
  // refined good's par $/t (single source of truth — the exchange
  // reads it through WORKS.BASE)
  const MACH = [
    { id: 'press',   name: 'Briquette Press',   cost: 22000, tpd: 560, in: 'Lignite', out: 'Briquette',  n: 1.4, par: 24 },
    { id: 'pmill',   name: 'Plaster Mill',      cost: 26000, tpd: 500, in: 'Gypsum',  out: 'Plaster',    n: 1.5, par: 29 },
    { id: 'kiln',    name: 'Glass Kiln',        cost: 29000, tpd: 400, in: 'Quartz',  out: 'Glass',     n: 1.6, par: 38 },
    { id: 'mint',    name: 'Bullion Mint',      cost: 30000, tpd: 160, in: 'Silver',  out: 'Silver Bar', n: 2,   par: 86 },
    { id: 'solvay',  name: 'Solvay Tower',      cost: 33000, tpd: 420, in: 'Salt',    out: 'Soda Ash',  n: 2.1, par: 47 },
    { id: 'solder',  name: 'Solder Line',       cost: 34000, tpd: 300, in: 'Tin',     out: 'Tin Solder', n: 2.5, par: 74 },
    { id: 'oven',    name: 'Coke Oven',         cost: 38000, tpd: 500, in: 'Coal',    out: 'Coke',      n: 1.6, par: 31 },
    { id: 'zinc',    name: 'Zinc Works',        cost: 41000, tpd: 480, in: 'Zinc',    out: 'Zinc Ingot', n: 3,  par: 88 },
    { id: 'blast',   name: 'Blast Furnace',     cost: 46000, tpd: 600, in: 'Iron',    out: 'Steel',     n: 3,   par: 58 },
    { id: 'alsm',    name: 'Aluminium Smelter', cost: 58000, tpd: 480, in: 'Bauxite', out: 'Aluminium', n: 4,   par: 102 },
    { id: 'cusm',    name: 'Copper Smelter',    cost: 62000, tpd: 400, in: 'Copper',  out: 'Cathode',   n: 5,   par: 170 },
    { id: 'alloy',   name: 'Alloy Works',       cost: 64000, tpd: 320, in: 'Nickel',  out: 'Superalloy', n: 4,  par: 152 },
  ];
  const BASE = {}; for (const T of MACH) BASE[T.out] = T.par;   // the refined par table (the exchange reads this)
  const INOF = {}; for (const T of MACH) INOF[T.out] = T.in;    // Cathode ← Copper, for the board's "refined from" line
  const BYID = {}; MACH.forEach(T => { BYID[T.id] = T; });

  let dayT = 0;                 // game-day beat accumulator
  let toldFirst = false;        // the first-pour toast fires once per session
  let last = null;              // the previous day's pour (rides the modal + panels)

  // ---- state helpers (all lazy — a save load can replace STATE) ------
  function ensure() {
    if (!STATE.works || typeof STATE.works !== 'object') STATE.works = {};
    for (const k in STATE.works) {
      if (!BYID[k] || !isFinite(+STATE.works[k]) || +STATE.works[k] <= 0) delete STATE.works[k];
      else STATE.works[k] = Math.min(99, Math.round(+STATE.works[k]));
    }
    return STATE.works;
  }
  const cnt = id => Math.max(0, (STATE.works && STATE.works[id]) | 0);
  const machines = () => MACH.reduce((s, T) => s + cnt(T.id), 0);
  const held = r => { try { return window.EXCH ? (+EXCH.held(r) || 0) : 0; } catch (er) { return 0; } };
  const outTpd = T => Math.round(T.tpd / T.n);

  // ---- the pour: every machine draws ore, pours goods --------------------
  function day() {
    ensure();
    let ran = 0, made = 0, power = 0, firstOut = null;
    for (const T of MACH) {
      const n = cnt(T.id);
      if (!n) continue;
      const have = held(T.in);
      const run = Math.min(n * T.tpd, have);   // a short pile runs the line slower
      if (!(run > .01)) continue;
      try {
        const left = +(have - run).toFixed(2);
        if (left > .005) STATE.res[T.in] = left; else delete STATE.res[T.in];
        if (window.EXCH) EXCH.pile(T.out, +(run / T.n).toFixed(2));   // rounding + the once-toast live in the exchange
        else STATE.res[T.out] = +(((+STATE.res[T.out] || 0) + run / T.n)).toFixed(2);
      } catch (er) { }
      const p = Math.round(run * POWER * 100) / 100;
      const bill = Math.min(p, Math.max(0, STATE.money));   // power never dips the balance below zero
      STATE.money = +(STATE.money - bill).toFixed(2);
      power += bill;
      ran += run; made += run / T.n;
      if (!firstOut) firstOut = T.out;
    }
    if (made > 0) {
      last = { ran: Math.round(ran * 10) / 10, made: Math.round(made * 10) / 10, power: Math.round(power), at: firstOut };
      try { uiBalance(); } catch (er) { }
      try { saveGame(); } catch (er) { }
      if (!toldFirst) {
        toldFirst = true;
        try { toast('🏭 <b>The works poured their first ' + firstOut + '.</b> Refined goods trade on the <b>ORE exchange</b> — sell them like ore, when the price suits.', 'warn'); } catch (er) { }
      }
      try { renderIfOpen(); } catch (er) { }
    }
  }
  function tick(dt) {
    if (STATE.mode === 'boot') return;
    dayT += dt;
    if (dayT >= DAY) { dayT -= DAY; try { day(); } catch (er) { console.error('[works]', er); } }
  }

  // ---- buying / scrapping ---------------------------------------------------
  function buy(id) {
    ensure();
    const T = BYID[id];
    if (!T) return { ok: false, why: 'no machine' };
    if (cnt(id) >= 99) { try { toast('<b>The line is full</b> — 99 of them is enough ' + T.name + 's for anyone.', 'warn'); } catch (er) { } return { ok: false, why: 'cap' }; }
    if (STATE.money < T.cost) { try { toast('<b>Not enough money.</b> The ' + T.name + ' costs ' + fmt$(T.cost) + '.', 'warn'); } catch (er) { } return { ok: false, why: 'cash' }; }
    if (!spend(T.cost)) return { ok: false, why: 'cash' };
    STATE.works[id] = cnt(id) + 1;
    try { saveGame(); } catch (er) { }
    try { toast('🔥 <b>The ' + T.name + ' is on the line</b> — ' + fmt$(T.cost) + '. At full feed it pours ' + outTpd(T).toLocaleString('en-US') + ' t of ' + T.out.toLowerCase() + ' a day' + (held(T.in) > 1 ? '.' : ' — stockpile some ' + T.in.toLowerCase() + ' for it first.'), 'warn'); } catch (er) { }
    try { renderIfOpen(); } catch (er) { }
    return { ok: true, n: STATE.works[id] };
  }
  function scrap(id) {
    ensure();
    const T = BYID[id];
    if (!T || cnt(id) <= 0) return { ok: false, why: 'none' };
    STATE.works[id] = cnt(id) - 1;
    earn(Math.round(T.cost * SELL_BACK), false);   // resale doesn't count toward GDP
    try { saveGame(); } catch (er) { }
    try { toast('Scrapped the <b>' + T.name + '</b> for ' + fmt$(Math.round(T.cost * SELL_BACK)) + ' (60%).'); } catch (er) { }
    try { renderIfOpen(); } catch (er) { }
    return { ok: true, n: STATE.works[id] };
  }

  // ---- the yard -----------------------------------------------------------
  function cardHTML(T) {
    const n = cnt(T.id);
    const feed = held(T.in);
    const px = (window.EXCH && EXCH.price) ? EXCH.price(T.out) : T.par;
    return '<div class="wk-card' + (STATE.money < T.cost ? ' dim' : '') + '">' +
      '<div class="wk-info"><b>' + T.name + (n ? ' <span class="wk-n">×' + n + '</span>' : '') + '</b>' +
      '<span>' + T.tpd.toLocaleString('en-US') + ' t ' + T.in.toLowerCase() + '/day → ' + outTpd(T).toLocaleString('en-US') + ' t ' + T.out.toLowerCase() + '/day · ' +
      (T.n % 1 ? T.n.toFixed(1) : T.n) + ' t ' + T.in.toLowerCase() + ' per t ' + T.out.toLowerCase() + ' · power ≈ $' + Math.round(T.tpd * POWER) + '/day at full feed</span>' +
      '<span>' + (feed > 1 ? '<span class="g">' + Math.round(feed).toLocaleString('en-US') + ' t of ' + T.in.toLowerCase() + ' on hand</span>' : 'no ' + T.in.toLowerCase() + ' in the stockpile yet') +
      (n ? ' · pours ≈ ' + fmt$(outTpd(T) * n * px) + '/day of ' + T.out.toLowerCase() + ' at today\u2019s $' + (Math.round(px * 10) / 10) + '/t' : '') + '</span></div>' +
      '<div class="wk-buy"><span>' + fmt$(T.cost) + '</span>' +
      '<button class="btn primary" data-wb="' + T.id + '">BUY</button>' +
      (n ? '<button class="tpbtn" data-ws="' + T.id + '">SCRAP +' + fmt$(Math.round(T.cost * SELL_BACK)) + '</button>' : '') +
      '</div></div>';
  }
  function render() {
    const list = document.getElementById('wk-list');
    if (!list) return;
    ensure();
    const t = window.EXCH ? EXCH.stockT() : 0, v = window.EXCH ? EXCH.stockValue() : 0;
    const sum = document.getElementById('wk-sum');
    if (sum) sum.innerHTML =
      '<div class="kv"><span class="k">STOCKPILE</span><span class="v">' + (t > 0 ? t.toFixed(1) + ' t of ore and goods ≈ ' + fmt$(v) + ' at today\u2019s prices' : 'empty — the works draw the ore your crews dig') + '</span></div>' +
      '<div class="kv" style="margin-top:6px"><span class="k">LAST POUR</span><span class="v' + (last ? ' g' : '') + '">' + (last ? last.ran.toLocaleString('en-US') + ' t of ore in → ' + last.made.toLocaleString('en-US') + ' t of goods out · power ' + fmt$(last.power) : 'nothing yet — machines pour on the game-day beat') + '</span></div>' +
      '<div class="kv" style="margin-top:6px"><span class="k">THE LINE</span><span class="v">' + machines() + ' machine' + (machines() === 1 ? '' : 's') + ' on the line · power $' + POWER.toFixed(2) + '/t processed · scrap back ' + Math.round(SELL_BACK * 100) + '%</span></div>';
    list.innerHTML = MACH.map(cardHTML).join('');
    list.querySelectorAll('[data-wb]').forEach(b => { b.onclick = () => { try { buy(b.dataset.wb); } catch (er) { } }; });
    list.querySelectorAll('[data-ws]').forEach(b => { b.onclick = () => { try { scrap(b.dataset.ws); } catch (er) { } }; });
  }
  function renderIfOpen() { if (document.getElementById('wk-list')) render(); }
  function open() {
    ensure();
    openModal('THE WORKS — refining machines', `
      <p>Machines that <b>refine resources into other resources</b>. Every game day each machine draws ore from your stockpile and pours refined goods back into it — <b>steel from iron, coke from coal, glass from quartz</b> — and the goods trade on the <b>ORE exchange</b> for more than the ore that went in. Power is billed at $0.25 per tonne processed; any machine scraps back for 60%.</p>
      <div id="wk-sum"></div>
      <div id="wk-list" style="max-height:44vh;overflow:auto;padding-right:2px"></div>
      <p style="margin-top:10px">The pour lands on the same 90 s game-day beat as the exchange prices — feed the works by holding some ore back, and sell the goods when the price suits.</p>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="wk-exch" style="flex:1">OPEN THE EXCHANGE</button><button class="btn" id="wk-x" style="flex:1">CLOSE</button></div>`);
    render();
    const x = document.getElementById('wk-x');
    if (x) x.onclick = closeModal;
    const ex = document.getElementById('wk-exch');
    if (ex) ex.onclick = () => { try { if (window.EXCH) EXCH.open(); } catch (er) { } };
  }

  // ---- the MINE panel row (above STAKE A CLAIM) ---------------------------
  function mineInto() {
    const stake = document.getElementById('mp-stake');
    if (!stake) return;
    ensure();
    const n = machines();
    const html = '<div class="kv" style="margin-top:8px"><span class="k">THE WORKS — ' + (n ? n + ' refining machine' + (n === 1 ? '' : 's') + ' on the line' + (last ? ' · last pour ' + last.made.toLocaleString('en-US') + ' t of goods' : '') : 'refine your ore into goods') + '</span><button class="tpbtn" id="mp-works">OPEN</button></div>';
    stake.insertAdjacentHTML('beforebegin', html);
    const b = document.getElementById('mp-works');
    if (b) b.onclick = () => { try { open(); } catch (er) { } };
  }

  // ---- the Empire panel section --------------------------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    ensure();
    const n = machines();
    const html = '<div class="msec" style="margin-top:14px">The Works — your refiners</div>' +
      '<div class="kv"><span class="k">' + (n ? n + ' machine' + (n === 1 ? '' : 's') + ' on the line' + (last ? ' · last pour ' + last.made.toLocaleString('en-US') + ' t of goods out' : '') : 'none yet — machines that refine ore into goods') + '</span><button class="tpbtn" id="em-wk">OPEN</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    const b = document.getElementById('em-wk');
    if (b) b.onclick = () => { try { open(); } catch (er) { } };
  }

  // ---- styles -----------------------------------------------------------------
  try {
    const st = document.createElement('style');
    st.textContent = [
      '#wk-list{display:flex;flex-direction:column}',
      '.wk-card{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;',
      ' background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);margin-top:6px}',
      '.wk-card.dim{opacity:.55}',
      '.wk-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.wk-info b{font-size:12px;letter-spacing:.4px}',
      '.wk-info span{font-size:9.5px;color:var(--mut)}',
      '.wk-n{font-size:8.5px;letter-spacing:1px;background:#f5cc74;color:#241d08;',
      ' border-radius:4px;padding:1.5px 5px;vertical-align:1px;margin-left:4px}',
      '.wk-buy{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:none}',
      '.wk-buy span{font-size:11px;font-weight:800;font-family:var(--mono);color:var(--ink,#e8e4d8)}',
      '.wk-buy .tpbtn{margin:0;white-space:nowrap}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }

  ensure();   // seed a fresh save's works (empty until the first machine)
  // v2.53: the refined goods join the exchange's tradable list NOW, at
  // boot — every multiplier, board row, WORTH term and SELL button
  // picks them up from this moment on
  try { if (window.EXCH && EXCH.addGoods) EXCH.addGoods(MACH.map(T => T.out)); } catch (er) { }

  return {
    open, mineInto, empireInto, tick, buy, scrap,
    goods: () => MACH.map(T => T.out), BASE, inOf: r => INOF[r] || null,
    count: cnt, machines, list: () => MACH.map(T => ({ id: T.id, name: T.name, cost: T.cost, tpd: T.tpd, n: T.n, in: T.in, out: T.out, par: T.par, n_owned: cnt(T.id) })),
    // QA: run whole game-days of pouring instantly (same math as the beat)
    qaDay(n) { for (let i = 0; i < (n || 1); i++) { try { day(); } catch (er) { } } return this.state(); },
    state() {
      ensure();
      return {
        machines: machines(), power: POWER, goods: MACH.length,
        kinds: MACH.filter(T => cnt(T.id) > 0).map(T => ({ id: T.id, name: T.name, n: cnt(T.id), in: T.in, out: T.out })),
        last,
      };
    },
  };
})();
window.WORKS = WORKS;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the MINE panel gains THE WORKS row (above STAKE A CLAIM)
const __wkMinePanel = MINE.openPanel.bind(MINE);
MINE.openPanel = function () {
  __wkMinePanel();
  try { WORKS.mineInto(); } catch (e) { console.error('[works]', e); }
};
// 2. the Empire panel gains the Works section (after the exchange's)
const __wkEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __wkEmpire();
  try { WORKS.empireInto(); } catch (e) { console.error('[works]', e); }
};
// 3. the update chain: original → world forest → open house → suburbs →
//    title deeds → patchwork → machines → landlord → MOTHERLODE →
//    MONEY LIST → ORE EXCHANGE → THE WORKS. Every call is try/caught
//    so a works error can never touch the world.
const __wkOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __wkOrigUpdate(dt, px, pz, camDist);
  try { WORKS.tick(dt); } catch (e) { console.error('[works]', e); }
  return req;
};

