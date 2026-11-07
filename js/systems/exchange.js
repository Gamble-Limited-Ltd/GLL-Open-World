// ====================================================================
// js/systems/exchange.js — the Ore Exchange (Stage 7c): stockpile,
// twelve daily-moving prices, sell half/all. WORKS late-bound.
// ====================================================================
import { fmt$ } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { ECO } from '../systems/eco.js';
import { MINE } from '../systems/mining.js';

// ---- late binding (boot binds after every module evaluates) --------
export let WORKS;
export function __late(b) { ({ WORKS } = b); }

// ======== section: 53_exchange.js ========
// ====================================================================
// v2.52 — THE ORE EXCHANGE. The ask: "Make resources that people can
// get from mining, and sell on a market." This is the MARKET half of
// the pair (51_mining.js is the resource half — the crew's dig now
// becomes stockpiled resource instead of selling itself):
//   - the ORE button (bottom bar, next to MINE) opens THE ORE
//     EXCHANGE — twelve resource rows (Iron, Copper, Coal, Bauxite,
//     Nickel, Lignite, Gypsum, Salt, Zinc, Tin, Silver, Quartz), each
//     trading around its PAR value at a market MULTIPLIER;
//   - THE PRICES MOVE: on every 90 s game-day beat (the same beat as
//     every other income in the game) each multiplier drifts ±8%,
//     clamped to ×0.55–×1.70 — the day-change rides every row
//     (▲/▼ %), rows you hold glow gold, and an open board re-renders
//     on the beat;
//   - SELLING: SELL HALF / SELL ALL per resource and SELL EVERYTHING
//     up top — a sale pays tons × today's price straight into the
//     balance (and the GDP), saves, and toasts the fill; wages are
//     still paid daily in CASH, so a tycoon who hoards everything
//     can still lose the crew;
//   - THE STOCKPILE: STATE.res (tonnes per resource) is fed by
//     EXCH.pile() from the mining tick — the first ore in the pile
//     toasts the exchange once. The pile counts in WORTH at today's
//     prices (EXCH.stockValue(), wired into RIVALS.playerWorth and
//     the ticker fallback) and lists in the Empire panel next to the
//     day's biggest mover;
//   - MIGRATION: older saves never stockpiled — at boot (and lazily
//     everywhere) the mines' resource is read back from the mine's
//     own name and its grade is re-marked to the resource's par;
//   - persistence: the optional `res` + `mkt` fields in the save
//     pack (pack stays v5 — older builds ignore them), sanitized on
//     load; multipliers default to par (×1.00).
// v2.53 — THE WORKS rework (the market half of the refining pair;
// 54_works.js is the machine half): the board now carries the
// REFINED GOODS the works pour alongside the ores — 24 rows in two
// groups (THE ORES / REFINED GOODS), each good trading around the
// par its machine sets, the same daily drift, the same SELL buttons,
// the same WORTH — and a THE WORKS button on the board opens the
// refiners. addGoods() (called once by 54_works.js at boot) extends
// the tradable list; every loop over RES picks the goods up from
// then on. The ready log moved to 54_works.js (the last section).
// Everything lives in this one additive section; the only outside
// touchpoints are annotated "v2.52"/"v2.53" (STATE/save/load res+mkt,
// the WORTH ticker, the ORE button + wiring, the help-modal line,
// the What's-New modal, the attrib footer and the version surfaces).
// window.EXCH is the QA surface. Every exchange call is try/caught.
// ====================================================================

export const EXCH = (() => {
  const DAY = 90;               // seconds per game day (the office/deed/acres/rivals beat)
  // the mined ores (51_mining.js's ORES, in the same order)
  const ORES = ['Iron', 'Copper', 'Coal', 'Bauxite', 'Nickel', 'Lignite', 'Gypsum', 'Salt', 'Zinc', 'Tin', 'Silver', 'Quartz'];
  // the full tradable list — the refined goods (54_works.js) join it
  // at boot via addGoods(); every loop below reads RES live, so the
  // goods ride the multipliers, the board, WORTH and SELL EVERYTHING
  // with no further wiring
  let RES = ORES.slice();
  // the par tables: the ores' live in the mining section and the
  // refined goods' in the works section (single sources of truth);
  // this fallback only matters if 51/54 ever eval after 53
  const FALLBACK = { Iron: 13, Copper: 22, Coal: 12, Bauxite: 15, Nickel: 24, Lignite: 12, Gypsum: 14, Salt: 16, Zinc: 19, Tin: 21, Silver: 26, Quartz: 17,
    Steel: 58, Coke: 31, Aluminium: 102, Cathode: 170, Superalloy: 152, 'Zinc Ingot': 88, 'Tin Solder': 74, 'Silver Bar': 86, Glass: 38, Plaster: 29, 'Soda Ash': 47, Briquette: 24 };
  const parOf = r => (window.MINE && MINE.BASE && MINE.BASE[r]) || (window.WORKS && WORKS.BASE && WORKS.BASE[r]) || FALLBACK[r] || 14;
  const LO = .55, HI = 1.7;     // the multiplier band
  const STEP = .16;             // ±8% a day

  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  let dayT = 0;                 // game-day beat accumulator
  let dayN = 0;                 // days since boot (seeds the drift)
  let toldPile = false;         // the first-ore toast fires once per session

  // ---- state helpers (all lazy — a save load can replace STATE) ------
  function ensure() {
    if (!STATE.mkt || typeof STATE.mkt !== 'object') STATE.mkt = {};
    for (const r of RES) {
      const e = STATE.mkt[r];
      if (!e || typeof e !== 'object' || !isFinite(+e.m) || +e.m <= 0) STATE.mkt[r] = { m: 1, pm: isFinite(+e && e.pm) ? +e.pm : 1 };
    }
    if (!STATE.res || typeof STATE.res !== 'object') STATE.res = {};
    migrate();   // older saves re-mark on first touch (a load can land after boot)
    return STATE.mkt;
  }
  // v2.52 migration: older saves carry mines without `res` and with
  // pre-exchange grades — read the resource back from the mine's own
  // name and re-mark the grade to par (idempotent)
  function migrate() {
    try {
      for (const m of (STATE.mines || [])) {
        if (!m) continue;
        if (!m.res) m.res = String(m.name || 'Ore').split(' ')[0];
        const b = (window.MINE && MINE.BASE) ? MINE.BASE[m.res] : FALLBACK[m.res];
        if (b && Math.abs((+m.grade || 0) - b) > .01) m.grade = b;
      }
    } catch (er) { }
  }
  const mult = r => { const e = STATE.mkt && STATE.mkt[r]; return (e && isFinite(+e.m) && +e.m > 0) ? +e.m : 1; };
  const pmv = r => { const e = STATE.mkt && STATE.mkt[r]; return (e && isFinite(+e.pm) && +e.pm > 0) ? +e.pm : 1; };
  const price = r => parOf(r) * mult(r);
  const pctOf = r => { const p = pmv(r); return p ? (mult(r) / p - 1) * 100 : 0; };
  const held = r => +(+((STATE.res && STATE.res[r]) || 0)) || 0;
  const stockT = () => { ensure(); return RES.reduce((s, r) => s + held(r), 0); };
  const stockValue = () => { ensure(); return RES.reduce((s, r) => s + held(r) * price(r), 0); };

  // ---- the market day: prices move ------------------------------------
  function day() {
    ensure();
    dayN++;
    for (const r of RES) {
      const e = STATE.mkt[r];
      e.pm = e.m;
      const wob = ((hash('ex' + r + 'd' + dayN) % 1000) / 1000 - .5) * STEP;
      e.m = Math.max(LO, Math.min(HI, e.m * (1 + wob)));
    }
    try { renderIfOpen(); } catch (er) { }
  }
  function tick(dt) {
    if (STATE.mode === 'boot') return;
    dayT += dt;
    if (dayT >= DAY) { dayT -= DAY; try { day(); } catch (er) { console.error('[exchange]', er); } }
  }

  // ---- the stockpile (fed by the mining tick and the works pour) ------
  function pile(res, tons) {
    if (!isFinite(+tons) || +tons <= 0) return held(res);
    ensure();
    const r = String(res || '').slice(0, 12);
    STATE.res[r] = +(((+STATE.res[r] || 0) + +tons)).toFixed(2);
    if (!toldPile) {
      toldPile = true;
      try { toast('⛏ <b>First ore in the stockpile.</b> The resource stacks up tonne by tonne — sell it on the <b>ORE exchange</b> (bottom bar) whenever the price suits you.', 'warn'); } catch (er) { }
    }
    return STATE.res[r];
  }

  // ---- selling -----------------------------------------------------------
  function sell(res, tons) {
    ensure();
    const r = String(res || '');
    const have = held(r);
    let t = Math.min(+tons || 0, have);
    if (!(t > 0)) return { ok: false, why: 'none', held: have };
    const px = price(r);
    const gross = t * px;
    const left = +(have - t).toFixed(2);
    if (left > 0.005) STATE.res[r] = left; else delete STATE.res[r];
    earn(gross);   // a sale is income — money + GDP
    try { saveGame(); } catch (er) { }
    try { toast('💰 Sold <b>' + t.toFixed(1) + ' t of ' + r + '</b> for <b>' + fmt$(gross) + '</b> at $' + (Math.round(px * 10) / 10) + '/t on the exchange.'); } catch (er) { }
    return { ok: true, t: +t.toFixed(2), px: +px.toFixed(3), gross: Math.round(gross * 100) / 100, left };
  }
  function sellAll(res) { return sell(res, held(res)); }
  function sellHalf(res) { return sell(res, held(res) / 2); }
  function sellEverything() {
    ensure();
    let gross = 0, t = 0, kinds = 0;
    for (const r of RES) {
      const h = held(r);
      if (h > 0.005) { gross += h * price(r); t += h; kinds++; sell(r, h); }
    }
    if (!kinds) { try { toast('The stockpile is empty — send a crew digging first.', 'warn'); } catch (er) { } return { ok: false }; }
    try { toast(' Sold <b>everything</b> — ' + t.toFixed(1) + ' t across ' + kinds + ' resource' + (kinds === 1 ? '' : 's') + ' for <b>' + fmt$(gross) + '</b>.'); } catch (er) { }
    return { ok: true, t: +t.toFixed(1), gross: Math.round(gross), kinds };
  }

  // ---- the board ------------------------------------------------------------
  function rowHTML(r) {
    const px = price(r), pc = pctOf(r), h = held(r), up = pc >= 0;
    const from = (window.WORKS && WORKS.inOf) ? WORKS.inOf(r) : null;   // v2.53: refined goods carry their ore
    const pcs = '<span style="color:' + (up ? '#4dff88' : '#ff5470') + '">' + (up ? '▲' : '▼') + Math.abs(pc).toFixed(1) + '% today</span>';
    return '<div class="ox-row' + (h > 0 ? ' hot' : '') + '">' +
      '<div class="ox-name"><b>' + r.toUpperCase() + '</b><span>' + (from ? 'refined from ' + from.toLowerCase() + ' · ' : '') + 'par $' + parOf(r) + '/t · ' + (h > 0 ? h.toFixed(1) + ' t held ≈ ' + fmt$(h * px) : 'none held') + '</span></div>' +
      '<div class="ox-px">$' + (Math.round(px * 10) / 10) + '/t<span>' + pcs + '</span></div>' +
      '<div class="ox-btns">' + (h > 0
        ? '<button class="tpbtn" data-eh="' + r + '">SELL HALF</button><button class="tpbtn" data-es="' + r + '">SELL ALL</button>'
        : '') + '</div></div>';
  }
  function render() {
    const list = document.getElementById('ox-list');
    if (!list) return;
    ensure();
    const t = stockT(), v = stockValue();
    const sum = document.getElementById('ox-sum');
    if (sum) sum.innerHTML =
      '<div class="kv"><span class="k">STOCKPILE</span><span class="v' + (t > 0 ? ' g' : '') + '">' + (t > 0 ? t.toFixed(1) + ' t of ore and goods ≈ ' + fmt$(v) + ' at today\u2019s prices' : 'empty — the ore your crews dig stacks up here') + '</span></div>' +
      '<div class="kv" style="margin-top:6px"><span class="k">THE MARKET</span><span class="v">' + ORES.length + ' ores + ' + Math.max(0, RES.length - ORES.length) + ' refined goods · par × the day\u2019s multiplier · moves every game day</span></div>';
    const sorter = rs => [...rs.filter(r => held(r) > 0.005), ...rs.filter(r => held(r) <= 0.005)];   // what you hold rides the top of its group
    const ores = RES.filter(r => ORES.indexOf(r) >= 0);
    const goods = RES.filter(r => ORES.indexOf(r) < 0);
    list.innerHTML = '<div class="ox-sec">THE ORES — what your mines dig</div>' + sorter(ores).map(rowHTML).join('') +
      (goods.length ? '<div class="ox-sec" style="margin-top:10px">REFINED GOODS — what the works pour</div>' + sorter(goods).map(rowHTML).join('') : '');
    list.querySelectorAll('[data-eh]').forEach(b => { b.onclick = () => { try { sellHalf(b.dataset.eh); } catch (er) { } render(); }; });
    list.querySelectorAll('[data-es]').forEach(b => { b.onclick = () => { try { sellAll(b.dataset.es); } catch (er) { } render(); }; });
    const all = document.getElementById('ox-all');
    if (all) all.onclick = () => { try { sellEverything(); } catch (er) { } render(); };
  }
  function renderIfOpen() { if (document.getElementById('ox-list')) render(); }
  function open() {
    ensure(); migrate();
    openModal('THE ORE EXCHANGE — the resource market', `
      <p>The market for everything your mines dig <b>and your works pour</b>. Every resource trades around its <b>par value</b> at a multiplier that moves on each game-day beat — sell when it suits you, or hold the pile and wait for a better price. The stockpile counts in your <b>WORTH</b> at today's prices.</p>
      <div id="ox-sum"></div>
      <div id="ox-list" style="max-height:44vh;overflow:auto;padding-right:2px"></div>
      <p style="margin-top:10px">Prices drift up to ±8% a day around par (clamped ×0.55–×1.70). Wages are still paid daily in cash — keep selling to cover payday. Refined goods come from <b>THE WORKS</b>, machines that turn ore into goods worth more.</p>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="ox-all" style="flex:1">SELL EVERYTHING</button><button class="btn good" id="ox-works" style="flex:1">THE WORKS</button><button class="btn" id="ox-x" style="flex:1">CLOSE</button></div>`);
    render();
    const x = document.getElementById('ox-x');
    if (x) x.onclick = closeModal;
    const wk = document.getElementById('ox-works');   // v2.53 THE WORKS: refine, don't just sell
    if (wk) wk.onclick = () => { try { if (window.WORKS) WORKS.open(); } catch (er) { } };
  }

  // ---- the Empire panel section (the market, one glance) -----------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    ensure();
    const rk = RES.map(r => ({ r, pc: pctOf(r), px: price(r) })).sort((a, b) => b.pc - a.pc);
    const top = rk[0], bot = rk[rk.length - 1];
    const a2 = p => (p >= 0 ? '▲' : '▼') + Math.abs(p).toFixed(1) + '%';
    const html = '<div class="msec" style="margin-top:14px">Ore Exchange — the market</div>' +
      '<div class="kv"><span class="k">' + top.r + ' ' + a2(top.pc) + ' ($' + (Math.round(top.px * 10) / 10) + '/t) · ' + bot.r + ' ' + a2(bot.pc) + ' ($' + (Math.round(bot.px * 10) / 10) + '/t) today</span>' +
      '<button class="tpbtn" id="em-ox">OPEN</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    const b = document.getElementById('em-ox');
    if (b) b.onclick = () => { try { open(); } catch (er) { } };
  }

  // ---- styles ---------------------------------------------------------------
  try {
    const st = document.createElement('style');
    st.textContent = [
      '#ox-list{display:flex;flex-direction:column}',
      '.ox-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:9px;',
      ' background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);margin-top:6px}',
      '.ox-row.hot{background:rgba(245,204,116,.10);border-color:rgba(245,204,116,.45)}',
      '.ox-sec{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--mut);',
      ' font-weight:700;margin-top:12px;padding-bottom:1px}',
      '.ox-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.ox-name b{font-size:12px;letter-spacing:.4px}',
      '.ox-name span{font-size:9.5px;color:var(--mut)}',
      '.ox-px{text-align:right;flex:none;font-weight:800;font-size:12px;font-family:var(--mono)}',
      '.ox-px span{display:block;font-size:9px;font-weight:600}',
      '.ox-btns{display:flex;gap:6px;flex:none}',
      '.ox-btns .tpbtn{margin:0;white-space:nowrap}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }

  ensure();   // seed a fresh save's multipliers at par
  migrate();  // re-mark older saves' mines to the exchange

  return {
    open, empireInto, tick, pile, sell, sellAll, sellHalf, sellEverything,
    price, mult, held, stockT, stockValue, list: () => RES.slice(), BASE: (window.MINE && MINE.BASE) || { Iron: 13, Copper: 22, Coal: 12, Bauxite: 15, Nickel: 24, Lignite: 12, Gypsum: 14, Salt: 16, Zinc: 19, Tin: 21, Silver: 26, Quartz: 17 },
    parOf,
    // v2.53 THE WORKS: the refined goods join the tradable list at boot
    addGoods(list) { for (const g of (list || [])) if (typeof g === 'string' && RES.indexOf(g) < 0) RES.push(g); return RES.slice(); },
    // QA: run whole market-days of drift instantly (same math as the beat)
    qaDay(n) { for (let i = 0; i < (n || 1); i++) { try { day(); } catch (er) { } } return this.state(); },
    state() {
      ensure();
      return {
        dayN, stockT: +stockT().toFixed(1), stockValue: Math.round(stockValue()),
        res: RES.map(r => ({ r, t: +held(r).toFixed(1), px: +price(r).toFixed(2), m: +mult(r).toFixed(3), pm: +pmv(r).toFixed(3), pc: +pctOf(r).toFixed(2) })),
      };
    },
  };
})();
window.EXCH = EXCH;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the Empire panel gains the market section (after the Money List)
const __exchEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __exchEmpire();
  try { EXCH.empireInto(); } catch (e) { console.error('[exchange]', e); }
};
// 2. the update chain: original → world forest → open house → suburbs →
//    title deeds → patchwork → machines → landlord → MOTHERLODE →
//    MONEY LIST → ORE EXCHANGE. Every call is try/caught so an
//    exchange error can never touch the world. (v2.53: THE WORKS
//    wraps this same chain one section later.)
const __exchOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __exchOrigUpdate(dt, px, pz, camDist);
  try { EXCH.tick(dt); } catch (e) { console.error('[exchange]', e); }
  return req;
};

