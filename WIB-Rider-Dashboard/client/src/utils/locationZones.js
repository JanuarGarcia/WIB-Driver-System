const ZONE_TOKENS = {
  trinidad: [
    'la trinidad',
    'trinidad',
  ],
  brookside: [
    'brookspoint', 'brookside', 'guevarra', 'bugallon', 'ledesma', 'ambiong', 'evangelista',
    'leonila hill', 'leonila', 'trancoville', 'sanitary', 'happy homes', 'yap', 'lopez',
    'rimando', 'fatima', 'aurora', 'aurorahill', 'malvar', 'bayan', 'quisumbing', 'manuel',
    'new lucban', 'caguioa', 'courtyards goshenland', 'floresca',
  ],
  pacdal: [
    'cabinet hill', 'cabinethill', 'north drive', 'dominica lane', 'mines view', 'minesview',
    'bcc village', 'ignacio villamor', 'honeymoon', 'morning', 'sunflower', 'calalily', 'navy',
    'recto', 'siapno', 'pacdal', 'amsing', 'liteng', 'basa', 'regidor', 'gibraltar', 'julian',
    'castro', 'baltazar', 'lualhati', 'lulhati', 'romulo', 'ambuklao', 'outlook', 'apostol',
    'moran', 'arellano', 'modesda', 'leonard', 'teacher', 'teachers', 'paterno', 'gomez',
    'singian', 'poblete', 'country', 'itogon', 'ignacio',
  ],
  session: [
    'holy ghost', 'imelda village', 'general luna', 'diego silang', 'governor pack', 'happy glen',
    'happy queen', 'jungletown', 'bagumbayan', 'assumption', 'lapu lapu', 'father carlu', 'slu hospital',
    'sacred heart baguio', 'our lady of atonement', 'notre dame', 'megatower', 'brentwood', 'laubach',
    'harrison', 'claudio', 'sandico', 'sumulong', 'bonifacio', 'jungle', 'valenzuela', 'bagong',
    'mabini', 'tecson', 'laurel', 'lakandula', 'brent', 'yangco', 'luna', 'ghost', 'tulip',
  ],
  alonzo: [
    'justice hall', 'city hall', 'camp allen', 'victoria village', 'pleasantville', 'green lane',
    'tangerine', 'gumamela', 'dahlia', 'calla', 'white', 'rose', 'lily', 'sepic', 'sixto', 'gaerlan',
    'ayson', 'manzanilo', 'rivera', 'badihoy', 'pucay', 'avelino', 'fairview', 'cerise', 'burgundy',
    'million', 'bado', 'quezon', 'ponce', 'manzanilo', 'alonzo', 'bokawkan', 'kayang', 'zamora',
    'hilltop', 'burgos', 'buhagan', 'easter', 'ferguson', 'may', 'april', 'july', 'roman', 'leonor',
  ],
  pinsao: [
    'gabriela silang street', 'gabriela silang st', 'private road', 'slaughterhouse', 'tam-awan',
    'purok magsaysay', 'heavenly', 'sunshine', 'sunrise', 'pinsao', 'pinget', 'aguila', 'maya',
    'loro', 'kalapati', 'kanaryu', 'adarna', 'pilot', 'maligcong', 'emerald', 'camdas', 'quirino',
    'tandang', 'main', 'tacay', 'supreme', 'long', 'magsaysay', 'slaughter', 'manzanilo',
    'norway', 'aspen', 'pacific', 'yew', 'willow',
  ],
  engineer: [
    "engineer's", 'engineer’s', 'engineer', 'convention center', 'marcoville', 'south drive',
    'quinto', 'forestry', 'micael', 'villalon', 'utility', 'martinez', 'dps', 'kalaw', 'up',
    'goverment', 'government', 'military', 'wagner', 'escolastica', 'greenwater', 'green water',
    'hillside', 'manalo alley',
  ],
  loakan: [
    'liwanag-loakan', 'camp john hay baguio', 'gabriela silang road', 'springhills', 'pinesville',
    'demonstration', 'crestwood', 'shiemadez', 'johnmary', 'kadaclan', 'apugan', 'liwanag', 'cudirao',
    'loakan', 'bubun', 'balete', 'scout', 'ordonio', 'eastern', 'atok', 'pma', 'fort', 'kias',
    'alnos', 'ipil', 'narra', 'balatoc', 'alphaville',
  ],
  camp7: [
    'baguio general hospital', 'home sweet home', 'san vicente', 'sn.vicente', 'camp 8', 'camp 7',
    'fil-am', 'kennon', 'kenon', 'puliwes', 'poliwes', 'balsigan', 'woodsgate', 'youngland',
    'verdepino', 'centrium.', 'centrum', 'mangitit', 'petersville', 'douglas', 'giant', 'sequoia',
    'fir', 'mino', 'sarok', 'parisas', 'dagsian', 'tames', 'tony', 'pias', 'amparo', 'peter',
    'jude', 'alexandria', 'luke', 'philip', 'benedict', 'agnes', 'bernard', 'donamar', 'lexber',
    'amistad', 'monticello', 'golden', 'ebony', 'loblolly', 'milk', 'pepper', 'violet', 'chesnut',
    'oak', 'spruce', 'bghmc', 'bgh', 'vicente',
  ],
  citycamp: [
    'everlasting street', 'everlasting st', 'happy homes subd', 'cooyeesan', 'shangrila', 'city camp',
    'montinola', 'carino', 'quarry', 'lourdes', 'bukaneg', 'doctor', 'camella', 'magnolia', 'gladiola',
    'dominican', 'mirador', 'katmandu', 'labsan', 'hamada', 'mystical', 'tibet', 'queen', 'palma',
    'otek', 'pinpin', 'nacnac', 'urbano', 'legarda', 'felipe', 'jose', 'blue', 'yellow', 'bright',
    'rock', 'angels', 'dahlia', 'kisad', 'qm',
  ],
  bakakeng: [
    'santo tomas road', 'forest gold', 'justice village', 'bayanihan drive', 'george drive',
    'lodge pole pine', 'white elm', 'black ash', 'red elm', 'iron wood', 'misereor', 'santo tomas',
    'bakakeng', 'declerq', 'fairbreeze', 'bass', 'parana', 'cabato', 'buckeye', 'persimmon',
    'limburg', 'm & r', 'cicm', 'bougainville', 'bareng', 'carnation', 'cosmos', 'milflores',
    'cuenca', 'barciluna',
  ],
  irisanGradient: [
    'quirino highway', 'bauang - baguio', 'st. joseph street', 'bernardo calatan sreet',
    'san carlos heights', 'police village road', 'mulberry alley', 'cherry blossoms street',
    'kalye diretso', 'sariling sikap', 'muslim village', 'kiangan village', 'up village',
    'genesis point', 'tengdowroad', 'marville street', 'catalino drive', 'munoz drive',
    'naguilian', 'baguio cemetery', 'bauang', 'lamtang', 'kafagway', 'irisan', 'agro', 'argo',
    'la chesa', 'ambayao', 'osio', 'mang-os', 'calgryp', 'conon', 'tacio', 'luna street',
    'balenben', 'pshs', 'smith road', 'add road', 'jade', 'pearl', 'amethyst', 'sapphire',
    'onyx', 'diamond', 'aquamarnie', 'idogan', 'anthony', 'patrick', 'san luis', 'sampaguita',
    'camia', 'ilang-ilang', 'reyes',
  ],
  campo: [
    'green valley village', "teacher's village", 'westside route', 'marcos highway', 'pnb village',
    'crystal cave', 'mission road', 'pinewook street', 'remedios hill', 'elizabeth court',
    'balballo-licano', 'bradley-acay', 'f.r della', 'ridge view', 'greenvalley', 'western link',
    'sto. rosario', 'campo sioco', 'rosario', 'chapis', 'kitma', 'guia lane', 'crystal', 'cobble',
    'sprint water', 'foot hill', 'bengao', 'terry court', 'leafy lane', "ben's court", 'chapis village',
    'agoo', 'atab west', 'palispis', 'adiwang', 'rockvalley', 'aurello', 'dongpapen', 'della',
    'tello street', 'balusdan', 'interior a', 'interior b', 'interior c', 'roseville', 'balacbac',
    'tuba', 'green valley',
  ],
  asin: [
    'asin rd', 'san roque', 'roque', 'asin',
  ],
};

const SHORT_TOKEN_ALLOWLIST = new Set([
  'up', 'qm', 'bgh', 'pma',
]);

const AMBIGUOUS_TOKENS = new Set([
  'luna', 'white', 'dahlia', 'camia', 'main', 'long', 'doctor', 'blue', 'yellow', 'rock',
  'ghost', 'country', 'teacher', 'teachers', 'pilot', 'emerald', 'jade', 'pearl',
  'onyx', 'diamond', 'sapphire', 'rose', 'lily', 'oak', 'fir', 'golden',
]);

function shouldKeepToken(rawToken) {
  const token = normalizeLocationText(rawToken);
  if (!token) return false;
  if (AMBIGUOUS_TOKENS.has(token)) return false;
  if (token.length < 4 && !SHORT_TOKEN_ALLOWLIST.has(token)) return false;
  return true;
}

const PRIORITY_OVERRIDES = [
  // Session / CBD
  ['general luna', 'session'],
  ['governor pack', 'session'],
  ['harrison', 'session'],
  ['holy ghost', 'session'],
  // Pacdal / Outlook / Mines
  ['mines view', 'pacdal'],
  ['minesview', 'pacdal'],
  ['cabinet hill', 'pacdal'],
  ['outlook', 'pacdal'],
  // Camp 7/8 corridor
  ['camp 7', 'camp7'],
  ['camp 8', 'camp7'],
  ['kenon', 'camp7'],
  ['kennon', 'camp7'],
  ['bghmc', 'camp7'],
  ['baguio general hospital', 'camp7'],
  // Loakan / John Hay
  ['camp john hay', 'loakan'],
  ['john hay', 'loakan'],
  ['loakan', 'loakan'],
  ['liwanag-loakan', 'loakan'],
  // City camp cluster
  ['city camp', 'citycamp'],
  ['dominican', 'citycamp'],
  ['legarda', 'citycamp'],
  ['lourdes', 'citycamp'],
  // Irisan / Naguilian gradient zone
  ['quirino highway', 'irisanGradient'],
  ['naguilian', 'irisanGradient'],
  ['irisan', 'irisanGradient'],
  ['kafagway', 'irisanGradient'],
  // Campo/Marcos slope cluster
  ['campo sioco', 'campo'],
  ['sto rosario', 'campo'],
  ['sto. rosario', 'campo'],
  ['marcos highway', 'campo'],
  ['green valley', 'campo'],
  // Bakakeng / Sto Tomas cluster
  ['bakakeng', 'bakakeng'],
  ['santo tomas', 'bakakeng'],
  ['sto tomas', 'bakakeng'],
  ['santo tomas road', 'bakakeng'],
  // Out-of-core zones
  ['la trinidad', 'trinidad'],
  ['asin rd', 'asin'],
  ['asin', 'asin'],
];

const PRIORITY_ENTRIES = PRIORITY_OVERRIDES
  .map(([token, zone]) => [normalizeLocationText(token), zone])
  .sort((a, b) => b[0].length - a[0].length);

const TOKEN_ENTRIES = Object.entries(ZONE_TOKENS)
  .flatMap(([zone, tokens]) => (
    tokens
      .filter((token) => shouldKeepToken(token))
      .map((token) => [normalizeLocationText(token), zone])
  ))
  .sort((a, b) => b[0].length - a[0].length);
const LOCATION_ZONE_CACHE = new Map();
const LOCATION_ZONE_CACHE_LIMIT = 1000;

export function normalizeLocationText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,]/g, ' ')
    .replace(/[^a-z0-9\s\-&/']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getLocationZone(location = '') {
  const text = normalizeLocationText(location);
  if (!text) return 'default';
  if (LOCATION_ZONE_CACHE.has(text)) return LOCATION_ZONE_CACHE.get(text);
  let resolved = 'default';
  for (const [token, zone] of PRIORITY_ENTRIES) {
    if (!token) continue;
    if (hasTokenMatch(text, token)) {
      resolved = zone;
      break;
    }
  }
  if (resolved === 'default') {
    for (const [token, zone] of TOKEN_ENTRIES) {
      if (!token) continue;
      if (hasTokenMatch(text, token)) {
        resolved = zone;
        break;
      }
    }
  }
  if (LOCATION_ZONE_CACHE.size >= LOCATION_ZONE_CACHE_LIMIT) {
    // Keep memory bounded for long dashboard sessions.
    LOCATION_ZONE_CACHE.clear();
  }
  LOCATION_ZONE_CACHE.set(text, resolved);
  return resolved;
}

function hasTokenMatch(text, token) {
  const boundaryPattern = new RegExp(`(^|\\s)${escapeRegExp(token)}(\\s|$)`, 'i');
  return boundaryPattern.test(text) || text.includes(token);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ZONE_LABELS = {
  default: 'Location',
  trinidad: 'La Trinidad',
  brookside: 'Brookside',
  pacdal: 'Pacdal',
  session: 'Session/Holy Ghost',
  alonzo: 'Alonzo/Bokawkan',
  pinsao: 'Pinsao/Magsaysay',
  engineer: 'Engineer Hill',
  loakan: 'Loakan',
  camp7: 'Camp 7/8',
  citycamp: 'City Camp',
  bakakeng: 'Bakakeng',
  irisanGradient: 'Irisan/Naguilian',
  campo: 'Campo Sioco/Marcos',
  asin: 'Asin',
};

export function getLocationZoneLabel(zone) {
  return ZONE_LABELS[zone] || ZONE_LABELS.default;
}
