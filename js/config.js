// ====================================================================
// js/config.js — the game's static catalog, extracted VERBATIM from
// openworld.html v2.59 (Stage 2 of the ES-module refactor): version,
// save key, the 64-city catalog + projection constants, economy
// tuning, palettes, cuisines, name pool, commodities, zoom limits.
// Pure data — no imports.
// ====================================================================

export const GAME_VERSION = 'v2.68';
export const SAVE_KEY = 'openworld-v2';
// ---- city catalog: [name, lat, lon, tier] (public geographic facts)
export const RAW_CITIES = [
  ['New York', 40.71, -74.01, 3], ['Los Angeles', 34.05, -118.24, 3],
  ['Chicago', 41.88, -87.63, 2], ['Toronto', 43.65, -79.38, 2],
  ['Mexico City', 19.43, -99.13, 3], ['San Francisco', 37.77, -122.42, 2],
  ['Miami', 25.76, -80.19, 1], ['Houston', 29.76, -95.37, 1],
  ['Vancouver', 49.28, -123.12, 1], ['Montreal', 45.50, -73.57, 1],
  ['Havana', 23.11, -82.37, 1], ['Las Vegas', 36.17, -115.14, 1],
  ['Sao Paulo', -23.55, -46.63, 3], ['Buenos Aires', -34.60, -58.38, 2],
  ['Rio de Janeiro', -22.91, -43.17, 2], ['Lima', -12.05, -77.04, 2],
  ['Bogota', 4.71, -74.07, 2], ['Santiago', -33.45, -70.67, 2],
  ['Quito', -0.18, -78.47, 1], ['Caracas', 10.48, -66.90, 1],
  ['London', 51.51, -0.13, 3], ['Paris', 48.86, 2.35, 3],
  ['Berlin', 52.52, 13.40, 2], ['Madrid', 40.42, -3.70, 2],
  ['Rome', 41.90, 12.50, 2], ['Moscow', 55.76, 37.62, 3],
  ['Istanbul', 41.01, 28.98, 2], ['Amsterdam', 52.37, 4.90, 1],
  ['Vienna', 48.21, 16.37, 1], ['Stockholm', 59.33, 18.07, 1],
  ['Athens', 37.98, 23.73, 1], ['Lisbon', 38.72, -9.14, 1],
  ['Kyiv', 50.45, 30.52, 1], ['Dublin', 53.35, -6.26, 1],
  ['Zurich', 47.37, 8.54, 1], ['Oslo', 59.91, 10.75, 1],
  ['Cairo', 30.04, 31.24, 3], ['Lagos', 6.52, 3.38, 2],
  ['Johannesburg', -26.20, 28.05, 2], ['Nairobi', -1.29, 36.82, 1],
  ['Casablanca', 33.57, -7.59, 1], ['Addis Ababa', 9.01, 38.76, 1],
  ['Dubai', 25.20, 55.27, 2], ['Riyadh', 24.71, 46.68, 1],
  ['Tehran', 35.69, 51.39, 2], ['Tel Aviv', 32.09, 34.78, 1],
  ['Tokyo', 35.68, 139.69, 3], ['Seoul', 37.57, 126.98, 2],
  ['Beijing', 39.90, 116.41, 3], ['Shanghai', 31.23, 121.47, 3],
  ['Hong Kong', 22.32, 114.17, 2], ['Singapore', 1.35, 103.82, 2],
  ['Bangkok', 13.76, 100.50, 2], ['Mumbai', 19.08, 72.88, 2],
  ['Delhi', 28.61, 77.21, 3], ['Karachi', 24.86, 67.01, 1],
  ['Manila', 14.60, 120.98, 2], ['Jakarta', -6.21, 106.85, 2],
  ['Kuala Lumpur', 3.14, 101.69, 1], ['Taipei', 25.03, 121.57, 1],
  ['Sydney', -33.87, 151.21, 2], ['Melbourne', -37.81, 144.96, 2],
  ['Auckland', -36.85, 174.76, 1], ['Perth', -31.95, 115.86, 1],
];
export const CITIES = RAW_CITIES.map((r, i) => ({
  idx: i, name: r[0], lat: r[1], lon: r[2], tier: r[3],
  key: r[0].toLowerCase().replace(/[^a-z]+/g, ''),
}));
// ---- v2.18 PLANET EARTH: real positions -------------------------------
// wx/wz = world meters on a true equirectangular projection of the whole
// planet — the same projection as the coastlines, so the planet you
// orbit is the planet you walk.
// v2.27 TRUE SCALE: DEG_M is the real size of one degree — 111,320 m.
// The world is now 1:1 with the actual Earth: 40,007 km around the
// equator, Chicago really ~940 km from Toronto, and the OSM city
// inserts (which were ALWAYS true meters) finally sit on the same
// scale as the planet under them. World coordinates run to
// ±20 million meters, so every chunk of geometry is built in a
// LOCAL frame (tile / chunk / anchor) and positioned in double
// precision — see the per-tile land builder and CITY's AX/AZ.
export const DEG_M = 111320;
// v2.26 and earlier built the world at 550 m per degree; saves from
// those builds are migrated by multiplying world coordinates by K.
export const DEG_M_OLD = 550, DEG_M_K = DEG_M / DEG_M_OLD;
// the old stylized layout — kept ONLY to migrate pre-Earth saves
export const OLD_LAYOUT = [  [-4332, -2319], [-10325, -240], [-7033, -1651], [-5917, -2933],
  [-8213, 1683], [-11064, -1791], [-4988, 627], [-8222, -420],
  [-10848, -3566], [-4555, -4004], [-4882, 2324], [-9368, -1675],
  [-3892, 4412], [-4315, 6059], [-2201, 4237], [-6439, 3576],
  [-6633, 182], [-5987, 5748], [-6523, 1878], [-5445, -1034],
  [-2913, -3567], [-2690, -1883], [430, -4184], [-2722, 729],
  [-551, 759], [4963, -4437], [5088, -1686], [-1250, -3920],
  [659, -2500], [1532, -5478], [2152, 1752], [-3801, -590],
  [4021, -3022], [-3313, -5219], [-1026, -2235], [-639, -5507],
  [45, -915], [-1447, 2204], [786, 4846], [1626, 3368],
  [-1618, -564], [489, 2104], [4473, -101], [1112, 408],
  [2336, -2782], [1726, -1177], [9432, -1562], [8343, -2882],
  [6574, -3143], [7247, -1582], [6670, 16], [6580, 2589],
  [5516, 1264], [3831, 1492], [3406, -1437], [2791, 148],
  [7734, 1342], [5935, 4163], [4871, 2837], [8349, -252],
  [9494, 4490], [8183, 5572], [13136, 5244], [3647, 4210],];
// continent label anchors [name, x, z] — v2.18: real geography
export const WORLD_CONTS = [
  ['North America', -100 * DEG_M, -45 * DEG_M], ['Latin America', -60 * DEG_M, 12 * DEG_M],
  ['Europe', 15 * DEG_M, -52 * DEG_M], ['Africa & Middle East', 25 * DEG_M, -7 * DEG_M],
  ['Asia', 95 * DEG_M, -45 * DEG_M], ['Oceania', 140 * DEG_M, 26 * DEG_M],
  ['Antarctica', 0, 74 * DEG_M],
];
// world bounds (v2.18): the whole planet, pole to pole
export const WORLD_BOUNDS = { x0: -180 * DEG_M, x1: 180 * DEG_M, z0: -90 * DEG_M, z1: 90 * DEG_M };
// ---- economy config ------------------------------------------------
export const ECON = {
  startMoney: 8000,
  plotBase: 1400,               // base plot price (scales with city tier)
  ruralFactor: .55,             // countryside plots are cheaper
  cartCost: 2500, permitCost: 500,
  officeBase: 90,               // $/day per suite, scales with size & city tier
  serveTipMin: .8, serveTipMax: 2.6,
  vendorWagePerMin: .22,        // paid only while producing
  custSpawnMin: 4.5, custSpawnMax: 8.0,   // seconds between customers
  custPatience: 26,             // seconds before walking away
  vendorInterval: 7.8,          // seconds between vendor serves
  patienceMax: 26,
};
// v2.04: hover prefetch
export const R = 100;
// bright toy-globe colors (Capital Rift bright-flat daylight direction)
export const COL = { ocean: '#2C7BB9', ocean2: '#24689F', land: '#58913C', land2: '#4A8134', node: '#22D3EE', owned: '#48BB78', here: '#F5CC74' };
// ---------------- cuisines -------------------------------------------
export const CUISINES = [
  { id: 'hotdog', name: 'Hot Dog', emoji: '🌭', color: 0xd64545, umbrella: 0xf2f2f2,
    menu: [['Classic dog', 6.5, .9], ['Chili dog', 9.0, .75], ['Bratwurst', 8.5, .7], ['Dodger dog', 11.0, .55], ['Veggie dog', 7.0, .5]] },
  { id: 'taco', name: 'Taco', emoji: '🌮', color: 0xe0873c, umbrella: 0x2f8f8f,
    menu: [['Street taco', 5.5, .95], ['Al pastor', 7.5, .8], ['Carne asada', 8.5, .7], ['Baja fish', 9.5, .6], ['Birria', 12.0, .5]] },
  { id: 'sushi', name: 'Sushi', emoji: '🍣', color: 0x4a8f7a, umbrella: 0xf2f2f2,
    menu: [['Salmon nigiri', 8.0, .9], ['California roll', 9.5, .8], ['Spicy tuna', 11.0, .7], ['Bento box', 15.0, .6], ['Omakase bite', 18.0, .5]] },
  { id: 'burger', name: 'Burger', emoji: '🍔', color: 0xb0563c, umbrella: 0xf5cc74,
    menu: [['Slider', 5.0, .9], ['Cheeseburger', 8.0, .85], ['Double smash', 11.5, .7], ['Bacon deluxe', 13.0, .6], ['Truffle burger', 16.0, .5]] },
  { id: 'pizza', name: 'Pizza', emoji: '🍕', color: 0xd64545, umbrella: 0xe8e4dc,
    menu: [['Slice', 4.5, .95], ['Margherita', 9.0, .8], ['Pepperoni', 10.0, .75], ['Sicilian', 12.0, .6], ['Whole pie', 24.0, .5]] },
  { id: 'coffee', name: 'Coffee', emoji: '☕', color: 0x6b4f3a, umbrella: 0xf2f2f2,
    menu: [['Drip', 3.5, .95], ['Latte', 5.5, .85], ['Cappuccino', 5.0, .8], ['Cold brew', 6.0, .65], ['Espresso', 3.0, .6]] },
  { id: 'icecream', name: 'Ice Cream', emoji: '🍦', color: 0x8f6bb0, umbrella: 0xf5cc74,
    menu: [['Soft serve', 4.0, .9], ['Waffle cone', 6.5, .8], ['Sundae', 8.0, .7], ['Gelato duo', 9.5, .6], ['Banana split', 12.0, .5]] },
];
export const NAMES = ['Cyrus', 'Dakota', 'Kai', 'Maya', 'Leo', 'Zara', 'Otto', 'Ivy', 'Hugo', 'Nina', 'Felix', 'Ruby', 'Ezra', 'Lola', 'Silas', 'Juno', 'Amos', 'Cleo', 'Rex', 'Vera', 'Otis', 'Pia', 'Bram', 'Suki', 'Dov', 'Freya', 'Gus', 'Hana', 'Ike', 'Mona'];
export const COMMODITIES = [
  { sym: 'HDG', name: 'Hot Dogs', base: 6.5 },
  { sym: 'BUN', name: 'Buns', base: 2.1 },
  { sym: 'KCH', name: 'Ketchup', base: 1.8 },
  { sym: 'CTL', name: 'Cola', base: 0.95 },
  { sym: 'SGD', name: 'Sausages', base: 4.2 },
];
// v2.37 WHOLE-WORLD ZOOM: "allow me to zoom out farther" — the ceiling
// lifts from 34 km to 23,000 km: the FULL flat Earth (40,075 km wide,
// 20,038 km tall) fits in one overhead view at el 1.5, with every
// altitude in between on the same wheel. The far plane spans 56,000 km
// so even a tilted whole-world view keeps every corner of the planet
// inside the clip (log depth keeps the streets crisp at the bottom of
// the same range — same renderer, same near plane).
export const ZOOM_MAX = 23000000;
export const CAM_FAR = 56000000;
