// ====================================================================
// js/systems/rivals.js — the Money List (Stage 7c): rival
// tycoons on the game-day beat. EXCH/BLD/FURN late-bound below.
// ====================================================================
import { fmtK } from '../util.js';
import { STATE } from '../state.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { ECO } from '../systems/eco.js';
import { MACH } from '../systems/machines.js';
import { MINE } from '../systems/mining.js';

// ---- late binding (boot binds after every module evaluates) --------
export let EXCH, BLD, FURN;
export function __late(b) { ({ EXCH, BLD, FURN } = b); }

// ======== section: 52_rivals.js ========
// ====================================================================
// v2.51 — THE MONEY LIST. The ask: "Make a leaderboard for people
// with the most money." The game is serverless (GitHub Pages +
// localStorage), so the "people" are a fixed cast of FIFTEEN rival
// tycoons stationed around the real Earth — each with a fortune that
// moves on the same 90 s game-day beat as every other income in the
// game — and YOU, ranked among them by the same WORTH figure the
// ticker shows:
//   - the RANK button (bottom bar, next to MINE) opens THE MONEY
//     LIST: sixteen rows, richest first, gold/silver/bronze badges on
//     the podium, your row gold-tagged YOU with the next rival to
//     beat called out above the list;
//   - the WORTH ticker chip carries your live rank (#N of 16);
//   - the Empire panel gains a Money List section (VIEW LIST);
//   - every game day each fortune moves: percent growth that runs
//     slower the bigger the pile (old money compounds, upstarts
//     sprint), plus a deterministic per-day wobble so the order can
//     shuffle — and passing a rival (or being passed) toasts it;
//   - fortunes persist in the save as a new optional `rivals` field
//     (pack stays v5 — older builds ignore it), sanitized on load;
//     a fresh save seeds the fifteen defaults.
// Everything lives in this one additive section; the only outside
// touchpoints are annotated "v2.51" (STATE/save/load, the WORTH
// ticker call + rank chip, the RANK button + wiring, one help-modal
// line, the What's-New modal, the attrib footer and the version
// surfaces). window.RIVALS is the QA surface.
// ====================================================================

export const RIVALS = (() => {
  const DAY = 90;               // seconds per game day (the office/deed/acres beat)
  // the fixed roster: base fortunes at a fresh save, daily growth
  // (smaller piles sprint, old money compounds slow and huge)
  const ROSTER = [
    { name: 'Vittorio "The Duke" Marchetti', city: 'Monaco',     trade: 'old shipping money', w: 148200000, g: .0028 },
    { name: 'Aurelio Vance',                 city: 'Dubai',      trade: 'ports & towers',     w:  96400000, g: .0034 },
    { name: 'Ingrid Solberg',                city: 'Oslo',       trade: 'fishery fleet',      w:  61500000, g: .0038 },
    { name: 'Kunihiko Sato',                 city: 'Tokyo',      trade: 'electronics',        w:  44000000, g: .0042 },
    { name: 'Marguerite Okafor',             city: 'Lagos',      trade: 'cement & telecom',   w:  28700000, g: .0048 },
    { name: 'Camille Aubert',                city: 'Paris',      trade: 'hotels',             w:  17300000, g: .0055 },
    { name: 'Ezekiel Storm',                 city: 'Dallas',     trade: 'oil wells',          w:   9800000, g: .0062 },
    { name: 'Hari Menon',                    city: 'Mumbai',     trade: 'textiles',           w:   5600000, g: .0070 },
    { name: 'Bianca Ferrante',               city: 'Milan',      trade: 'fashion houses',     w:   3100000, g: .0078 },
    { name: 'Tara Krishnan',                 city: 'Singapore',  trade: 'port terminals',     w:   1700000, g: .0085 },
    { name: 'Lena Vogt',                     city: 'Frankfurt',  trade: 'a private bank',     w:    840000, g: .0092 },
    { name: 'Wes "Wildcat" Boone',           city: 'Calgary',    trade: 'gas fields',         w:    410000, g: .0100 },
    { name: 'Paloma Reyes',                  city: 'Madrid',     trade: 'a grocery chain',    w:    190000, g: .0105 },
    { name: 'Aldous Grubb',                  city: 'Pittsburgh', trade: 'a steel pension',    w:     72000, g: .0110 },
    { name: 'June Park',                     city: 'Seoul',      trade: 'a first food cart',  w:     26000, g: .0115 },
  ];
  let dayT = 0;                 // game-day beat accumulator
  let dayN = 0;                 // days since boot (seeds the wobble)
  let lastRank = -1;            // rank after the last day beat (toasts fire on change)

  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // seed any missing/invalid slot with its default fortune (a fresh
  // save, or an older save without the field)
  function ensure() {
    if (!Array.isArray(STATE.rivals)) STATE.rivals = [];
    for (let i = 0; i < ROSTER.length; i++) {
      const w = +STATE.rivals[i];
      if (!isFinite(w) || w < 500) STATE.rivals[i] = ROSTER[i].w;
    }
    STATE.rivals.length = ROSTER.length;
    return STATE.rivals;
  }

  // the player's WORTH — the exact ticker formula (v2.44 acres ·
  // v2.45 machines · v2.48 claims · v2.52 the ore stockpile at
  // today's exchange prices), one source for ticker and board
  function playerWorth() {
    return STATE.money + STATE.offices.reduce((s2, o) => s2 + o.rate * 8, 0)
      + (STATE.rooms || []).reduce((s2, r) => s2 + (r.mode === 'owned' ? r.price : 0), 0)
      + (STATE.acres || []).reduce((s2, a) => s2 + a.price, 0)
      + (window.MACH ? MACH.valueOfRooms() : 0)
      + (window.MINE ? MINE.valueOf() : 0)
      + (window.EXCH ? EXCH.stockValue() : 0)
      + (window.BLD ? BLD.valueOf() : 0)
      + (window.FACT ? FACT.valueOf() : 0)
      + (window.FURN ? FURN.valueOfRooms() : 0)
      + (window.OIL ? OIL.valueOf() : 0);   // v2.52 ORE EXCHANGE · v2.56 GROUND UP · v2.57 FURNITURE · v2.61 FACTORY FLOOR · v2.62 DEEP WATER (platforms + tanked crude at par)
  }

  // the board: sixteen rows, richest first, you among them
  function board() {
    ensure();
    const rows = ROSTER.map((r, i) => ({ name: r.name, city: r.city, trade: r.trade, g: r.g, w: +STATE.rivals[i], ri: i, you: false }));
    rows.push({ name: STATE.name || 'You', city: 'everywhere at once', trade: 'a tycoon on the rise', g: 0, w: playerWorth(), ri: -1, you: true });
    rows.sort((a, b) => b.w - a.w);
    return rows;
  }
  function rankNo() { return board().findIndex(r => r.you) + 1; }
  const count = () => ROSTER.length + 1;

  // ---- the day beat: fortunes move -------------------------------------
  function day() {
    ensure();
    dayN++;
    for (let i = 0; i < ROSTER.length; i++) {
      const wob = ((hash('riv' + i + 'd' + dayN) % 1000) / 1000 - .5) * .007;   // ±0.35% daily wobble
      STATE.rivals[i] = Math.max(500, Math.round(STATE.rivals[i] * (1 + ROSTER[i].g + wob)));
    }
    // passing (or being passed) toasts on the spot
    const rk = rankNo();
    if (lastRank > 0 && rk !== lastRank) {
      const b = board(), idx = b.findIndex(x => x.you);
      try {
        if (rk < lastRank) {
          const passed = b[idx + 1];
          toast('🏆 <b>You passed ' + passed.name + '</b> on the Money List — now <b>#' + rk + ' of ' + b.length + '</b>.', 'warn');
        } else {
          const by = b[idx - 1];
          toast('<b>' + by.name + '</b> passed you on the Money List — down to #' + rk + ' of ' + b.length + '.', 'warn');
        }
      } catch (er) { }
    }
    lastRank = rk;
  }
  function tick(dt) {
    if (STATE.mode === 'boot') return;
    dayT += dt;
    if (dayT >= DAY) { dayT -= DAY; try { day(); } catch (er) { console.error('[rivals]', er); } }
  }

  // ---- the board modal ---------------------------------------------------
  function openBoard() {
    ensure();
    const b = board();
    const youIdx = b.findIndex(r => r.you);
    const you = b[youIdx];
    const next = youIdx > 0 ? b[youIdx - 1] : null;
    const medal = i => i === 0 ? '<span class="lb-rank g1">1</span>'
      : i === 1 ? '<span class="lb-rank g2">2</span>'
      : i === 2 ? '<span class="lb-rank g3">3</span>'
      : '<span class="lb-rank">' + (i + 1) + '</span>';
    const rows = b.map((r, i) =>
      '<div class="lb-row' + (r.you ? ' you' : '') + '">' + medal(i) +
      '<div class="lb-name"><b>' + esc(r.name) + (r.you ? ' <span class="lb-you">YOU</span>' : '') + '</b>' +
      '<span>' + esc(r.city) + ' · ' + esc(r.trade) + '</span></div>' +
      '<div class="lb-worth">' + fmtK(r.w) + '<span>' + (r.you ? 'your worth · #' + (youIdx + 1) : '+' + (r.g * 100).toFixed(2) + '%/day') + '</span></div></div>').join('');
    openModal('THE MONEY LIST — richest on Earth', `
      <p>Sixteen fortunes on one board — fifteen rival tycoons around the real Earth and <b>you</b>, ranked by <b>WORTH</b> (cash plus every plot, room, field, machine, mine and ore stockpile you own). Fortunes move on every game-day beat; pass them one by one.</p>
      <div class="kv"><span class="k">YOUR RANK</span><span class="v g">#${youIdx + 1} of ${b.length} · ${fmtK(you.w)}</span></div>
      ${next
        ? '<div class="kv"><span class="k">NEXT UP</span><span class="v">' + esc(next.name) + ' — ' + fmtK(next.w - you.w) + ' away</span></div>'
        : '<div class="kv"><span class="k">NEXT UP</span><span class="v g">nobody — you lead the list</span></div>'}
      <div id="lb-list">${rows}</div>
      <p style="margin-top:10px">Rival piles grow whether you play or not — the little ones fastest. The board re-ranks on the game-day beat (90 s).</p>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="lb-x" style="flex:1">CLOSE</button></div>`);
    const x = document.getElementById('lb-x');
    if (x) x.onclick = closeModal;
    // a bottom-of-the-list player still sees their own row (centered)
    try { const yr = document.querySelector('.lb-row.you'); if (yr) yr.scrollIntoView({ block: 'center' }); } catch (er) { }
  }

  // ---- the Empire panel section ------------------------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    ensure();
    const rk = rankNo();
    const html = '<div class="msec" style="margin-top:14px">Money List — your rank</div>' +
      '<div class="kv"><span class="k">RANK</span><span class="v g">#' + rk + ' of ' + count() + ' · ' + fmtK(playerWorth()) + ' worth</span>' +
      '<button class="tpbtn" id="em-lb">VIEW LIST</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    const b = document.getElementById('em-lb');
    if (b) b.onclick = () => { try { openBoard(); } catch (er) { } };
  }

  // ---- styles ------------------------------------------------------------
  try {
    const st = document.createElement('style');
    st.textContent = [
      '#lb-list{display:flex;flex-direction:column;margin-top:10px}',
      '.lb-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:9px;',
      ' background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);margin-top:6px}',
      '.lb-row.you{background:rgba(245,204,116,.12);border-color:rgba(245,204,116,.5)}',
      '.lb-rank{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;',
      ' font-size:11px;font-weight:800;background:rgba(255,255,255,.08);flex:none;font-family:var(--mono)}',
      '.lb-rank.g1{background:#f5cc74;color:#241d08}',
      '.lb-rank.g2{background:#c9d4de;color:#1b222a}',
      '.lb-rank.g3{background:#d29a6b;color:#26150a}',
      '.lb-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.lb-name b{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.lb-name span{font-size:9.5px;color:var(--mut)}',
      '.lb-worth{text-align:right;flex:none}',
      '.lb-worth{font-weight:800;font-size:12px;font-family:var(--mono)}',
      '.lb-worth span{display:block;font-size:9px;color:var(--mut);font-weight:600}',
      '.lb-you{font-size:8.5px;letter-spacing:1px;background:#f5cc74;color:#241d08;',
      ' border-radius:4px;padding:1.5px 5px;vertical-align:1px;margin-left:4px}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }

  ensure();   // seed a fresh save's fifteen fortunes at boot

  return {
    openBoard, empireInto, tick, board, rankNo, count, playerWorth,
    roster: ROSTER.slice(),
    list() { ensure(); return STATE.rivals.slice(); },
    // QA: run whole game-days of growth instantly (same math as the beat)
    qaDay(n) { for (let i = 0; i < (n || 1); i++) day(); return this.state(); },
    state() {
      const b = board(), you = b.find(r => r.you);
      return {
        rank: b.findIndex(r => r.you) + 1, of: b.length, worth: you.w,
        rivals: b.filter(r => !r.you).map(r => ({ name: r.name, w: Math.round(r.w) })),
        dayN,
      };
    },
  };
})();
window.RIVALS = RIVALS;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the Empire panel gains the Money List section (after the mines)
const __rivEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __rivEmpire();
  try { RIVALS.empireInto(); } catch (e) { console.error('[rivals]', e); }
};
// 2. the update chain: original → world forest → open house → suburbs →
//    title deeds → patchwork → machines → landlord → MOTHERLODE →
//    MONEY LIST. Every call is try/caught so a rivals error can never
//    touch the world.
const __rivOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __rivOrigUpdate(dt, px, pz, camDist);
  try { RIVALS.tick(dt); } catch (e) { console.error('[rivals]', e); }
  return req;
};

