// Speech-to-text (OpenAI) and transmission decoding (Claude). Both are optional:
// without OPENAI_API_KEY audio is rejected, without ANTHROPIC_API_KEY the rule parser is used.

const Anthropic = require('@anthropic-ai/sdk');

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const TYPES = ['Shooting', 'Fire', 'Crash', 'Medical', 'Crime', 'Hazard', 'Rescue', 'Other'];

const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const canTranscribe = () => Boolean(process.env.OPENAI_API_KEY);
const canDecode = () => Boolean(claude);

async function transcribe(audio, filename, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), filename);
  form.append('model', TRANSCRIBE_MODEL);
  // Steer the transcriber toward dispatch vocabulary.
  form.append('prompt', 'Police, fire and EMS radio dispatch. Unit callsigns like Engine 5, Ladder 3, Medic 12. Street addresses and intersections.');
  const r = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`transcription failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).text.trim();
}

const SCHEMA = {
  type: 'object',
  properties: {
    is_incident: { type: 'boolean', description: 'False for chatter with no incident (acknowledgements, status checks, traffic stops with no call).' },
    type: { type: 'string', enum: TYPES },
    summary: { type: 'string', description: 'Short plain-English description, under 12 words.' },
    location_heard: { type: ['string', 'null'], description: 'The location exactly as spoken, or null if none.' },
    geocode_query: { type: ['string', 'null'], description: 'A query an OpenStreetMap geocoder can resolve: a street address, a single street, or a named place, followed by the city and state. For an intersection give "Street A & Street B, City, State". Null if no location.' },
    units: { type: 'array', items: { type: 'string' }, description: 'Responding unit callsigns, e.g. "Engine 5".' },
  },
  required: ['is_incident', 'type', 'summary', 'location_heard', 'geocode_query', 'units'],
  additionalProperties: false,
};

async function decode(text, area) {
  const response = await claude.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system:
      'You read police, fire and EMS radio transmissions (often messy speech-to-text) and extract the incident. ' +
      'Expand dispatch shorthand and ten-codes where the meaning is clear, fix obvious transcription errors in street names, ' +
      `and assume locations are in ${area || 'the area the dispatcher serves'} unless the transmission says otherwise. ` +
      'Never invent a location that was not spoken.',
    messages: [{ role: 'user', content: `Transmission:\n${text}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('decoder declined this transmission');
  const block = response.content.find(b => b.type === 'text');
  if (!block) throw new Error('decoder returned no result');
  const out = JSON.parse(block.text);
  return { ...out, type: TYPES.includes(out.type) ? out.type : 'Other' };
}

module.exports = { transcribe, decode, canTranscribe, canDecode };
