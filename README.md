# Scanner Incident Map

Send radio transmissions (audio clips or text) to an HTTP endpoint. Audio is transcribed with
OpenAI's Whisper, Claude reads each transmission for the incident type, location and responding units,
the location is geocoded with OpenStreetMap, and the incident appears live on a map page.

Needs Node 18 or newer. One dependency (`@anthropic-ai/sdk`).

## Run it locally

```bash
API_KEY=choose-a-secret AREA="Brooklyn, NY" node server.js
# map:  http://localhost:3000
```

## The API

### Send a transmission

`POST /api/transmissions`

Audio (mp3, wav, m4a, ogg, webm, flac, up to 25 MB), as a raw body:

```bash
curl -X POST "https://YOUR-HOST/api/transmissions?source=County%20Fire" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: audio/mpeg" \
  --data-binary @clip.mp3
```

or as a form upload with the file in an `audio` field:

```bash
curl -X POST https://YOUR-HOST/api/transmissions \
  -H "X-API-Key: $API_KEY" -F "audio=@clip.mp3" -F "source=County Fire"
```

Audio needs `OPENAI_API_KEY` on the server; without it the endpoint answers `503`.

Text works too:

Authenticate with `X-API-Key: <API_KEY>` or `Authorization: Bearer <API_KEY>` (skipped when `API_KEY` is unset).

```bash
curl -X POST https://YOUR-HOST/api/transmissions \
  -H "X-API-Key: $API_KEY" \
  --data-binary "Engine 5, Ladder 3 respond to a working fire at 1420 Oak Street"
```

Or JSON, with optional overrides (these also work as query parameters or form fields alongside audio):

```bash
curl -X POST https://YOUR-HOST/api/transmissions \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"text": "Medic 12 respond to Main Street and 5th Avenue for an MVA", "source": "County Fire Dispatch"}'
```

| Field      | Required | Meaning |
|------------|----------|---------|
| `text`     | yes, unless audio is sent | The transmission, as heard |
| `source`   | no       | Channel or agency label |
| `location` | no       | Use this location instead of the one parsed from `text` |
| `lat`,`lng`| no       | Skip geocoding and place the incident here |
| `type`     | no       | Use this type instead of the parsed one |

Response `201` is the stored incident:

```json
{
  "id": "…", "receivedAt": "2026-10-12T18:08:49.760Z",
  "text": "Engine 5, Ladder 3 working fire at 1420 Oak Street",
  "type": "Fire", "units": ["Engine 5", "Ladder 3"],
  "locationText": "1420 Oak Street",
  "lat": 40.75, "lng": -73.99, "resolvedAddress": "1420 Oak Street, …",
  "approximate": false, "located": true
}
```

If no location is heard, or the geocoder can't find it, the incident is still stored with
`"located": false` and shows in the side list but not on the map.

### Other endpoints

- `GET /api/incidents` returns incidents from the last `MAX_AGE_HOURS`.
- `GET /api/stream` is a server-sent event stream (`incident`, `removed`) the map listens to.
- `DELETE /api/incidents/:id` removes one (needs the API key).
- `GET /health` for uptime checks; also reports whether audio and AI decoding are switched on.

## How decoding works

With `ANTHROPIC_API_KEY` set, `ai.js` sends each transcript to Claude, which returns the incident type,
a short summary, the location as spoken, a geocoder-ready query (with your `AREA` filled in), the units,
and whether it is an incident at all or just radio chatter. Responses carry `"decodedBy": "ai"`.

Without the key, or if Claude can't be reached, `parser.js` falls back to rules (`"decodedBy": "rules"`):

- **Type** from keywords: Shooting, Fire, Crash, Medical, Crime, Hazard, Rescue, otherwise Other.
- **Location**, in order: an intersection ("Main Street and 5th Avenue", "Elm St & Maple Ave"),
  a street address ("1420 Oak Street"), or a place after at / on / to / near ("Riverside Park").
- **Units** from callsigns such as Engine 5, Ladder 3, Medic 12, Car 22.

Set `AREA` to your city or county so "1420 Oak Street" geocodes to the right town. The OpenStreetMap
geocoder rarely resolves intersections, so those fall back to the first street and are marked approximate.

## Settings

| Variable        | Default | Meaning |
|-----------------|---------|---------|
| `PORT`          | 3000    | Port to listen on |
| `API_KEY`       | none    | Secret required to post or delete |
| `AREA`          | none    | Appended to every geocoder query, e.g. `Brooklyn, NY` |
| `MAX_AGE_HOURS` | 24      | How far back the map shows |
| `DATA_FILE`     | `data/incidents.json` | Where incidents are saved |
| `OPENAI_API_KEY` | none | Turns on audio transcription |
| `ANTHROPIC_API_KEY` | none | Turns on AI decoding |
| `TRANSCRIBE_MODEL` | `whisper-1` | OpenAI transcription model |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model used for decoding |
| `CONTACT_EMAIL` | placeholder | Sent to OpenStreetMap's geocoder, which asks for a contact |

## Deploy on Render (free)

1. Put this folder in a GitHub repository.
2. In Render, choose **New → Blueprint** and pick the repository. `render.yaml` sets everything up
   and generates an `API_KEY` (find it under the service's Environment tab).
3. Set `AREA` to your area. The map is at `https://<service>.onrender.com`.

On Render's free plan the service sleeps after 15 idle minutes (the next request takes about a minute)
and its disk is wiped on restart, so incidents older than the last restart disappear. A paid instance
with a persistent disk, or Fly.io / Railway with a volume, keeps them.

## Feeding it from a scanner

Each call should be one clip. Tools like trunk-recorder or rdio-scanner already split scanner audio
into one file per transmission; point their upload hook (or a small script) at `/api/transmissions`.
