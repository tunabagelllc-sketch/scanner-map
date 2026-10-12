// Scanner incident map: receives radio transmissions over HTTP, parses and geocodes them,
// and serves a live map. No dependencies; needs Node 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTransmission } = require('./parser');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || '';                 // required for POST/DELETE when set
const AREA = process.env.AREA || '';                       // e.g. "Brooklyn, NY", appended to geocoder queries
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS) || 24;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'incidents.json');
const CONTACT = process.env.CONTACT_EMAIL || 'scanner-map@example.com'; // Nominatim asks for a contact
const MOCK_GEOCODE = process.env.MOCK_GEOCODE === '1';     // offline testing only

let incidents = load();
const clients = new Set();

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(incidents));
}
function recent() {
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600e3;
  return incidents.filter(i => Date.parse(i.receivedAt) >= cutoff);
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// --- Geocoding (OpenStreetMap Nominatim: max 1 request/second, results cached) ---
const cache = new Map();
let queue = Promise.resolve();

function geocode(query) {
  if (cache.has(query)) return Promise.resolve(cache.get(query));
  const job = queue.then(async () => {
    const result = MOCK_GEOCODE ? mockGeocode(query) : await nominatim(query);
    cache.set(query, result);
    await new Promise(r => setTimeout(r, MOCK_GEOCODE ? 0 : 1100));
    return result;
  });
  queue = job.catch(() => {});
  return job;
}

async function nominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'User-Agent': `scanner-incident-map (${CONTACT})` } });
  if (!r.ok) throw new Error(`geocoder HTTP ${r.status}`);
  const [hit] = await r.json();
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name } : null;
}

function mockGeocode(query) {
  const h = crypto.createHash('md5').update(query).digest();
  return { lat: 40.7128 + (h[0] - 128) / 2000, lng: -74.006 + (h[1] - 128) / 2000, label: `${query} (mock)` };
}

async function locate(loc) {
  const withArea = q => (AREA ? `${q}, ${AREA}` : q);
  const hit = await geocode(withArea(loc.text));
  if (hit) return { ...hit, approximate: false };
  // Nominatim rarely resolves intersections; fall back to the first street.
  if (loc.streets) {
    const street = await geocode(withArea(loc.streets[0]));
    if (street) return { ...street, approximate: true };
  }
  return null;
}

// --- HTTP ---
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }
  return { text: raw };
}

function authorized(req) {
  if (!API_KEY) return true;
  const header = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(header));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

async function createIncident(body) {
  const text = String(body.text || '').trim();
  if (!text) throw Object.assign(new Error('"text" is required'), { status: 400 });

  const parsed = parseTransmission(text);
  const location = body.location ? { kind: 'given', text: String(body.location) } : parsed.location;
  let coords = null;
  let geocodeError = null;

  if (Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng)) && body.lat !== '' && body.lng !== '') {
    coords = { lat: Number(body.lat), lng: Number(body.lng), label: location?.text || 'given coordinates', approximate: false };
  } else if (location) {
    try { coords = await locate(location); } catch (e) { geocodeError = e.message; }
  }

  const incident = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    text,
    source: body.source ? String(body.source).slice(0, 100) : undefined,
    type: body.type ? String(body.type) : parsed.type,
    color: parsed.color,
    units: parsed.units,
    locationText: location?.text || null,
    ...(coords ? { lat: coords.lat, lng: coords.lng, resolvedAddress: coords.label, approximate: coords.approximate } : {}),
    located: Boolean(coords),
    ...(geocodeError ? { geocodeError } : {}),
  };
  incidents.push(incident);
  if (incidents.length > 5000) incidents = incidents.slice(-5000);
  save();
  broadcast('incident', incident);
  return incident;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/transmissions') {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong API key' });
      const incident = await createIncident(await readBody(req));
      return send(res, 201, incident);
    }
    if (req.method === 'GET' && url.pathname === '/api/incidents') return send(res, 200, recent());
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/incidents/')) {
      if (!authorized(req)) return send(res, 401, { error: 'missing or wrong API key' });
      const id = url.pathname.split('/').pop();
      const before = incidents.length;
      incidents = incidents.filter(i => i.id !== id);
      if (incidents.length === before) return send(res, 404, { error: 'not found' });
      save();
      broadcast('removed', { id });
      return send(res, 200, { removed: id });
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Scanner map on http://localhost:${PORT}`));
