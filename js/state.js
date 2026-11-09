// ====================================================================
// js/state.js — the single shared mutable STATE object (Stage 4).
// All cross-system game state lives here; save.js loads into it.
// ====================================================================
import { ECON } from './config.js';

// ---- global state --------------------------------------------------
export const STATE = {
  name: '', money: ECON.startMoney, gdp: 0,
  mode: 'boot',                  // boot | globe | city | diving
  city: null,                    // active city record + runtime
  placing: null,                 // {kind:'cart'|'plot'} while placing
  plots: [],                     // owned: {id, cityKey, x, z(world), cart:{cuisine}, crew:[], office?}
  offices: [],                   // leased: {id, cityKey, bkey, name, sqm, rate}
  rooms: [],                     // v2.43 TITLE DEEDS: bought/rented units {id, cityKey, cityName, bkey, kind:'floor'|'room', index, name, area, rate, mode:'owned'|'rented', price, x, z} · v2.45 machines · v2.57 FURNITURE: furn pieces {t,x,z,r,fl,craft}
  acres: [],                     // v2.44 PATCHWORK: bought farm parcels {id, name, ha, price, rate, x, z, near, nearKey}
  rentals: [],                   // v2.47 LANDLORD: listings {id, price, on, tenant, term, next}
  mines: [],                     // v2.48 MOTHERLODE: staked mining claims {id, name, x, z, w, d, price, grade, ore, got, machines} · v2.50 HIRED HANDS: crew, walked, wageAcc
  rivals: [],                    // v2.51 MONEY LIST: the fifteen rival fortunes by roster slot (worth only — names/trades live in code)
  res: {},                       // v2.52 ORE EXCHANGE: the resource stockpile {resource: tonnes} — what your mines dug, unsold
  mkt: {},                       // v2.52 ORE EXCHANGE: the market multipliers {resource: {m, pm}} — today's and yesterday's rate around par
  works: {},                     // v2.53 THE WORKS: the refining machine counts {machineId: n}
  rigs: [],                      // v2.62 DEEP WATER: the offshore oil rigs {id, name, x, z, price, ore, got, crew, walked, wageAcc, sto, near, nearKey} — tanked crude + the field's reserve
  mat: { Wood: 0, Stone: 0, Steel: 0, Glass: 0 },   // v2.56 GROUND UP: the materials shed — tonnes of wood/stone/steel/glass for construction
  pow: { g: { m: 1, pm: 1 }, b: {} },   // v2.59 THE GRID: the power state — grid price multiplier {m, pm} + per-business meters {plotId: {m, cut, due}}
  gfx: { shadows: true, trees: true, scale: 1, lite: false },   // v2.66 PICTURE: the graphics levers behind the Help tab's GRAPHICS button — saved with the world
  market: null,                  // MARKET module state (positions/orders)
  lastCityKey: null,
  seenNews: false,
  tut: { step: 0, done: false },   // v2.05 starter-guide progress
  playerW: null, playerZ: null,  // last world position (v2.15 saves)
};
