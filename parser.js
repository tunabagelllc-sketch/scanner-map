// Turns a radio transmission (plain text) into an incident: type, location text, units.

const TYPES = [
  { type: 'Shooting', color: '#b91c1c', re: /\b(shots? fired|shooting|gunshot|gsw|person shot)\b/i },
  { type: 'Fire', color: '#ea580c', re: /\b(fire|smoke|flames|burning|working fire|alarm activation)\b/i },
  { type: 'Crash', color: '#ca8a04', re: /\b(mva|mvc|accident|collision|crash|vehicle (?:vs|versus)|rollover|hit and run|pedestrian struck)\b/i },
  { type: 'Medical', color: '#2563eb', re: /\b(medical|ems|cardiac|unconscious|unresponsive|not breathing|overdose|od|seizure|fall victim|chest pain|difficulty breathing|injur(?:y|ed))\b/i },
  { type: 'Crime', color: '#7c3aed', re: /\b(robbery|burglary|theft|assault|stabbing|break[- ]in|suspicious|domestic|fight|larceny|carjacking|shoplift)\b/i },
  { type: 'Hazard', color: '#0d9488', re: /\b(gas leak|hazmat|wires down|tree down|flood(?:ing)?|water main|odor of gas)\b/i },
  { type: 'Rescue', color: '#db2777', re: /\b(rescue|entrapment|trapped|water rescue|missing person)\b/i },
];
const OTHER = { type: 'Other', color: '#4b5563' };

const SUFFIX = '(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|place|pl|court|ct|parkway|pkwy|highway|hwy|terrace|ter|circle|cir|expressway|expy|turnpike|tpke|route|rte)';
// A street-name word: anything but filler words that precede locations in radio traffic.
const WORD = "(?!(?:at|on|to|and|the|for|of|near|respond|responding|in|a|an|with|from|copy|report|reports|by)\\b)[A-Za-z0-9.'-]+";
const STREET = `(?:[NSEW]\\.?\\s+)?${WORD}(?:\\s+${WORD}){0,3}?\\s+${SUFFIX}\\.?`;

const ADDRESS_RE = new RegExp(`\\b(\\d{1,6}[A-Za-z]?\\s+${STREET})(?=\\W|$)`, 'i');
const INTERSECTION_RE = new RegExp(`\\b(${STREET})\\s*(?:and|&|/|at)\\s*(${STREET})(?=\\W|$)`, 'i');
const PREPOSITION_RE = /\b(?:at|on|to|corner of|near|in front of|vicinity of|location)\s*:?\s+([A-Z0-9][^,.;!?\n]{2,60}?)(?=[,.;!?\n]|\s+(?:for|with|reports?|reporting|caller|units?|respond|responding|copy|en route)\b|$)/;
const UNIT_RE = /\b(engine|ladder|truck|medic|rescue|squad|battalion|ambulance|car|unit|tower|tanker)\s*-?\s*(\d{1,4})\b/gi;

function classify(text) {
  return TYPES.find(t => t.re.test(text)) || OTHER;
}

function extractLocation(text) {
  const inter = text.match(INTERSECTION_RE);
  if (inter) return { kind: 'intersection', text: `${clean(inter[1])} & ${clean(inter[2])}`, streets: [clean(inter[1]), clean(inter[2])] };
  const addr = text.match(ADDRESS_RE);
  if (addr) return { kind: 'address', text: clean(addr[1]) };
  const prep = text.match(PREPOSITION_RE);
  if (prep) return { kind: 'place', text: clean(prep[1]) };
  return null;
}

function extractUnits(text) {
  const units = new Set();
  for (const m of text.matchAll(UNIT_RE)) units.add(`${cap(m[1])} ${m[2]}`);
  return [...units];
}

function parseTransmission(text) {
  const t = classify(text);
  // Drop callsigns ("Medic 12") so their numbers are not read as house numbers.
  const rest = text.replace(UNIT_RE, ' ').replace(/\s+/g, ' ');
  return { type: t.type, color: t.color, location: extractLocation(rest), units: extractUnits(text) };
}

const clean = s => s.replace(/\s+/g, ' ').trim();
const cap = s => s[0].toUpperCase() + s.slice(1).toLowerCase();

module.exports = { parseTransmission, TYPES, OTHER };
