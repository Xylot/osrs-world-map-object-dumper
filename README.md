# osrs-world-map-object-dumper

Dumps every **named** map object in Old School RuneScape, keyed by packed chunk id, straight from
the game cache. Regenerated weekly by GitHub Actions.

Cache decoding is done by [rs-map-viewer](https://github.com/dennisdev/rs-map-viewer), vendored as a
pinned submodule under `vendor/`.

## Output

Everything lands in `data/`:

| File | Size | Contents |
| --- | --- | --- |
| `chunks.json` | ~20 MB | chunk id → objects in that chunk |
| `loc-types.json` | ~4 MB | loc id → name, actions, morph forms |
| `npc-types.json` | ~0.4 MB | npc id → name, actions, combat level |
| `obj-types.json` | ~0.1 MB | item id → name, ground actions |
| `meta.json` | tiny | cache revision, counts, generation time |

Type tables are separate rather than inlined per instance — 41,800 loc types repeated across 5M
instances is what turns a 20 MB file into a 300 MB one.

### Chunk ids

A chunk is 8×8 tiles; a region ("map square") is 64×64, so 8×8 chunks per region.

```
chunkId = ((mapX << 8 | mapY) << 6) | (chunkX << 3) | chunkY
```

`mapX << 8 | mapY` is the familiar region id, so region 12582 chunk 5,5 is `805293`. Max value is
about 4.19M, well inside a JS safe integer. To go back:

```js
const regionId = chunkId >> 6;
const mapX = regionId >> 8;
const mapY = regionId & 0xff;
const chunkX = (chunkId >> 3) & 0x7;
const chunkY = chunkId & 0x7;
```

`unpackChunkId` is exported from `scripts/dump.ts` if you'd rather import it.

### Shape

```jsonc
// chunks.json
{
  "805293": {
    "locs": [
      { "id": 58439, "x": 3176, "y": 2477, "level": 0, "type": 10, "rotation": 2 }
    ],
    "npcs": [3106],   // present only if the chunk has spawns
    "objs": [995]
  }
}
```

`type` is rs-map-viewer's `LocModelType` (0–3 walls, 4–8 wall decorations, 10–11 normal, 12–21
roofs, 22 floor decoration).

```jsonc
// loc-types.json
{
  "58439": {
    "name": "null",
    "displayName": "Cave entrance",   // resolved from forms when the base is unnamed
    "actions": [],
    "sizeX": 1, "sizeY": 1, "clipType": 2,
    "transformVarbit": 18321,
    "transformVarp": -1,
    "forms": [
      { "locId": 58440, "name": "Cave entrance", "actions": ["Unblock"],
        "values": ["0-26"], "isFallback": false },
      { "locId": 58441, "name": "Cave entrance", "actions": ["Enter"],
        "values": [], "isFallback": true }
    ]
  }
}
```

### Morphing objects

Many objects change with game state — doors, quest objects, anything gated behind progress. The
cache stores this as a `transforms` list indexed by a varbit or varp, and `forms` enumerates every
reachable version with the values that select it. `isFallback` marks the entry used when the value
falls outside the list.

**The cache holds no varbit *values*** — those are account state, server-side. So this data tells
you *"varbit 18321 ≥ 27 means Enter"*, never *"your varbit 18321 is 27"*. Which form is live for a
given player needs a value from somewhere else.

## Caveats

**Named objects only.** Unnamed decorative scenery is dropped — 94% of instances, and the reason the
output fits in a git repo at all. A loc counts as named if it *or any form it morphs into* has a
real name, so doors and quest objects survive even though their base type is `"null"`.

**NPC and item spawns are stale.** Modern OSRS caches contain no spawn data; it's server-side.
Those coordinates come from rs-map-viewer's scraped JSON, last updated **2023-08** (NPCs) and
**2024-03** (items). Anything added since is missing outright — the NPC *types* are current, but
their locations are not. Locs have no such problem: they come from the cache and track it exactly.

**A cache newer than the vendored viewer may not fully decode.** New config opcodes make
`TypeLoader` fall back to a default type. `meta.json` reports these under `decodeFailures`; if that
count climbs, bump the submodule.

## Running locally

```bash
git clone --recurse-submodules https://github.com/Xylot/osrs-world-map-object-dumper.git
cd osrs-world-map-object-dumper
npm ci
npm run all
```

`npm run download-cache` pulls the newest valid live OSRS cache (~220 MB) from
[OpenRS2](https://archive.openrs2.org/) into `cache/` (gitignored), skipping the download if that
same cache is already there. `npm run dump` writes `data/`. Takes a couple of minutes.

## Automation

`.github/workflows/dump.yml` runs Wednesdays at 18:00 UTC, after Jagex's usual update window, and on
manual dispatch. It downloads a fresh cache, dumps, and commits `data/` only when something other
than `meta.json` changed — `generatedAt` alone would otherwise produce a commit every week.

## Credits

- [dennisdev/rs-map-viewer](https://github.com/dennisdev/rs-map-viewer) — all cache decoding
- [OpenRS2 Archive](https://archive.openrs2.org/) — cache hosting
- Jagex — the game
