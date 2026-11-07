// ====================================================================
// js/systems/mining.js — mining claims (Stage 7c): stake,
// machinery, crews, wages, pit terraces. EXCH late-bound below.
// ====================================================================
import * as THREE from 'three';
import { CITIES } from '../config.js';
import { fmt$, hashStr } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend, uiBalance } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { LANDGEO } from '../core.js';
import { WORLD, camCtl } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';
import { canvas, enterWorld } from '../render/main.js';
import { clickPick, patchClickPick, screenToGround } from '../render/night.js';
import { MACH } from '../systems/machines.js';

// ---- late binding (boot binds after every module evaluates) --------
export let EXCH;
export function __late(b) { ({ EXCH } = b); }

// ======== section: 51_mining.js ========
// ====================================================================
// v2.52 — THE ORE EXCHANGE (on v2.48 MOTHERLODE · v2.50 HIRED
// HANDS). The ask: "Make resources that people can get from mining,
// and sell on a market." Ore no longer sells itself — it becomes a
// PHYSICAL RESOURCE STOCKPILE that trades on a market:
//   - every mine digs the RESOURCE its assay names (Iron, Copper,
//     Coal, Bauxite, Nickel, Lignite, Gypsum, Salt, Zinc, Tin,
//     Silver, Quartz) — tonne by tonne the crew's dig moves from the
//     claim's reserve into your shared stockpile (STATE.res), and NO
//     money arrives until you sell;
//   - each ore carries a PAR price $/t (the BASE table below); the
//     ORE EXCHANGE (53_exchange.js, the new ORE button in the bottom
//     bar) is the market that swings a daily multiplier around par
//     (±8%/game-day, clamped ×0.55–×1.70) — sell any or all of the
//     pile at today's price, hold for a better day, wages still come
//     due daily in CASH so a hoarding tycoon can lose the crew;
//   - NEW claims assay their ore at par (grade = BASE[ore]) and the
//     claim modal prices the reserve at today's exchange rate; older
//     saves migrate at boot — the mine's resource is read back from
//     its name and its grade is re-marked to par;
//   - the stockpile counts in WORTH at today's prices (via
//     EXCH.stockValue(), wired into RIVALS.playerWorth and the ticker
//     fallback), lists in the Empire panel with an EXCHANGE button,
//     and shows on the MINE panel and every mine's MANAGE modal;
//   - staking, guards, machinery placement, crews, wages, walk-offs,
//     worked-out release, pit terraces, rim workers and TELEPORT are
//     the v2.48/v2.50 mechanics, untouched below.
// Touchpoints outside this section (each annotated "v2.52"): the
// STATE/save/load `res` + `mkt` fields and the mines' `res` field,
// the WORTH ticker fallback + playerWorth, the ORE button + wiring,
// the help-modal lines, the What's-New modal, the attrib footer and
// the version surfaces. Every mining call is try/caught so a
// mistake here can never touch the world. window.MINE is the QA
// surface (BASE, resOf, priceOf, qaDay now stockpiles instead of
// earning).
// ====================================================================
export const MINE = (() => {
  const DAY = 90;                 // seconds per game day (the office/deed/acres beat)
  const SNAP = 10;                // claim corners snap to a 10 m grid
  const MIN_SIDE = 40, MAX_SIDE = 320;
  const SUB_R = 2400;             // quilt/suburb boundary — claims start past it
  const CLAIM_RATE = 4;           // $/m² of claim
  const DENS = .9;                // tonnes of ore per m² of claim
  const CAP_MAX = 14, MAX_MINES = 12;
  const SELL_BACK = .6;           // machinery resale (the property rate)
  const WAGE = 95;                // v2.50 HIRED HANDS: $/day per worker
  const MAX_CREW = 60;            // v2.50: crew cap per claim
  const INSET = 3;                // keep machines off the berm
  const CLEAR = .8;               // extra clearance between machine AABBs
  const STAGES = 6, BENCH = 8;      // the pit's terraces (rim rises 2.6 m per stage)
  const ORES = ['Iron', 'Copper', 'Coal', 'Bauxite', 'Nickel', 'Lignite', 'Gypsum', 'Salt', 'Zinc', 'Tin', 'Silver', 'Quartz'];
  const PITS = ['Pit', 'Quarry', 'Cut', 'Bank', 'Workings', 'Dig'];
  // v2.52 ORE EXCHANGE: every ore's PAR price $/t — the anchor the
  // market multiplier (53_exchange.js) swings around. New claims
  // assay their ore at par; the exchange pays par × the day's rate.
  const BASE = { Iron: 13, Copper: 22, Coal: 12, Bauxite: 15, Nickel: 24, Lignite: 12, Gypsum: 14, Salt: 16, Zinc: 19, Tin: 21, Silver: 26, Quartz: 17 };

  // ---- the machinery catalog ------------------------------------------
  // payback ~11-14 days at medium grade; the catch: the ore runs out.
  // v2.50: `ops` = operators a machine needs for its full t/day (a
  // short crew digs proportionally slower — people dig, not steel).
  const TYPES = [
    { key: 'loader', name: 'Wheel Loader', cost: 18000, tpd: 60, ops: 1, w: 3.4, d: 2.6, h: 2.4, body: 0xd9a13b, top: 0xf0c05a },
    { key: 'excavator', name: 'Track Excavator', cost: 42000, tpd: 180, ops: 2, w: 4.8, d: 2.9, h: 2.9, body: 0xc9772e, top: 0xe89a4f },
    { key: 'haul', name: 'Haul Truck', cost: 86000, tpd: 480, ops: 4, w: 6.6, d: 3.6, h: 3.1, body: 0x3d6fa8, top: 0xd9a13b },
    { key: 'drill', name: 'Rotary Drill', cost: 160000, tpd: 1100, ops: 6, w: 5.2, d: 3.2, h: 9.0, body: 0x8c5a2b, top: 0xb3773d },
    { key: 'bwe', name: 'Bucket-Wheel Excavator', cost: 520000, tpd: 4200, ops: 12, w: 12, d: 5, h: 6.5, body: 0xb34d4d, top: 0xd9a13b },
  ];

  let acc = 0;                    // income accumulator (1 s beat, like the acres)
  let root = null;                // WORLD.group swap detector (the FARM pattern)
  let lastPtr = null;             // {x, y} from pointermove (the ghosts follow it)
  let staking = null;             // { a: {x,z} | null } while staking a claim
  let placing = null;             // { m, t } while placing machinery
  const built = new Map();        // mine id -> { g, mach: [{g, bc}], stage, machN }

  // ---- little helpers --------------------------------------------------
  const isW = (x, z) => { try { return !!(LANDGEO.ready && LANDGEO.isWaterWorld(x, z)); } catch (e) { return false; } };
  function nearCity(x, z) {
    let best = 1e9;
    for (const c of CITIES) { const d = Math.hypot(x - c.wx, z - c.wz); if (d < best) best = d; }
    return best;
  }
  function nearestCity(x, z) {
    let best = null;
    for (const c of CITIES) { const d = Math.hypot(x - c.wx, z - c.wz); if (!best || d < best.d) best = { c, d }; }
    return best;
  }
  const mines = () => (STATE.mines || []);
  // v2.52 ORE EXCHANGE: the RESOURCE a claim digs (its ore type —
  // older saves read it back from the mine's own name) and what a
  // tonne trades for right now (par × the day's market rate; falls
  // back to the claim's own grade before the exchange boots)
  const resOf = m => m.res || String(m.name || 'Ore').split(' ')[0];
  const priceOfRes = r => { try { return window.EXCH ? +EXCH.price(r) : (BASE[r] || 14); } catch (er) { return BASE[r] || 14; } };
  const priceOf = m => priceOfRes(resOf(m));
  // v2.50 HIRED HANDS — the crew math. capTpd is what the installed
  // machinery COULD dig fully crewed; digTpd is what today's crew
  // actually moves (a short staff digs proportionally slower);
  // working() is a claim with machines, workers and ore all present.
  const crewOf = m => Math.max(0, m.crew | 0);
  const opsOf = m => (m.machines || []).reduce((s, x) => s + (TYPES[x.t] ? TYPES[x.t].ops : 0), 0);
  const capTpd = m => (m.machines || []).reduce((s, x) => s + (TYPES[x.t] ? TYPES[x.t].tpd : 0), 0);
  const digTpd = m => { const ops = opsOf(m); return ops ? capTpd(m) * Math.min(1, crewOf(m) / ops) : 0; };
  const working = m => !!(m.machines || []).length && crewOf(m) > 0 && m.got < m.ore;
  const wageOfDay = m => working(m) ? crewOf(m) * WAGE : 0;
  const incOfDay = m => working(m) ? digTpd(m) * priceOf(m) - crewOf(m) * WAGE : 0;   // v2.52: NET of wages at today's exchange prices — the money itself lands when the ore is SOLD
  const signedNet = n => (n >= 0 ? '+' : '-') + fmt$(Math.abs(n));
  const stageOf = m => (m.ore > 0 ? Math.min(STAGES, Math.floor(STAGES * m.got / m.ore)) : 0);
  const rimOf = m => 1.4 + stageOf(m) * 2.6;    // the dump rim rises as the pit is dug
  // the pit's footprint — 62% of the claim on big claims, but always
  // leaving a >= 13 m machinery ring on every side (a 40 m claim keeps
  // a 14 m shaft with a 13 m ring around it)
  const pitW = m => Math.max(14, Math.min(m.w * .62, m.w - 26));
  const pitD = m => Math.max(14, Math.min(m.d * .62, m.d - 26));
  const capOf = m => {
    const ring = m.w * m.d - pitW(m) * pitD(m);
    return Math.min(CAP_MAX, Math.max(2, Math.floor(ring / 700)));
  };
  const valueOf = () => mines().reduce((s, m) =>
    s + (m.price || 0) + (m.machines || []).reduce((t, x) => t + (TYPES[x.t] ? TYPES[x.t].cost : 0), 0), 0);
  function mineAt(x, z) {
    for (const m of mines())
      if (Math.abs(x - m.x) <= m.w / 2 + 2 && Math.abs(z - m.z) <= m.d / 2 + 2) return m;
    return null;
  }
  const gradeLabel = g => g >= 21 ? 'HIGH-GRADE' : g >= 16 ? 'MEDIUM' : 'LOW-GRADE';
  const statusShort = m => m.got >= m.ore ? 'worked out'
    : !(m.machines || []).length ? 'no machinery yet'
    : m.walked ? 'crew walked off'
    : crewOf(m) ? signedNet(incOfDay(m)) + '/day net at the exchange · crew ' + crewOf(m)
    : 'no crew — idle';

  // ---- the claim guards --------------------------------------------------
  function validateClaim(x0, z0, x1, z1) {
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (Math.min(w, d) < MIN_SIDE) return { ok: false, why: 'small' };
    if (Math.max(w, d) > MAX_SIDE) return { ok: false, why: 'big' };
    if (nearCity(cx, cz) < SUB_R + Math.hypot(w, d) / 2) return { ok: false, why: 'city' };
    const pts = [[cx, cz], [x0, z0], [x1, z0], [x0, z1], [x1, z1],
      [(x0 + x1) / 2, z0], [(x0 + x1) / 2, z1], [x0, (z0 + z1) / 2], [x1, (z0 + z1) / 2]];
    for (const [x, z] of pts) if (isW(x, z)) return { ok: false, why: 'water' };
    try {
      for (const [x, z] of pts)
        if (WORLD.nearRoad && WORLD.nearRoad(x, z, 16)) return { ok: false, why: 'road' };
    } catch (e) { }
    try {
      for (const [x, z] of pts)
        if ((CITY.plotAt && CITY.plotAt(x, z)) || (WORLD.plotAt && WORLD.plotAt(x, z))) return { ok: false, why: 'plot' };
    } catch (e) { }
    for (const a of (STATE.acres || []))
      if (a.x > x0 - 120 && a.x < x1 + 120 && a.z > z0 - 120 && a.z < z1 + 120) return { ok: false, why: 'farm', name: a.name };
    for (const m of mines())
      if (Math.abs(m.x - cx) < (m.w + w) / 2 + 20 && Math.abs(m.z - cz) < (m.d + d) / 2 + 20) return { ok: false, why: 'mine', name: m.name };
    return { ok: true };
  }
  const whyText = v => ({
    small: 'Too small — a claim needs at least ' + MIN_SIDE + ' m on a side.',
    big: 'Too big — keep claims to ' + MAX_SIDE + ' m on a side.',
    city: 'Too close to a city — stake claims out in the open country, past the suburbs.',
    water: 'That ground is not dry land — a claim needs solid ground at every corner.',
    road: 'A road runs through there — stake the claim clear of the roads.',
    plot: 'A vending plot stands there — stake the claim clear of the plots.',
    farm: (v.name ? 'Your ' + v.name + ' is in the way' : 'Your farmland is in the way') + ' — stake the claim clear of your fields.',
    mine: (v.name ? v.name : 'Another mine') + ' is too close — give each mine its own ground.',
  })[v.why] || 'That claim will not validate.';

  // ---- the 3D builders (mine-local frame, float32-safe at 1:1) ---------
  const wcol = h => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
  const DIRT = wcol(0x8a6f4d), DIRT2 = wcol(0x6f5a3a), EDGE = wcol(0x4a3a26),
    TERR = [wcol(0x8a6f4d), wcol(0x59462b)], FLOOR = wcol(0x3c2f1c),
    BERM = wcol(0x8f7452), SPOIL = 0xa98a5e, ORE = 0x2e2418,
    POST = 0x6e5138, BOARD = 0xf5cc74, INK = 0x4a3a28;

  function buildStatic(m) {
    const B = { pos: [], norm: [], col: [] };
    const quad = (x0, z0, x1, z1, y, c) => {
      B.pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
      for (let i = 0; i < 6; i++) { B.norm.push(0, 1, 0); B.col.push(c[0], c[1], c[2]); }
    };
    // a vertical wall between two ground points; the normal points at
    // the pit's centre so the terrace faces read lit from above
    const wall = (x0, z0, x1, z1, y0, y1, c) => {
      const ex = x1 - x0, ez = z1 - z0;
      let nx = -ez, nz = ex; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      if (nx * (-(x0 + x1) / 2) + nz * (-(z0 + z1) / 2) < 0) { nx = -nx; nz = -nz; }
      B.pos.push(x0, y0, z0, x0, y1, z0, x1, y1, z1, x0, y0, z0, x1, y1, z1, x1, y0, z1);
      for (let i = 0; i < 6; i++) { B.norm.push(nx, 0, nz); B.col.push(c[0], c[1], c[2]); }
    };
    const hw = m.w / 2, hd = m.d / 2;
    const pw = pitW(m), pd = pitD(m);
    const phw = pw / 2, phd = pd / 2;
    const stage = stageOf(m);
    // THE RIM MODEL: this world's ground is one flat plane, so a pit is
    // carved as a raised dump ring — the spoil lifts the rim bench the
    // machines ride, and the benches step DOWN from it to the ore face
    // (every vertex stays above the world ground plane, where the
    // flat-ground ladder can never swallow it)
    const ringY = 1.4 + stage * 2.6;
    if (stage === 0) {
      quad(-hw, -hd, hw, hd, ringY, DIRT);              // the graded claim (a low dirt platform)
      quad(-phw, -phd, phw, phd, ringY + .006, DIRT2);   // the marked pit area
    } else {
      // the ring — the rim bench the machinery works from
      quad(-hw, -hd, hw, -phd, ringY, DIRT);
      quad(-hw, phd, hw, hd, ringY, DIRT);
      quad(-hw, -phd, -phw, phd, ringY, DIRT);
      quad(phw, -phd, hw, phd, ringY, DIRT);
      // the benches — ANNULAR TREADS (a full-rect quad would hide every
      // bench below it from above, flattening the pit into one stain):
      // each step is the ring between the previous rect and this one,
      // with a vertical riser on the previous rect's perimeter
      const BH = (ringY - .5) / stage;                  // even steps down to the floor
      let ax0 = -phw, ax1 = phw, az0 = -phd, az1 = phd, ay = ringY;
      let cut = false;
      for (let i = 1; i <= stage; i++) {
        const y = ringY - i * BH;
        const ins = Math.min(i * BENCH, Math.max(0, Math.min(pw, pd) / 2 - 7));
        const bx0 = -phw + ins, bx1 = phw - ins, bz0 = -phd + ins, bz1 = phd - ins;
        if (bx1 - bx0 < 5 || bz1 - bz0 < 5) { cut = true; break; }   // small claims: a shaft, the innermost rect is the floor
        // the tread ring at this level (four band quads, exact tiling)
        quad(ax0, az0, ax1, bz0, y, TERR[i % 2]);
        quad(ax0, bz1, ax1, az1, y, TERR[i % 2]);
        quad(ax0, bz0, bx0, bz1, y, TERR[i % 2]);
        quad(bx1, bz0, ax1, bz1, y, TERR[i % 2]);
        // the riser — the vertical face on the previous rect's perimeter
        wall(ax0, az0, ax1, az0, ay, y, EDGE);
        wall(ax0, az1, ax1, az1, ay, y, EDGE);
        wall(ax0, az0, ax0, az1, ay, y, EDGE);
        wall(ax1, az0, ax1, az1, ay, y, EDGE);
        ax0 = bx0; ax1 = bx1; az0 = bz0; az1 = bz1; ay = y;
      }
      if (!cut) quad(ax0, az0, ax1, az1, ay - .06, FLOOR);   // the ore face at the bottom
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(B.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.renderOrder = 1.82;   // v2.48 flat-ground ladder: above the quilt (1.8), under the ponds
    mesh.receiveShadow = true;
    const grp = new THREE.Group();
    grp.add(mesh);

    // the rim wall — the dump ring around the claim, rising with every
    // terrace dug (it starts as the low stage-0 berm)
    const bermW = 2.4;
    const mkBox = (w, h, d, x, y, z, colr) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: colr }));
      b.position.set(x, y, z); b.castShadow = true; b.receiveShadow = true; grp.add(b); return b;
    };
    mkBox(m.w - 4, ringY, bermW, 0, ringY / 2, -hd + bermW / 2, BERM);
    mkBox(m.w - 4, ringY, bermW, 0, ringY / 2, hd - bermW / 2, BERM);
    mkBox(bermW, ringY, m.d - 4, -hw + bermW / 2, ringY / 2, 0, BERM);
    mkBox(bermW, ringY, m.d - 4, hw - bermW / 2, ringY / 2, 0, BERM);

    // spoil heaps grow on the rim corners as the pit deepens
    if (stage > 0) {
      const H = 3.5 + stage * 3, R = Math.min(7 + stage * 2.8, Math.min(m.w, m.d) * .3);
      for (const [sx, sz] of [[-hw + 12, -hd + 12], [hw - 12, hd - 12]]) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(R, H, 8), new THREE.MeshLambertMaterial({ color: SPOIL }));
        cone.position.set(sx, ringY + H / 2, sz); cone.castShadow = true;
        grp.add(cone);
      }
    }

    // a dark ORE SPOT at the pit floor — the seam being worked
    if (stage > 0) {
      const fy = Math.max(.45, ringY - stage * ((ringY - .5) / stage));
      mkBox(5, 1.6, 5, 0, fy + .8, 0, ORE);
      mkBox(3, 1.1, 3, 1.5, fy + .55, -1.5, ORE);
    }

    // the claim sign — a gold MINE board just outside the south rim,
    // where it stands clear against the green ground
    const sx = 0, sz = hd + 2.6;
    mkBox(.16, 3.2, .16, sx, 1.6, sz, POST);
    const board = mkBox(2.8, 1.2, .1, sx, 2.7, sz, BOARD);
    board.castShadow = false;
    mkBox(2.1, .2, .12, sx, 2.78, sz, INK);
    mkBox(1.6, .12, .12, sx, 2.45, sz, INK);
    return grp;
  }

  // ---- the machinery props --------------------------------------------
  function buildMachine(t) {
    const T = TYPES[t] || TYPES[0];
    const g = new THREE.Group();
    const lam = h => new THREE.MeshLambertMaterial({ color: h });
    const add = (w, hh, d, x, y, z, mat) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
      b.position.set(x, y, z); b.castShadow = true; g.add(b); return b;
    };
    const dark = lam(0x2b313c), body = lam(T.body), accent = lam(T.top), glass = lam(0xbfd8e6);
    add(T.w * .92, .5, T.d * .62, 0, .3, 0, dark);                    // undercarriage
    add(T.w * .8, T.h * .4, T.d, 0, .5 + T.h * .2, 0, body);          // main body
    add(1.15, 1.05, 1.15, T.w * .2, .5 + T.h * .4 + .55, T.d * .16, glass);   // cab
    if (t === 0) add(T.w * .55, .8, 1.05, T.w * .44, .55, 0, accent);         // loader bucket
    if (t === 1) {                                                    // excavator boom + scoop
      const boom = add(.55, .55, 3.2, T.w * .22, 1.85, -T.d * .95, accent);
      boom.rotation.x = -.55;
      add(1.05, .75, 1.15, T.w * .22, 1.0, -T.d * 1.85, dark);
    }
    if (t === 2) {                                                    // haul bed (tipped)
      const bed = add(T.w * .92, .95, T.d * .95, -T.w * .12, 1.95, .15, accent);
      bed.rotation.x = .16;
    }
    if (t === 3) {                                                    // drill mast + platform
      add(.7, 7.4, .7, 0, .5 + T.h * .4 + 3.7, -T.d * .28, dark);
      add(1.7, .35, 1.7, 0, .5 + T.h * .4 + .2, -T.d * .28, accent);
    }
    if (t === 4) {                                                    // bucket wheel + discharge
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, .55, 10), accent);
      wheel.rotation.z = Math.PI / 2; wheel.position.set(T.w * .4, 2.2, 0); wheel.castShadow = true;
      g.add(wheel);
      add(.8, .8, T.w * 1.05, -T.w * .16, 2.5, 0, dark);
    }
    // the beacon — blinks while the CREW is digging (v2.50: ore alone
    // isn't enough — people run the machines)
    const bc = new THREE.Mesh(new THREE.BoxGeometry(.2, .15, .2), new THREE.MeshBasicMaterial({ color: 0xffa53c }));
    bc.position.set(T.w * .2, .5 + T.h * .4 + 1.15, T.d * .16);
    g.add(bc); g.userData.beacon = bc;
    return g;
  }

  // ---- the workers (v2.50 HIRED HANDS) --------------------------------
  // a hi-vis chibi: orange coveralls, silver stripe, hard hat. They
  // stand around the pit rim while the crew digs and bob as they work.
  function buildWorker() {
    const g = new THREE.Group();
    const lam = h => new THREE.MeshLambertMaterial({ color: h });
    const body = new THREE.Mesh(new THREE.BoxGeometry(.55, .8, .34), lam(0xff8c1a));
    body.position.y = .62; body.castShadow = true; g.add(body);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(.58, .2, .37), lam(0xf2ede1));
    stripe.position.y = .8; g.add(stripe);
    const head = new THREE.Mesh(new THREE.SphereGeometry(.19, 8, 6), lam(0xd9a06b));
    head.position.y = 1.17; g.add(head);
    const hat = new THREE.Mesh(new THREE.SphereGeometry(.22, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), lam(0xf2ede1));
    hat.position.y = 1.19; hat.castShadow = true; g.add(hat);
    return g;
  }
  // spread up to ten workers around the pit perimeter, pushed out onto
  // the ring until they stand clear of the machinery
  function workerSpots(m, wn) {
    const phw = pitW(m) / 2, phd = pitD(m) / 2;
    const out = [];
    for (let i = 0; i < wn; i++) {
      const t = ((i + .5) / wn) * 4;     // 0..4 around the rectangle
      let x, z, nx = 0, nz = 0;
      if (t < 1) { x = -phw + 2 * phw * t; z = -phd; nz = -1; }
      else if (t < 2) { x = phw; z = -phd + 2 * phd * (t - 1); nx = 1; }
      else if (t < 3) { x = phw - 2 * phw * (t - 2); z = phd; nz = 1; }
      else { x = -phw; z = phd - 2 * phd * (t - 3); nx = -1; }
      let sx = x, sz = z;
      for (const off of [2.6, 5.6, 8.6, 11.6]) {
        const cx = x + nx * off, cz = z + nz * off;
        let hit = false;
        for (const o of (m.machines || [])) {
          const T2 = TYPES[o.t] || TYPES[0];
          if (Math.abs(cx - o.x) < T2.w / 2 + .9 && Math.abs(cz - o.z) < T2.d / 2 + .9) { hit = true; break; }
        }
        sx = cx; sz = cz;
        if (!hit) break;
      }
      out.push({ x: sx, z: sz, ph: i * 1.7 });
    }
    return out;
  }

  // ---- the mesh manager -------------------------------------------------
  function disposeOne(id) {
    const e = built.get(id);
    if (e) {
      try {
        if (e.g.parent) e.g.parent.remove(e.g);
        e.g.traverse(o => { if (o.geometry) { try { o.geometry.dispose(); } catch (er) { } } });
      } catch (er) { }
      built.delete(id);
    }
  }
  function ensureOne(id) {
    const m = mines().find(x => x.id === id);
    if (!m || !root) { disposeOne(id); return; }
    const st = stageOf(m), n = (m.machines || []).length;
    const wn = Math.min(crewOf(m), 10);   // v2.50: up to ten workers stand the rim
    const e = built.get(id);
    if (e && e.stage === st && e.machN === n && e.crewN === wn) return;
    disposeOne(id);
    const grp = buildStatic(m);
    const mach = [];
    const ringY = 1.4 + stageOf(m) * 2.6;
    for (const mm of (m.machines || [])) {
      const g = buildMachine(mm.t);
      g.position.set(mm.x, ringY + .02, mm.z);
      grp.add(g);
      mach.push({ g, bc: g.userData.beacon });
    }
    const wrk = [];
    if (wn > 0 && m.got < m.ore)
      for (const s of workerSpots(m, wn)) {
        const w = buildWorker();
        w.position.set(s.x, ringY + .02, s.z);
        w.rotation.y = Math.atan2(-s.x, -s.z);   // face the pit
        w.userData.y0 = w.position.y; w.userData.ph = s.ph;
        w.visible = working(m);
        grp.add(w); wrk.push(w);
      }
    grp.position.set(m.x, 0, m.z);   // mine-local frame (the FARM convention)
    try { root.add(grp); } catch (er) { return; }
    built.set(id, { g: grp, mach, wrk, stage: st, machN: n, crewN: wn });
  }
  function ensureAll() { for (const m of mines()) ensureOne(m.id); }
  function disposeAll() { for (const id of [...built.keys()]) disposeOne(id); }

  // ---- the bars + ghosts -------------------------------------------------
  try {
    const st = document.createElement('style');
    st.textContent = [
      '#mn-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px',
      ' background:var(--panel2);border:1px solid rgba(245,204,116,.4);border-radius:10px;padding:8px 12px;font-size:12px;',
      ' color:var(--txt);box-shadow:0 8px 26px rgba(0,0,0,.55);white-space:nowrap;max-width:92vw;overflow:hidden}',
      '#mn-bar.hidden{display:none}',
      '#mn-bar b{color:#f5cc74}',
      '#mn-bar .mn-x{flex:none;padding:5px 12px;border-radius:7px;background:rgba(245,204,116,.16);color:#f5cc74;font-weight:700;cursor:pointer}',
      '#mn-bar .mn-x:hover{background:rgba(245,204,116,.3)}',
      '#myard{display:flex;flex-direction:column;gap:6px;margin-top:10px}',
      '.myard-card{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09)}',
      '.myard-card.dim{opacity:.45}',
      '.myard-info{display:flex;flex-direction:column;gap:2px;font-size:12px}',
      '.myard-info span{color:var(--mut);font-size:10.5px}',
      '.myard-buy{display:flex;align-items:center;gap:8px;flex:none}',
      '.myard-buy span{font-weight:700;font-size:12px}',
      '.myard-buy .btn{padding:6px 12px;font-size:11px;margin:0}',
      '.mn-prog{height:9px;border-radius:5px;background:rgba(255,255,255,.09);overflow:hidden;margin-top:5px}',
      '.mn-prog i{display:block;height:100%;background:linear-gradient(90deg,#d9a13b,#f5cc74)}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }
  function bar(msg, btnLabel, onBtn) {
    let bar = document.getElementById('mn-bar');
    if (!bar) { try { bar = document.createElement('div'); bar.id = 'mn-bar'; document.body.appendChild(bar); } catch (er) { return; } }
    bar.innerHTML = '<span>' + msg + '</span>' + (btnLabel ? '<span class="mn-x" id="mn-bx">' + btnLabel + '</span>' : '');
    bar.classList.remove('hidden');
    const b = bar.querySelector('#mn-bx');
    if (b) b.onclick = onBtn;
  }
  function hideBar() { const b = document.getElementById('mn-bar'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; } }

  // the claim-staking ghost: a live gold rectangle between the clicks
  let stakeGhost = null, stakeLine = null;
  function ensureStakeGhost() {
    if (stakeGhost && stakeGhost.parent === root) return;
    killStakeGhost();
    if (!root) return;
    try {
      const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
      stakeGhost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf5cc74, transparent: true, opacity: .22, depthWrite: false, side: THREE.DoubleSide }));
      stakeGhost.renderOrder = 3; stakeGhost.visible = false;
      const lg = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-.5, 0, -.5), new THREE.Vector3(.5, 0, -.5), new THREE.Vector3(.5, 0, .5),
        new THREE.Vector3(-.5, 0, .5), new THREE.Vector3(-.5, 0, -.5)]);
      stakeLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xf5cc74 }));
      stakeLine.renderOrder = 3; stakeLine.visible = false;
      root.add(stakeGhost); root.add(stakeLine);
    } catch (er) { }
  }
  function killStakeGhost() {
    for (const o of [stakeGhost, stakeLine]) {
      try { if (o && o.parent) o.parent.remove(o); if (o) o.geometry.dispose(); } catch (er) { }
    }
    stakeGhost = null; stakeLine = null;
  }
  function updateStakeGhost() {
    if (!staking || !lastPtr || !root) return;
    ensureStakeGhost();
    if (!stakeGhost) return;
    const pt = screenToGround(lastPtr.x, lastPtr.y);
    if (!pt) return;
    const bx = Math.round(pt.x / SNAP) * SNAP, bz = Math.round(pt.z / SNAP) * SNAP;
    if (!staking.a) {   // corner marker: a small square under the cursor
      stakeGhost.visible = true;
      stakeGhost.scale.set(SNAP, 1, SNAP);
      stakeGhost.position.set(bx, .05, bz);
      if (stakeLine) stakeLine.visible = false;
      return;
    }
    const x0 = Math.min(staking.a.x, bx), x1 = Math.max(staking.a.x, bx);
    const z0 = Math.min(staking.a.z, bz), z1 = Math.max(staking.a.z, bz);
    stakeGhost.visible = true;
    stakeGhost.scale.set(Math.max(x1 - x0, 1), 1, Math.max(z1 - z0, 1));
    stakeGhost.position.set((x0 + x1) / 2, .05, (z0 + z1) / 2);
    if (stakeLine) {
      stakeLine.visible = true;
      stakeLine.scale.copy(stakeGhost.scale);
      stakeLine.position.copy(stakeGhost.position);
    }
  }

  // the machinery ghost: green where it fits, red where it doesn't
  let machGhost = null, machMat = null, machT = -1;
  function ensureMachGhost() {
    if (machGhost && machT === placing.t) return;
    killMachGhost();
    const T = TYPES[placing.t];
    machMat = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: .4, depthWrite: false });
    machGhost = new THREE.Mesh(new THREE.BoxGeometry(T.w, T.h, T.d), machMat);
    machGhost.renderOrder = 3;
    machT = placing.t;
    try { if (root) root.add(machGhost); } catch (er) { }
  }
  function killMachGhost() {
    try { if (machGhost && machGhost.parent) machGhost.parent.remove(machGhost); if (machGhost) machGhost.geometry.dispose(); if (machMat) machMat.dispose(); } catch (er) { }
    machGhost = null; machMat = null; machT = -1;
  }
  function updateMachGhost() {
    if (!placing || !lastPtr || !root) return;
    ensureMachGhost();
    if (!machGhost) return;
    const pt = screenToGround(lastPtr.x, lastPtr.y);
    if (!pt) { machGhost.visible = false; return; }
    const lx = pt.x - placing.m.x, lz = pt.z - placing.m.z;
    const v = validSpot(lx, lz, placing.m, placing.t);
    machGhost.visible = true;
    machGhost.position.set(pt.x, 1.4 + stageOf(placing.m) * 2.6 + .04 + TYPES[placing.t].h / 2, pt.z);
    if (machMat) machMat.color.setHex(v.ok ? 0x4dff88 : 0xff5470);
  }

  // ---- staking a claim ----------------------------------------------------
  function armStake() {
    if (STATE.mode !== 'city' || !WORLD.group) { toast('Enter the world first — mining needs ground under your boots.'); return; }
    if (mines().length >= MAX_MINES) { toast('<b>Mining cap reached</b> (' + MAX_MINES + ' claims). Close a mine first.', 'warn'); return; }
    try { closeModal(); } catch (er) { }
    staking = { a: null };
    bar('CLAIM STAKING — <b>click the first corner</b> of your mine', 'CANCEL', () => exitStake(false));
    toast('Click the <b>first corner</b> of your claim — any rectangle of open country will do.', 'warn');
  }
  function exitStake(done) {
    staking = null;
    killStakeGhost();
    hideBar();
    if (done) try { toast('Claim staking finished.', 'warn'); } catch (er) { }
  }
  function stakeClick(x, z) {
    const sx = Math.round(x / SNAP) * SNAP, sz = Math.round(z / SNAP) * SNAP;
    if (!staking.a) {
      staking.a = { x: sx, z: sz };
      bar('CLAIM STAKING — now <b>click the opposite corner</b> (' + MIN_SIDE + '–' + MAX_SIDE + ' m sides)', 'CANCEL', () => exitStake(false));
      return;
    }
    const x0 = Math.min(staking.a.x, sx), x1 = Math.max(staking.a.x, sx);
    const z0 = Math.min(staking.a.z, sz), z1 = Math.max(staking.a.z, sz);
    const v = validateClaim(x0, z0, x1, z1);
    if (!v.ok) { toast('<b>' + whyText(v) + '</b> Pick the opposite corner again — the first corner stays put.', 'warn'); return; }
    confirmClaim({ x0, z0, x1, z1, w: x1 - x0, d: z1 - z0 });
  }
  function confirmClaim(R) {
    bar('CLAIM READY — <b>' + Math.round(R.w) + ' × ' + Math.round(R.d) + ' m</b> · review the assay, then stake it', 'CANCEL', () => { exitStake(false); try { closeModal(); } catch (er) { } });
    const area = R.w * R.d;
    const id = 'm' + Math.round((R.x0 + R.x1) / 2) + '_' + Math.round((R.z0 + R.z1) / 2);
    const h = hashStr(id + 'ore'), h3 = hashStr(id + 'n');
    const oreName = ORES[h % ORES.length];
    const grade = BASE[oreName] || 14;                     // v2.52: claims assay their ore at PAR — the exchange market swings around it
    const ore = Math.round(area * DENS);
    const price = Math.round(area * CLAIM_RATE / 100) * 100;
    const name = oreName + ' ' + PITS[h3 % PITS.length];
    const nc = nearestCity((R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2);
    const px = Math.round(priceOfRes(oreName) * 10) / 10;    // today's exchange price $/t
    openModal('Stake this claim?', `
      <p>A <b>${Math.round(R.w)} × ${Math.round(R.d)} m</b> rectangle of open country${nc && nc.d < 120000 ? ' out past <b>' + nc.c.name + '</b>' : ''}. The assay says what's under the grass:</p>
      <div class="kv"><span class="k">ASSAY</span><span class="v">${name.toUpperCase()} · ${gradeLabel(grade)} · par $${grade}/t</span></div>
      <div class="kv"><span class="k">RESERVE</span><span class="v">${ore.toLocaleString('en-US')} tonnes of ${oreName.toLowerCase()} resource</span></div>
      <div class="kv"><span class="k">GROSS VALUE</span><span class="v g">${fmt$(ore * px)} at today's exchange price ($${px}/t)</span></div>
      <div class="kv"><span class="k">CLAIM PRICE</span><span class="v g">${fmt$(price)}</span></div>
      <div class="kv"><span class="k">BALANCE</span><span class="v">${fmt$(STATE.money)}</span></div>
      <div class="kv" style="margin-top:6px"><span class="k">NEXT</span><span class="v">Buy machinery for its ring, then hire the crew that digs — the ore stacks up in your stockpile and sells on the ORE exchange; wages are paid daily in cash</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn good" id="mc-go" style="flex:1">STAKE THE CLAIM — ${fmt$(price)}</button>
        <button class="btn" id="mc-x">CANCEL</button>
      </div>`);
    document.getElementById('mc-go').onclick = () => {
      if (mines().length >= MAX_MINES) { toast('<b>Mining cap reached</b> (' + MAX_MINES + ' claims).', 'warn'); return; }
      if (!spend(price)) { toast('<b>Not enough money.</b> This claim costs ' + fmt$(price) + '.', 'warn'); return; }
      const m = {
        id, name, x: (R.x0 + R.x1) / 2, z: (R.z0 + R.z1) / 2, w: R.w, d: R.d,
        price, grade, ore, got: 0, machines: [], res: oreName,
        near: nc && nc.d < 120000 ? nc.c.name : null, nearKey: nc ? nc.c.key : null,
      };
      STATE.mines.push(m);
      try { saveGame(); } catch (er) { }
      exitStake(false);
      ensureOne(id);
      closeModal();
      toast('⛏ <b>' + name + ' is yours.</b> Now buy machinery — and hire the crew that digs it out. The ore stacks up for the ORE exchange.');
      openShop(m);
    };
    document.getElementById('mc-x').onclick = () => { closeModal(); exitStake(false); };
  }

  // ---- machinery placement --------------------------------------------------
  function validSpot(lx, lz, m, t) {
    const T = TYPES[t];
    const hw = m.w / 2 - INSET - T.w / 2, hd = m.d / 2 - INSET - T.d / 2;
    if (hw < 0 || hd < 0 || Math.abs(lx) > hw || Math.abs(lz) > hd) return { ok: false, why: 'berm' };
    const phw = pitW(m) / 2 + T.w / 2 + .6;
    const phd = pitD(m) / 2 + T.d / 2 + .6;
    if (Math.abs(lx) < phw && Math.abs(lz) < phd) return { ok: false, why: 'pit' };
    for (const o of (m.machines || [])) {
      const T2 = TYPES[o.t] || TYPES[0];
      if (Math.abs(o.x - lx) < (T.w + T2.w) / 2 + CLEAR && Math.abs(o.z - lz) < (T.d + T2.d) / 2 + CLEAR)
        return { ok: false, why: 'clear' };
    }
    return { ok: true };
  }
  function startPlacing(m, t) {
    placing = { m, t };
    try { closeModal(); } catch (er) { }
    const T = TYPES[t], n = (m.machines || []).length;
    bar('PLACING <b>' + T.name.toUpperCase() + '</b> on <b>' + m.name + '</b> · ' + fmt$(T.cost) + ' each · ' + (n + 1) + '/' + capOf(m) + ' · <span style="color:var(--mut)">' + fmt$(STATE.money) + '</span>', 'DONE', () => exitPlacing(true));
    toast('Click a spot on the <b>claim\u2019s dirt ring</b> to set the ' + T.name + ' down. ESC or DONE to finish.', 'warn');
  }
  function exitPlacing(reopen) {
    const m = placing ? placing.m : null;
    placing = null;
    killMachGhost();
    hideBar();
    if (reopen && m) { try { openShop(m); } catch (er) { } }
  }
  function placeAt(x, z) {
    const m = placing.m, T = TYPES[placing.t];
    const lx = +(x - m.x).toFixed(1), lz = +(z - m.z).toFixed(1);
    const v = validSpot(lx, lz, m, placing.t);
    if (!v.ok) {
      toast(v.why === 'pit' ? '<b>That spot is over the pit.</b> Set machinery on the dirt ring around it.'
        : v.why === 'clear' ? '<b>Too close to another machine.</b>'
        : '<b>Too close to the berm.</b> Keep machinery inside the claim.', 'warn');
      return;
    }
    if ((m.machines || []).length >= capOf(m)) { toast('<b>' + m.name + ' is full</b> (' + capOf(m) + ' machines on its ring).', 'warn'); exitPlacing(true); return; }
    if (!spend(T.cost)) { toast('<b>Not enough money.</b> The ' + T.name + ' costs ' + fmt$(T.cost) + '.', 'warn'); exitPlacing(false); return; }
    (m.machines || (m.machines = [])).push({ t: placing.t, x: lx, z: lz });
    try { saveGame(); } catch (er) { }
    ensureOne(m.id);
    const n = (m.machines || []).length;
    if (!crewOf(m) && n >= 1)
      try { toast(' Machinery set down. <b>Now hire a crew</b> — nothing digs until workers do.', 'warn'); } catch (er) { }
    bar('PLACING <b>' + T.name.toUpperCase() + '</b> on <b>' + m.name + '</b> · ' + fmt$(T.cost) + ' each · ' + (n + 1) + '/' + capOf(m) + ' · <span style="color:var(--mut)">' + fmt$(STATE.money) + '</span>', 'DONE', () => exitPlacing(true));
    if (n >= capOf(m) || STATE.money < T.cost) exitPlacing(true);
  }

  // ---- the crew (v2.50 HIRED HANDS) --------------------------------------
  // hire / lay off from the yard or the MANAGE modal; dug rates scale
  // with staffing and wages are due every game day (see tick)
  function setCrew(m, n) {
    n = Math.max(0, Math.min(n, MAX_CREW));
    const ops = opsOf(m);
    if (n > ops) n = ops;                      // no idle hires past full staffing
    m.crew = n;
    if (n > 0) { m.walked = false; m.wageAcc = 0; }   // a fresh hire starts a fresh payroll
    try { saveGame(); } catch (er) { }
    ensureOne(m.id);
    return n;
  }
  function crewBlock(m, withHead) {
    const ops = opsOf(m), crew = crewOf(m), done = m.got >= m.ore;
    const short = Math.max(0, ops - crew);
    const rate = ops ? Math.round(100 * Math.min(1, crew / ops)) : 0;
    let s = withHead ? '<div class="msec" style="margin-top:12px">The crew — workers dig, not steel</div>' : '';
    s += '<div class="kv"><span class="k">CREW</span><span class="v">' + (done ? 'released — the ore is gone'
      : !ops ? 'nothing to crew yet — set machinery down first'
      : crew + ' worker' + (crew === 1 ? '' : 's') + ' · full staffing ' + ops
        + (short ? ' · <b style="color:#f5cc74">' + short + ' SHORT</b>' : ' · fully staffed')) + '</span></div>';
    s += '<div class="kv"><span class="k">DIG RATE</span><span class="v">' + (done ? '0 t/day'
      : ops ? digTpd(m).toLocaleString('en-US') + ' of ' + capTpd(m).toLocaleString('en-US') + ' t/day (' + rate + '% rate)'
        : '0 t/day') + '</span></div>';
    s += '<div class="kv"><span class="k">WAGES</span><span class="v">' + (crew && !done ? fmt$(crew * WAGE) + '/day at ' + fmt$(WAGE) + ' each' : '$0/day') + '</span></div>';
    if (ops && !done) {
      s += '<div class="kv"><span class="k">NET</span><span class="v g">' + signedNet(incOfDay(m)) + '/day at today\u2019s exchange — wages included</span></div>';
      s += '<div style="display:flex;gap:8px;margin-top:8px">'
        + '<button class="btn primary" data-ch="1" style="flex:1">+ HIRE 1</button>'
        + '<button class="btn primary" data-ch="5" style="flex:1">+ HIRE 5</button>'
        + '<button class="btn good" data-ch="full" style="flex:1">FULL CREW (' + ops + ')</button>'
        + '<button class="btn" data-ch="0" style="flex:none">LAY OFF ALL</button></div>';
      if (short) s += '<p style="margin-top:6px">A short crew digs slower — ' + short + ' more worker' + (short === 1 ? '' : 's') + ' would run the ring at full rate.</p>';
    }
    return s;
  }
  function wireCrew(rootSel, m) {
    document.querySelectorAll(rootSel + ' [data-ch]').forEach(b => {
      b.onclick = () => {
        const v = b.dataset.ch;
        const before = crewOf(m);
        let n = v === 'full' ? opsOf(m) : v === '0' ? 0 : before + +v;
        if (v !== '0' && v !== 'full' && n > opsOf(m)) n = opsOf(m);
        if (v !== '0' && n <= before) { toast('<b>Fully staffed</b> — ' + opsOf(m) + ' workers run every machine here.', 'warn'); return; }
        setCrew(m, n);
        const after = crewOf(m);
        if (after > before) toast('👷 <b>' + (after - before) + ' worker' + (after - before === 1 ? '' : 's') + ' hired.</b> The dig is on — wages ' + fmt$(after * WAGE) + '/day in cash; the ore stacks up for the ORE exchange.', 'warn');
        else if (after === 0) toast('The crew was laid off — the machinery stands idle.');
        openShop(m);   // re-render (the MANAGE modal routes here too)
      };
    });
  }

  // ---- the yard (machine shop) --------------------------------------------
  function openShop(m) {
    if (!m) return;
    const cap = capOf(m), n = (m.machines || []).length;
    const cards = TYPES.map((T, i) =>
      '<div class="myard-card' + (n >= cap || STATE.money < T.cost ? ' dim' : '') + '">' +
      '<div class="myard-info"><b>' + T.name + '</b><span>' + T.tpd.toLocaleString('en-US') + ' t/day · ' + T.ops + ' operator' + (T.ops === 1 ? '' : 's') + ' · digs ' + fmt$(T.tpd * priceOf(m)) + '/day of ore at today\u2019s $' + (Math.round(priceOf(m) * 10) / 10) + '/t</span></div>' +
      '<div class="myard-buy"><span>' + fmt$(T.cost) + '</span>' +
      '<button class="btn primary" data-yi="' + i + '"' + (n >= cap ? ' disabled' : '') + '>INSTALL</button></div></div>').join('');
    const yours = (m.machines || []).map((x, i) => TYPES[x.t] ?
      '<div class="kv"><span class="k">' + TYPES[x.t].name + ' · ' + TYPES[x.t].tpd.toLocaleString('en-US') + ' t/day · ' + TYPES[x.t].ops + ' operator' + (TYPES[x.t].ops === 1 ? '' : 's') + '</span>' +
      '<button class="tpbtn" data-ys="' + i + '">SELL ' + fmt$(Math.round(TYPES[x.t].cost * SELL_BACK)) + '</button></div>' : '').join('');
    const pct = m.ore ? Math.round(100 * m.got / m.ore) : 0;
    openModal('MACHINERY & CREW — ' + m.name, `
      <p>Set machinery down on <b>${m.name}</b>'s dirt ring, then <b>hire the crew that runs it</b> — the ore stacks up as <b>${resOf(m).toLowerCase()} resource</b> for the ORE exchange (today <b>$${Math.round(priceOf(m) * 10) / 10}/t</b>) and every worker earns ${fmt$(WAGE)}/day in cash until the assay runs out.</p>
      <div class="kv"><span class="k">RESERVE</span><span class="v">${Math.round(m.ore - m.got).toLocaleString('en-US')} t left of ${m.ore.toLocaleString('en-US')} t (${pct}% mined)</span></div>
      <div class="mn-prog"><i style="width:${pct}%"></i></div>
      <div class="kv" style="margin-top:8px"><span class="k">OUTPUT</span><span class="v g">${m.got >= m.ore ? 'nothing left to dig' : digTpd(m).toLocaleString('en-US') + ' t/day dug · ' + signedNet(incOfDay(m)) + '/day net'}</span></div>
      <div class="kv"><span class="k">MACHINERY</span><span class="v">${n}/${cap} on the ring</span></div>
      <div id="myard">${cards}</div>
      ${crewBlock(m, true)}
      ${yours ? '<div class="msec" style="margin-top:12px">On the ring — sell any back for ' + Math.round(SELL_BACK * 100) + '%</div>' + yours : ''}
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="my-x" style="flex:1">CLOSE</button></div>`);
    document.querySelectorAll('#myard [data-yi]').forEach(el => {
      el.onclick = () => {
        const t = +el.dataset.yi;
        if (n >= cap) { toast('<b>' + m.name + ' is full</b> (' + cap + ' machines on its ring).', 'warn'); return; }
        if (STATE.money < TYPES[t].cost) { toast('<b>Not enough money.</b> The ' + TYPES[t].name + ' costs ' + fmt$(TYPES[t].cost) + '.', 'warn'); return; }
        startPlacing(m, t);
      };
    });
    wireCrew('#modalwrap', m);
    document.querySelectorAll('[data-ys]').forEach(el => {
      el.onclick = () => {
        const i = +el.dataset.ys;
        const x = (m.machines || [])[i];
        if (!x || !TYPES[x.t]) return;
        m.machines.splice(i, 1);
        if (crewOf(m) > opsOf(m)) setCrew(m, opsOf(m));   // trim the crew to the fleet that remains
        earn(Math.round(TYPES[x.t].cost * SELL_BACK), false);   // resale doesn't count toward GDP
        try { saveGame(); } catch (er) { }
        ensureOne(m.id);
        toast('Sold the <b>' + TYPES[x.t].name + '</b> for ' + fmt$(Math.round(TYPES[x.t].cost * SELL_BACK)) + '.');
        openShop(m);
      };
    });
    const x = document.getElementById('my-x');
    if (x) x.onclick = closeModal;
  }

  // ---- the mine panel --------------------------------------------------------
  function openManage(m) {
    if (!m) return;
    const done = m.got >= m.ore;
    const pct = m.ore ? Math.round(100 * m.got / m.ore) : 0;
    const n = (m.machines || []).length;
    const crew = crewOf(m), ops = opsOf(m);
    const walked = m.walked || false;   // v2.50: unpaid crews walk off
    const held = (window.EXCH ? EXCH.held(resOf(m)) : 0) || 0;   // v2.52: the resource pile this claim feeds
    openModal(m.name + ' — Your Mine', `
      <p>${done ? '<b>Worked out.</b> The assay ran dry — the crew is released, the machines are idle and the land can be reclaimed. The stockpile still sells on the exchange.'
        : walked ? '<b>The crew walked off</b> — payday came up short. Re-hire them from the yard when your balance can cover the wages.'
        : 'A <b>' + Math.round(m.w) + ' × ' + Math.round(m.d) + ' m</b> open-pit claim' + (m.near ? ' out past <b>' + m.near + '</b>' : '') + ', dug by a hired crew running the machinery you set down.'}</p>
      <div class="kv"><span class="k">ASSAY</span><span class="v">${(m.ore > 0 ? gradeLabel(m.grade) : '')} · par $${m.grade}/t · exchange $${Math.round(priceOf(m) * 10) / 10}/t today</span></div>
      <div class="kv"><span class="k">RESERVE</span><span class="v">${Math.round(m.ore - m.got).toLocaleString('en-US')} t left of ${m.ore.toLocaleString('en-US')} t · ${pct}% mined</span></div>
      <div class="mn-prog"><i style="width:${pct}%"></i></div>
      <div class="kv" style="margin-top:8px"><span class="k">PIT</span><span class="v">rim ${Math.round(rimOf(m) * 10) / 10} m · ${stageOf(m)}/${STAGES} terraces cut</span></div>
      <div class="kv"><span class="k">CREW</span><span class="v">${done ? 'released — the ore is gone' : crew + ' of ' + ops + ' operator seats filled'}</span></div>
      <div class="kv"><span class="k">OUTPUT</span><span class="v ${done || !crew ? '' : 'g'}">${done ? 'nothing left to dig' : !crew ? 'idle — hire a crew to start digging' : digTpd(m).toLocaleString('en-US') + ' t/day dug · ' + signedNet(incOfDay(m)) + '/day net'}</span></div>
      <div class="kv"><span class="k">MACHINERY</span><span class="v">${n}/${capOf(m)} on the ring · ${fmt$((m.machines || []).reduce((s, x) => s + (TYPES[x.t] ? TYPES[x.t].cost : 0), 0))}</span></div>
      <div class="kv"><span class="k">CLAIM VALUE</span><span class="v">${fmt$(m.price)}</span></div>
      <div class="kv"><span class="k">STOCKPILE</span><span class="v">${held > 0 ? held.toFixed(1) + ' t of ' + resOf(m).toLowerCase() + ' ≈ ' + fmt$(held * priceOf(m)) + ' at today\u2019s exchange' : 'empty — dug ore stacks up here until you sell it'}</span></div>
      <button class="btn good" id="mm-mach" style="width:100%;margin-top:12px">${n ? 'MACHINERY & CREW · ' + n + (crew ? ' + 👷 ' + crew : '') : 'BUY MACHINERY & HIRE A CREW'}</button>
      <button class="btn primary" id="mm-exch" style="width:100%;margin-top:8px">SELL ${resOf(m).toUpperCase()} ON THE ORE EXCHANGE</button>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn primary" id="mm-tp" style="flex:1">TELEPORT THERE</button>
        <button class="btn bad" id="mm-close">${done ? 'CLOSE & RECLAIM' : 'ABANDON MINE'}</button>
        <button class="btn" id="mm-x">CLOSE</button>
      </div>`);
    document.getElementById('mm-mach').onclick = () => openShop(m);
    document.getElementById('mm-tp').onclick = () => travelTo(m);
    const mex = document.getElementById('mm-exch');
    if (mex) mex.onclick = () => { try { if (window.EXCH) EXCH.open(); } catch (er) { } };   // v2.52 ORE EXCHANGE
    document.getElementById('mm-close').onclick = () => {
      const refund = (m.machines || []).reduce((s, x) => s + Math.round((TYPES[x.t] ? TYPES[x.t].cost : 0) * SELL_BACK), 0);
      STATE.mines = mines().filter(x => x !== m);
      if (refund) earn(refund, false);
      try { saveGame(); } catch (er) { }
      disposeOne(m.id);
      closeModal();
      toast(done ? '<b>' + m.name + ' closed</b> — the land goes back to the country.'
        : '<b>' + m.name + ' abandoned.</b>' + (refund ? ' Machinery refunded ' + fmt$(refund) + '.' : ''));
    };
    document.getElementById('mm-x').onclick = closeModal;
  }

  // ---- the mining panel (the MINE button) ------------------------------------
  function openPanel() {
    if (STATE.mode !== 'city' || !WORLD.group) { toast('Enter the world first — mining needs ground under your boots.'); return; }
    const M = mines();
    const rows = M.map((m, i) =>
      '<div class="kv"><span class="k">' + m.name + ' · ' + Math.round(m.w) + '×' + Math.round(m.d) + ' m · ' + statusShort(m) + '</span>' +
      '<button class="tpbtn" data-mp="' + i + '">MANAGE</button></div>').join('');
    const inc = M.reduce((s, m) => s + incOfDay(m), 0);
    const stT = window.EXCH ? EXCH.stockT() : 0, stV = window.EXCH ? EXCH.stockValue() : 0;   // v2.52: the resource stockpile
    openModal('MINING — the open country', `
      <p>The land past every city's suburbs holds ore. <b>Stake a rectangular claim</b>, set machinery on its ring, and <b>hire the crew that digs it</b> — the ore they dig stacks up tonne by tonne as <b>resources in your stockpile</b> and sells on the <b>ORE exchange</b>, the wages are paid daily in cash, and the pit you carve grows a terrace deeper the more you take.</p>
      ${rows ? '<div class="msec" style="margin-top:4px">Your mines</div>' + rows +
      '<div class="kv" style="margin-top:10px"><span class="k">MINING OUTPUT</span><span class="v g">' + signedNet(inc) + '/day net at today\u2019s exchange · wages included</span></div>' : ''}
      <div class="kv" style="margin-top:8px"><span class="k">STOCKPILE — ${stT > 0 ? stT.toFixed(1) + ' t of ore ≈ ' + fmt$(stV) + ' at today\u2019s prices' : 'empty — the ore your crews dig stacks up here'}</span><button class="tpbtn" id="mp-exch">SELL ON THE EXCHANGE</button></div>
      <button class="btn good" id="mp-stake" style="width:100%;margin-top:14px">STAKE A CLAIM — SELECT AN AREA</button>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="mp-x" style="flex:1">CLOSE</button></div>`);
    document.getElementById('mp-stake').onclick = armStake;
    document.getElementById('mp-x').onclick = closeModal;
    const exb = document.getElementById('mp-exch');
    if (exb) exb.onclick = () => { try { if (window.EXCH) EXCH.open(); } catch (er) { } };   // v2.52 ORE EXCHANGE
    document.querySelectorAll('[data-mp]').forEach(b => {
      b.onclick = () => { const m = mines()[+b.dataset.mp]; if (m) openManage(m); };
    });
  }

  // ---- travel (one world, one tap) --------------------------------------------
  function travelTo(m) {
    if (!m) return;
    closeModal();
    const p = ACTORS.player && ACTORS.player.group.position;
    const local = STATE.mode === 'city' && WORLD.group && p && Math.hypot(p.x - m.x, p.z - m.z) < 3000;
    if (local) {
      try { ACTORS.clearGoal(); } catch (e) { }
      ACTORS.placePlayer(m.x, m.z);
      camCtl.tx = m.x; camCtl.tz = m.z;
      camCtl.follow = true; camCtl.distT = Math.max(90, Math.max(m.w, m.d) * 1.4);   // frame the whole claim
      ECO.arrivalPulse(m.x, m.z);
      toast('⚡ Teleported to your <b>' + m.name + '</b>.', 'warn');
      return;
    }
    const c = nearestCity(m.x, m.z);
    if (!c) return;
    enterWorld({ key: c.c.key, name: c.c.name, lat: c.c.lat, lon: c.c.lon, tier: c.c.tier },
      { at: { x: m.x, z: m.z } });
  }

  // ---- the Empire panel rows ---------------------------------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    const M = mines();
    const rows = M.map((m, i) =>
      '<div class="kv"><span class="k">' + m.name + ' · ' + Math.round(m.w) + '×' + Math.round(m.d) + ' m · ' +
      (m.got >= m.ore ? 'worked out' : m.walked ? 'crew walked off' : !crewOf(m) ? (!(m.machines || []).length ? 'no machinery yet' : 'needs a crew') : signedNet(incOfDay(m)) + '/day net at the exchange') + '</span>' +
      '<button class="tpbtn" data-mt="' + i + '">TELEPORT</button></div>').join('');
    const inc = M.reduce((s, m) => s + incOfDay(m), 0);
    const stT = window.EXCH ? EXCH.stockT() : 0, stV = window.EXCH ? EXCH.stockValue() : 0;   // v2.52: the stockpile rides the Empire panel
    const html = '<div class="msec" style="margin-top:14px">Mines — your claims</div>' +
      (rows || '<p>No mines yet. Press the MINE button, STAKE A CLAIM on any rectangle of open country, set machinery on its ring and hire the crew that digs it.</p>') +
      (rows ? '<div class="kv" style="margin-top:10px"><span class="k">MINING OUTPUT</span><span class="v g">' + signedNet(inc) + '/day net at today\u2019s exchange · ' + M.length + ' claim' + (M.length === 1 ? '' : 's') + '</span></div>' : '') +
      '<div class="kv"><span class="k">ORE STOCKPILE — ' + stT.toFixed(1) + ' t ≈ ' + fmt$(stV) + ' at today\u2019s exchange</span><button class="tpbtn" id="em-ore">EXCHANGE</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    body.querySelectorAll('[data-mt]').forEach(b => {
      b.onclick = () => { travelTo(M[+b.dataset.mt]); };
    });
    const ob = document.getElementById('em-ore');
    if (ob) ob.onclick = () => { try { if (window.EXCH) EXCH.open(); } catch (er) { } };   // v2.52 ORE EXCHANGE
  }

  // ---- the hover tip -------------------------------------------------------------
  function tip(x, z) {
    if (STATE.mode !== 'city' || !WORLD.group) return null;
    if (staking && staking.a) {
      const bx = Math.round(x / SNAP) * SNAP, bz = Math.round(z / SNAP) * SNAP;
      const w = Math.abs(bx - staking.a.x), d = Math.abs(bz - staking.a.z);
      const area = w * d;
      return {
        t: 'Claim — ' + Math.max(w, SNAP) + ' × ' + Math.max(d, SNAP) + ' m',
        s: (area / 1e4).toFixed(1) + ' ha · ' + area.toLocaleString('en-US') + ' m²',
        p: fmt$(Math.round(area * CLAIM_RATE / 100) * 100), a: '⛏ CLAIM', l: 'Click to set the far corner',
      };
    }
    const m = mineAt(x, z);
    if (!m) return null;
    const done = m.got >= m.ore;
    const crew = crewOf(m);
    return {
      t: m.name + ' — your mine',
      s: Math.round(m.w) + '×' + Math.round(m.d) + ' m · $' + (Math.round(priceOf(m) * 10) / 10) + '/t on the exchange · 👷 ' + crew + (m.near ? ' · near ' + m.near : ''),
      p: done ? 'worked out' : m.walked ? 'crew walked off' : !crew ? 'idle — no crew' : signedNet(incOfDay(m)) + '/day net at the exchange',
      a: done ? '⛏ EMPTY' : !crew ? '⛏ IDLE' : '⛏ DIGGING',
      l: 'Click to manage',
    };
  }

  // ---- the click -------------------------------------------------------------------
  function click(cx, cy) {
    if (STATE.mode !== 'city' || !WORLD.group) return false;
    // while staking / placing, EVERY canvas click is ours
    if (staking || placing) {
      const pt = screenToGround(cx, cy);
      if (!pt) { toast('Aim at the ground — the camera needs to see it.', 'warn'); return true; }
      if (placing) placeAt(pt.x, pt.z); else stakeClick(pt.x, pt.z);
      return true;
    }
    // never steal a click while the indoor machine placer is armed
    try { if (window.MACH && MACH.placing()) return false; } catch (er) { }
    const pt = screenToGround(cx, cy);
    if (!pt) return false;
    const m = mineAt(pt.x, pt.z);
    if (m) { openManage(m); return true; }
    return false;
  }

  // ---- income + tick ------------------------------------------------------------------
  // v2.50 HIRED HANDS: the crew paces the dig (a short staff runs the
  // machinery proportionally slower) and their wages come due as a day's
  // lump on the same 90 s game-day beat — a balance that can't cover
  // payday means the crews walk off on the spot.
  function walkOff(m) {
    m.crew = 0; m.walked = true; m.wageAcc = 0;
    try { saveGame(); } catch (er) { }
    ensureOne(m.id);
    try { toast('🚧 <b>The ' + m.name + ' crew walked off</b> — payday came up short. Re-hire them when your balance can cover the wages.', 'warn'); } catch (er) { }
  }
  function tick(dt) {
    try {
      if (WORLD.group !== root) {
        root = WORLD.group;
        disposeAll();
        killStakeGhost(); killMachGhost();
        if (root) ensureAll();
      }
      // the beat: the crew digs, the stockpile grows, reserves run down, pits deepen
      const M = mines();
      if (STATE.mode === 'city' && M.length) {
        acc += dt;
        if (acc >= 1) {
          const secs = acc; acc = 0;
          for (const m of M) {
            if (!working(m)) continue;
            const tpd = digTpd(m);              // what today's crew moves
            if (!tpd || m.got >= m.ore) continue;
            let tons = Math.min(tpd / DAY * secs, m.ore - m.got);
            if (tons <= 0) continue;
            m.got = +(m.got + tons).toFixed(2);
            try { if (window.EXCH) EXCH.pile(resOf(m), tons); } catch (er) { }   // v2.52 ORE EXCHANGE: the dig becomes stockpiled resource — it sells on the market, never by itself
            const e = built.get(m.id);
            if (!e || e.stage !== stageOf(m)) ensureOne(m.id);
            // wages accrue and come due as a full day's lump
            m.wageAcc = +(((m.wageAcc || 0)) + crewOf(m) * WAGE / DAY * secs).toFixed(2);
            if (m.wageAcc >= crewOf(m) * WAGE) {
              const due = crewOf(m) * WAGE;
              if (STATE.money >= due) {
                STATE.money -= due; uiBalance();
                m.wageAcc = +(m.wageAcc - due).toFixed(2);
              } else { walkOff(m); continue; }
            }
            if (m.got >= m.ore) {
              m.crew = 0; m.wageAcc = 0;          // worked out — the crew is released
              try { saveGame(); } catch (er) { }
              ensureOne(m.id);
              try { toast('⛏ <b>' + m.name + ' is worked out</b> — the assay ran dry and the crew is released. Sell the machinery or reclaim the land; the stockpile still sells on the exchange.', 'warn'); } catch (er) { }
            }
          }
        }
      } else acc = 0;
      // ghosts follow the cursor
      if (staking) updateStakeGhost();
      if (placing) updateMachGhost();
      // beacons blink while the CREW is digging; the workers bob at work
      if (built.size) {
        const on = ((performance.now() / 650) | 0) % 2 === 0;
        const tnow = performance.now() / 1000;
        for (const [id, e] of built) {
          const m = mines().find(x => x.id === id);
          const busy = m && working(m);
          for (const q of e.mach) { try { q.bc.visible = !!(on && busy); } catch (er) { } }
          for (const w of (e.wrk || [])) {
            try {
              w.visible = !!busy;
              if (busy) w.position.y = w.userData.y0 + Math.abs(Math.sin(tnow * 2 + (w.userData.ph || 0))) * .12;
            } catch (er) { }
          }
        }
      }
    } catch (er) { console.error('[mining]', er); }
  }

  // ---- listeners (once) ------------------------------------------------------------------
  try {
    canvas.addEventListener('pointermove', e => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true });
    canvas.addEventListener('pointerleave', () => { lastPtr = null; }, { passive: true });
    window.addEventListener('keydown', e => {           // capture: ESC ends staking/placing first
      if (e.key !== 'Escape' || (!staking && !placing)) return;
      const mw = document.getElementById('modalwrap');
      if (mw && !mw.classList.contains('hidden')) return;   // a real modal wins
      try { e.stopPropagation(); } catch (er) { }
      if (placing) exitPlacing(false); else exitStake(false);
    }, true);
  } catch (er) { }

  return {
    openPanel, openShop, openManage, travelTo, tick, click, tip, empireInto,
    stageOf, rimOf, capOf, incOfDay, mineAt, valueOf, armStake,
    crewOf, opsOf, capTpd, digTpd, wageOfDay,          // v2.50 HIRED HANDS
    BASE, resOf, priceOfRes, priceOf,                  // v2.52 ORE EXCHANGE (par prices, resource keys, today's $/t)
    list: () => mines().slice(),
    count: () => mines().length,
    TYPES,
    // QA: programmatic stake (same validation, same commit)
    stake(x0, z0, x1, z1) {
      const v = validateClaim(x0, z0, x1, z1);
      if (!v.ok) return { ok: false, why: v.why, text: whyText(v) };
      if (mines().length >= MAX_MINES) return { ok: false, why: 'cap' };
      const R = { x0, z0, x1, z1, w: x1 - x0, d: z1 - z0 };
      const area = R.w * R.d;
      const id = 'm' + Math.round((R.x0 + R.x1) / 2) + '_' + Math.round((R.z0 + R.z1) / 2);
      const h = hashStr(id + 'ore'), h3 = hashStr(id + 'n');
      const price = Math.round(area * CLAIM_RATE / 100) * 100;
      if (!spend(price)) return { ok: false, why: 'funds', cost: price };
      const nc = nearestCity((R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2);
      const res = ORES[h % ORES.length];
      const m = {
        id, name: res + ' ' + PITS[h3 % PITS.length],
        x: (R.x0 + R.x1) / 2, z: (R.z0 + R.z1) / 2, w: R.w, d: R.d,
        price, grade: BASE[res] || 14, ore: Math.round(area * DENS), got: 0, machines: [], res,
        near: nc && nc.d < 120000 ? nc.c.name : null, nearKey: nc ? nc.c.key : null,
      };
      STATE.mines.push(m);
      try { saveGame(); } catch (e) { }
      ensureOne(id);
      return { ok: true, id: m.id, price: m.price, grade: m.grade, ore: m.ore, name: m.name, res };
    },
    // QA: programmatic install (no modal, no ghost) — same validation
    install(id, t, lx, lz) {
      const m = mines().find(x => x.id === id);
      if (!m) return { ok: false, why: 'no mine' };
      if ((m.machines || []).length >= capOf(m)) return { ok: false, why: 'cap' };
      const v = validSpot(lx, lz, m, t);
      if (!v.ok) return { ok: false, why: v.why };
      if (!spend(TYPES[t].cost)) return { ok: false, why: 'funds', cost: TYPES[t].cost };
      (m.machines || (m.machines = [])).push({ t, x: +(+lx).toFixed(1), z: +(+lz).toFixed(1) });
      try { saveGame(); } catch (e) { }
      ensureOne(id);
      return { ok: true };
    },
    // QA: programmatic hire (same clamps as the buttons)
    hire(id, n) {
      const m = mines().find(x => x.id === id);
      if (!m) return { ok: false, why: 'no mine' };
      const before = crewOf(m);
      setCrew(m, n);
      return { ok: true, before, crew: crewOf(m), walked: !!m.walked };
    },
    // QA: run whole game-days of extraction instantly (wages paid, walk-off
    // honored, the dig becomes STOCKPILED RESOURCE — v2.52: no auto-sale)
    qaDay(n) {
      let dug = 0, wages = 0, walked = 0;
      for (let i = 0; i < (n || 1); i++) {
        for (const m of mines()) {
          if (!working(m)) continue;
          const tons = Math.min(digTpd(m), m.ore - m.got);
          if (tons <= 0) continue;
          m.got = +(m.got + tons).toFixed(2);
          dug += tons;
          try { if (window.EXCH) EXCH.pile(resOf(m), tons); } catch (er) { }
          const due = crewOf(m) * WAGE;
          if (STATE.money >= due) { STATE.money -= due; uiBalance(); wages += due; }
          else { walkOff(m); walked++; continue; }   // same walk-off path as the live beat (toast + save + rebuild)
          if (m.got >= m.ore) { m.crew = 0; m.wageAcc = 0; ensureOne(m.id); }
        }
      }
      ensureAll();
      return { dug: Math.round(dug * 10) / 10, wages, walked };
    },
    state() {
      const M = mines();
      return {
        mines: M.length,
        incomePerDay: M.reduce((s, m) => s + incOfDay(m), 0),      // v2.52: net at today's exchange prices
        grossPerDay: M.reduce((s, m) => s + digTpd(m) * priceOf(m), 0),
        stockT: window.EXCH ? EXCH.stockT() : 0,                   // v2.52 ORE EXCHANGE: the resource stockpile
        stockValue: window.EXCH ? EXCH.stockValue() : 0,
        wagesPerDay: M.reduce((s, m) => s + wageOfDay(m), 0),
        crew: M.reduce((s, m) => s + crewOf(m), 0),
        walked: M.filter(m => m.walked).length,
        value: valueOf(),
        machinery: M.reduce((s, m) => s + (m.machines || []).length, 0),
        built: built.size,
        staking: !!staking,
        placing: !!placing,
        accrual: +acc.toFixed(2),
      };
    },
  };
})();
window.MINE = MINE;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the click chain: a mining claim / mine click runs FIRST (before the
//    indoor machine placement, the farm claim, the openhouse inspector
//    and the walk orders) so staking and installing never walk the
//    character. If the mining pass ever throws, the original flow still
//    runs.
const __mineClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (MINE.click(cx, cy)) return; } catch (e) { console.error('[mining]', e); }
  return __mineClickPick(cx, cy);
});
// 2. hover: the mine tip fills in wherever nothing older claims the point
const __mineHoverInfo = ECO.hoverInfo.bind(ECO);
ECO.hoverInfo = function (x, z) {
  const info = __mineHoverInfo(x, z);
  if (info) return info;
  try { return MINE.tip(x, z); } catch (e) { return null; }
};
// 3. the Empire panel: your mines, one tap away
const __mineEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __mineEmpire();
  try { MINE.empireInto(); } catch (e) { console.error('[mining]', e); }
};
// 4. the update chain: original → world forest → open house → suburbs →
//    title deeds → patchwork → machines → landlord → MOTHERLODE →
//    MONEY LIST → ORE EXCHANGE. Every call is try/caught so a mining
//    error can never touch the world.
const __mineOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __mineOrigUpdate(dt, px, pz, camDist);
  try { MINE.tick(dt); } catch (e) { console.error('[mining]', e); }
  return req;
};

