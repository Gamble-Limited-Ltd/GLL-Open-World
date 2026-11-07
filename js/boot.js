// ====================================================================
// js/boot.js — the entry module (Stage 8 of the ES-module refactor).
// The import list below IS the module evaluation order — it mirrors
// the original openworld.html section order exactly (only OSM before
// EARTH: both are self-contained at load). After every module has
// evaluated, the late bindings resolve the forward references the
// original single script handled through closure scope, then the
// night shift settles and the ready log fires. No game logic here.
// ====================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GAME_VERSION, SAVE_KEY, CITIES, DEG_M, DEG_M_K, OLD_LAYOUT, WORLD_CONTS, WORLD_BOUNDS, ECON, R, COL, CUISINES, NAMES, COMMODITIES, ZOOM_MAX, CAM_FAR } from './config.js';
import { _ihash, _mulberry, hashStr, gcKmLL, worldAnchorOf, fmt$, fmt$2, fmtK, latLonToVec3, vec3ToLatLon, coordStr, latLonToWorld, _polyArea, VNUM } from './util.js';
import { STATE } from './state.js';
import { loadGame, saveGame, __late as saveLate } from './save.js';
import { spend, earn, uiBalance } from './systems/economy.js';
import { toast, openModal, closeModal, showTooltip, hideTooltip, veilOn, veilOff } from './ui/dom.js';
import { MARKET } from './systems/market.js';
import { LAND, LANDGEO } from './core.js';
import { OSM } from './world/osm.js';
import { EARTH } from './world/earth.js';
import { __late as worldLate, WORLD, camCtl } from './world/world.js';
import { CITY } from './world/city.js';
import { ACTORS } from './world/actors.js';
import { __late as ecoLate, ECO } from './systems/eco.js';
import { TUT } from './systems/tutorial.js';
import { canvas, renderer, camera, enterWorld } from './render/main.js';
import { __late as nightLate, NIGHT, clickPick, patchClickPick, screenToGround, ray, groundPlane } from './render/night.js';
import { WF } from './world/worldforest.js';   // original file position: after night, before openhouse; nothing else references WF
import { __late as ohLate, OH } from './systems/openhouse.js';
import { __late as propLate, PROP } from './systems/property.js';
import { __late as farmLate, FARM } from './systems/farmland.js';
import { MACH } from './systems/machines.js';
import { LORD } from './systems/landlord.js';
import { __late as mineLate, MINE } from './systems/mining.js';
import { __late as rivLate, RIVALS } from './systems/rivals.js';
import { __late as exchLate, EXCH } from './systems/exchange.js';
import { WORKS } from './systems/works.js';
import { BLD } from './systems/builder.js';
import { FACT } from './systems/factory.js';   // v2.61 FACTORY FLOOR — after builder (rides its live shells); wraps the click/empire/update chains
import { FURN } from './systems/furniture.js';
import { PWR } from './systems/power.js';

// ---- late binding -------------------------------------------------------
// The original single script resolved these forward references through
// closure scope at call time. Bound here, after every module has
// evaluated in file order and before any interaction can run.
saveLate({ ACTORS });
worldLate({ CITY });
ecoLate({ PWR, LORD });
nightLate({ PWR, MINE, BLD, EXCH, RIVALS, MACH, FURN });
ohLate({ PROP });
propLate({ MACH, LORD, FURN });
farmLate({ LORD });
mineLate({ EXCH });
rivLate({ EXCH, BLD, FURN });
exchLate({ WORKS });

try { NIGHT.settle(); } catch (e) { console.error('[night]', e); }   // v2.55 NIGHT SHIFT: settle the offline gap — invoked here, at the END of the module, so ECO/MINE/WORKS are all up (the boot screen blocks until the ready log, so no click can beat it)
console.log('%cOPEN WORLD v2.61 — FACTORY FLOOR', 'color:#38BDF8;font-weight:700', 'ready.');
