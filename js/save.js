// ====================================================================
// js/save.js — save-pack LOADING + migrations (packs v2/3/4 -> v5;
// the 'openworld-v2' localStorage key and wire format unchanged),
// plus saveGame() (moved here from 10_core in Stage 6; it reads
// ACTORS.player for the standing spot — ACTORS is late-bound below
// so save.js never imports the world layer).
// ====================================================================
import { CITIES, DEG_M_K, ECON, OLD_LAYOUT, SAVE_KEY } from './config.js';
import { worldAnchorOf } from './util.js';
import { STATE } from './state.js';
import { onSaved } from './sync.js';

// ---- late binding (boot binds after every module evaluates) --------
export let ACTORS;
export function __late(b) { ({ ACTORS } = b); }

export const OLD_ANCHOR = key => {
  const c = CITIES.find(x => x.key === key);
  if (!c) return null;
  const o = OLD_LAYOUT[c.idx];
  return o ? { x: o[0], z: o[1] } : null;
};
export function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw);
    STATE.saveTs = (typeof p.ts === 'number' && +p.ts > 0) ? +p.ts : null;   // v2.55 NIGHT SHIFT: the stamp of the last save (absent on pre-v2.55 packs — their first reload measures from the next save)
    STATE.name = p.name || ''; STATE.money = p.money ?? ECON.startMoney;
    STATE.gdp = p.gdp || 0; STATE.lastCityKey = p.lastCityKey || null;
    // per-version news gate: stores the version whose news was seen
    // (boolean true = the v2.0 launch news)
    STATE.seenNews = p.seenNews === true ? 'v2.0' : (p.seenNews || false);
    STATE.gfx = p.gfx ? { shadows: p.gfx.sh !== 0, trees: p.gfx.tr !== 0, scale: p.gfx.sc === .75 || p.gfx.sc === .5 ? p.gfx.sc : 1, lite: !!p.gfx.lt } : STATE.gfx;   // v2.66 PICTURE (optional field — older builds ignore it)
    STATE.designs = (p.dsg || []).filter(x => x && typeof x.n === 'string' && isFinite(+x.w) && isFinite(+x.f)).slice(0, 12)
      .map(x => ({ n: x.n.slice(0, 24), w: Math.max(6, Math.min(14, +x.w)), d: Math.max(6, Math.min(12, +x.d || 8)), f: Math.max(1, Math.min(12, x.f | 0)), s: x.s || 'brick' }));   // v2.67 THE ARCHITECT: raw drafts — builder.js re-derives the full spec (cost/days/income) on first use, so a balance tweak re-prices saved designs honestly
    // v2.18 PLANET EARTH: the world was re-projected onto the real globe —
    // v3-era world coordinates no longer mean anything. City plots ride
    // their city's new anchor; rural plots snap to the nearest dry land;
    // the old standing spot is dropped so you re-land somewhere real.
    // (v2.27: the v3 remap below works in OLD 550 m/° coordinates — the
    // TRUE-SCALE rescale right after moves everything to 1:1.)
    if (p.v === 3) {
      p.wx = null; p.wz = null;
      (p.plots || []).forEach(q => {
        if (q.cityKey && q.cityKey !== 'rural') {
          const was = OLD_ANCHOR(q.cityKey), now0 = worldAnchorOf(q.cityKey);
          const now = now0 ? { x: now0.x / DEG_M_K, z: now0.z / DEG_M_K } : null;
          if (was && now) { q.x = now.x + (q.x - was.x); q.z = now.z + (q.z - was.z); }
        }
      });
    }
    // v2.27 TRUE SCALE: v3/v4 packs were written on the 550 m/° world.
    // City plots keep their offset from their city's anchor (the anchor
    // itself moved to its true-scale position); rural plots, searched
    // 'll…' sites and the saved standing spot keep their lat/lon (world
    // coords × K). Fresh v5 packs need nothing.
    if (p.v === 3 || p.v === 4) {
      (p.plots || []).forEach(q => {
        const a = (q.cityKey && q.cityKey !== 'rural') ? worldAnchorOf(q.cityKey) : null;
        if (a) {
          const ao = { x: a.x / DEG_M_K, z: a.z / DEG_M_K };   // old-scale anchor
          q.x = a.x + (q.x - ao.x);
          q.z = a.z + (q.z - ao.z);
        } else {
          q.x = (q.x || 0) * DEG_M_K; q.z = (q.z || 0) * DEG_M_K;
        }
      });
      if (typeof p.wx === 'number') p.wx *= DEG_M_K;
      if (typeof p.wz === 'number') p.wz *= DEG_M_K;
    }
    STATE.playerW = (typeof p.wx === 'number') ? p.wx : null;
    STATE.playerZ = (typeof p.wz === 'number') ? p.wz : null;
    STATE.plots = (p.plots || []).map(o => {
      const q = { ...o, crew: o.crew || [] };
      q.bld = (Array.isArray(o.bld) ? o.bld : []).filter(b => b && ((b.t >= 0 && b.t < 4) || (b.t >= 100 && b.t < 112)) && isFinite(+b.x) && isFinite(+b.z)).slice(0, 8)
        .map(b => ({ t: b.t | 0, x: Math.round(+b.x * 10) / 10, z: Math.round(+b.z * 10) / 10, p: Math.max(0, Math.min(30, +(+b.p || 0))),   // v2.67 THE ARCHITECT: t>=100 = design index +100 (12 designs max); taller customs run longer build-days, so the progress cap eases to 30
          // v2.61 FACTORY FLOOR: the machines on a factory shell's floor (absent on older saves — an empty floor)
          mach: (Array.isArray(b.mach) ? b.mach : []).filter(m => m && m.t >= 0 && m.t < 16 && isFinite(+m.x) && isFinite(+m.z)).slice(0, 16)
            .map(m => ({ t: m.t | 0, x: +(+m.x || 0).toFixed(2), z: +(+m.z || 0).toFixed(2) })) }));   // v2.56 GROUND UP (absent on older saves — nothing built; coords are plot-LOCAL, so world migrations never touch them) · v2.61: mach t<6 heavy line, t 10-15 the classic machines
      // v2 (city-local) -> v3 (world) migration via the city's world anchor
      // (v2.27: in old-scale coordinates; the true-scale rescale above
      // has already run, so divide back — ancient saves, best effort)
      if (p.v !== 3 && p.v !== 4 && p.v !== 5 && q.cityKey) {
        const a = worldAnchorOf(q.cityKey);
        if (a) { q.x = a.x + (q.x || 0) * DEG_M_K; q.z = a.z + (q.z || 0) * DEG_M_K; }
      }
      return q;
    });
    STATE.offices = p.offices || [];
    // v2.43 TITLE DEEDS: rooms/floors you bought or rented (absent on older saves)
    // v2.44 PATCHWORK: farm parcels you bought (absent on older saves)
    STATE.acres = (p.acres || []).filter(a => a && typeof a.id === 'string' && a.id.charAt(0) === 'f')
      .slice(0, 150)
      .map(a => ({ id: a.id, name: a.name || 'Farm parcel', ha: +a.ha || 0, price: +a.price || 0, rate: +a.rate || 0, x: +a.x || 0, z: +a.z || 0, near: a.near || null, nearKey: a.nearKey || null }));
    STATE.rooms = (p.rooms || []).filter(r => r && (r.kind === 'floor' || r.kind === 'room') &&
      (r.mode === 'owned' || r.mode === 'rented') && r.bkey !== undefined && typeof r.index === 'number')
      .map(r => ({ id: r.id, cityKey: r.cityKey, cityName: r.cityName || null, bkey: r.bkey, kind: r.kind, index: r.index, name: r.name || r.kind, area: +r.area || 0, rate: +r.rate || 0, mode: r.mode, price: +r.price || 0, x: +r.x || 0, z: +r.z || 0,
        // v2.45 MACHINES: the machines installed in that unit (absent on older saves)
        machines: (Array.isArray(r.machines) ? r.machines : []).filter(m => m && m.t >= 0 && m.t < 6 && isFinite(+m.x) && isFinite(+m.z)).slice(0, 16)
          .map(m => ({ t: m.t | 0, x: +(+m.x || 0).toFixed(2), z: +(+m.z || 0).toFixed(2), fl: m.fl | 0 })),
        // v2.57 FURNITURE: the pieces placed in that unit (absent on older saves)
        furn: (Array.isArray(r.furn) ? r.furn : []).filter(f => f && f.t >= 0 && f.t < 10 && isFinite(+f.x) && isFinite(+f.z)).slice(0, 24)   // v2.58 HOME OFFICE: desks + computers join the catalog (was < 8)
          .map(f => ({ t: f.t | 0, x: +(+f.x || 0).toFixed(2), z: +(+f.z || 0).toFixed(2), r: (f.r | 0) % 4, fl: f.fl | 0, craft: f.craft ? 1 : 0 })) }));
    // v2.47 LANDLORD: your rental listings (absent on older saves)
    STATE.rentals = (p.rentals || []).filter(x => x && typeof x.id === 'string' && +x.price > 0)
      .map(x => ({ id: x.id, price: Math.round(+x.price), on: !!x.on, tenant: (typeof x.tenant === 'string' && x.tenant) || null, term: Math.max(0, x.term | 0), next: Math.max(0, +x.next || 0) }))
      .filter(x => STATE.plots.some(q => q.id === x.id) || STATE.offices.some(q => q.id === x.id) ||
        STATE.rooms.some(q => q.id === x.id) || STATE.acres.some(q => q.id === x.id));
    // v2.48 MOTHERLODE: your mining claims (absent on older saves)
    STATE.mines = (p.mines || []).filter(m => m && typeof m.id === 'string' && m.id.charAt(0) === 'm' && isFinite(+m.x) && isFinite(+m.z) && +m.w >= 40 && +m.d >= 40)
      .slice(0, 12)
      .map(m => ({ id: m.id, name: m.name || 'Mine', x: +m.x || 0, z: +m.z || 0, w: Math.min(320, +m.w || 40), d: Math.min(320, +m.d || 40), price: +m.price || 0, grade: Math.max(1, +m.grade || 12), ore: Math.max(0, Math.round(+m.ore || 0)), got: Math.min(Math.max(0, +m.got || 0), Math.max(0, Math.round(+m.ore || 0))), near: m.near || null, nearKey: m.nearKey || null,
        machines: (Array.isArray(m.machines) ? m.machines : []).filter(x => x && x.t >= 0 && x.t < 5 && isFinite(+x.x) && isFinite(+x.z)).slice(0, 14)
          .map(x => ({ t: x.t | 0, x: +(+x.x || 0).toFixed(1), z: +(+x.z || 0).toFixed(1) })),
        crew: Math.min(60, Math.max(0, m.crew | 0)), walked: !!m.walked, wageAcc: +(+m.wageAcc || 0).toFixed(2), res: (typeof m.res === 'string' && m.res) ? m.res.slice(0, 12) : null }));   // v2.50 HIRED HANDS (clamped 0–60) · v2.52 ORE EXCHANGE: the resource key (older saves re-derive it from the mine's name at boot)
    // v2.51 MONEY LIST: the rival fortunes (absent on older saves — defaults seed at boot)
    STATE.rivals = (Array.isArray(p.rivals) ? p.rivals : []).slice(0, 15).map(w => (isFinite(+w) && +w >= 500) ? Math.round(+w) : null);
    // v2.52 ORE EXCHANGE: the resource stockpile + the market multipliers (absent on older saves — multipliers seed at par)
    STATE.res = {};
    const __exr = (p.res && typeof p.res === 'object') ? p.res : {};
    for (const k in __exr) { if (typeof k === 'string' && k.length && k.length <= 12 && isFinite(+__exr[k]) && +__exr[k] > 0) STATE.res[k] = Math.min(1e9, +(+__exr[k]).toFixed(2)); }
    STATE.mkt = {};
    const __exm = (p.mkt && typeof p.mkt === 'object') ? p.mkt : {};
    for (const k in __exm) { const e = __exm[k]; if (typeof k === 'string' && k.length && k.length <= 12 && e && typeof e === 'object' && isFinite(+e.m)) STATE.mkt[k] = { m: Math.max(.55, Math.min(1.7, +e.m)), pm: Math.max(.55, Math.min(1.7, +(e.pm || 1))) }; }
    // v2.53 THE WORKS: the refining machine counts (absent on older saves — none built)
    STATE.works = {};
    const __wk = (p.works && typeof p.works === 'object') ? p.works : {};
    for (const k in __wk) { if (typeof k === 'string' && k.length && k.length <= 12 && isFinite(+__wk[k]) && +__wk[k] > 0) STATE.works[k] = Math.min(99, Math.round(+__wk[k])); }
    // v2.56 GROUND UP: the materials shed (absent on older saves — an empty shed)
    STATE.mat = { Wood: 0, Stone: 0, Steel: 0, Glass: 0 };
    const __mt = (p.mat && typeof p.mat === 'object') ? p.mat : {};
    for (const k of ['Wood', 'Stone', 'Steel', 'Glass']) { const v = +__mt[k]; if (isFinite(v) && v > 0) STATE.mat[k] = +Math.min(1e6, v).toFixed(1); }
    // v2.59 THE GRID: the power state (absent on older saves — grid at par, empty meters)
    STATE.pow = { g: { m: 1, pm: 1 }, b: {} };
    // v2.62 DEEP WATER: the offshore oil rigs (absent on older saves — none built)
    STATE.rigs = (p.rigs || []).filter(r => r && typeof r.id === 'string' && r.id.charAt(0) === 'r' && isFinite(+r.x) && isFinite(+r.z) && +r.ore > 0)
      .slice(0, 8)
      .map(r => ({ id: r.id.slice(0, 24), name: String(r.name || 'Oil Field').slice(0, 40), x: +r.x || 0, z: +r.z || 0,
        price: Math.max(0, +r.price || 0), ore: Math.max(0, Math.round(+r.ore || 0)), got: Math.min(Math.max(0, +r.got || 0), Math.max(0, Math.round(+r.ore || 0))),
        crew: Math.min(32, Math.max(0, r.crew | 0)), walked: !!r.walked, wageAcc: +(+r.wageAcc || 0).toFixed(2),
        sto: Math.min(2000, Math.max(0, +r.sto || 0)), near: r.near || null, nearKey: r.nearKey || null }));   // crew 0–32 · tank 0–2000 t (same clamps the game enforces)
    const __pw = (p.pow && typeof p.pow === 'object') ? p.pow : {};
    if (__pw.g && typeof __pw.g === 'object') {
      if (isFinite(+__pw.g.m)) STATE.pow.g.m = Math.max(.55, Math.min(1.7, +__pw.g.m));
      if (isFinite(+__pw.g.pm)) STATE.pow.g.pm = Math.max(.55, Math.min(1.7, +__pw.g.pm));
    }
    const __pwb = (__pw.b && typeof __pw.b === 'object') ? __pw.b : {};
    let __pwn = 0;
    for (const k in __pwb) {
      const e = __pwb[k];
      if (typeof k !== 'string' || !k.length || k.length > 24 || __pwn >= 32) continue;
      if (!STATE.plots.some(q => q && q.id === k && q.cart)) continue;   // a scrapped cart leaves no meter behind
      if (!e || typeof e !== 'object') continue;
      STATE.pow.b[k] = { m: Math.min(1e6, Math.max(0, +e.m || 0)), cut: e.cut ? 1 : 0, due: Math.min(1e6, Math.max(0, +e.due || 0)) };
      __pwn++;
    }
    STATE.marketPack = p.market || null;
    // v2.05 starter guide: fresh players start at step 0; returning
    // players who already own a business are exempt
    STATE.tut = p.tut ? { step: Math.max(0, Math.min(5, p.tut.step | 0)), done: !!p.tut.done }
      : { step: 0, done: false };
    if (!STATE.tut.done && (STATE.plots.length || STATE.offices.length)) STATE.tut.done = true;
    return true;
  } catch (e) { return false; }
}
// ---- save / load ---------------------------------------------------
// v2.15: plots live in WORLD coordinates (pack v 3). Older saves stored
// city-LOCAL x/z — they are migrated to world coords via the city anchor.
export function saveGame() {
  try {
    const pack = {
      v: 5, ts: Date.now(), name: STATE.name, money: STATE.money, gdp: STATE.gdp,   // v2.55 NIGHT SHIFT: every save carries its timestamp — the offline clock reads it on the next load
      lastCityKey: STATE.lastCityKey, seenNews: STATE.seenNews,
      tut: { step: STATE.tut.step, done: STATE.tut.done },
      wx: ACTORS.player ? +ACTORS.player.group.position.x.toFixed(1) : null,
      wz: ACTORS.player ? +ACTORS.player.group.position.z.toFixed(1) : null,
      plots: STATE.plots.map(p => ({
        id: p.id, cityKey: p.cityKey, cityName: p.cityName || null, price: p.price || 0, x: +p.x.toFixed(2), z: +p.z.toFixed(2), lot: !!p.lot,   // v2.47 LANDLORD: price feeds the land market rate · v2.67 THE ARCHITECT: lot rides the pack
        cart: p.cart ? { cuisine: p.cart.cuisine } : null,
        crew: (p.crew || []).map(c => ({ name: c.name, stars: c.stars })),
        bld: (p.bld || []).map(b => ({ t: b.t | 0, x: +(+b.x || 0).toFixed(1), z: +(+b.z || 0).toFixed(1), p: +(+b.p || 0).toFixed(2),
          mach: (b.mach || []).map(m => ({ t: m.t | 0, x: +(+m.x || 0).toFixed(2), z: +(+m.z || 0).toFixed(2) })) })),   // v2.56 GROUND UP (optional field — older builds ignore it) · v2.61 FACTORY FLOOR: the machines on the factory floor (optional nested field)
      })),
      offices: STATE.offices.map(o => ({ id: o.id, cityKey: o.cityKey, bkey: o.bkey, name: o.name, sqm: o.sqm, rate: o.rate })),
      rooms: (STATE.rooms || []).map(r => ({ id: r.id, cityKey: r.cityKey, cityName: r.cityName || null, bkey: r.bkey, kind: r.kind, index: r.index, name: r.name, area: r.area, rate: r.rate, mode: r.mode, price: r.price, x: r.x, z: r.z,
        machines: (r.machines || []).map(m => ({ t: m.t | 0, x: +(+m.x || 0).toFixed(2), z: +(+m.z || 0).toFixed(2), fl: m.fl | 0 })),
        furn: (r.furn || []).map(f => ({ t: f.t | 0, x: +(+f.x || 0).toFixed(2), z: +(+f.z || 0).toFixed(2), r: f.r | 0, fl: f.fl | 0, craft: f.craft ? 1 : 0 })) })),   // v2.43 TITLE DEEDS + v2.45 MACHINES + v2.57 FURNITURE (optional fields — older builds ignore them)
      acres: (STATE.acres || []).map(a => ({ id: a.id, name: a.name, ha: +a.ha || 0, price: +a.price || 0, rate: +a.rate || 0, x: +a.x || 0, z: +a.z || 0, near: a.near || null, nearKey: a.nearKey || null })),   // v2.44 PATCHWORK (optional field — older builds ignore it)
      rentals: (STATE.rentals || []).map(x => ({ id: x.id, price: +x.price || 0, on: !!x.on, tenant: x.tenant || null, term: x.term | 0, next: +(+x.next || 0).toFixed(1) })),   // v2.47 LANDLORD (optional field — older builds ignore it)
      mines: (STATE.mines || []).map(m => ({ id: m.id, name: m.name, x: +m.x || 0, z: +m.z || 0, w: +m.w || 0, d: +m.d || 0, price: +m.price || 0, grade: +m.grade || 0, ore: Math.round(+m.ore || 0), got: +(+m.got || 0).toFixed(1), near: m.near || null, nearKey: m.nearKey || null, machines: (m.machines || []).map(x => ({ t: x.t | 0, x: +(+x.x || 0).toFixed(1), z: +(+x.z || 0).toFixed(1) })), crew: m.crew | 0, walked: !!m.walked, wageAcc: +(+m.wageAcc || 0).toFixed(2), res: m.res || null })),   // v2.48 MOTHERLODE · v2.50 HIRED HANDS: crew/walked/wageAcc · v2.52 ORE EXCHANGE: res (optional fields — older builds ignore them)
      rivals: (STATE.rivals || []).map(w => isFinite(+w) ? Math.round(+w) : null),   // v2.51 MONEY LIST (optional field — older builds ignore it)
      res: (() => { const o = {}; for (const k in (STATE.res || {})) { const v = +(STATE.res[k] || 0); if (isFinite(v) && v > 0) o[k] = +v.toFixed(2); } return o; })(),   // v2.52 ORE EXCHANGE (optional field — older builds ignore it)
      mkt: (() => { const o = {}; for (const k in (STATE.mkt || {})) { const e = STATE.mkt[k]; if (e && typeof e === 'object' && isFinite(+e.m)) o[k] = { m: +(+e.m).toFixed(3), pm: +(+e.pm || 1).toFixed(3) }; } return o; })(),   // v2.52 ORE EXCHANGE (optional field — older builds ignore it)
      works: (() => { const o = {}; for (const k in (STATE.works || {})) { const v = STATE.works[k] | 0; if (v > 0) o[k] = Math.min(99, v); } return o; })(),   // v2.53 THE WORKS (optional field — older builds ignore it)
      mat: (() => { const o = {}; for (const k of ['Wood', 'Stone', 'Steel', 'Glass']) { const v = +((STATE.mat || {})[k]) || 0; if (isFinite(v) && v > 0) o[k] = +Math.min(1e6, v).toFixed(1); } return o; })(),   // v2.56 GROUND UP (optional field — older builds ignore it)
      pow: (() => { const s = STATE.pow || {}, g = s.g || {}; const o = { g: { m: +(g.m || 1).toFixed(3), pm: +(g.pm || 1).toFixed(3) }, b: {} }; for (const k in (s.b || {})) { const e = s.b[k]; if (e && typeof e === 'object' && (isFinite(+e.m) || e.cut || isFinite(+e.due))) o.b[k] = { m: +Math.min(1e6, Math.max(0, +e.m || 0)).toFixed(1), cut: e.cut ? 1 : 0, due: +Math.min(1e6, Math.max(0, +e.due || 0)).toFixed(2) }; } return o; })(),   // v2.59 THE GRID (optional field — older builds ignore it)
      rigs: (STATE.rigs || []).map(r => ({ id: r.id, name: r.name, x: +r.x || 0, z: +r.z || 0, price: +r.price || 0, ore: Math.round(+r.ore || 0), got: +(+r.got || 0).toFixed(1), crew: r.crew | 0, walked: !!r.walked, wageAcc: +(+r.wageAcc || 0).toFixed(2), sto: +(+r.sto || 0).toFixed(1), near: r.near || null, nearKey: r.nearKey || null })),   // v2.62 DEEP WATER (optional field — older builds ignore it)
      gfx: STATE.gfx ? { sh: STATE.gfx.shadows === false ? 0 : 1, tr: STATE.gfx.trees === false ? 0 : 1, sc: STATE.gfx.scale === .75 || STATE.gfx.scale === .5 ? STATE.gfx.scale : 1, lt: STATE.gfx.lite ? 1 : 0 } : null,   // v2.66 PICTURE (optional field — older builds ignore it)
      dsg: (STATE.designs || []).slice(0, 12).map(d => ({ n: d.name, w: +d.w || 10, d: +d.d || 8, f: d.floors | 0, s: d.style || 'brick' })),   // v2.67 THE ARCHITECT (optional field — older builds ignore it; cost/days/income re-derive on load, so a balance tweak in a later build re-prices old designs honestly)
      market: STATE.market ? STATE.market.pack() : null,
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(pack));
    onSaved();   // hosted site only: schedules the upload to the player's account
  } catch (e) { /* quota — keep playing in memory */ }
}
