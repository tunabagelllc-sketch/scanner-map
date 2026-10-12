// Scanner incident map: receives radio transmissions over HTTP, parses and geocodes them,
// and serves a live map. No dependencies; needs Node 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTransmission, colorFor } = require('./parser');
const ai = require('./ai');

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

// `query` is a full geocoder query; `fallback` is tried when it fails (Nominatim rarely
// resolves intersections, so callers pass the first street of one).
async function locate(query, fallback) {
  const hit = await geocode(query);
  if (hit) return { ...hit, approximate: false };
  if (fallback) {
    const street = await geocode(fallback);
    if (street) return { ...street, approximate: true };
  }
  return null;
}

const withArea = q => (AREA ? `${q}, ${AREA}` : q);

// "A St & B Ave, Town, ST" -> "A St, Town, ST"
function firstStreet(query) {
  const m = query.match(/^([^&,]+?)\s*(?:&| and )\s*[^,]+(,.*)?$/i);
  return m ? `${m[1].trim()}${m[2] || ''}` : null;
}

// --- HTTP ---
const MAX_BODY = 25 * 1024 * 1024; // the transcription API's file limit
const AUDIO_TYPES = /^(audio\/|video\/|application\/octet-stream)/i;
const EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac', 'video/mp4': 'mp4' };

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Returns { text?, audio?: {data, filename, mimeType}, source?, location?, lat?, lng?, type? }.
// Accepts JSON, plain text, a raw audio body, or multipart form data with an "audio" file.
async function readBody(req, url) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, 'body too large (25 MB max)');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks);
  const contentType = req.headers['content-type'] || '';
  const meta = Object.fromEntries(url.searchParams);

  if (contentType.includes('application/json')) {
    try { return { ...meta, ...JSON.parse(raw.toString('utf8') || '{}') }; } catch { throw httpError(400, 'invalid JSON'); }
  }
  if (contentType.includes('multipart/form-data')) {
    const form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData();
    const body = { ...meta };
    for (const [k, v] of form) {
      if (typeof v === 'string') body[k] = v;
      else if (!body.audio) body.audio = { data: Buffer.from(await v.arrayBuffer()), filename: v.name || 'audio.mp3', mimeType: v.type || 'audio/mpeg' };
    }
    return body;
  }
  if (AUDIO_TYPES.test(contentType)) {
    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    return { ...meta, audio: { data: raw, filename: meta.filename || `audio.${EXT[mimeType] || 'mp3'}`, mimeType } };
  }
  return { ...meta, text: raw.toString('utf8') };
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

// Works out type, location and units: Claude when configured, otherwise (or on failure) the rules.
async function interpret(text) {
  if (ai.canDecode()) {
    try {
      const d = await ai.decode(text, AREA);
      return {
        decodedBy: 'ai', type: d.type, summary: d.summary, units: d.units, isIncident: d.is_incident,
        locationText: d.location_heard, query: d.geocode_query, fallback: d.geocode_query && firstStreet(d.geocode_query),
      };
    } catch (e) {
      console.error('AI decode failed, using rules:', e.message);
    }
  }
  const p = parseTransmission(text);
  return {
    decodedBy: 'rules', type: p.type, units: p.units, isIncident: true,
    locationText: p.location?.text || null,
    query: p.location ? withArea(p.location.text) : null,
    fallback: p.location?.streets ? withArea(p.location.streets[0]) : null,
  };
}

async function createIncident(body) {
  let text = String(body.text || '').trim();
  let transcribed = false;
  if (body.audio) {
    if (!ai.canTranscribe()) throw httpError(503, 'audio needs OPENAI_API_KEY set on the server; send text instead');
    if (!body.audio.data.length) throw httpError(400, 'audio file is empty');
    try { text = await ai.transcribe(body.audio.data, body.audio.filename, body.audio.mimeType); }
    catch (e) { throw httpError(502, e.message); }
    transcribed = true;
    if (!text) throw httpError(422, 'no speech found in the audio');
  }
  if (!text) throw httpError(400, 'send "text" or an audio file');

  const info = await interpret(text);
  if (body.location) Object.assign(info, { locationText: String(body.location), query: withArea(String(body.location)), fallback: null });
  let coords = null;
  let geocodeError = null;

  if (Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng)) && body.lat !== '' && body.lng !== '') {
    coords = { lat: Number(body.lat), lng: Number(body.lng), label: info.locationText || 'given coordinates', approximate: false };
  } else if (info.query) {
    try { coords = await locate(info.query, info.fallback); } catch (e) { geocodeError = e.message; }
  }

  const incident = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    text,
    transcribed,
    source: body.source ? String(body.source).slice(0, 100) : undefined,
    type: body.type ? String(body.type) : info.type,
    color: colorFor(body.type ? String(body.type) : info.type),
    summary: info.summary,
    units: info.units,
    isIncident: info.isIncident,
    decodedBy: info.decodedBy,
    locationText: info.locationText || null,
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
      const incident = await createIncident(await readBody(req, url));
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
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, audio: ai.canTranscribe(), aiDecoding: ai.canDecode() });
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
