// ====================================================================
// js/render/night.js — the NIGHT SHIFT settlement, boot flow
// (doEnter, autoEnterLast), input, picking, maps, search, ticker
// and the main render loop (Stage 7b). The seven late systems
// (PWR MINE BLD EXCH RIVALS MACH FURN) are late-bound below;
// patchClickPick() is the click-path patch slot the five wrapper
// sections use (openhouse / farmland / machines / mining /
// furniture) — same chain semantics as the original's
// script-scope reassignment of clickPick.
// ====================================================================
import * as THREE from 'three';
import { CITIES, DEG_M, ECON, GAME_VERSION, ZOOM_MAX } from '../config.js';
import { VNUM, fmt$, fmtK } from '../util.js';
import { isHosted } from '../sync.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { uiBalance } from '../systems/economy.js';
import { closeModal, hideTooltip, openModal, showTooltip, toast } from '../ui/dom.js';
import { MARKET } from '../systems/market.js';
import { LANDGEO } from '../core.js';
import { OSM } from '../world/osm.js';
import { EARTH } from '../world/earth.js';
import { WORLD, camCtl } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';
import { TUT } from '../systems/tutorial.js';
import { bootEl, camera, canvas, clampPan, enterBtn, enterWorld, landAtWorld, leftCity, pnameEl, renderer, returnToGlobe, skyDome, sun, walkIntoCity, worldScene } from '../render/main.js';

// ---- late binding (boot binds after every module evaluates) --------
export let PWR, MINE, BLD, EXCH, RIVALS, MACH, FURN;
export function __late(b) { ({ PWR, MINE, BLD, EXCH, RIVALS, MACH, FURN } = b); }

// ======== section: 66_night.js ========
// ====================================================================
// v2.55 — THE NIGHT SHIFT. The ask: "If people have workers, they
// should make money while they are offline. And when they join back,
// they should get a pop up of how much money they made while offline."
// The game is serverless, so "offline" is the time between your last
// save and this load. Every save now carries a timestamp (a 45 s
// autosave while you play and a save on pagehide keep the stamp fresh),
// and on boot — or on refocusing a sleeping tab — the night shift
// settles the gap on the same rules the day shift runs on:
//   - VENDORS: every cart with hired vendors serves its own night
//     crowd at the live rate (a customer every 6.25 s on average, each
//     vendor serving at their star-paced interval) — the same money a
//     crewed cart makes at the screen, minute by minute.
//   - CREWS: every working mine digs its digTpd a day, and the NIGHT
//     BUYER takes every tonne at PAR — no market timing while you
//     sleep. Wages come due first, same as every payday: a crew the
//     balance can't cover WALKS OFF, a claim that can't pay for itself
//     at par gets the night off, and a worked-out claim releases its
//     crew — so the offline net can never go negative.
//   - THE CARD: "While You Were Away" greets you when you join back —
//     vendors, crews, wages, events, one NET figure at the bottom.
//   - THE CAP: the shift ends after 24 hours away. The works have no
//     workers of their own — they sleep, and pour again on your beat.
// ====================================================================
export const NIGHT = (() => {
  const CAP_MS = 24 * 3600e3;      // the night shift is 24 hours long
  const DAY_MS = 90 * 1000;        // one game day, same as every beat
  let summary = null;
  // NOTE: settle() touches ECO.CUISINES and MINE.digTpd/BASE, so the
  // settle CALL is made at the very end of the module (after every
  // module has attached its window.* surface), right before the ready
  // log — the section itself only defines and registers listeners.

  // ---- settle the gap between the last save and now -------------------
  function settle() {
    const ts = STATE.saveTs;
    if (!ts || !isFinite(+ts) || +ts <= 0) return null;   // pre-v2.55 pack: no stamp, no shift
    const away = Date.now() - ts;
    STATE.saveTs = Date.now();                            // the window is consumed the moment it is read
    if (away < DAY_MS) return null;                       // under one game day — nobody clocked in
    const shift = Math.min(away, CAP_MS), capped = away > CAP_MS;
    const mins = shift / 60000;                           // vendors earn by the minute
    const days = Math.floor(shift / DAY_MS);              // crews dig by the whole day

    // vendors first — the tills run all night, so payday reads a full till
    let vendN = 0, cartN = 0, vendInc = 0;
    for (const p of (STATE.plots || [])) {
      if (!p || !p.cart || !(p.crew || []).length) continue;
      if (window.PWR && PWR.isCut(p)) continue;   // v2.59 THE GRID: a cut-off cart serves nobody
      const cui = (window.ECO ? ECO.CUISINES : []).find(c => c && c.id === p.cart.cuisine);
      if (!cui || !cui.menu || !cui.menu.length) continue;
      const pop = cui.menu.reduce((s, m) => s + (m[2] || 0), 0) || 1;
      const ticket = cui.menu.reduce((s, m) => s + m[1] * (m[2] || 0), 0) / pop
        + (ECON.serveTipMin + ECON.serveTipMax) / 2;               // avg item + avg tip
      const arrivals = 60 / ((ECON.custSpawnMin + ECON.custSpawnMax) / 2);   // this cart's own night crowd
      const serves = p.crew.reduce((s, v) => s + 60 / Math.max(2.6, ECON.vendorInterval - (v.stars | 0) * .55), 0);
      vendInc += Math.min(arrivals, serves) * ticket * mins;
      vendN += p.crew.length; cartN++;
    }
    if (vendInc > 0) STATE.money += vendInc;

    // v2.59 THE GRID: power comes due while you sleep — every elapsed
    // game day, every staffed cart (an unstaffed one powers down for
    // the night), at the grid price the meter froze at. A bill the
    // balance can't cover cuts that cart off with the bill as arrears.
    let pwrBill = 0; const pwrCut = [];
    if (window.PWR) { try { const r = PWR.nightSettle(days); pwrBill = Math.round(r.billed); pwrCut = r.cut; } catch (er) { } }

    // crews: day by day, wages first, the night buyer pays par
    let dug = 0, sold = 0, wages = 0;
    const walked = [], workedOut = [], nightOff = [];
    const BASE = (window.MINE && MINE.BASE) || {};
    for (const m of (STATE.mines || [])) {
      if (!m || !(m.machines || []).length || !((m.crew | 0) > 0) || m.got >= m.ore) continue;   // not working
      const res = (window.MINE && MINE.resOf) ? MINE.resOf(m) : (m.res || 'Ore');
      const par = BASE[res] || 14;
      const dig = (window.MINE && MINE.digTpd) ? MINE.digTpd : (() => 0);
      for (let d = 0; d < days; d++) {
        if (!((m.crew | 0) > 0) || m.got >= m.ore) break;   // released mid-shift
        const tons = Math.min(dig(m), m.ore - m.got);
        const gross = tons * par, due = (m.crew | 0) * 95;  // the same $95/day/worker as the pit
        if (!(tons > 0) || gross < due) {                   // can't pay for itself at par — the night off
          if (nightOff.indexOf(m.name) === -1) nightOff.push(m.name);
          break;
        }
        if (STATE.money < due) {                             // payday came up short — the crew walks
          m.crew = 0; m.walked = true; m.wageAcc = 0;
          if (walked.indexOf(m.name) === -1) walked.push(m.name);
          break;
        }
        STATE.money = +(STATE.money - due + gross).toFixed(2);
        wages += due; sold += gross; dug += tons;
        m.got = +(m.got + tons).toFixed(2);
        if (m.got >= m.ore) {                               // the assay ran dry — the crew is released
          m.crew = 0; m.wageAcc = 0;
          if (workedOut.indexOf(m.name) === -1) workedOut.push(m.name);
        }
      }
    }

    // v2.62 DEEP WATER: the rigs pump into their own tanks while you
    // sleep (no auto-sale — the crude waits for the exchange), running
    // costs come due day by day, and a full tank lays the crew up for
    // the night (the mine's night-off rule, applied to tanks)
    let oilT = 0, oilW = 0, oilU = 0; const oilWalk = [], oilOut = [], oilFull = [];
    if (window.OIL) { try { const r = OIL.nightSettle(days); if (r) { oilT = r.pumped || 0; oilW = r.wages || 0; oilU = r.upkeep || 0; oilWalk.push(...(r.walked || [])); oilOut.push(...(r.out || [])); oilFull.push(...(r.full || [])); } } catch (er) { } }

    vendInc = +vendInc.toFixed(2);
    // v2.56 GROUND UP: the sites rise while you sleep — time works, no wages due
    let bDays = 0, bDone = 0;
    if (days > 0 && window.BLD) { try { const r = BLD.advance(days); bDays = r.days; bDone = r.done; } catch (er) { } }
    STATE.money = +STATE.money.toFixed(2);
    const net = +(vendInc + sold - wages - pwrBill - oilW - oilU).toFixed(2);
    if (net > 0) STATE.gdp += net;
    try { uiBalance(); } catch (e) { }

    if (!cartN && !dug && !walked.length && !workedOut.length && !nightOff.length && !bDays && !pwrBill && !pwrCut.length && !oilT && !oilWalk.length && !oilOut.length && !oilFull.length) return null;   // no workers, no shift, no card (sites still rise silently)
    summary = {
      awayMs: away, capped, days, mins: Math.round(mins),
      cartN, vendN, vendInc: Math.round(vendInc),
      dug: Math.round(dug * 10) / 10, sold: Math.round(sold), wages: Math.round(wages),
      walked, workedOut, nightOff, net: Math.round(net),
      bdays: bDays, bdone: bDone,   // v2.56 GROUND UP: the construction sites
      pwr: pwrBill, pcut: pwrCut,   // v2.59 THE GRID: the night's power bills
      oilT: Math.round(oilT * 10) / 10, oilW: Math.round(oilW), oilU: Math.round(oilU), oilWalk, oilOut, oilFull,   // v2.62 DEEP WATER: the rigs' night
    };
    return summary;
  }

  // ---- the welcome-back card -------------------------------------------
  function show() {
    const s = summary; if (!s) return;
    const h = Math.floor(s.awayMs / 3600e3), mn = Math.round((s.awayMs % 3600e3) / 60000);
    const awayLabel = (h ? h + 'h ' : '') + mn + 'm';
    let rows = '';
    if (s.vendN) rows += '<div class="kv"><span class="k">VENDORS</span><span class="v g">+' + fmt$(s.vendInc) + ' — ' + s.vendN + ' vendor' + (s.vendN > 1 ? 's' : '') + ' served the night crowd across ' + s.cartN + ' cart' + (s.cartN > 1 ? 's' : '') + '</span></div>';
    if (s.dug) rows += '<div class="kv"><span class="k">CREWS</span><span class="v g">+' + fmt$(s.sold) + ' — dug ' + s.dug.toLocaleString('en-US') + ' t of ore; the night buyer paid par for every tonne</span></div>';
    if (s.bdays) rows += '<div class="kv"><span class="k">SITES</span><span class="v g">+' + s.bdays + ' game day' + (s.bdays > 1 ? 's' : '') + ' of construction' + (s.bdone ? ' — ' + s.bdone + ' building' + (s.bdone > 1 ? 's' : '') + ' topped out' : '') + '</span></div>';   // v2.56 GROUND UP
    if (s.oilT) rows += '<div class="kv"><span class="k">RIGS</span><span class="v g">' + s.oilT.toLocaleString('en-US') + ' t of crude pumped into the tanks — waiting for the exchange, not sold</span></div>';   // v2.62 DEEP WATER
    if (s.wages) rows += '<div class="kv"><span class="k">WAGES</span><span class="v">-' + fmt$(s.wages) + ' — payday came due as always</span></div>';
    if (s.pwr) rows += '<div class="kv"><span class="k">POWER</span><span class="v">-' + fmt$(s.pwr) + ' — the grid took its kilowatts' + ((s.pcut || []).length ? ' · <b>' + s.pcut.length + ' cart' + (s.pcut.length > 1 ? 's' : '') + ' cut off</b> — pay at the POWER panel' : '') + '</span></div>';   // v2.59 THE GRID
    if (s.oilW || s.oilU) rows += '<div class="kv"><span class="k">RIG COSTS</span><span class="v">-' + fmt$(s.oilW + s.oilU) + ' — the crews and the marine upkeep</span></div>';   // v2.62 DEEP WATER
    for (const n of s.walked) rows += '<div class="kv"><span class="k">WALKED OFF</span><span class="v">The ' + n + ' crew — payday came up short. Re-hire them when your balance can cover the wages</span></div>';
    for (const n of s.workedOut) rows += '<div class="kv"><span class="k">WORKED OUT</span><span class="v">' + n + ' — the assay ran dry and the crew was released</span></div>';
    for (const n of s.nightOff) rows += '<div class="kv"><span class="k">NIGHT OFF</span><span class="v">' + n + ' — the dig at par wouldn\'t cover the wages, so the crew got the night off</span></div>';
    for (const n of (s.oilWalk || [])) rows += '<div class="kv"><span class="k">RIGS OFF</span><span class="v">The ' + n + ' crew — payday came up short offshore. Re-hire them from the rig when you can cover the running costs</span></div>';   // v2.62 DEEP WATER
    for (const n of (s.oilOut || [])) rows += '<div class="kv"><span class="k">PLAYED OUT</span><span class="v">' + n + ' — the field ran dry and the crew was released. Salvage the steel at the rig</span></div>';   // v2.62 DEEP WATER
    for (const n of (s.oilFull || [])) rows += '<div class="kv"><span class="k">TANKS FULL</span><span class="v">' + n + ' laid the crew up — the tank filled, so nothing pumped and nothing was charged. Offload the crude to pump on</span></div>';   // v2.62 DEEP WATER
    rows += '<div class="kv" style="margin-top:6px"><span class="k">NET</span><span class="v g" style="font-size:1.15em">' + (s.net >= 0 ? '+' : '') + fmt$(s.net) + '</span></div>';   // v2.62: signed — a costly night reads honestly
    if (s.capped) rows += '<div class="kv"><span class="k">THE CAP</span><span class="v">You were away ' + awayLabel + ' — the night shift pays the first 24 hours</span></div>';
    openModal('🌙 While You Were Away', `
      <p>You were gone <b>${awayLabel}</b> — <b>${s.days}</b> game day${s.days > 1 ? 's' : ''} of night shift, and your hired hands kept the money moving:</p>
      ${rows}
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="ns-x" style="flex:1">BACK TO WORK</button></div>`);
    const b = document.getElementById('ns-x');
    if (b) b.onclick = closeModal;
  }
  // the card queues behind whatever modal is up (the news card goes first)
  function maybeShow() {
    if (!summary) return;
    const t = () => {
      const mw = document.getElementById('modalwrap');
      if (mw && !mw.classList.contains('hidden')) { setTimeout(t, 400); return; }
      try { show(); } catch (e) { console.error('[night]', e); }
    };
    setTimeout(t, 1200);
  }

  // ---- keep the stamp honest while you play -----------------------------
  setInterval(() => { try { if (STATE.mode !== 'boot' && !document.hidden) saveGame(); } catch (e) { } }, 45000);
  window.addEventListener('pagehide', () => { try { if (STATE.mode !== 'boot') saveGame(); } catch (e) { } });
  // a sleeping tab is offline too: refocus settles the gap and shows the
  // card (the pit's mesh catches up on the next dig second or city entry)
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'visible' && STATE.mode !== 'boot') {
        if (settle()) { show(); try { saveGame(); } catch (e) { } }
      }
    } catch (e) { console.error('[night]', e); }
  });

  return { settle, show, maybeShow, summary: () => summary };
})();
window.NIGHT = NIGHT;   // QA surface
// (the settle invocation lives at the END of the module — see the
// ready-log insertion below — because MINE/WORKS attach their window
// surfaces only after this point in the file)


// wake up where you left off (used by CONTINUE and after the news modal)
function autoEnterLast() {
  if (STATE.mode !== 'globe' || !STATE.lastCityKey) return;
  const c = CITIES.find(x => x.key === STATE.lastCityKey);
  if (c) enterWorld({ key: c.key, name: c.name, lat: c.lat, lon: c.lon, tier: c.tier });
  else if (STATE.lastCityKey.startsWith('ll')) {
    const m = STATE.lastCityKey.match(/^ll(-?[\d.]+)_(-?[\d.]+)$/);
    if (m) enterWorld({ key: STATE.lastCityKey, name: 'Your spot', lat: +m[1], lon: +m[2] });
  } else if (typeof STATE.playerW === 'number') {
    landAtWorld(STATE.playerW, STATE.playerZ, 'Home ground');
  }
}

function doEnter() {
  const nm = (pnameEl.value || '').trim() || 'Tycoon';
  STATE.name = nm;
  saveGame();
  bootEl.classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  EARTH.init(renderer, camera);
  MARKET.setBalanceRef(uiBalance);
  MARKET.start();
  if (STATE.marketPack) MARKET.restore(STATE.marketPack);
  STATE.mode = 'globe';
  EARTH.setOwned(new Set(STATE.plots.map(p => p.cityKey)), STATE.lastCityKey);
  uiBalance();
  buildTicker();
  // v2.04: warm the last-visited city's data while the player is still
  // on the globe — returning players dive straight in
  if (STATE.lastCityKey) {
    const c = CITIES.find(x => x.key === STATE.lastCityKey);
    if (c) OSM.prefetch(c);
  }
  if (STATE.seenNews !== GAME_VERSION) setTimeout(openWhatsNew, 600);
  else if (STATE.lastCityKey) {
    toast('Welcome back, <b>' + nm + '</b> — dropping you back into the world.');
    setTimeout(autoEnterLast, 900);
  }
  else toast('Welcome, <b>' + nm + '</b>. Click a glowing city — or any land — to land anywhere on Earth.');
  // v2.24: compare this build to the site's feed once per session
  checkForUpdate();
  try { if (window.NIGHT) NIGHT.maybeShow(); } catch (e) { console.error('[night]', e); }   // v2.55 NIGHT SHIFT: the welcome-back card
}
enterBtn.addEventListener('click', doEnter);
pnameEl.addEventListener('keydown', e => { if (e.key === 'Enter') doEnter(); });
document.querySelectorAll('#boot .foot a').forEach(a => {
  a.onclick = e => {
    e.preventDefault();
    const k = a.dataset.abt;
    // v2.60: the boot links open short summaries + the full legal pages
    // (privacy.html / terms.html, same site, relative URL)
    const LNK = (f, t) => `<a href="${f}" target="_blank" style="color:#7DD3FC">${t}</a>`;
    const B = {
      privacy: `<p><b>Open World</b> runs entirely in your browser: no accounts, no analytics, no tracking, no payments.</p>
      ${isHosted() ? '<p>You sign in with a GLL ID. Your world is saved to your account on our server (with a working copy in this browser) so it follows you to any device. NEW GAME deletes it.</p>' : '<p>Your world saves locally in this browser (key <b>openworld-v2</b>) and never leaves your device.</p>'}
      <p>City search and map data call OpenStreetMap (Nominatim / Overpass); those services see the query and your IP, as with any web request. Map data © OpenStreetMap contributors (ODbL).</p>
      <p>${LNK('privacy.html', 'Read the full Privacy Policy →')}</p>`,
      terms: `<p>Open World is free to play. All money in the game is fictional play money — there is no way to spend real money in it, and nothing to cash out.</p>
      ${isHosted() ? '<p>Your save is stored on our server under your GLL ID. The game is provided as-is, under the PolyForm Noncommercial license.</p>' : '<p>Your save lives only in your browser; we keep no backup. The game is provided as-is, under the PolyForm Noncommercial license.</p>'}
      <p>${LNK('terms.html', 'Read the full Terms of Service →')}</p>`,
      support: `<p>Open World is a small project — the best support is to keep playing and build something big.</p>
      <p>Bugs and problems: open an issue on the project's GitHub repository.</p>`
    };
    openModal(k.toUpperCase(), B[k] || '');
  };
});

// ---------------- v2.24 — UPDATE GUARD --------------------------------
// Nothing used to read version.json: a player whose browser kept an old
// openworld.html (bookmarked the direct URL, no ?v= busting, a cached
// CDN copy) never learned the world had moved on — fixes shipped but
// "I still can't see it" stayed. Now the game quietly compares its build
// number to the site's feed and, when the feed is newer, raises a small
// persistent banner. UPDATE NOW reloads through a cache-busting ?v=
// (a different full URL = a fresh fetch); LATER keeps playing on this
// build and won't be nagged again this session. Feed unreachable (offline,
// no feed on this host) or older than the running build → silent, never
// blocks the game.
let __updateChecked = false;
function checkForUpdate() {
  if (__updateChecked) return;
  __updateChecked = true;
  fetch('version.json', { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(feed => {
      if (!feed || !feed.version) return;
      if (!(VNUM(feed.version) > VNUM(GAME_VERSION))) return;
      const b = document.createElement('div');
      b.id = 'upd-banner';
      b.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:60;' +
        'display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:6px;' +
        'background:rgba(26,32,44,.94);border:1px solid #4A5568;color:#E2E8F0;font:600 12px/1.4 ' +
        "'Segoe UI',system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);white-space:nowrap;max-width:92vw";
      b.innerHTML = '<span style="color:#F5CC74">\u25C9 BUILD ' + GAME_VERSION + '</span>' +
        '<span style="color:#A0AEC0">a newer build (' + feed.version + ') is live</span>' +
        '<button id="upd-go" style="background:#48BB78;color:#0F172A;border:0;border-radius:4px;' +
        'padding:6px 12px;font:700 11px system-ui;cursor:pointer">UPDATE NOW</button>' +
        '<button id="upd-no" style="background:transparent;color:#A0AEC0;border:1px solid #4A5568;' +
        'border-radius:4px;padding:6px 10px;font:600 11px system-ui;cursor:pointer">LATER</button>';
      document.body.appendChild(b);
      const go = b.querySelector('#upd-go'), no = b.querySelector('#upd-no');
      go.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.set('v', feed.version.replace(/^v/, ''));
        location.replace(u);
      };
      no.onclick = () => b.remove();
    })
    .catch(() => { });   // offline / CSP / no feed — never nag
}

// ---------------- What's New ------------------------------------------
// v2.49 — QUICK START: the ask was "make the summary of the page
// shorter when I first login." This card pops right after ENTER
// WORLD whenever a build is new to you; it used to carry five dense
// paragraph rows (~280 words) and now reads as three tight lines.
// The long-form how-to detail still lives in HELP / How to Build.
function openWhatsNew() {
  STATE.seenNews = GAME_VERSION;
  saveGame();
  openModal('Welcome to v2.65 — CITY DNA', `
    <p><b>No two cities share a size or a face any more — all 64 roll their own identity.</b></p>
    <div class="kv"><span class="k">SIZE</span><span class="v">Small towns loop 4–5 tight rings inside ~1.5 km and read as towns from orbit; metros sprawl past 3 km with up to 8 rings and 20 radials — and the skyline, ground rings, farms and streaming all follow the same per-city numbers</span></div>
    <div class="kv"><span class="k">LOOK</span><span class="v">Each downtown draws from its own rotated palette slice with its own warm↔cool bias, glass↔classic facades, height character, greenery and villa-scale suburbs — houses, roofs and street trees included</span></div>
    <div class="kv"><span class="k">SAME STREETS</span><span class="v">The real OSM streets, tagged heights and shorelines never change — the DNA dresses the city around them, deterministically, the same on every visit (your cached maps re-import once to pick up the look)</span></div>
    <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="wn-x" style="flex:1">EXPLORE</button></div>`);
  document.getElementById('wn-x').onclick = () => { closeModal(); setTimeout(autoEnterLast, 250); };
}

// ---------------- HUD wiring ------------------------------------------
document.getElementById('b-globe').addEventListener('click', () => {
  if (STATE.mode === 'city') returnToGlobe();
  else toast('You are already in orbit.');
});
document.getElementById('b-market').addEventListener('click', () => MARKET.toggleOpen());
document.getElementById('b-help').addEventListener('click', openHelp);
document.getElementById('b-build').addEventListener('click', () => {
  if (STATE.mode !== 'city') { toast('Enter the world first.'); return; }
  try { BLD.open(); } catch (er) { console.error('[bld]', er); }   // v2.56 GROUND UP: BUILD opens the builder — yard, catalog, placement
});
document.getElementById('b-mine').addEventListener('click', () => {   // v2.48 MOTHERLODE: the mining panel
  try { MINE.openPanel(); } catch (er) { console.error('[mining]', er); }
});
document.getElementById('b-ore').addEventListener('click', () => {   // v2.52 ORE EXCHANGE: the resource market
  try { EXCH.open(); } catch (er) { console.error('[exchange]', er); }
});
document.getElementById('b-rank').addEventListener('click', () => {   // v2.51 MONEY LIST: the leaderboard
  try { RIVALS.openBoard(); } catch (er) { console.error('[rivals]', er); }
});
document.getElementById('b-power').addEventListener('click', () => {   // v2.59 THE GRID: the power usage panel
  try { PWR.open(); } catch (er) { console.error('[power]', er); }
});
document.getElementById('avatar-chip').addEventListener('click', () => ECO.openEmpire());

// v2.17: recenter on the character — [C] or the FIND ME crosshair button
function recenterOnPlayer() {
  if (STATE.mode !== 'city' || !ACTORS.player) return;
  camCtl.follow = true;
  const p = ACTORS.player.group.position;
  camCtl.tx = p.x; camCtl.tz = p.z;
}
document.getElementById('b-locate').addEventListener('click', recenterOnPlayer);

// v2.23: WALK-TO pill — one tap and your tycoon walks to the nearest
// city; setGoal road-routes around water automatically (bridges included)
document.getElementById('bb-next').addEventListener('click', () => {
  if (!nextCityRef || STATE.mode !== 'city') return;
  const ok = ACTORS.setGoal(nextCityRef.wx, nextCityRef.wz);
  if (ok) {
    camCtl.follow = true;
    toast('Walking to <b>' + nextCityRef.name + '</b> — following the road the whole way. Tap anywhere else to change plans.', 'warn');
  }
});

function openHelp() {
  openModal('Open World ' + GAME_VERSION + ' — Help', `
    <p><b>Controls</b></p>
    <div class="kv"><span class="k">MOVE</span><span class="v g">Tap / click anywhere — your tycoon walks there (the only way they move)</span></div>
    <div class="kv"><span class="k">LOOK AROUND</span><span class="v">Drag or WASD / arrows / joystick to glide the bird\u2019s-eye view across the map — no distance cap, roam the whole Earth; detail streams wherever you look</span></div>
    <div class="kv"><span class="k">ROTATE</span><span class="v">Right-drag (or Ctrl+drag) · touch: pinch zoom</span></div>
    <div class="kv"><span class="k">ZOOM</span><span class="v">Wheel / pinch — gentle at street level, faster with altitude; zoom out to a 23,000 km whole-world view of the real Earth</span></div>
    <div class="kv"><span class="k">FIND ME</span><span class="v">[C] or the crosshair button → snap back to your tycoon</span></div>
    <div class="kv"><span class="k">THE HORIZON</span><span class="v">Every city already stands in the world at metro scale — walk in and the true downtown gains full detail</span></div>
    <div class="kv"><span class="k">WALK TO A CITY</span><span class="v g">The gold pill above the bottom bar walks you to the nearest city — road-routed around lakes and seas, bridges included</span></div>
    <div class="kv"><span class="k">WORLD MAP</span><span class="v">minimap (bottom right) · [M] or click it for the big map</span></div>
    <div class="kv"><span class="k">THE EARTH</span><span class="v">the real planet at TRUE SCALE — 40,007 km around, real distances between cities. Cross continents by orbit flight, search or the world map [M]; sea bridges still span the straits</span></div>
    <div class="kv"><span class="k">EMPIRE</span><span class="v">avatar (top right) → TELEPORT to any plot you own</span></div>
    <div class="kv"><span class="k">BUILD</span><span class="v g">BUILD button → pick a house, shop, apartment block or factory shell, stock the materials (wood & stone at the yard; steel & glass at the yard or pulled from your ore-exchange stockpile), then PLACE — a 1 m grid overlays your plot, a ghost follows the cursor and a click sites it; buildings rise over real game days, pay every day and demolish back to 60% of their materials</span></div>
    <div class="kv"><span class="k">FACTORIES</span><span class="v g">Click a finished factory shell → MACHINES: twelve machines can stand on its floor — six heavy (packaging station, CNC, stamping press, assembly line, weld cell, injection molder) plus the six classics — each pays every day; the shell fades to a cutaway while you place them, and selling back pays 60%</span></div>   <!-- v2.61 FACTORY FLOOR -->
    <div class="kv"><span class="k">OFFSHORE</span><span class="v g">MINE button → OFFSHORE → BUILD A RIG on open ocean (400 m off any coast, clear of your other rigs): $185,000 + 260 t steel + 60 t stone, then hire up to 32 workers — crude pumps into the rig's own 2,000 t tank (a short crew pumps slower), wages and upkeep come due daily, pressure falls as the field drains, and OFFLOAD moves the crude to the Ore Exchange for $2/t freight — decommission salvages 60%</span></div>   <!-- v2.62 DEEP WATER -->
    <div class="kv"><span class="k">FURNISH</span><span class="v g">Hold a room or floor? FURNISH in its panel opens the furniture shop — craft pieces from shed materials or buy with cash, click to place (<b>R</b> rotates the ghost), and click any placed piece to turn, move or sell it back for 60% — computers sit on desks (place the desk first)</span></div>
    <div class="kv"><span class="k">POWER</span><span class="v g">POWER button → every cart you run draws power — the meter spins, the grid bills each game day at a price that moves, and an unpaid bill cuts the power and the income until you pay (PAY &amp; RECONNECT at the cart’s panel or the POWER panel)</span></div>   <!-- v2.59 THE GRID -->
    <div class="kv"><span class="k">SERVE</span><span class="v">[E] when standing at your cart</span></div>
    <div class="kv"><span class="k">MARKET</span><span class="v">📈 button · limit &amp; market orders</span></div>
    <p style="margin-top:12px"><b>The loop</b></p>
    <p>Buy a green <b>$</b> plot → park a food cart → serve the queue yourself or hire star vendors → lease offices in the towers → trade the exchange → grow your net worth.</p>
    <p style="font-size:11px;color:var(--dim)">Map data © OpenStreetMap contributors (ODbL). This game runs 100% in your browser; your world saves locally.</p>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn" id="hp-tut" style="flex:1">REPLAY TUTORIAL</button>
      <button class="btn" id="hp-x" style="flex:1">CLOSE</button>
    </div>`);
  document.getElementById('hp-x').onclick = closeModal;
  document.getElementById('hp-tut').onclick = () => { closeModal(); TUT.restart(); };
}

// search box
const searchbox = document.getElementById('searchbox');
document.getElementById('searchbtn').addEventListener('click', () => {
  searchbox.classList.toggle('hidden');
  if (!searchbox.classList.contains('hidden')) document.getElementById('q').focus();
});
document.getElementById('qgo').addEventListener('click', runSearch);
document.getElementById('q').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
let lastSearch = 0;
async function runSearch() {
  const q = document.getElementById('q').value.trim();
  if (!q || Date.now() - lastSearch < 2500) return;
  lastSearch = Date.now();
  const res = document.getElementById('qres');
  res.style.display = 'block';
  res.innerHTML = '<div class="r"><span class="d">searching OpenStreetMap…</span></div>';
  const found = await OSM.searchPlaces(q);
  if (!found.length) {
    res.innerHTML = '<div class="r"><span class="d">no results — try a street, landmark or city</span></div>';
    return;
  }
  res.innerHTML = found.map((f, i) => `<div class="r" data-i="${i}"><div class="n">${f.name}</div><div class="d">${f.display}</div></div>`).join('');
  res.querySelectorAll('.r').forEach(el => {
    el.onclick = () => {
      const f = found[+el.dataset.i];
      searchbox.classList.add('hidden');
      res.style.display = 'none';
      // v2.21 REAL CITIES: a search that lands on a catalog city enters
      // THAT city — the same key a globe dive uses, so its real streets
      // import live (or come from cache, or generate procedurally).
      // Before, a searched city kept a raw ll-key, and whenever the live
      // map server was slow or rate-limited the spot degraded to an
      // empty pasture — "there is no city". Cities can't degrade now;
      // wild searches stay pastures by design.
      const near = WORLD.nearestCityInfo(f.lon * DEG_M, -f.lat * DEG_M);
      if (near && near.city && near.d < WORLD.BUILD_DIST) {
        enterWorld({ key: near.city.key, name: near.city.name, lat: near.city.lat,
          lon: near.city.lon, tier: near.city.tier, searched: true });
        return;
      }
      const key = 'll' + f.lat.toFixed(3) + '_' + f.lon.toFixed(3);
      enterWorld({ key, name: f.name, lat: f.lat, lon: f.lon, display: f.display, searched: true });
    };
  });
}

// ---------------- stats ticker ----------------------------------------
function buildTicker() {
  const track = document.getElementById('ticktrack');
  const upd = () => {
    const stats = MARKET.tickerStats();
    const items = stats.map(s =>
      `<span class="tk"><span class="s">${s.sym}</span><span class="p">$${s.price.toFixed(2)}</span><span class="${s.chg >= 0 ? 'up' : 'dn'}">${s.chg >= 0 ? '▲' : '▼'}${Math.abs(s.chg).toFixed(1)}%</span></span>`).join('');
    const worth = (window.RIVALS ? RIVALS.playerWorth() : STATE.money + STATE.offices.reduce((s2, o) => s2 + o.rate * 8, 0)
      + (STATE.rooms || []).reduce((s2, r) => s2 + (r.mode === 'owned' ? r.price : 0), 0)
      + (STATE.acres || []).reduce((s2, a) => s2 + a.price, 0)
      + (window.MACH ? MACH.valueOfRooms() : 0)
      + (window.MINE ? MINE.valueOf() : 0)
      + (window.EXCH ? EXCH.stockValue() : 0)
      + (window.BLD ? BLD.valueOf() : 0)
      + (window.FACT ? FACT.valueOf() : 0)
      + (window.FURN ? FURN.valueOfRooms() : 0)
      + (window.OIL ? OIL.valueOf() : 0));   // v2.51 MONEY LIST + v2.52 ORE EXCHANGE + v2.56 GROUND UP · v2.57 FURNITURE · v2.61 FACTORY FLOOR · v2.62 DEEP WATER: one formula feeds the ticker chip and the board
    track.innerHTML = items +
      `<span class="tk"><span class="s g">GDP</span><span class="p">${fmtK(STATE.gdp)}</span><span class="up">▲</span></span>` +
      `<span class="tk"><span class="s o">WORTH</span><span class="p">${fmtK(worth)}</span><span class="up">${window.RIVALS ? '#' + RIVALS.rankNo() + '/' + RIVALS.count() : ''}</span></span>` +   // v2.51 MONEY LIST: your live rank rides the WORTH chip
      `<span class="tk"><span class="s">CARTS</span><span class="p">${STATE.plots.filter(p => p.cart).length}</span></span>` +
      `<span class="tk"><span class="s g">OFFICES</span><span class="p">${STATE.offices.length}</span></span>` +
      `<span class="tk"><span class="s">PLAYER</span><span class="p">${STATE.name || '—'}</span></span>`;
  };
  upd();
  setInterval(upd, 4000);
}

// ---------------- world camera + picking -------------------------------
// v2.17 BIRD'S EYE command view:
//   · left-drag (or one finger) GRABS THE MAP and pans the view; the
//     pan speed scales with how high the camera sits, and the focus
//     roams freely — detail streams around whatever you look at
//   · right-drag / middle-drag / Ctrl+drag rotates + tilts
//   · wheel / pinch zooms gently (v2.37: the ceiling is now the whole
//     world — 23,000 km, the full flat Earth in one view)
//   · WASD / arrows / the touch joystick pan from the keyboard
//   · a TAP on the ground sends the character walking there (the only
//     way it moves now) and re-attaches the follow camera
let dragging = false, rotating = false, moved = 0, lastX = 0, lastY = 0, pinchD = 0, pinched = false;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (STATE.mode !== 'city') return;
  dragging = true;
  rotating = e.button === 2 || e.button === 1 || e.ctrlKey;   // v2.17: rotate on right/middle/ctrl drag
  moved = 0; lastX = e.clientX; lastY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { }   // v2.13: synthetic taps (QA) carry no active pointer
});
canvas.addEventListener('pointermove', e => {
  if (STATE.mode !== 'city') return;
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX; lastY = e.clientY;
    if (rotating) {
      camCtl.az -= dx * .0052;
      camCtl.el = THREE.MathUtils.clamp(camCtl.el + dy * .004, .28, 1.5);
    } else {
      // v2.17 grab-the-map: the ground follows the pointer, so the focus
      // moves opposite the drag on screen-right and along screen-up
      camCtl.follow = false;
      const k = camCtl.dist * .0018;
      const fx = -Math.sin(camCtl.az), fz = -Math.cos(camCtl.az);   // screen-up on the ground
      const rx = Math.cos(camCtl.az), rz = -Math.sin(camCtl.az);    // screen-right
      const [nx, nz] = clampPan(
        camCtl.tx + (-dx * rx + dy * fx) * k,
        camCtl.tz + (-dx * rz + dy * fz) * k);
      camCtl.tx = nx; camCtl.tz = nz;
    }
  } else {
    hoverPick(e.clientX, e.clientY);
  }
});
canvas.addEventListener('pointerup', e => {
  if (STATE.mode !== 'city') return;
  if (dragging && moved < 6 && !pinched && !rotating) clickPick(e.clientX, e.clientY);   // v2.13: pinch is not a tap
  dragging = false; rotating = false;
});
canvas.addEventListener('wheel', e => {
  if (STATE.mode !== 'city') return;
  let dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1);   // deltaMode 1 = lines
  dy = THREE.MathUtils.clamp(dy, -180, 180);          // cap single-event jumps
  // v2.37: the glide stays gentle at street level (.0016 — the feel the
  // user knows) and firms up smoothly with altitude (to .005 above
  // ~60 km) so the climb from 100 m to the 23,000 km whole-world view
  // takes ~35 notches instead of ~80
  const zf = .0016 + .0034 * THREE.MathUtils.clamp((camCtl.distT - 800) / 60000, 0, 1);
  camCtl.distT = THREE.MathUtils.clamp(camCtl.distT * Math.exp(dy * zf), 45, ZOOM_MAX);
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  if (STATE.mode !== 'city' || e.touches.length !== 2) return;
  pinched = true;   // v2.13: two fingers down — a pinch, never a tap
  const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  if (pinchD) {
    camCtl.distT = THREE.MathUtils.clamp(camCtl.distT * (pinchD / d), 45, ZOOM_MAX);
    camCtl.dist = camCtl.distT;
  }
  pinchD = d;
}, { passive: true });
canvas.addEventListener('touchend', () => { pinchD = 0; pinched = false; });

export const ray = new THREE.Raycaster();
export const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.15);
export function screenToGround(cx, cy) {
  const ndc = new THREE.Vector2((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const pt = new THREE.Vector3();
  return ray.ray.intersectPlane(groundPlane, pt) ? pt : null;
}
let hoverThrottle = 0;
export function hoverPick(cx, cy) {
  const now = performance.now();
  if (now - hoverThrottle < 70) return;
  hoverThrottle = now;
  const pt = screenToGround(cx, cy);
  if (!pt) { hideTooltip(); return; }
  const info = ECO.hoverInfo(pt.x, pt.z);
  if (info) showTooltip(cx, cy, info);
  else hideTooltip();
  canvas.style.cursor = info ? 'pointer' : '';
}
// ---- click-path patch slot ---------------------------------------------
// The openhouse / farmland / machines / mining / furniture sections wrap
// the click path by REPLACING this function — exactly as the original
// single script reassigned clickPick at script scope (ES imports are
// read-only, so the reassignment goes through this setter; the chain
// semantics are identical: each wrapper captures the previous head).
export function patchClickPick(fn) { clickPick = fn; }

export function clickPick(cx, cy) {
  const pt = screenToGround(cx, cy);
  if (!pt) return;
  // v2.13 CLICK TO WALK (v2.17: the ONLY movement): interactive clicks
  // (spots, carts, towers) keep their meaning; any plain ground point
  // becomes a walk destination — and the camera re-attaches to follow
  if (ECO.clickAt(pt.x, pt.z)) return;
  if (ACTORS.setGoal(pt.x, pt.z)) camCtl.follow = true;
}

// ---------------- minimap + big map ------------------------------------
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');
let mmT = 0;
function mapProject(b, w, h, x, z, pad = 9) {
  const sx = (w - pad * 2) / (b.x1 - b.x0), sz = (h - pad * 2) / (b.z1 - b.z0);
  return [pad + (x - b.x0) * sx, pad + (z - b.z0) * sz, sx, sz];
}
function drawWorldMap(ctx, w, h, opts = {}) {
  const d = WORLD.mapData();
  const b = d.bounds;
  ctx.clearRect(0, 0, w, h);
  // v2.18: the real planet — ocean, Natural Earth coastlines, great lakes
  ctx.fillStyle = '#173f5f';
  ctx.fillRect(0, 0, w, h);
  const P = (x, z) => mapProject(b, w, h, x, z);
  if (LANDGEO.ok()) {
    ctx.fillStyle = '#3c7a44';
    ctx.beginPath();
    for (const ring of LANDGEO.rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = P(ring[i][0] * DEG_M, -ring[i][1] * DEG_M);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.fillStyle = '#2e6f9e';
    ctx.beginPath();
    for (const lk of LANDGEO.lakes) {
      for (let i = 0; i < lk.ring.length; i++) {
        const [x, y] = P(lk.ring[i][0] * DEG_M, -lk.ring[i][1] * DEG_M);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fill();
  }
  // roads: real routed polylines; sea bridges dashed
  ctx.strokeStyle = 'rgba(226,232,240,.34)';
  ctx.lineWidth = Math.max(.6, w / 300);
  for (const e of d.edges) {
    if (!e.poly || e.poly.length < 2) continue;
    ctx.beginPath();
    if (e.bridge) ctx.setLineDash([3, 3]);
    for (let i = 0; i < e.poly.length; i += 2) {
      const [x, y] = P(e.poly[i][0], e.poly[i][1]);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // continent names (big map)
  if (opts.names && d.conts) {
    ctx.fillStyle = 'rgba(226,232,240,.32)';
    ctx.font = '700 ' + Math.max(8, w / 34) + 'px -apple-system,Segoe UI,Arial';
    ctx.textAlign = 'center';
    for (const c of d.conts) {
      const [x, y] = P(c[1], c[2]);
      ctx.fillText(c[0].toUpperCase(), x, y);
    }
  }
  // cities
  for (const c of d.cities) {
    const [x, y] = mapProject(b, w, h, c.x, c.z);
    const r = (c.tier === 3 ? 3.4 : c.tier === 2 ? 2.6 : 1.9) * (w / 184);
    if (c.active) {
      ctx.fillStyle = '#F5CC74';
      ctx.beginPath(); ctx.arc(x, y, r + 1.6, 0, 6.29); ctx.fill();
    }
    ctx.fillStyle = c.owned ? '#48BB78' : '#22D3EE';
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.29); ctx.fill();
    if (opts.names) {
      ctx.fillStyle = 'rgba(226,232,240,.85)';
      ctx.font = '600 ' + Math.max(8, w / 52) + 'px -apple-system,Segoe UI,Arial';
      ctx.textAlign = 'center';
      ctx.fillText(c.name, x, y - r - 3);
    }
  }
  // player arrow
  if (ACTORS.player) {
    const p = ACTORS.player.group.position;
    const [x, y] = mapProject(b, w, h, p.x, p.z);
    const hd = ACTORS.player.group.rotation.y;
    const s = Math.max(5, w / 30);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(Math.sin(hd), Math.cos(hd)));
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(13,17,23,.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, s * .8); ctx.lineTo(s * .55, -s * .6); ctx.lineTo(0, -s * .25); ctx.lineTo(-s * .55, -s * .6);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // north marker
  ctx.fillStyle = 'rgba(226,232,240,.5)';
  ctx.font = '700 ' + Math.max(8, w / 23) + 'px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('N', w / 2, Math.max(10, w / 18));
}
function drawMinimap() {
  if (STATE.mode !== 'city') return;
  drawWorldMap(mmCtx, mmCanvas.width, mmCanvas.height);
}
function openBigMap() {
  openModal('The One World', `
    <div id="bigmap-wrap"><canvas id="bigmap" width="560" height="420"></canvas></div>
    <div class="maplegend">
      <span><i style="background:#22D3EE"></i>city</span>
      <span><i style="background:#48BB78"></i>you own land here</span>
      <span><i style="background:#F5CC74"></i>you are here</span>
      <span>· click anywhere to travel</span>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn" id="bm-x" style="flex:1">CLOSE</button></div>`);
  const cv = document.getElementById('bigmap');
  drawWorldMap(cv.getContext('2d'), cv.width, cv.height, { names: true });
  document.getElementById('bm-x').onclick = closeModal;
  cv.onclick = ev => {
    const r = cv.getBoundingClientRect();
    const mx = (ev.clientX - r.left) * (cv.width / r.width);
    const my = (ev.clientY - r.top) * (cv.height / r.height);
    const d = WORLD.mapData();
    const b = d.bounds;
    const pad = 9;
    const wx = b.x0 + (mx - pad) / ((cv.width - pad * 2) / (b.x1 - b.x0));
    const wz = b.z0 + (my - pad) / ((cv.height - pad * 2) / (b.z1 - b.z0));
    // nearest city within grab radius?
    let best = null, bd = 1e9;
    for (const c of d.cities) {
      const [cx, cy] = mapProject(b, cv.width, cv.height, c.x, c.z);
      const dd = Math.hypot(cx - mx, cy - my);
      if (dd < bd) { bd = dd; best = c; }
    }
    closeModal();
    if (best && bd < 26) {
      const cc = CITIES.find(x => x.key === best.key);
      enterWorld({ key: cc.key, name: cc.name, lat: cc.lat, lon: cc.lon, tier: cc.tier });
    } else if (LANDGEO.ready && LANDGEO.isWaterWorld(wx, wz)) {
      toast('<b>That\'s water.</b> Pick a spot on land — or a city dot.', 'warn');
    } else {
      landAtWorld(wx, wz);
    }
  };
}
mmCanvas.addEventListener('click', () => { if (STATE.mode === 'city') openBigMap(); });
window.addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;   // v2.06
  if (e.key.toLowerCase() === 'm' && STATE.mode === 'city' && !e.repeat) openBigMap();
  if (e.key.toLowerCase() === 'c' && STATE.mode === 'city' && !e.repeat) recenterOnPlayer();   // v2.17 FIND ME
});

// ---------------- main loop -------------------------------------------
const clock = new THREE.Clock();
let streetT = 0, mmTimer = 0, nextCityRef = null;   // v2.23: WALK-TO pill target
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(.05, clock.getDelta());
  if (STATE.mode === 'globe') {
    EARTH.update(dt);
    renderer.render(EARTH.scene, camera);
  } else if (STATE.mode === 'city' && worldScene) {
    ACTORS.updatePlayer(dt);
    ACTORS.updateCitizens(dt);
    ACTORS.update(dt);
    ECO.update(dt);
    TUT.update(dt);   // v2.05 starter guide: panel + beacon + step checks
    const p = ACTORS.player.group.position;
    // v2.17 bird's-eye roam: WASD / arrows / joystick pan the camera
    // focus (zoom-scaled speed — way out = fast, close in = precise)
    const ni = ACTORS.navInput();
    if (ni.active) {
      camCtl.follow = false;
      const spd = THREE.MathUtils.clamp(camCtl.dist * .9, 18, 3e7) * (ni.run ? 1.8 : 1);   // v2.27 altitude-scaled; v2.37: cap raised with the 23,000 km ceiling — WASD still crosses one screen in ~2 s at ANY altitude
      const fx = -Math.sin(camCtl.az), fz = -Math.cos(camCtl.az);   // screen-up on the ground
      const rx = Math.cos(camCtl.az), rz = -Math.sin(camCtl.az);    // screen-right
      const [nx, nz] = clampPan(
        camCtl.tx + (fx * -ni.z + rx * ni.x) * spd * dt,
        camCtl.tz + (fz * -ni.z + rz * ni.x) * spd * dt);
      camCtl.tx = nx; camCtl.tz = nz;
    }
    // v2.17: while following, the view rides along with the character
    // (any tap-to-move order or FIND ME re-attaches; panning detaches)
    if (camCtl.follow) {
      camCtl.tx += (p.x - camCtl.tx) * Math.min(1, dt * 5);
      camCtl.tz += (p.z - camCtl.tz) * Math.min(1, dt * 5);
    }
    // zoom glides toward its target — no snapping
    camCtl.dist += (camCtl.distT - camCtl.dist) * Math.min(1, dt * 9);
    camCtl.dist = THREE.MathUtils.clamp(camCtl.dist, 45, ZOOM_MAX);
    // v2.35: zero fog — nothing to refresh (see buildWorldScene).
    const ce = Math.cos(camCtl.el), se = Math.sin(camCtl.el);
    camera.position.set(
      camCtl.tx + Math.sin(camCtl.az) * camCtl.dist * ce,
      1.6 + camCtl.dist * se,
      camCtl.tz + Math.cos(camCtl.az) * camCtl.dist * ce);
    camera.lookAt(camCtl.tx, 1.4, camCtl.tz);
    if (skyDome) skyDome.position.copy(camera.position);   // v2.31: the sky rides with the camera
    if (sun) {
      sun.position.set(camCtl.tx - 170, 180, camCtl.tz + 95);
      sun.target.position.set(camCtl.tx, 0, camCtl.tz);
      sun.target.updateMatrixWorld();
      // v2.32 SUN CLIFF FIX: the shadow camera used to be a fixed ±240 m
      // box — every fragment beyond it sampled the shadow-map EDGE (the
      // out-of-frustum clamp) and lost the WHOLE sun term, so all
      // mid-distance terrain dimmed ~35% with a hard brightness cliff
      // ~240 m past the camera focus. The v2.31 fog (300/1050 m) had
      // masked it; widening the fog exposed it. The box now scales with
      // the camera distance: street level keeps the crisp ±240 m map,
      // zoomed out it grows to cover the whole view, so distant land,
      // lakes and roads keep full sunlight.
      const SH_S = Math.max(240, Math.round(camCtl.dist * 2.2));
      if (sun.shadow.camera.right !== SH_S) {
        sun.shadow.camera.left = -SH_S; sun.shadow.camera.right = SH_S;
        sun.shadow.camera.top = SH_S; sun.shadow.camera.bottom = -SH_S;
        sun.shadow.camera.far = Math.max(1200, SH_S * 1.5);
        sun.shadow.camera.updateProjectionMatrix();
      }
    }
    // the ONE WORLD: stream pasture chunks, swap city chunks as you walk
    const req = WORLD.update(dt, p.x, p.z, camCtl.dist);
    if (req) {
      if (req.type === 'enterCity') walkIntoCity(req.city);
      else if (req.type === 'leftCity') leftCity();
      else if (req.type === 'region') ECO.setRegion(req.region);
    }
    // street/region HUD — v2.17: tracks where the VIEW is pointed
    streetT += dt;
    if (streetT > .6) {
      streetT = 0;
      let nm = '', loc = '';
      if (CITY.rec && STATE.city) {
        nm = CITY.nearestRoadName(camCtl.tx, camCtl.tz);
        loc = STATE.city.name;
      } else {
        const r = WORLD.nearestRoadInfo(camCtl.tx, camCtl.tz);
        nm = r ? r.name : '';
        const near = WORLD.nearestCityInfo(camCtl.tx, camCtl.tz);
        // v2.22: the chip always names the nearest city, its distance and
        // a bearing arrow relative to the view — no more "the wild"
        {
          const ddx = near.city.wx - camCtl.tx, ddz = near.city.wz - camCtl.tz;
          const upx = -Math.sin(camCtl.az), upz = -Math.cos(camCtl.az);
          const rtx = Math.cos(camCtl.az), rtz = -Math.sin(camCtl.az);
          const th = Math.atan2(ddx * rtx + ddz * rtz, ddx * upx + ddz * upz);
          const AR = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
          loc = 'Open Country · ' + near.city.name + ' ' + (near.d / 1000).toFixed(1) + ' km ' +
            AR[((Math.round(th / (Math.PI / 4)) % 8) + 8) % 8];
        }
      }
      document.getElementById('streetname').textContent = nm ? '· ' + nm : '';
      document.getElementById('bb-loc').textContent = loc + (nm ? ' · ' + nm : '');
      // v2.23: WALK-TO pill — always names the nearest other city with its
      // distance + bearing arrow; one tap walks you there, roads included.
      // v2.25: the distance is the TYCOON'S, never the camera's — a panned
      // bird's-eye view used to claim "0.9 KM" while the tycoon stood
      // 4.7 km away, the city ahead never streamed in (detail follows the
      // tycoon) and it read as "the city doesn't load". A decoupled view
      // now says so and points at C.
      {
        const pill = document.getElementById('bb-next');
        if (STATE.mode === 'city' && CITIES.length) {
          let nc = null, nd = 1e9;
          for (const c of CITIES) {
            if (STATE.city && c.key === STATE.city.key) continue;
            const dd = Math.hypot(c.wx - camCtl.tx, c.wz - camCtl.tz);
            if (dd < nd) { nd = dd; nc = c; }
          }
          if (nc) {
            nextCityRef = nc;
            const ddx = nc.wx - camCtl.tx, ddz = nc.wz - camCtl.tz;
            const upx = -Math.sin(camCtl.az), upz = -Math.cos(camCtl.az);
            const rtx = Math.cos(camCtl.az), rtz = -Math.sin(camCtl.az);
            const th = Math.atan2(ddx * rtx + ddz * rtz, ddx * upx + ddz * upz);
            const AR = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
            const ar = AR[((Math.round(th / (Math.PI / 4)) % 8) + 8) % 8];
            const walking = ACTORS.goal && Math.hypot(ACTORS.goal.x - nc.wx, ACTORS.goal.z - nc.wz) < 260;
            const pp = ACTORS.player && ACTORS.player.group.parent
              ? ACTORS.player.group.position : { x: camCtl.tx, z: camCtl.tz };
            const pd = Math.hypot(nc.wx - pp.x, nc.wz - pp.z);
            const vd = Math.hypot(camCtl.tx - pp.x, camCtl.tz - pp.z);
            pill.textContent = (walking ? '● WALKING TO ' : 'WALK TO ') + nc.name.toUpperCase() +
              ' · ' + (pd / 1000).toFixed(1) + ' KM ' + ar +
              (vd > 250 ? ' · VIEW ' + (vd / 1000).toFixed(1) + ' KM FROM YOUR TYCOON (C)' : '');
            pill.style.display = '';
          } else { nextCityRef = null; pill.style.display = 'none'; }
        } else { nextCityRef = null; pill.style.display = 'none'; }
      }
    }
    // minimap
    mmTimer += dt;
    if (mmTimer > .5) {
      mmTimer = 0;
      mmCanvas.classList.remove('hidden');
      drawMinimap();
    }
    renderer.render(worldScene, camera);
  } else {
    // boot / diving — idle render of globe if available
    if (EARTH.scene && STATE.mode !== 'boot') { EARTH.update(dt); renderer.render(EARTH.scene, camera); }
  }
}
loop();

// ---------------- saves ------------------------------------------------
setInterval(() => { if (STATE.mode !== 'boot') saveGame(); }, 10000);
window.addEventListener('beforeunload', () => { if (STATE.mode !== 'boot') saveGame(); });

// globe dive hook (EARTH calls onArrived)
// v2.04: kick the street download the INSTANT the dive starts — the
// 1.25s flight overlaps the network instead of serializing after it
const _origDive = EARTH.diveTo.bind(EARTH);
EARTH.diveTo = (city, cb) => {
  OSM.prefetch({ key: city.key, name: city.name, lat: city.lat, lon: city.lon });
  return _origDive(city, () => enterWorld({
    key: city.key, name: city.name, lat: city.lat, lon: city.lon, tier: city.tier,
  }));
};



