# Scanner Incident Map

Send radio transmissions (as text) to an HTTP endpoint. Each one is parsed for the incident type,
the location and the responding units, geocoded with OpenStreetMap, and pushed live to a map page.

No dependencies. Needs Node 18 or newer.

## Run it locally

```bash
API_KEY=choose-a-secret AREA="Brooklyn, NY" node server.js
# map:  http://localhost:3000
```

## The API

### Send a transmission

`POST /api/transmissions`

Authenticate with `X-API-Key: <API_KEY>` or `Authorization: Bearer <API_KEY>` (skipped when `API_KEY` is unset).

Plain text body:

```bash
curl -X POST https://YOUR-HOST/api/transmissions \
  -H "X-API-Key: $API_KEY" \
  --data-binary "Engine 5, Ladder 3 respond to a working fire at 1420 Oak Street"
```

Or JSON, with optional overrides:

```bash
curl -X POST https://YOUR-HOST/api/transmissions \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"text": "Medic 12 respond to Main Street and 5th Avenue for an MVA", "source": "County Fire Dispatch"}'
```

| Field      | Required | Meaning |
|------------|----------|---------|
| `text`     | yes      | The transmission, as heard |
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
- `GET /health` for uptime checks.

## How parsing works

`parser.js` is rule based:

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
| `CONTACT_EMAIL` | placeholder | Sent to OpenStreetMap's geocoder, which asks for a contact |

## Deploy on Render (free)

1. Put this folder in a GitHub repository.
2. In Render, choose **New → Blueprint** and pick the repository. `render.yaml` sets everything up
   and generates an `API_KEY` (find it under the service's Environment tab).
3. Set `AREA` to your area. The map is at `https://<service>.onrender.com`.

On Render's free plan the service sleeps after 15 idle minutes (the next request takes about a minute)
and its disk is wiped on restart, so incidents older than the last restart disappear. A paid instance
with a persistent disk, or Fly.io / Railway with a volume, keeps them.

## Audio

This takes text. To feed it audio from a scanner, transcribe first (for example trunk-recorder or
rdio-scanner with a speech-to-text step) and post each transcript here.
