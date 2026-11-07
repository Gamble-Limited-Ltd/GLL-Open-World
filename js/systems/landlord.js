// ====================================================================
// js/systems/landlord.js — landlord rentals (Stage 7c): list at
// your own price, tenants, terms.
// ====================================================================
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { ECO } from '../systems/eco.js';

// ======== section: 50_landlord.js ========
// ====================================================================
// v2.47 — LANDLORD. The ask: "If people buy a plot, building, floor,
// or room — allow them to rent it back to other people at a price
// they can set." Everything you hold can now go on the rental market
// at YOUR price:
//   - an empty street plot (no cart on it), an office suite in a
//     tower, a bought room/floor, a leased one (sublet) and a farm
//     parcel — each panel you already use grows a RENT IT OUT button
//     (the park-a-cart panel, your office panel, the title-deed
//     MANAGE modal, your farmland panel);
//   - the rent-out modal has a price YOU set (type it, or MARKET /
//     +10% / -10%), the local market rate for an honest reference,
//     and a live OUTLOOK line that calls the demand before you
//     commit;
//   - listing puts the unit ON THE MARKET: its own tenant moves out
//     (that income stops), prospective tenants view it on the
//     game-day beat, and they sign a 4-12 day lease paying YOUR price
//     — the take-probability falls linearly from ~95% at market to
//     zero at 3x market, so overpricing means long vacant stretches
//     at $0/day while the market looks. That is the gamble;
//   - income is an additive delta on the same 90 s game-day beat the
//     offices, deeds, acres and machines already use: tenanted ->
//     the asset pays (your price - its normal income), listed &
//     empty -> (0 - its normal income), unlisted -> no entry at all,
//     the original income stands untouched. The delta is clamped so
//     money never dips below zero, and machine income is separate
//     and never touched;
//   - leases run down a day at a time, tenants move out on their own
//     and the unit re-lets; you can EVICT early, reprice between
//     tenants, or TAKE IT OFF THE MARKET any time;
//   - every listing shows in the Empire panel (Landlord section,
//     with net-vs-normal income) and persists in the save as a new
//     optional "rentals" field (pack stays v5; older builds ignore
//     it), sanitized on load and swept when you sell or end a lease.
// Touchpoints outside this section (each annotated "v2.47"): the
// STATE/save/load rentals field + the plot purchase price now saved
// (it feeds the land market rate), the RENT OUT buttons + status
// lines in openBuild / openOfficeMine / the title-deed MANAGE modal /
// the farmland panel / the inspector deal block, the openBusiness
// routing for tenanted plots, one help-modal line, and the version
// surfaces. Every landlord call is try/caught so a mistake here can
// never touch the world. window.LORD is the QA surface.
// ====================================================================
export const LORD = (() => {
  const DAY = 90;              // seconds per game day (the office/deed/acres beat)
  const NAMES = ['M. Alvarez', 'K. Osei', 'S. Nakamura', 'R. Novak', 'A. Diallo', 'J. Whitfield',
    'L. Marchetti', 'T. Okafor', 'P. Lindqvist', 'D. Fontaine', 'H. Yamada', 'C. Mwangi',
    'N. Petrov', 'E. Sandoval', 'B. Kowalski', 'F. Haddad', 'G. Iversen', 'I. Moreau',
    'V. Castillo', 'W. Adeyemi'];
  let acc = 0;                 // income accumulator (1 s ticks, like the offices)
  let dayT = 0;                // game-day beat accumulator (leases run down)

  // ---- resolve an asset id -> facts the market needs ----------------
  // base = the daily income the asset pays right now (unlisted);
  // fair = the market-rate price tenants compare YOUR price against.
  function assetOf(id) {
    let a = (STATE.plots || []).find(p => p.id === id);
    if (a) {
      // land lease: 1/12 of the purchase price per day (the title-deed
      // convention); older saves without a stored price get a sane default
      const fair = Math.max(4, Math.round((a.price || 900) / 12));
      return { kind: 'plot', obj: a, name: (a.cityName || 'Countryside') + ' plot', city: a.cityName || a.cityKey, fair, base: 0, cart: !!a.cart };
    }
    a = (STATE.offices || []).find(o => o.id === id);
    if (a) return { kind: 'office', obj: a, name: a.name, city: a.cityKey, fair: Math.max(1, Math.round(a.rate)), base: Math.max(1, Math.round(a.rate)) };
    a = (STATE.rooms || []).find(r => r.id === id);
    if (a) {
      const base = a.mode === 'owned' ? Math.round(a.rate * 2) : Math.round(a.rate);   // the deed's own income (machines are separate)
      return { kind: 'unit', obj: a, name: a.name, city: a.cityName || a.cityKey, fair: Math.max(1, base), base, sublet: a.mode === 'rented' };
    }
    a = (STATE.acres || []).find(x => x.id === id);
    if (a) return { kind: 'acre', obj: a, name: a.name, city: a.near || 'open country', fair: Math.max(1, Math.round(a.rate)), base: Math.max(1, Math.round(a.rate)) };
    return null;
  }
  const entryOf = id => (STATE.rentals || []).find(x => x.id === id) || null;
  const isListed = id => { const e = entryOf(id); return !!(e && e.on); };
  const isTenanted = id => { const e = entryOf(id); return !!(e && e.tenant); };

  // ---- the demand curve: P(a viewing tenant signs) vs price/market --
  const CURVE = [[.9, .97], [1, .95], [1.25, .85], [1.5, .62], [1.75, .42], [2, .22], [2.25, .10], [2.5, .045], [2.75, .015], [3, 0]];
  function takeProb(ratio) {
    if (ratio <= CURVE[0][0]) return CURVE[0][1];
    for (let i = 1; i < CURVE.length; i++) {
      if (ratio <= CURVE[i][0]) {
        const [x0, y0] = CURVE[i - 1], [x1, y1] = CURVE[i];
        return y0 + (y1 - y0) * (ratio - x0) / (x1 - x0);
      }
    }
    return 0;
  }
  function verdict(ratio) {
    if (ratio <= 1.05) return ['Tenants will snap this up', '#48BB78'];
    if (ratio <= 1.5) return ['Priced to move — steady interest', '#48BB78'];
    if (ratio <= 2) return ['Above market — expect vacancies', '#F5CC74'];
    if (ratio <= 2.5) return ['Steep — long empty stretches likely', '#FB923C'];
    return ['Nobody will pay this price', '#F87171'];
  }
  const tenantName = () => NAMES[Math.floor(Math.random() * NAMES.length)];

  // ---- list / reprice / unlist / evict -------------------------------
  function listFor(id, price) {
    const a = assetOf(id);
    if (!a) return { ok: false, why: 'no asset' };
    if (a.kind === 'plot' && a.cart) return { ok: false, why: 'cart' };
    price = Math.max(1, Math.min(999999, Math.round(price)));
    const R = STATE.rentals || (STATE.rentals = []);
    let e = entryOf(id);
    if (!e) { e = { id, price, on: true, tenant: null, term: 0, next: 6 + Math.random() * 9 }; R.push(e); }
    else { e.price = price; e.on = true; if (!e.tenant) e.next = Math.min(e.next || 12, 12); }
    try { saveGame(); } catch (er) { }
    return { ok: true, entry: e, fair: a.fair };
  }
  function unlist(id) {
    if (!entryOf(id)) return { ok: false };
    STATE.rentals = STATE.rentals.filter(x => x.id !== id);
    try { saveGame(); } catch (er) { }
    return { ok: true };
  }
  function evict(id) {
    const e = entryOf(id);
    if (!e || !e.tenant) return { ok: false };
    e.tenant = null; e.term = 0; e.next = 15 + Math.random() * 30;
    try { saveGame(); } catch (er) { }
    return { ok: true };
  }

  // ---- the lease clock: one game day at a time -----------------------
  function dayBeat() {
    for (const e of (STATE.rentals || []).slice()) {
      if (!assetOf(e.id)) {   // sold / lease-ended under us — sweep it
        STATE.rentals = STATE.rentals.filter(x => x !== e);
        continue;
      }
      if (!e.tenant) continue;
      if (--e.term <= 0) {
        const a = assetOf(e.id);
        try { toast((a ? '<b>' + a.name + '</b>' : 'Your rental') + ' — ' + e.tenant + ' moved out. Back on the market.', 'warn'); } catch (er) { }
        e.tenant = null; e.term = 0; e.next = 15 + Math.random() * 30;
      }
    }
    try { saveGame(); } catch (er) { }
  }
  function letView(e, a) {   // one prospective tenant looks at a vacant listing
    if (Math.random() < takeProb(e.price / a.fair)) {
      e.tenant = tenantName();
      e.term = 4 + Math.floor(Math.random() * 9);
      try { toast('<b>' + e.tenant + '</b> rented your <b>' + a.name + '</b> — paying $' + e.price + '/day for ' + e.term + ' days.'); } catch (er) { }
      return true;
    }
    return false;
  }

  // ---- income: additive delta on the office/deed/acres beat ----------
  // tenanted -> the asset now pays YOUR price (delta = price - base);
  // listed & empty -> the market has it, nobody pays (delta = -base);
  // unlisted -> no entry, the original income stands untouched.
  function tick(dt) {
    const R = STATE.rentals || [];
    if (STATE.mode !== 'city' || !R.length) { acc = 0; dayT = 0; return; }
    acc += dt; dayT += dt;
    if (acc >= 1) {
      const secs = acc; acc = 0;
      let d = 0;
      for (const e of R) {
        const a = assetOf(e.id);
        if (!a) continue;
        d += (e.on && e.tenant ? e.price - a.base : (e.on ? -a.base : 0)) / DAY * secs;
      }
      if (d) {
        if (d < 0) d = Math.max(d, -STATE.money);   // never below zero
        if (d) earn(d);
      }
      for (const e of R) {   // viewings run their own countdown while vacant
        if (!e.on || e.tenant) continue;
        if ((e.next -= secs) <= 0) {
          const a = assetOf(e.id);
          if (a && letView(e, a)) { try { saveGame(); } catch (er) { } }
          else e.next = DAY;   // next viewing one game day out
        }
      }
    }
    if (dayT >= DAY) { dayT -= DAY; dayBeat(); }
  }

  // ---- status lines for the panels you already use -------------------
  function tagLine(id, modalForm) {
    const e = entryOf(id);
    if (!e) return '';
    if (modalForm) return e.tenant
      ? '<div class="kv"><span class="k">RENTED OUT</span><span class="v" style="color:#48BB78">' + e.tenant + ' pays $' + e.price + '/day \u00b7 ' + e.term + ' day' + (e.term === 1 ? '' : 's') + ' left</span></div>'
      : '<div class="kv"><span class="k">ON THE MARKET</span><span class="v" style="color:#F5CC74">$' + e.price + '/day \u00b7 vacant, tenants viewing</span></div>';
    return e.tenant
      ? '<div class="ohp-kv"><span>Tenant</span><b style="color:#48BB78">' + e.tenant + ' \u00b7 $' + e.price + '/day \u00b7 ' + e.term + 'd left</b></div>'
      : '<div class="ohp-kv"><span>On the market</span><b style="color:#F5CC74">$' + e.price + '/day \u00b7 waiting for a tenant</b></div>';
  }

  // ---- the rent-out modal --------------------------------------------
  function open(id) {
    const a = assetOf(id);
    if (!a) return;
    const label = a.kind === 'office' || a.sublet ? 'Sublet It Out' : 'Rent It Out';
    const renter = a.kind === 'acre' ? 'tenant farmers' : 'tenants';
    const render = (preset) => {
      const e = entryOf(id);
      const price = preset != null ? preset : (e ? e.price : Math.max(1, Math.round(a.fair * 1.4)));
      const [vt, vc] = verdict(price / a.fair);
      const status = !e
        ? 'Not listed — earning <b>' + (a.base > 0 ? '$' + a.base + '/day</b>' : 'nothing</b> (empty land)')
        : (e.tenant
          ? '<b style="color:#48BB78">' + e.tenant + '</b> pays <b style="color:#48BB78">$' + e.price + '/day</b> \u00b7 ' + e.term + ' day' + (e.term === 1 ? '' : 's') + ' left on the lease'
          : 'On the market — <b style="color:#F5CC74">vacant</b>, earning $0/day while ' + renter + ' view it');
      openModal(a.name + ' \u2014 ' + label, `
        <div id="pl"><span class="l">Landlord</span><span class="v">${a.city || 'Worldwide'}</span></div>
        <div class="kv"><span class="k">MARKET RATE</span><span class="v">$${a.fair}/day \u2014 what ${renter} pay around here</span></div>
        <div class="kv"><span class="k">STATUS</span><span class="v">${status}</span></div>
        <div class="kv"><span class="k">YOUR PRICE</span><span class="v"><input id="lr-p" type="number" min="1" step="1" value="${price}" style="width:110px;background:#0b1220;border:1px solid #2a3a52;color:#e6edf3;padding:8px 10px;border-radius:8px;font-weight:700;text-align:center;font-size:16px"> /day</span></div>
        <div class="kv"><span class="k">OUTLOOK</span><span class="v" id="lr-o" style="color:${vc}">${vt}</span></div>
        ${e && e.tenant ? '<p style="margin:10px 0 0">The price is locked until this lease ends \u2014 or evict ' + e.tenant + ' now and re-list at any price.</p>' : ''}
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn" id="lr-mk" style="flex:1">MARKET $${a.fair}</button>
          <button class="btn" id="lr-up" style="flex:1">+10%</button>
          <button class="btn" id="lr-dn" style="flex:1">\u221210%</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          ${e && e.tenant
            ? '<button class="btn bad" id="lr-go" style="flex:1">EVICT \u2014 RELIST AT MY PRICE</button>'
            : '<button class="btn good" id="lr-go" style="flex:1">' + (e ? 'UPDATE PRICE' : 'LIST IT FOR RENT') + '</button>'}
          ${e && !e.tenant ? '<button class="btn bad" id="lr-off" style="flex:1">TAKE OFF MARKET</button>' : ''}
          <button class="btn" id="lr-x">CLOSE</button>
        </div>`);
      const inp = document.getElementById('lr-p');
      const cur = () => Math.max(1, Math.min(999999, Math.round(+inp.value || 1)));
      const liveVerdict = () => {
        const [t, c] = verdict(cur() / a.fair);
        const o = document.getElementById('lr-o');
        if (o) { o.textContent = t; o.style.color = c; }
      };
      inp.oninput = liveVerdict;
      document.getElementById('lr-mk').onclick = () => { inp.value = a.fair; liveVerdict(); };
      document.getElementById('lr-up').onclick = () => { inp.value = Math.round(cur() * 1.1); liveVerdict(); };
      document.getElementById('lr-dn').onclick = () => { inp.value = Math.max(1, Math.round(cur() * .9)); liveVerdict(); };
      document.getElementById('lr-go').onclick = () => {
        if (e && e.tenant) {   // (e re-read below — this branch uses the live entry)
          const cur2 = entryOf(id);
          if (cur2 && cur2.tenant) { evict(id); toast(cur2.tenant + ' moved out \u2014 the unit is back on the market.', 'warn'); }
          render();
          return;
        }
        const r = listFor(id, cur());
        if (!r.ok) {
          toast(r.why === 'cart'
            ? '<b>The cart uses this land.</b> Scrap it first to rent the plot out.'
            : 'Not yours to rent.', 'warn');
          return;
        }
        toast('Listed <b>' + a.name + '</b> at <b>$' + cur() + '/day</b> \u2014 ' + renter + ' are viewing it now.');
        render(cur());
      };
      const off = document.getElementById('lr-off');
      if (off) off.onclick = () => {
        unlist(id);
        toast('Took <b>' + a.name + '</b> off the market \u2014 its normal income resumes.');
        closeModal();
      };
      document.getElementById('lr-x').onclick = closeModal;
    };
    render();
  }

  // ---- the Empire panel: your rental portfolio ------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const R = (STATE.rentals || []).slice();
    const rows = R.map((e, i) => {
      const a = assetOf(e.id);
      if (!a) return '';
      const st = e.tenant
        ? '<span style="color:#48BB78">' + e.tenant + ' \u00b7 $' + e.price + '/day \u00b7 ' + e.term + 'd left</span>'
        : '<span style="color:#F5CC74">vacant \u00b7 $' + e.price + '/day</span>';
      return '<div class="kv"><span class="k">' + a.name + ' \u00b7 ' + st + '</span>' +
        '<button class="tpbtn" data-lr="' + i + '">MANAGE</button></div>';
    }).join('');
    const net = R.reduce((s, e) => {
      const a = assetOf(e.id);
      return s + (a ? (e.tenant ? e.price - a.base : -a.base) : 0);
    }, 0);
    const html = '<div class="msec" style="margin-top:14px">Landlord \u2014 your rentals</div>' +
      (rows || '<p>No rentals listed. Anything you own \u2014 a plot, an office, a room, a floor or a farm parcel \u2014 can be rented out at <b>your own price</b>.</p>') +
      (rows ? '<div class="kv" style="margin-top:10px"><span class="k">RENTAL NET</span><span class="v ' + (net >= 0 ? 'g' : '') + '">' + (net >= 0 ? '+' : '\u2212') + '$' + Math.abs(net / 90 * 60).toFixed(2) + '/min vs. normal income</span></div>' : '');
    const anchorEl = close ? close.parentElement : null;
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    body.querySelectorAll('[data-lr]').forEach(b => {
      b.onclick = () => { const e2 = R[+b.dataset.lr]; if (e2) open(e2.id); };
    });
  }
  const __landEmpire = ECO.openEmpire.bind(ECO);
  ECO.openEmpire = function () {
    __landEmpire();
    try { empireInto(); } catch (e) { console.error('[landlord]', e); }
  };

  return {
    open, tick, listFor, unlist, evict, isListed, isTenanted, tagLine,
    assetOf, verdict, takeProb,
    list: () => (STATE.rentals || []).slice(),
    state() {
      const R = STATE.rentals || [];
      return {
        listings: R.length,
        tenanted: R.filter(e => e.tenant).length,
        vacant: R.filter(e => e.on && !e.tenant).length,
        netPerDay: R.reduce((s, e) => { const a = assetOf(e.id); return s + (a ? (e.tenant ? e.price - a.base : -a.base) : 0); }, 0),
      };
    },
    qaDay(n) { for (let i = 0; i < (n || 1); i++) dayBeat(); },        // QA: run lease days instantly
    qaLet(id) {                                                        // QA: force a tenant into a vacant listing
      const e = entryOf(id);
      if (e && !e.tenant) { e.tenant = tenantName(); e.term = 8; }
      return entryOf(id);
    },
  };
})();
window.LORD = LORD;   // QA surface

// ADDITIVE hook — the landlord tick rides the same WORLD.update wrap
// chain the game already uses (original -> world forest -> open house
// -> suburbs -> title deeds -> patchwork -> machines -> LANDLORD).
// Every call is try/caught so a landlord error can never touch the
// world.
const __landOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __landOrigUpdate(dt, px, pz, camDist);
  try { LORD.tick(dt); } catch (e) { console.error('[landlord]', e); }
  return req;
};


