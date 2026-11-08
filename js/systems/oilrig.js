// ====================================================================
// js/systems/oilrig.js — DEEP WATER (v2.62): buildable offshore oil
// rigs on the open ocean, using the game's own land/water data.
// ====================================================================
import * as THREE from 'three';
import { CITIES, DEG_M } from '../config.js';
import { fmt$, hashStr } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend, uiBalance } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { LANDGEO } from '../core.js';
import { WORLD, camCtl } from '../world/world.js';
import { ACTORS } from '../world/actors.js';
import { ECO } from '../systems/eco.js';
import { canvas, enterWorld } from '../render/main.js';
import { clickPick, patchClickPick, screenToGround } from '../render/night.js';
import { MACH } from '../systems/machines.js';
import { FACT } from '../systems/factory.js';
import { BLD } from '../systems/builder.js';
import { MINE } from '../systems/mining.js';
import { EXCH } from '../systems/exchange.js';

// ======== section: 59_oilrig.js ========
// ====================================================================
// v2.62 — DEEP WATER. The ask: "Add buildable oil rigs in the ocean
// at valid offshore spots (use the existing land/water data). Rigs
// cost materials, need hired workers, and produce oil into storage
// over in-game time based on worker count. Add running costs, a
// capacity limit and a depletion model."
//   - THE SITE: the OFFSHORE row on the MINE panel (and the Empire
//     panel) opens the OIL panel; BUILD A RIG arms placement — a
//     translucent platform follows the cursor over the water, green
//     where a rig may stand, red where it may not. VALID OFFSHORE:
//     open OCEAN (LANDGEO.isWaterWorld — the same vector-exact
//     coast truth the world renders), never a lake, a full 400 m of
//     clear water on every side (8-point ring), land within ~150 km
//     (offshore, not mid-ocean — the tanker run has to make sense)
//     and 400 m clear of any other rig. A click surveys the field.
//   - THE BILL: $185,000 in cash PLUS MATERIALS — 260 t of steel and
//     60 t of stone (the jacket and the ballast). Steel pulls from
//     the Ore-Exchange stockpile first (the Ground-Up shed rule —
//     run the Works and refine your own), then the shed; stone is
//     yard-only. BUY MISSING buys the shortfall at yard prices.
//   - THE CREW: hire up to 32 workers at $95/day each (the mine's
//     wage). THE PUMP runs at 160 t/day fully crewed — a short crew
//     pumps proportionally slower (people run rigs, not steel).
//   - RUNNING COSTS: wages + $520/day marine upkeep, due every game
//     day as a lump; a payday the balance can't cover walks the
//     crew off (re-hire when you can cover it).
//   - THE TANK: each rig pumps into its OWN storage tank, capped at
//     2,000 t (~12 days at full pump). FULL TANK = pumping pauses
//     while the costs keep running — offload it. OFFLOAD moves the
//     tank to the Ore Exchange stockpile for a $2/t tanker freight,
//     where it trades as CRUDE OIL around par $95/t like any
//     resource.
//   - THE DEPLETION MODEL: the field carries a finite reserve
//     (6,700-13,400 t, hashed from the spot); FIELD PRESSURE falls
//     linearly from 100% to 25% as the reserve drains, slowing the
//     pump — and when it plays out the crew is released and only
//     salvage is left.
//   - Decommission salvages 60% of the price in cash and 60% of the
//     materials back to the shed (auto-offloading any tanked oil,
//     freight-free). Rigs count in WORTH (price + tanked oil at
//     par), list in the Empire panel, and TELEPORT aims the CAMERA
//     at the platform (the tycoon stays ashore — nobody walks on
//     the ocean; [C] snaps back). The night
//     shift pumps into the tanks while you sleep (full tank = the
//     crew lays up, uncharged).
// Touchpoints outside this section (each annotated "v2.62"):
// STATE/save/load `rigs` + state.js, the exchange's Oil par + crude
// row-group, the WORTH ticker + help line + What's-New card + night
// settle + show() rows in night.js, playerWorth in rivals.js, the
// boot import + ready log. Every oilrig call is try/caught so a
// mistake here can never touch the world. window.OIL is the QA
// surface.
// ====================================================================
export const OIL = (() => {
  const DAY = 90;                 // seconds per game day (the office/deed/crew beat)
  const PRICE = 185000;           // the platform bill, cash half
  const BILL = { Steel: 260, Stone: 60 };   // the materials half (jacket + ballast), tonnes
  const MAX_RIGS = 8;             // how many fields one tycoon works
  const FULL_CREW = 32;           // workers that run a rig at full pump
  const BASE_TPD = 160;           // t/day of crude at full crew and full pressure
  const CAP_T = 2000;             // the rig's own storage tank, tonnes
  const WAGE = 95;                // $/day per worker (the mine's wage)
  const UPKEEP = 520;             // $/day marine upkeep while the crew is aboard
  const FREIGHT = 2;              // $/t to offload a tank to the exchange
  const SELL_BACK = .6;           // decommission salvage rate (the property rate)
  const MIN_GAP = 400;            // m of water between rigs (anchor arrays)
  const SHORE_CLR = 400;          // m of clear water on every side
  const MAX_OFF = DEG_M * 1.35;   // land must sit within ~150 km (offshore, not abyssal)
  const FIELDS = ['Poseidon', 'Triton', 'Neptune', 'Aegir', 'Kraken', 'Halcyon',
    'Meridian', 'Pelagos', 'Boreas', 'Zephyr', 'Nereid', 'Calypso'];
  const BASE = { Oil: 95 };       // the crude's par $/t — the exchange reads it live

  let acc = 0;                    // pump/wage accumulator (1 s beat, like the pits)
  let root = null;                // WORLD.group swap detector (the MINE pattern)
  let lastPtr = null;             // {x, y} from pointermove (the ghost follows it)
  let placing = false;            // site-survey mode armed
  let surveyAt = null;            // {x, z} of the click being confirmed (modal up)
  const built = new Map();        // rig id -> { g, flame, lights, wrk }

  // ---- little helpers --------------------------------------------------
  const rigs = () => (STATE.rigs || []);
  const crewOf = m => Math.max(0, m.crew | 0);
  const staffingOf = m => Math.min(1, crewOf(m) / FULL_CREW);
  const pressureOf = m => (m.ore > 0 ? Math.max(.25, 1 - .75 * Math.min(1, m.got / m.ore)) : 0);
  const pumpTpd = m => BASE_TPD * staffingOf(m) * pressureOf(m);
  const playedOut = m => m.got >= m.ore;
  const pumping = m => crewOf(m) > 0 && !m.walked && !playedOut(m) && m.sto < CAP_T - .01;
  const costOfDay = m => (crewOf(m) > 0 && !playedOut(m)) ? crewOf(m) * WAGE + UPKEEP : 0;   // costs run while the crew is aboard — a full tank is paid idling
  const grossOfDay = m => pumping(m) ? pumpTpd(m) * parOil() : 0;
  const parOil = () => { try { return (window.EXCH && EXCH.parOf) ? +EXCH.parOf('Oil') : BASE.Oil; } catch (er) { return BASE.Oil; } };
  const signedNet = n => (n >= 0 ? '+' : '-') + fmt$(Math.abs(n));
  const netOfDay = m => grossOfDay(m) - costOfDay(m);
  const valueOf = () => rigs().reduce((s, m) => s + (m.price || 0) + m.sto * parOil(), 0);
  const tankedAll = () => rigs().reduce((s, m) => s + (m.sto || 0), 0);
  function nearestCity(x, z) {
    let best = null;
    for (const c of CITIES) { const d = Math.hypot(x - c.wx, z - c.wz); if (!best || d < best.d) best = { c, d }; }
    return best;
  }
  function rigAt(x, z) {
    for (const m of rigs())
      if (Math.abs(x - m.x) <= 15 && Math.abs(z - m.z) <= 15) return m;
    return null;
  }
  const statusShort = m => playedOut(m) ? 'played out — salvage it'
    : m.walked ? 'crew walked off'
    : !crewOf(m) ? 'no crew — idle'
    : m.sto >= CAP_T - .01 ? 'tanks full — offload to pump on'
    : signedNet(netOfDay(m)) + '/day net · 👷 ' + crewOf(m);
  const depthLabel = d => d < 15e3 ? 'continental shelf' : d < 60e3 ? 'the slope' : 'deep water';

  // ---- the site guards ---------------------------------------------------
  // cheap checks the ghost can run every frame (water, lake, shore
  // ring, spacing); the one expensive check — land within MAX_OFF,
  // a ~150 km spiral — runs only on the click.
  const isW = (x, z) => { try { return !!(LANDGEO.ready && LANDGEO.isWaterWorld(x, z)); } catch (e) { return false; } };
  const isLake = (x, z) => { try { return LANDGEO.isLakeLL(-z / DEG_M, x / DEG_M); } catch (e) { return false; } };
  function cheapSpot(x, z) {
    if (!isW(x, z)) return { ok: false, why: 'land' };
    if (isLake(x, z)) return { ok: false, why: 'lake' };
    for (let i = 0; i < 8; i++) {          // 400 m of clear water on every side
      const a = i / 8 * Math.PI * 2;
      if (!isW(x + Math.cos(a) * SHORE_CLR, z + Math.sin(a) * SHORE_CLR)) return { ok: false, why: 'shore' };
    }
    for (const m of rigs())
      if (Math.hypot(x - m.x, z - m.z) < MIN_GAP) return { ok: false, why: 'rig' };
    return { ok: true };
  }
  function validateSpot(x, z) {
    const c = cheapSpot(x, z);
    if (!c.ok) return c;
    let nl = null;
    try { nl = LANDGEO.nearestLandWorld(x, z, MAX_OFF); } catch (e) { nl = null; }
    if (!nl) return { ok: false, why: 'deep' };
    return { ok: true, d: Math.hypot(nl.x - x, nl.z - z) };
  }
  function whyText(v) {
    return v.why === 'land' ? 'That is dry land — rigs stand in open water.'
      : v.why === 'lake' ? 'That is a lake — oil rigs are offshore, on the ocean.'
      : v.why === 'shore' ? 'Too close to shore — stand at least ' + SHORE_CLR + ' m off the coast.'
      : v.why === 'rig' ? 'Too close to another rig — give the anchor arrays ' + MIN_GAP + ' m.'
      : 'Too far offshore — no land within ~150 km, the tanker run would never pay.';
  }

  // ---- materials (the Ground-Up shed rules, mirrored here) --------------
  const YARD = () => (BLD && BLD.YARD) || { Wood: 30, Stone: 22, Steel: 78, Glass: 52 };
  const shed = k => +((+(STATE.mat ? STATE.mat[k] : 0)) || 0);
  const stock = k => +(((STATE.res || {})[k]) || 0);
  const avail = k => shed(k) + (k === 'Steel' ? stock(k) : 0);   // steel pulls from the exchange pile; stone is yard-only
  function matReady() { for (const k in BILL) if (avail(k) + 1e-9 < BILL[k]) return false; return true; }
  function shortOf() { const o = {}; for (const k in BILL) { const s = BILL[k] - avail(k); if (s > 1e-9) o[k] = Math.ceil(s); } return o; }
  function missCost() { let c = 0; const sh = shortOf(), y = YARD(); for (const k in sh) c += sh[k] * y[k]; return Math.round(c); }
  function deductBill() {         // stockpile first (the Works draw pattern), then the shed
    for (const k in BILL) {
      let need = BILL[k];
      if (k === 'Steel') {
        const have = stock(k), use = Math.min(need, have);
        if (use > .005) {
          const left = +(have - use).toFixed(2);
          if (left > .005) STATE.res[k] = left; else delete STATE.res[k];
          need = +(need - use).toFixed(2);
        }
      }
      STATE.mat[k] = Math.max(0, +((shed(k)) - need).toFixed(1));
    }
  }
  function refundBill() { const o = {}; for (const k in BILL) o[k] = Math.round(BILL[k] * SELL_BACK * 10) / 10; return o; }

  // ---- the 3D platform ---------------------------------------------------
  const LM = c => new THREE.MeshLambertMaterial({ color: c });
  function buildStatic(m) {
    const g = new THREE.Group();
    const lights = [], wrk = [];
    let flame = null;
    try {
      const steel = LM(0x3b4652), deck = LM(0x2f3944), rust = LM(0x8c4a32),
        tank = LM(0xe8e4d8), white = LM(0xd9dde2), dark = LM(0x232b33);
      // legs reach below the waterline (the ocean plane rides at -1.35)
      for (const [lx, lz] of [[-8.6, -7], [8.6, -7], [-8.6, 7], [8.6, 7]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.35, 18, 10), steel);
        leg.position.set(lx, 2.2, lz); g.add(leg);
        const brace = new THREE.Mesh(new THREE.BoxGeometry(15, .8, .8), steel);
        brace.position.set(lx ? lx / 2 : 0, -3.4, lz); g.add(brace);
      }
      // cellar deck + main deck
      const cellar = new THREE.Mesh(new THREE.BoxGeometry(20, 1.2, 16), steel);
      cellar.position.y = 10.4; g.add(cellar);
      const main = new THREE.Mesh(new THREE.BoxGeometry(24, 2.2, 20), deck);
      main.position.y = 12.1; main.castShadow = true; g.add(main);
      // the derrick — three tapering stages + crown
      for (const [w, y] of [[6, 15.7], [4.6, 20.5], [3.2, 25.2]]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(w, 4.8, w), rust);
        st.position.set(-2.5, y, 0); g.add(st);
      }
      const crown = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.1, 3.8), dark);
      crown.position.set(-2.5, 28, 0); g.add(crown);
      // the flare boom off the starboard corner + its flame
      const boom = new THREE.Mesh(new THREE.BoxGeometry(1.1, 15, 1.1), rust);
      boom.position.set(11.2, 17.5, 7.6); boom.rotation.z = -.62; g.add(boom);
      flame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 3, 1.7),
        new THREE.MeshBasicMaterial({ color: 0xffa63d }));
      flame.position.set(15.6, 22.6, 8.9); g.add(flame);
      // the tank farm — three white crude tanks (the storage the game bills)
      for (const [tx, tz] of [[-6.5, -4.8], [-6.5, 1.2], [-6.5, 7.2]]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 5.4, 12), tank);
        t.position.set(tx, 15.9, tz); g.add(t);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.75, 2.75, .35, 12), dark);
        cap.position.set(tx, 18.75, tz); g.add(cap);
      }
      // accommodation + helipad
      const acc = new THREE.Mesh(new THREE.BoxGeometry(7, 3.6, 6), white);
      acc.position.set(6.5, 15, -5.5); g.add(acc);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, .5, 14), dark);
      pad.position.set(6.5, 17.1, -5.5); g.add(pad);
      // the crane
      const post = new THREE.Mesh(new THREE.CylinderGeometry(.5, .5, 7.5, 8), LM(0xd9a13b));
      post.position.set(8.5, 15.9, 3.5); g.add(post);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(9, .6, .6), LM(0xd9a13b));
      arm.position.set(5.2, 19.3, 3.5); arm.rotation.z = .18; g.add(arm);
      // running lights (blink while the crew pumps) + deck workers (bob)
      for (const [lx2, ly2, lz2, cL] of [[-2.5, 28.9, 0, 0xff4444], [6.5, 17.6, -5.5, 0x9ff9ff], [11, 13.6, 9.2, 0xffe08a]]) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(.5, .5, .5),
          new THREE.MeshBasicMaterial({ color: cL }));
        l.position.set(lx2, ly2, lz2); g.add(l); lights.push(l);
      }
      for (const [wx, wz] of [[-1.5, 6], [1.5, -6], [4, 2], [-4.5, -1]]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(.55, 1.1, .55), LM(0xf5cc74));
        w.position.set(wx, 13.4, wz); w.userData.y0 = 13.4; w.userData.ph = Math.random() * 6;
        g.add(w); wrk.push(w);
      }
    } catch (er) { }
    return { g, flame, lights, wrk };
  }
  function disposeOne(id) {
    const e = built.get(id);
    if (e) { try { if (e.g && e.g.parent) e.g.parent.remove(e.g); } catch (er) { } }
    built.delete(id);
  }
  function ensureOne(id) {
    const m = rigs().find(x => x.id === id);
    if (!m || !root) { disposeOne(id); return; }
    const old = built.get(id);
    if (old && old.g && old.g.parent === root) return;
    disposeOne(id);
    const e = buildStatic(m);
    e.g.position.set(m.x, -1.35, m.z);      // the ocean plane rides at -1.35
    try { root.add(e.g); } catch (er) { }
    built.set(id, e);
    return e;
  }
  function ensureAll() { for (const m of rigs()) ensureOne(m.id); }
  function disposeAll() { for (const id of [...built.keys()]) disposeOne(id); }

  // ---- the placement bar + ghost -----------------------------------------
  try {
    const st = document.createElement('style');
    st.textContent = [
      '#ol-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px',
      ' background:var(--panel2);border:1px solid rgba(245,204,116,.4);border-radius:10px;padding:8px 12px;font-size:12px;',
      ' color:var(--txt);box-shadow:0 8px 26px rgba(0,0,0,.55);white-space:nowrap;max-width:92vw;overflow:hidden}',
      '#ol-bar.hidden{display:none}',
      '#ol-bar b{color:#f5cc74}',
      '#ol-bar .ol-x{flex:none;padding:5px 12px;border-radius:7px;background:rgba(245,204,116,.16);color:#f5cc74;font-weight:700;cursor:pointer}',
      '#ol-bar .ol-x:hover{background:rgba(245,204,116,.3)}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }
  function bar(msg, btnLabel, onBtn) {
    let b = document.getElementById('ol-bar');
    if (!b) { try { b = document.createElement('div'); b.id = 'ol-bar'; document.body.appendChild(b); } catch (er) { return; } }
    b.innerHTML = '<span>' + msg + '</span>' + (btnLabel ? '<span class="ol-x" id="ol-bx">' + btnLabel + '</span>' : '');
    b.classList.remove('hidden');
    const x = b.querySelector('#ol-bx');
    if (x) x.onclick = onBtn;
  }
  function hideBar() { const b = document.getElementById('ol-bar'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; } }

  let ghost = null, ghostMat = null;
  function ensureGhost() {
    if (ghost && ghost.parent === root) return;
    killGhost();
    if (!root) return;
    try {
      ghost = new THREE.Group();
      ghostMat = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: .4, depthWrite: false });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(24, 2.2, 20), ghostMat);
      deck.position.y = 12.1; ghost.add(deck);
      for (const [lx, lz] of [[-8.6, -7], [8.6, -7], [-8.6, 7], [8.6, 7]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.35, 18, 8), ghostMat);
        leg.position.set(lx, 2.2, lz); ghost.add(leg);
      }
      ghost.renderOrder = 3; ghost.visible = false;
      root.add(ghost);
    } catch (er) { ghost = null; }
  }
  function killGhost() {
    if (!ghost) return;
    try { if (ghost.parent) ghost.parent.remove(ghost); if (ghostMat) ghostMat.dispose(); } catch (er) { }
    ghost = null; ghostMat = null;
  }
  function updateGhost() {
    if (!placing || !lastPtr || !root) return;
    ensureGhost();
    if (!ghost) return;
    const pt = screenToGround(lastPtr.x, lastPtr.y);
    if (!pt) { ghost.visible = false; return; }
    const v = cheapSpot(pt.x, pt.z);       // the cheap guards color the ghost; the deep-water check rides the click
    ghost.visible = true;
    ghost.position.set(pt.x, -1.35, pt.z);
    if (ghostMat) ghostMat.color.setHex(v.ok ? 0x4dff88 : 0xff5d5d);
  }

  // ---- placement mode -------------------------------------------------------
  function armPlacing() {
    if (STATE.mode !== 'city' || !WORLD.group) { toast('Enter the world first — a rig needs ocean under the survey.'); return; }
    if (rigs().length >= MAX_RIGS) { toast('<b>Offshore cap reached</b> (' + MAX_RIGS + ' rigs). Decommission one first.', 'warn'); return; }
    try { closeModal(); } catch (er) { }
    placing = true;
    bar('RIG SITE — <b>click open water</b> to survey the field', 'CANCEL', () => exitPlacing(false));
    toast('Click a spot of <b>open ocean</b> — at least ' + SHORE_CLR + ' m off the coast and clear of other rigs — to survey an oil field.', 'warn');
  }
  function exitPlacing(done) {
    placing = false;
    killGhost();
    hideBar();
    if (done) try { toast('Site survey finished.', 'warn'); } catch (er) { }
  }
  function placeClick(x, z) {
    const v = validateSpot(x, z);
    if (!v.ok) { toast('<b>' + whyText(v) + '</b> Pick another spot — the survey stays armed.', 'warn'); return; }
    confirmRig(x, z, v);
  }
  function confirmRig(x, z, v) {
    surveyAt = { x, z };
    const id = 'r' + Math.round(x) + '_' + Math.round(z);
    const h = hashStr(id), h2 = hashStr(id + 'v');
    const name = FIELDS[h % FIELDS.length] + ' Field';
    const ore = Math.round(9600 * (.7 + (h2 % 71) / 100));   // 6,720-13,440 t — hashed from the spot
    const nc = nearestCity(x, z);
    const depth = v.d || 0;
    const need = Object.keys(BILL).map(k => {
      const a = avail(k), sh = Math.max(0, BILL[k] - a);
      return k + ' ' + BILL[k] + ' t' + (sh > 1e-9 ? ' <b style="color:#f5cc74">short ' + Math.ceil(sh) + '</b>' : ' <b style="color:#48BB78">✓</b>');
    }).join(' · ');
    const miss = missCost();
    exitPlacing(false);
    openModal('Survey: ' + name + '?', `
      <p><b>${(depth / 1000).toFixed(1)} km offshore</b>${nc && nc.d < 300e3 ? ' off <b>' + nc.c.name + '</b>' : ''}, on the <b>${depthLabel(depth)}</b> — open ocean, clear water on every side. The survey says what's under the seabed:</p>
      <div class="kv"><span class="k">FIELD</span><span class="v">${name.toUpperCase()} · ${depthLabel(depth)}</span></div>
      <div class="kv"><span class="k">EST. RESERVE</span><span class="v">${ore.toLocaleString('en-US')} t of crude (≈${Math.round(ore * 7.33).toLocaleString('en-US')} bbl)</span></div>
      <div class="kv"><span class="k">FIRST PUMP</span><span class="v g">160 t/day fully crewed · pressure falls as the field drains · tank ${CAP_T.toLocaleString('en-US')} t on board</span></div>
      <div class="kv"><span class="k">PLATFORM</span><span class="v g">${fmt$(PRICE)} + ${need}</span></div>
      <div class="kv"><span class="k">RUNNING</span><span class="v">wages ${fmt$(WAGE)}/day per worker (up to ${FULL_CREW}) · upkeep ${fmt$(UPKEEP)}/day while the crew is aboard</span></div>
      <div class="kv"><span class="k">BALANCE</span><span class="v">${fmt$(STATE.money)}</span></div>
      <div class="kv" style="margin-top:6px"><span class="k">NEXT</span><span class="v">Build it, then hire the crew that pumps — crude stacks up in the rig's own tank, offloads to the Ore Exchange at ${fmt$(FREIGHT)}/t freight and sells like any resource</span></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn good" id="oc-go" style="flex:1">BUILD THE RIG — ${fmt$(PRICE)} + MATERIALS</button>
        ${miss > 0 ? '<button class="btn primary" id="oc-mat">BUY MISSING — ' + fmt$(miss) + '</button>' : ''}
        <button class="btn" id="oc-x">CANCEL</button>
      </div>`);
    const go = document.getElementById('oc-go');
    if (go) go.onclick = () => {
      const r = buildRig(x, z, v);
      if (r.ok) { closeModal(); toast('🛢 <b>' + r.name + ' is yours.</b> Now hire the crew that pumps it — the crude stacks up in the rig\'s own tank.'); try { openManage(rigs().find(q => q.id === r.id)); } catch (er) { } }
      else if (r.why === 'funds') toast('<b>Not enough money.</b> The platform runs ' + fmt$(PRICE) + ' — the survey stays open.', 'warn');
      else if (r.why === 'materials') toast('<b>Short on materials.</b> Buy the shortfall at the yard first (' + fmt$(r.cost) + ').', 'warn');
      else toast('<b>' + (r.text || 'That spot will not take a rig.') + '</b>', 'warn');
    };
    const mb = document.getElementById('oc-mat');
    if (mb) mb.onclick = () => {
      const sh = shortOf(), y = YARD();
      let cost = 0; for (const k in sh) cost += sh[k] * y[k];
      cost = Math.round(cost);
      if (cost <= 0) { confirmRig(x, z, v); return; }
      if (!spend(cost)) { toast('<b>Not enough money.</b> The shortfall runs ' + fmt$(cost) + ' at the yard.', 'warn'); return; }
      for (const k in sh) STATE.mat[k] = Math.min(1e6, +((shed(k)) + sh[k]).toFixed(1));
      try { saveGame(); } catch (er) { }
      toast('🧱 <b>Materials bought</b> — the platform is ready to build.');
      confirmRig(x, z, v);
    };
    const cx = document.getElementById('oc-x');
    if (cx) cx.onclick = () => { closeModal(); surveyAt = null; };
  }
  function buildRig(x, z, v) {
    v = v || validateSpot(x, z);
    if (!v.ok) return { ok: false, why: v.why, text: whyText(v) };
    if (rigs().length >= MAX_RIGS) return { ok: false, why: 'cap' };
    if (!matReady()) return { ok: false, why: 'materials', short: shortOf(), cost: missCost() };
    if (!spend(PRICE)) return { ok: false, why: 'funds', cost: PRICE };
    deductBill();
    const id = 'r' + Math.round(x) + '_' + Math.round(z);
    const h = hashStr(id), h2 = hashStr(id + 'v');
    const ore = Math.round(9600 * (.7 + (h2 % 71) / 100));
    const nc = nearestCity(x, z);
    const m = {
      id, name: FIELDS[h % FIELDS.length] + ' Field', x: +x, z: +z,
      price: PRICE, ore, got: 0, crew: 0, walked: false, wageAcc: 0, sto: 0,
      near: nc && nc.d < 300e3 ? nc.c.name : null, nearKey: nc ? nc.c.key : null,
    };
    (STATE.rigs || (STATE.rigs = [])).push(m);
    try { saveGame(); } catch (er) { }
    ensureOne(id);
    surveyAt = null;
    return { ok: true, id, name: m.name, ore, price: PRICE };
  }

  // ---- the crew (the mine's HIRED HANDS pattern) ---------------------------
  function setCrew(m, n) {
    n = Math.max(0, Math.min(n, FULL_CREW));
    m.crew = n;
    if (n > 0) { m.walked = false; m.wageAcc = 0; }
    try { saveGame(); } catch (er) { }
    return n;
  }
  function crewBlock(m) {
    const crew = crewOf(m), done = playedOut(m);
    const short = Math.max(0, FULL_CREW - crew);
    const rate = Math.round(100 * staffingOf(m));
    let s = '<div class="msec" style="margin-top:12px">The crew — people run rigs, not steel</div>';
    s += '<div class="kv"><span class="k">CREW</span><span class="v">' + (done ? 'released — the field played out'
      : crew + ' worker' + (crew === 1 ? '' : 's') + ' · full staffing ' + FULL_CREW
        + (short ? ' · <b style="color:#f5cc74">' + short + ' SHORT</b>' : ' · fully staffed')) + '</span></div>';
    s += '<div class="kv"><span class="k">PUMP RATE</span><span class="v">' + (done ? '0 t/day'
      : Math.round(pumpTpd(m)) + ' of ' + BASE_TPD + ' t/day (' + rate + '% crew · ' + Math.round(pressureOf(m) * 100) + '% pressure)') + '</span></div>';
    s += '<div class="kv"><span class="k">RUNNING COSTS</span><span class="v">' + (crew && !done ? fmt$(crew * WAGE) + ' wages + ' + fmt$(UPKEEP) + ' upkeep = ' + fmt$(costOfDay(m)) + '/day' : 'idle — nobody aboard, nothing due') + '</span></div>';
    if (!done) {
      s += '<div class="kv"><span class="k">NET</span><span class="v g">' + signedNet(netOfDay(m)) + '/day at par $' + Math.round(parOil()) + '/t — costs included</span></div>';
      s += '<div style="display:flex;gap:8px;margin-top:8px">'
        + '<button class="btn primary" data-oh="1" style="flex:1">+ HIRE 1</button>'
        + '<button class="btn primary" data-oh="5" style="flex:1">+ HIRE 5</button>'
        + '<button class="btn good" data-oh="full" style="flex:1">FULL CREW (' + FULL_CREW + ')</button>'
        + '<button class="btn" data-oh="0" style="flex:none">LAY OFF ALL</button></div>';
      if (short) s += '<p style="margin-top:6px">A short crew pumps slower — ' + short + ' more worker' + (short === 1 ? '' : 's') + ' would run the rig at full rate.</p>';
    }
    return s;
  }
  function wireCrew(rootSel, m) {
    document.querySelectorAll(rootSel + ' [data-oh]').forEach(b => {
      b.onclick = () => {
        const v = b.dataset.oh;
        const before = crewOf(m);
        let n = v === 'full' ? FULL_CREW : v === '0' ? 0 : before + +v;
        if (v !== '0' && v !== 'full' && n > FULL_CREW) n = FULL_CREW;
        if (v !== '0' && n <= before) { toast('<b>Fully staffed</b> — ' + FULL_CREW + ' workers run every pump on this rig.', 'warn'); return; }
        setCrew(m, n);
        const after = crewOf(m);
        if (after > before) toast('👷 <b>' + (after - before) + ' worker' + (after - before === 1 ? '' : 's') + ' hired.</b> The pump is on — wages ' + fmt$(after * WAGE) + '/day in cash; the crude stacks up in the rig\'s tank.', 'warn');
        else if (after === 0) toast('The crew was laid off — the rig rides idle at anchor.');
        openManage(m);
      };
    });
  }

  // ---- offload (the tank → the exchange) ---------------------------------
  function offload(m) {
    if (!m || !(m.sto > .01)) return { ok: false, why: 'empty' };
    const t = +m.sto;
    const fee = Math.min(FREIGHT * t, Math.max(0, STATE.money));   // freight never dips the balance below zero
    STATE.money = +(STATE.money - fee).toFixed(2);
    try { uiBalance(); } catch (er) { }
    m.sto = 0;
    try { if (window.EXCH) EXCH.pile('Oil', t); else STATE.res['Oil'] = +(((+STATE.res['Oil']) || 0) + t).toFixed(2); } catch (er) { }
    try { saveGame(); } catch (er) { }
    return { ok: true, t: +t.toFixed(1), fee: Math.round(fee) };
  }
  function offloadAll() {
    let t = 0, fee = 0;
    for (const m of rigs()) if (m.sto > .01) { const r = offload(m); if (r.ok) { t += r.t; fee += r.fee; } }
    if (t > 0) toast('🛢 <b>' + t.toFixed(1) + ' t of crude offloaded</b> to the exchange — tanker freight ' + fmt$(fee) + '. Sell it when the price suits.');
    return { t: +t.toFixed(1), fee };
  }

  // ---- the manage modal ----------------------------------------------------
  function openManage(m) {
    if (!m) return;
    const done = playedOut(m);
    const pct = m.ore ? Math.round(100 * m.got / m.ore) : 0;
    const tpct = Math.round(100 * m.sto / CAP_T);
    const px = parOil();
    const held = (window.EXCH ? +EXCH.held('Oil') : +((STATE.res || {})['Oil'] || 0)) || 0;
    const walkWarn = m.walked ? '<p><b>The crew walked off</b> — payday came up short. Re-hire them when your balance can cover the running costs.</p>' : '';
    openModal(m.name + ' — Your Rig', `
      <p>${done ? '<b>Played out.</b> The field ran dry — the crew is released and only salvage is left. The stockpile still sells on the exchange.'
        : 'An <b>offshore platform</b>' + (m.near ? ' off <b>' + m.near + '</b>' : '') + ', pumping crude into its own tank from ' + FULL_CREW + ' crew seats.'}</p>${walkWarn}
      <div class="kv"><span class="k">FIELD</span><span class="v">${done ? 'played out' : 'pressure ' + Math.round(pressureOf(m) * 100) + '% · par $' + Math.round(px) + '/t crude'}</span></div>
      <div class="kv"><span class="k">RESERVE</span><span class="v">${Math.round(m.ore - m.got).toLocaleString('en-US')} t left of ${m.ore.toLocaleString('en-US')} t · ${pct}% pumped</span></div>
      <div class="mn-prog"><i style="width:${pct}%"></i></div>
      <div class="kv" style="margin-top:8px"><span class="k">TANK</span><span class="v ${m.sto >= CAP_T - .01 && !done ? '' : 'g'}">${m.sto.toFixed(1)} of ${CAP_T.toLocaleString('en-US')} t (${tpct}%)${m.sto >= CAP_T - .01 && !done ? ' — <b style="color:#f5cc74">FULL, pumping paused</b>' : ''}</span></div>
      <div class="mn-prog"><i style="width:${tpct}%"></i></div>
      <div class="kv" style="margin-top:8px"><span class="k">OUTPUT</span><span class="v ${done || !crewOf(m) ? '' : 'g'}">${done ? 'nothing left to pump' : !crewOf(m) ? 'idle — hire a crew to start pumping' : m.sto >= CAP_T - .01 ? 'paused — the tank is full' : Math.round(pumpTpd(m)) + ' t/day pumped · ' + signedNet(netOfDay(m)) + '/day net'}</span></div>
      ${crewBlock(m)}
      <div class="kv" style="margin-top:10px"><span class="k">STOCKPILE</span><span class="v">${held > 0 ? held.toFixed(1) + ' t of crude ≈ ' + fmt$(held * px) + ' at par' : 'empty — offloaded crude trades here'}</span></div>
      <button class="btn primary" id="om-off" style="width:100%;margin-top:12px"${m.sto > .01 ? '' : ' disabled'}>OFFLOAD TANK — ${m.sto.toFixed(1)} t (freight ${fmt$(FREIGHT)}/t)</button>
      <button class="btn good" id="om-exch" style="width:100%;margin-top:8px">SELL CRUDE ON THE ORE EXCHANGE</button>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn primary" id="om-tp" style="flex:1">VIEW THE RIG</button>
        <button class="btn bad" id="om-close">${done ? 'CLOSE & SALVAGE' : 'DECOMMISSION'}</button>
        <button class="btn" id="om-x">CLOSE</button>
      </div>`);
    wireCrew('#modalwrap', m);
    const off = document.getElementById('om-off');
    if (off) off.onclick = () => {
      if (m.sto <= .01) return;
      const r = offload(m);
      if (r.ok) toast('🛢 <b>' + r.t + ' t of crude offloaded</b> — tanker freight ' + fmt$(r.fee) + '. It trades on the <b>ORE exchange</b> now.');
      openManage(m);
    };
    const ex = document.getElementById('om-exch');
    if (ex) ex.onclick = () => { try { if (window.EXCH) EXCH.open(); } catch (er) { } };
    const tp = document.getElementById('om-tp');
    if (tp) tp.onclick = () => travelTo(m);
    const cl = document.getElementById('om-close');
    if (cl) cl.onclick = () => { salvage(m, done); };
    const x = document.getElementById('om-x');
    if (x) x.onclick = closeModal;
  }
  // decommission / salvage — 60% of the price in cash, 60% of the
  // materials back to the shed, the tank offloaded first (freight-free:
  // the tanker comes for the steel anyway, the crude rides along). QA-
  // reachable as OIL.salvage.
  function salvage(m, done) {
    if (!m) return { ok: false, why: 'no rig' };
    const rfb = refundBill();
    const autoOff = m.sto > .01 ? +m.sto : 0;
    if (autoOff > 0) {                    // a direct pile, no freight — the tanker is already chartered
      m.sto = 0;
      try {
        if (window.EXCH) EXCH.pile('Oil', autoOff);
        else STATE.res['Oil'] = +(((+STATE.res['Oil']) || 0) + autoOff).toFixed(2);
      } catch (er) { }
    }
    const got = Math.round((m.price || 0) * SELL_BACK);
    STATE.rigs = rigs().filter(x => x !== m);
    if (got > 0) earn(got, false);               // salvage is resale — not GDP
    for (const k in rfb) if (rfb[k] > 0) STATE.mat[k] = Math.min(1e6, +((shed(k)) + rfb[k]).toFixed(1));
    try { saveGame(); } catch (er) { }
    disposeOne(m.id);
    try { closeModal(); } catch (er) { }
    const rf = Object.entries(rfb).map(([k, n]) => n + ' t ' + k.toLowerCase()).join(' + ');
    try {
      toast(done ? '<b>' + m.name + ' salvaged</b> — ' + fmt$(got) + ' for the steel' + (rf ? ' · ' + rf + ' back in the shed' : '') + (autoOff ? ' · tank offloaded first' : '') + '.'
        : '<b>' + m.name + ' decommissioned.</b> ' + fmt$(got) + ' salvage' + (rf ? ' · ' + rf + ' back in the shed' : '') + (autoOff ? ' · the tank was offloaded first' : '') + '.');
    } catch (er) { }
    return { ok: true, got, refund: rfb, offloaded: autoOff };
  }

  // ---- the OIL panel -------------------------------------------------------
  function openPanel() {
    if (STATE.mode !== 'city' || !WORLD.group) { toast('Enter the world first — a rig needs ocean under the survey.'); return; }
    const R = rigs();
    const rows = R.map((m, i) =>
      '<div class="kv"><span class="k">' + m.name + (m.near ? ' · off ' + m.near : '') + ' · ' + statusShort(m) + ' · tank ' + Math.round(100 * m.sto / CAP_T) + '%</span>' +
      '<button class="tpbtn" data-op="' + i + '">MANAGE</button></div>').join('');
    const tanked = tankedAll();
    const held = (window.EXCH ? +EXCH.held('Oil') : +((STATE.res || {})['Oil'] || 0)) || 0;
    const px = parOil();
    openModal('OFFSHORE — the oil fields', `
      <p>The ocean is a <b>field</b>. Build a rig on open water — at least ${SHORE_CLR} m off any coast, clear of your other rigs — hire the crew that pumps, and <b>crude stacks up in the rig's own tank</b> (${CAP_T.toLocaleString('en-US')} t) until you offload it to the <b>ORE exchange</b> for ${fmt$(FREIGHT)}/t freight. Wages and marine upkeep come due every game day; the field's pressure falls as it drains, and when it plays out only salvage is left.</p>
      ${rows ? '<div class="msec" style="margin-top:4px">Your rigs</div>' + rows +
      '<div class="kv" style="margin-top:10px"><span class="k">OFFSHORE OUTPUT</span><span class="v g">' + R.reduce((s, m) => s + (pumping(m) ? pumpTpd(m) : 0), 0).toFixed(0) + ' t/day pumped · ' + signedNet(R.reduce((s, m) => s + netOfDay(m), 0)) + '/day net</span></div>' : ''}
      <div class="kv" style="margin-top:8px"><span class="k">TANKED — ${tanked.toFixed(1)} t aboard your rigs${tanked > 0 ? ' ≈ ' + fmt$(tanked * px) + ' at par' : ''}</span><button class="tpbtn" id="op-off"${tanked > .01 ? '' : ' disabled'}>OFFLOAD ALL</button></div>
      <div class="kv"><span class="k">CRUDE STOCKPILE — ${held > 0 ? held.toFixed(1) + ' t ≈ ' + fmt$(held * px) + ' at par' : 'empty'}</span><button class="tpbtn" id="op-exch">SELL ON THE EXCHANGE</button></div>
      <div class="kv" style="margin-top:6px"><span class="k">PLATFORM BILL</span><span class="v">${fmt$(PRICE)} + ${Object.entries(BILL).map(([k, n]) => n + ' t ' + k.toLowerCase()).join(' + ')} · steel pulls from your exchange stockpile first</span></div>
      <button class="btn good" id="op-new" style="width:100%;margin-top:14px"${R.length >= MAX_RIGS ? ' disabled' : ''}>BUILD A RIG — PICK AN OFFSHORE SPOT</button>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="op-x" style="flex:1">CLOSE</button></div>`);
    document.getElementById('op-new').onclick = armPlacing;
    document.getElementById('op-x').onclick = closeModal;
    const off = document.getElementById('op-off');
    if (off) off.onclick = () => { offloadAll(); openPanel(); };
    const ex = document.getElementById('op-exch');
    if (ex) ex.onclick = () => { try { if (window.EXCH) EXCH.open(); } catch (er) { } };
    document.querySelectorAll('[data-op]').forEach(b => {
      b.onclick = () => { const m = rigs()[+b.dataset.op]; if (m) openManage(m); };
    });
  }

  // ---- travel (one world, one tap — the rig's twist on the mine's) ---------
  // A rig rides open water: the tycoon cannot walk there (water routing
  // is the point), and enterWorld never spawns anyone in the drink
  // (v2.19). So TELEPORT aims the CAMERA instead — the bird's-eye view
  // roams the whole planet, the platform stands in WORLD.group whatever
  // the focus, and [C] / FIND ME snaps back to the tycoon ashore.
  function travelTo(m) {
    if (!m) return;
    closeModal();
    const focus = () => {
      try {
        camCtl.follow = false;
        camCtl.tx = m.x; camCtl.tz = m.z;
        camCtl.distT = 170;                    // frame the platform
        ECO.arrivalPulse(m.x, m.z);
      } catch (er) { }
    };
    if (STATE.mode === 'city' && WORLD.group) {
      focus();
      toast('⚡ Camera on your <b>' + m.name + '</b> — the platform rides the open ocean. [C] or FIND ME returns to your tycoon.');
      return;
    }
    const c = nearestCity(m.x, m.z);
    if (!c) return;
    enterWorld({ key: c.c.key, name: c.c.name, lat: c.c.lat, lon: c.c.lon, tier: c.c.tier },
      { at: { x: m.x, z: m.z } });
    // the arrival watcher (the property pattern): when the world stands,
    // aim the camera at the rig — enterWorld's water snap keeps the
    // tycoon ashore, so only the view travels the last 100 km
    const t0 = Date.now();
    const w = () => {
      try {
        if (STATE.mode !== 'city' || !WORLD.group) {
          if (Date.now() - t0 < 45000) setTimeout(w, 500);
          return;
        }
        focus();
        toast('⚡ Camera on your <b>' + m.name + '</b> — the platform rides the open ocean. [C] or FIND ME returns to your tycoon.');
      } catch (er) { }
    };
    setTimeout(w, 800);
  }

  // ---- the Empire panel rows -------------------------------------------------
  function empireInto() {
    const body = document.getElementById('mbody');
    if (!body) return;
    const close = document.getElementById('em-x');
    const anchorEl = close ? close.parentElement : null;
    const R = rigs();
    const rows = R.map((m, i) =>
      '<div class="kv"><span class="k">' + m.name + ' · tank ' + Math.round(100 * m.sto / CAP_T) + '% · ' +
      (playedOut(m) ? 'played out' : m.walked ? 'crew walked off' : !crewOf(m) ? 'no crew — idle' : Math.round(pumpTpd(m)) + ' t/day') + '</span>' +
      '<button class="tpbtn" data-ot="' + i + '">TELEPORT</button></div>').join('');
    const tanked = tankedAll();
    const html = '<div class="msec" style="margin-top:14px">Offshore — your oil rigs</div>' +
      (rows || '<p>No rigs yet. Press the MINE button → OFFSHORE → BUILD A RIG on any spot of open ocean.</p>') +
      (rows ? '<div class="kv" style="margin-top:10px"><span class="k">OFFSHORE WORKS</span><span class="v g">' + R.reduce((s, m) => s + (pumping(m) ? pumpTpd(m) : 0), 0).toFixed(0) + ' t/day · ' + fmt$(valueOf()) + ' worth' + (tanked > .01 ? ' · ' + tanked.toFixed(0) + ' t tanked' : '') + '</span></div>' : '');
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    body.querySelectorAll('[data-ot]').forEach(b => {
      b.onclick = () => { travelTo(R[+b.dataset.ot]); };
    });
  }

  // ---- the MINE panel row (the WORKS pattern) ---------------------------------
  function mineInto() {
    const stake = document.getElementById('mp-stake');
    if (!stake) return;
    const R = rigs(), tanked = tankedAll();
    const html = '<div class="kv" style="margin-top:8px"><span class="k">OFFSHORE — ' + (R.length ? R.length + ' rig' + (R.length === 1 ? '' : 's') + ' pumping the ocean' + (tanked > .01 ? ' · ' + tanked.toFixed(0) + ' t tanked' : '') : 'oil rigs on the open water') + '</span><button class="tpbtn" id="mp-oil">OPEN</button></div>';
    stake.insertAdjacentHTML('beforebegin', html);
    const b = document.getElementById('mp-oil');
    if (b) b.onclick = () => { try { openPanel(); } catch (er) { } };
  }

  // ---- the hover tip -------------------------------------------------------------
  function tip(x, z) {
    if (STATE.mode !== 'city' || !WORLD.group) return null;
    const m = rigAt(x, z);
    if (!m) return null;
    const done = playedOut(m);
    return {
      t: m.name + ' — your rig',
      s: 'tank ' + Math.round(100 * m.sto / CAP_T) + '% of ' + CAP_T.toLocaleString('en-US') + ' t · 👷 ' + crewOf(m) + (m.near ? ' · off ' + m.near : ''),
      p: done ? 'played out — salvage it' : m.walked ? 'crew walked off' : !crewOf(m) ? 'idle — no crew' : m.sto >= CAP_T - .01 ? 'tanks full — offload to pump on' : Math.round(pumpTpd(m)) + ' t/day · ' + signedNet(netOfDay(m)) + '/day net',
      a: done ? '🛢 DRY' : !crewOf(m) ? '🛢 IDLE' : m.sto >= CAP_T - .01 ? '🛢 FULL' : '🛢 PUMPING',
      l: 'Click to manage',
    };
  }

  // ---- the click -------------------------------------------------------------------
  function click(cx, cy) {
    if (STATE.mode !== 'city' || !WORLD.group) return false;
    if (placing) {                     // while surveying, EVERY canvas click is ours
      const pt = screenToGround(cx, cy);
      if (!pt) { toast('Aim at the water — the camera needs to see the ocean.', 'warn'); return true; }
      placeClick(pt.x, pt.z);
      return true;
    }
    // never steal a click while another placer is armed
    try { if (window.MACH && MACH.placing()) return false; } catch (er) { }
    try { if (window.FACT && FACT.placing()) return false; } catch (er) { }
    try { if (window.BLD && BLD.arming()) return false; } catch (er) { }
    try { if (window.MINE) { const st = MINE.state(); if (st && (st.staking || st.placing)) return false; } } catch (er) { }
    const pt = screenToGround(cx, cy);
    if (!pt) return false;
    const m = rigAt(pt.x, pt.z);
    if (m) { openManage(m); return true; }
    return false;
  }

  // ---- the beat: pump, costs, walk-offs, played-out ---------------------------
  let toldFull = {};              // the tanks-full warning fires once per rig per fill
  function walkOff(m) {
    m.crew = 0; m.walked = true; m.wageAcc = 0;
    try { saveGame(); } catch (er) { }
    try { toast('🚧 <b>The ' + m.name + ' crew walked off</b> — payday came up short. Re-hire them when your balance can cover the running costs.', 'warn'); } catch (er) { }
  }
  function playedOutNow(m) {
    m.crew = 0; m.wageAcc = 0;
    try { saveGame(); } catch (er) { }
    try { toast('🛢 <b>' + m.name + ' played out</b> — the field ran dry and the crew is released. Offload the last of the tank and salvage the steel.', 'warn'); } catch (er) { }
  }
  function tick(dt) {
    try {
      if (WORLD.group !== root) {
        root = WORLD.group;
        disposeAll();
        killGhost();
        if (root) ensureAll();
      }
      const R = rigs();
      if (STATE.mode === 'city' && R.length) {
        acc += dt;
        if (acc >= 1) {
          const secs = acc; acc = 0;
          for (const m of R) {
            if (!m || playedOut(m)) continue;
            // the pump: crew-paced, pressure-scaled, tank-capped
            if (crewOf(m) > 0 && !m.walked && m.sto < CAP_T - .01) {
              let t = pumpTpd(m) / DAY * secs;
              t = Math.min(t, m.ore - m.got, CAP_T - m.sto);
              if (t > 0) {
                m.got = +(m.got + t).toFixed(2);
                m.sto = +(m.sto + t).toFixed(2);
                if (m.sto >= CAP_T - .01 && !toldFull[m.id]) {
                  toldFull[m.id] = true;
                  try { toast('<b>' + m.name + ': tanks full</b> — the pump is paused and the crew is paid to idle. Offload the crude to pump on.', 'warn'); } catch (er) { }
                }
                if (m.got >= m.ore) { playedOutNow(m); continue; }
              }
            } else if (m.sto < CAP_T - .01) toldFull[m.id] = false;
            // running costs accrue and come due as a full day's lump
            const due = costOfDay(m);
            if (due > 0) {
              m.wageAcc = +(((m.wageAcc || 0)) + due / DAY * secs).toFixed(2);
              if (m.wageAcc >= due) {
                if (STATE.money >= due) {
                  STATE.money = +(STATE.money - due).toFixed(2);
                  try { uiBalance(); } catch (er) { }
                  m.wageAcc = +(m.wageAcc - due).toFixed(2);
                } else { walkOff(m); continue; }
              }
            }
          }
        }
      } else acc = 0;
      // the ghost follows the cursor
      if (placing) updateGhost();
      // flare flickers, lights blink and deck hands bob while the crew pumps
      if (built.size) {
        const on = ((performance.now() / 650) | 0) % 2 === 0;
        const tnow = performance.now() / 1000;
        for (const [id, e] of built) {
          const m = rigs().find(x => x.id === id);
          const busy = m && pumping(m);
          try {
            if (e.flame) {
              e.flame.visible = !!busy;
              if (busy) e.flame.scale.set(1, .75 + Math.abs(Math.sin(tnow * 7 + 1)) * .6, 1);
            }
            for (const l of (e.lights || [])) l.visible = !!(on && m && crewOf(m) > 0 && !playedOut(m));
            for (const w of (e.wrk || [])) {
              w.visible = !!(m && crewOf(m) > 0 && !playedOut(m));
              if (w.visible) w.position.y = w.userData.y0 + Math.abs(Math.sin(tnow * 2 + (w.userData.ph || 0))) * .12;
            }
          } catch (er) { }
        }
      }
    } catch (er) { console.error('[oilrig]', er); }
  }

  // ---- the night shift (called from night.js settle) --------------------------
  // day by day: pump into the tank (capped), running costs due, walk-offs
  // honored, played-out released. A FULL TANK lays the crew up for the
  // remaining nights — no pumping, no charges (the mine's night-off rule,
  // applied to tanks instead of par prices).
  function nightSettle(days) {
    const out = { pumped: 0, wages: 0, upkeep: 0, walked: [], out: [], full: [] };
    if (!(days > 0)) return out;
    for (const m of rigs()) {
      if (!m || playedOut(m)) continue;
      for (let d = 0; d < days; d++) {
        if (playedOut(m)) break;
        if (m.sto >= CAP_T - .01) { if (out.full.indexOf(m.name) < 0) out.full.push(m.name); break; }   // lay-up: the tank is full, the crew stands down uncharged
        if (!(crewOf(m) > 0) || m.walked) break;
        const tons = Math.min(pumpTpd(m), m.ore - m.got, CAP_T - m.sto);
        const due = costOfDay(m);
        if (!(tons > 0)) {                        // nothing to pump — the crew stands down (no trap)
          if (out.full.indexOf(m.name) < 0) out.full.push(m.name);
          break;
        }
        if (STATE.money < due) {                  // payday came up short — the crew walks
          m.crew = 0; m.walked = true; m.wageAcc = 0;
          if (out.walked.indexOf(m.name) < 0) out.walked.push(m.name);
          break;
        }
        STATE.money = +(STATE.money - due).toFixed(2);
        out.wages += crewOf(m) * WAGE; out.upkeep += UPKEEP;
        m.got = +(m.got + tons).toFixed(2);
        m.sto = +(m.sto + tons).toFixed(2);
        out.pumped += tons;
        if (m.got >= m.ore) {
          m.crew = 0; m.wageAcc = 0;
          if (out.out.indexOf(m.name) < 0) out.out.push(m.name);
          break;
        }
      }
    }
    return out;
  }

  // ---- listeners (once) --------------------------------------------------------
  try {
    canvas.addEventListener('pointermove', e => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true });
    canvas.addEventListener('pointerleave', () => { lastPtr = null; }, { passive: true });
    window.addEventListener('keydown', e => {           // capture: ESC ends the survey
      if (e.key !== 'Escape' || !placing) return;
      const mw = document.getElementById('modalwrap');
      if (mw && !mw.classList.contains('hidden')) return;   // a real modal wins
      try { e.stopPropagation(); } catch (er) { }
      exitPlacing(false);
    }, true);
  } catch (er) { }

  // v2.62: crude joins the exchange's tradable list NOW, at boot — the
  // multipliers, board rows, WORTH term and SELL buttons pick it up from
  // this moment on (the Works pattern)
  try { EXCH.addGoods(['Oil']); } catch (er) { }

  return {
    openPanel, openManage, travelTo, tick, click, tip, empireInto, mineInto,
    nightSettle, offload, offloadAll, armPlacing, exitPlacing,
    crewOf, pumpTpd, pressureOf, costOfDay, netOfDay, valueOf, tankedAll,
    BASE, BILL, CAP: CAP_T, FULL_CREW, WAGE, UPKEEP, FREIGHT, PAR: BASE.Oil,
    list: () => rigs().slice(),
    count: () => rigs().length,
    // QA: programmatic build (same validation, same commit)
    build(x, z) { return buildRig(+x, +z); },
    // QA: spot validation with reasons
    spot(x, z) { const v = validateSpot(+x, +z); v.text = v.ok ? 'ok' : whyText(v); return v; },
    // QA: programmatic decommission (same math as the modal)
    salvage(id) { const m = rigs().find(x => x.id === id); return salvage(m, playedOut(m)); },
    // QA: programmatic hire (same clamps as the buttons)
    hire(id, n) {
      const m = rigs().find(x => x.id === id);
      if (!m) return { ok: false, why: 'no rig' };
      const before = crewOf(m);
      setCrew(m, n);
      return { ok: true, before, crew: crewOf(m), walked: !!m.walked };
    },
    // QA: run whole game-days of pumping instantly — the same rules as
    // the live beat (costs run while the crew is aboard, pumping or not;
    // walk-offs honored; tanks capped; fields played out)
    qaDay(n) {
      let pumped = 0, costs = 0, walked = 0, out = 0;
      for (let i = 0; i < (n || 1); i++) {
        for (const m of rigs()) {
          if (!m || playedOut(m)) continue;
          if (!(crewOf(m) > 0) || m.walked) continue;
          const due = costOfDay(m);
          if (STATE.money < due) { walkOff(m); walked++; continue; }
          STATE.money = +(STATE.money - due).toFixed(2);
          try { uiBalance(); } catch (er) { }
          costs += due;
          if (m.sto >= CAP_T - .01) continue;    // tank full — the crew is paid to idle
          const tons = Math.min(pumpTpd(m), m.ore - m.got, CAP_T - m.sto);
          if (!(tons > 0)) continue;
          m.got = +(m.got + tons).toFixed(2);
          m.sto = +(m.sto + tons).toFixed(2);
          pumped += tons;
          if (m.got >= m.ore) { playedOutNow(m); out++; }
        }
      }
      ensureAll();
      return { pumped: Math.round(pumped * 10) / 10, costs: Math.round(costs), walked, out };
    },
    state() {
      const R = rigs();
      return {
        rigs: R.length,
        crew: R.reduce((s, m) => s + crewOf(m), 0),
        pumpedT: Math.round(R.reduce((s, m) => s + (m.got || 0), 0) * 10) / 10,
        tankedT: +tankedAll().toFixed(1),
        heldT: (window.EXCH ? +(+EXCH.held('Oil')).toFixed(1) : 0),
        pumpedPerDay: Math.round(R.reduce((s, m) => s + (pumping(m) ? pumpTpd(m) : 0), 0)),
        costsPerDay: R.reduce((s, m) => s + costOfDay(m), 0),
        netPerDay: Math.round(R.reduce((s, m) => s + netOfDay(m), 0)),
        value: valueOf(),
        walked: R.filter(m => m.walked).length,
        playedOut: R.filter(m => playedOut(m)).length,
        placing: !!placing,
        accrual: +acc.toFixed(2),
      };
    },
  };
})();
window.OIL = OIL;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 1. the click chain: an oil-rig click runs FIRST (oilrig.js loads after
//    factory.js, so this wrap lands outside every other placer — before
//    the factory floor, the unit machines, the mine staking and the walk
//    orders) so surveying never walks the character. If the oil pass ever
//    throws, the original flow still runs.
const __oilClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (OIL.click(cx, cy)) return; } catch (e) { console.error('[oilrig]', e); }
  return __oilClickPick(cx, cy);
});
// 2. hover: the rig tip fills in wherever nothing older claims the point
const __oilHoverInfo = ECO.hoverInfo.bind(ECO);
ECO.hoverInfo = function (x, z) {
  const info = __oilHoverInfo(x, z);
  if (info) return info;
  try { return OIL.tip(x, z); } catch (e) { return null; }
};
// 3. the MINE panel gains the OFFSHORE row (above STAKE A CLAIM — the
//    Works pattern; oilrig.js loads after works.js, so the row lands
//    under THE WORKS' row, both above the stake button)
const __oilMinePanel = MINE.openPanel.bind(MINE);
MINE.openPanel = function () {
  __oilMinePanel();
  try { OIL.mineInto(); } catch (e) { console.error('[oilrig]', e); }
};
// 4. the Empire panel: your rigs, one tap away
const __oilEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __oilEmpire();
  try { OIL.empireInto(); } catch (e) { console.error('[oilrig]', e); }
};
// 5. the update chain: … → THE WORKS → GROUND UP → FACTORY FLOOR →
//    DEEP WATER. Every call is try/caught so an oilrig error can never
//    touch the world.
const __oilOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __oilOrigUpdate(dt, px, pz, camDist);
  try { OIL.tick(dt); } catch (e) { console.error('[oilrig]', e); }
  return req;
};
