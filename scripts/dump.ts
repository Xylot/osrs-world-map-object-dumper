import fs from "fs";
import path from "path";

import { CacheFiles } from "../vendor/rs-map-viewer/src/rs/cache/CacheFiles";
import { CacheInfo } from "../vendor/rs-map-viewer/src/rs/cache/CacheInfo";
import { CacheSystem } from "../vendor/rs-map-viewer/src/rs/cache/CacheSystem";
import { detectCacheType } from "../vendor/rs-map-viewer/src/rs/cache/CacheType";
import { getCacheLoaderFactory } from "../vendor/rs-map-viewer/src/rs/cache/loader/CacheLoaderFactory";
import { LocModelType } from "../vendor/rs-map-viewer/src/rs/config/loctype/LocModelType";
import { ByteBuffer } from "../vendor/rs-map-viewer/src/rs/io/ByteBuffer";

const CACHE_DIR = "./cache";
const DATA_DIR = "./data";
const VIEWER_DIR = "./vendor/rs-map-viewer";

const MAP_SQUARE_SIZE = 64; // tiles per region edge
const CHUNK_SIZE = 8; // tiles per chunk edge
const CHUNKS_PER_REGION_EDGE = MAP_SQUARE_SIZE / CHUNK_SIZE;

/**
 * Packed chunk key: regionId in the high bits, then chunkX and chunkY.
 * regionId is itself (mapX << 8) | mapY, so the whole key is:
 *
 *   ((mapX << 8 | mapY) << 6) | (chunkX << 3) | chunkY
 *
 * Max value is ~4.19M, comfortably inside a JS safe integer.
 */
function packChunkId(regionId: number, chunkX: number, chunkY: number): number {
    return (regionId << 6) | (chunkX << 3) | chunkY;
}

export function unpackChunkId(chunkId: number) {
    const regionId = chunkId >> 6;
    return {
        regionId,
        mapX: regionId >> 8,
        mapY: regionId & 0xff,
        chunkX: (chunkId >> 3) & 0x7,
        chunkY: chunkId & 0x7,
    };
}

type LocInstance = {
    id: number;
    x: number;
    y: number;
    level: number;
    type: LocModelType;
    rotation: number;
};

type LocForm = {
    locId: number;
    name: string;
    actions: string[];
    values: string[];
    isFallback: boolean;
};

// --- Load the cache ------------------------------------------------------

function loadCacheFiles(): CacheFiles {
    const files = new Map<string, ArrayBuffer>();
    for (const fileName of fs.readdirSync(CACHE_DIR)) {
        const buffer = fs.readFileSync(path.join(CACHE_DIR, fileName));
        // Copy into a standalone ArrayBuffer; Node pools Buffer memory.
        const arrayBuffer = new ArrayBuffer(buffer.byteLength);
        new Uint8Array(arrayBuffer).set(buffer);
        files.set(fileName, arrayBuffer);
    }
    return new CacheFiles(files);
}

if (!fs.existsSync(path.join(CACHE_DIR, "info.json"))) {
    console.error(`No cache in ${CACHE_DIR}. Run: npm run download-cache`);
    process.exit(1);
}

const rawInfo = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "info.json"), "utf8"));
const cacheInfo: CacheInfo = {
    name: rawInfo.name,
    game: "oldschool",
    environment: rawInfo.environment,
    revision: rawInfo.revision,
    timestamp: rawInfo.timestamp,
    size: rawInfo.size,
};

const xteasJson: Record<string, number[]> = JSON.parse(
    fs.readFileSync(path.join(CACHE_DIR, "keys.json"), "utf8"),
);
const xteas = new Map(Object.keys(xteasJson).map((key) => [parseInt(key), xteasJson[key]]));

console.log(`Cache: ${cacheInfo.name} (rev ${cacheInfo.revision})`);

const cacheSystem = CacheSystem.fromFiles(detectCacheType(cacheInfo), loadCacheFiles());
const loaderFactory = getCacheLoaderFactory(cacheInfo, cacheSystem);
const mapFileLoader = loaderFactory.getMapFileLoader();
const locTypeLoader = loaderFactory.getLocTypeLoader();
const npcTypeLoader = loaderFactory.getNpcTypeLoader();
const objTypeLoader = loaderFactory.getObjTypeLoader();

// --- Loc types -----------------------------------------------------------

/** Compress [0,1,2,5] into ["0-2","5"]. */
function toRanges(values: number[]): string[] {
    const ranges: string[] = [];
    for (let i = 0; i < values.length; i++) {
        const start = values[i];
        while (i + 1 < values.length && values[i + 1] === values[i] + 1) {
            i++;
        }
        ranges.push(start === values[i] ? `${start}` : `${start}-${values[i]}`);
    }
    return ranges;
}

/**
 * Every form a morphing loc can take. The transform value indexes into
 * `transforms`; the final entry is the out-of-range fallback.
 */
function getLocForms(transforms: number[]): LocForm[] {
    const valuesByLocId = new Map<number, number[]>();
    transforms.slice(0, -1).forEach((locId, value) => {
        if (locId === -1) {
            return;
        }
        const values = valuesByLocId.get(locId) ?? [];
        values.push(value);
        valuesByLocId.set(locId, values);
    });

    const fallbackId = transforms[transforms.length - 1];
    if (fallbackId !== -1 && !valuesByLocId.has(fallbackId)) {
        valuesByLocId.set(fallbackId, []);
    }

    return [...valuesByLocId].map(([locId, values]) => {
        const formType = locTypeLoader.load(locId);
        return {
            locId,
            name: formType.name,
            actions: formType.actions.filter((action) => !!action),
            values: toRanges(values),
            isFallback: locId === fallbackId,
        };
    });
}

const namedCache = new Map<number, boolean>();

/**
 * A loc is "named" if it or any form it can morph into has a real name.
 * Base types of morphing locs are usually name "null" with the real name on the
 * forms, so checking only the base would drop most doors and quest objects.
 */
function isNamed(id: number): boolean {
    const cached = namedCache.get(id);
    if (cached !== undefined) {
        return cached;
    }
    const locType = locTypeLoader.load(id);
    let named = locType.name !== "null";
    if (!named && locType.transforms) {
        named = locType.transforms.some(
            (formId) => formId !== -1 && locTypeLoader.load(formId).name !== "null",
        );
    }
    namedCache.set(id, named);
    return named;
}

// --- Decode every region -------------------------------------------------

const chunks: Record<number, { locs: LocInstance[]; npcs?: number[]; objs?: number[] }> = {};
const usedLocIds = new Set<number>();

let regionCount = 0;
let totalInstances = 0;
let keptInstances = 0;

for (let mapX = 0; mapX < 256; mapX++) {
    for (let mapY = 0; mapY < 256; mapY++) {
        let data: Int8Array | undefined;
        try {
            data = mapFileLoader.getLocData(mapX, mapY, xteas);
        } catch {
            // Missing or wrong XTEA key - the region simply cannot be read.
            continue;
        }
        if (!data) {
            continue;
        }
        regionCount++;

        const regionId = (mapX << 8) | mapY;
        const baseX = mapX * MAP_SQUARE_SIZE;
        const baseY = mapY * MAP_SQUARE_SIZE;

        const buffer = new ByteBuffer(data);
        let id = -1;
        let idDelta: number;
        while ((idDelta = buffer.readSmart3()) !== 0) {
            id += idDelta;

            let pos = 0;
            let posDelta: number;
            while ((posDelta = buffer.readUnsignedSmart()) !== 0) {
                pos += posDelta - 1;

                const localX = (pos >> 6) & 0x3f;
                const localY = pos & 0x3f;
                const level = pos >> 12;
                const attributes = buffer.readUnsignedByte();

                totalInstances++;
                if (!isNamed(id)) {
                    continue;
                }
                keptInstances++;
                usedLocIds.add(id);

                const chunkId = packChunkId(
                    regionId,
                    Math.floor(localX / CHUNK_SIZE),
                    Math.floor(localY / CHUNK_SIZE),
                );
                (chunks[chunkId] ??= { locs: [] }).locs.push({
                    id,
                    x: baseX + localX,
                    y: baseY + localY,
                    level,
                    type: attributes >> 2,
                    rotation: attributes & 0x3,
                });
            }
        }
    }
}

console.log(`Regions: ${regionCount}`);
console.log(
    `Loc instances: ${keptInstances} named of ${totalInstances} ` +
        `(${((keptInstances / totalInstances) * 100).toFixed(1)}%)`,
);

// --- NPC and item spawns -------------------------------------------------
// These are NOT in a modern OSRS cache (they are server-side), so they come from
// rs-map-viewer's scraped JSON, which lags the cache by years. Recorded in
// meta.json so consumers know how stale they are.

type NpcSpawnJson = { id: number; x: number; y: number; level: number };
type ObjSpawnJson = { id: number; count: number; x: number; y: number; plane: number };

const npcSpawnPath = path.join(VIEWER_DIR, "src/mapviewer/data/npc/npc-spawns-osrs.json");
const objSpawnPath = path.join(VIEWER_DIR, "src/mapviewer/data/obj/obj-spawns.json");

const npcSpawns: NpcSpawnJson[] = JSON.parse(fs.readFileSync(npcSpawnPath, "utf8"));
const objSpawns: ObjSpawnJson[] = JSON.parse(fs.readFileSync(objSpawnPath, "utf8"));

const usedNpcIds = new Set<number>();
const usedObjIds = new Set<number>();

function chunkIdForTile(x: number, y: number): number {
    const mapX = Math.floor(x / MAP_SQUARE_SIZE);
    const mapY = Math.floor(y / MAP_SQUARE_SIZE);
    return packChunkId(
        (mapX << 8) | mapY,
        Math.floor((x - mapX * MAP_SQUARE_SIZE) / CHUNK_SIZE),
        Math.floor((y - mapY * MAP_SQUARE_SIZE) / CHUNK_SIZE),
    );
}

for (const spawn of npcSpawns) {
    const chunkId = chunkIdForTile(spawn.x, spawn.y);
    const chunk = (chunks[chunkId] ??= { locs: [] });
    (chunk.npcs ??= []).push(spawn.id);
    usedNpcIds.add(spawn.id);
}
for (const spawn of objSpawns) {
    const chunkId = chunkIdForTile(spawn.x, spawn.y);
    const chunk = (chunks[chunkId] ??= { locs: [] });
    (chunk.objs ??= []).push(spawn.id);
    usedObjIds.add(spawn.id);
}

// Spawn lists are id-only, so dedupe them.
for (const chunk of Object.values(chunks)) {
    if (chunk.npcs) {
        chunk.npcs = [...new Set(chunk.npcs)].sort((a, b) => a - b);
    }
    if (chunk.objs) {
        chunk.objs = [...new Set(chunk.objs)].sort((a, b) => a - b);
    }
}

// --- Type tables ---------------------------------------------------------

const locTypes: Record<number, unknown> = {};
for (const id of [...usedLocIds].sort((a, b) => a - b)) {
    const locType = locTypeLoader.load(id);
    const forms = locType.transforms ? getLocForms(locType.transforms) : undefined;
    // A morphing loc's base type is usually name "null" with the real name on its
    // forms. Surface the first named form so lookups do not come back empty.
    const displayName =
        locType.name === "null" ? forms?.find((form) => form.name !== "null")?.name : undefined;
    locTypes[id] = {
        name: locType.name,
        ...(displayName ? { displayName } : {}),
        actions: locType.actions.filter((action) => !!action),
        sizeX: locType.sizeX,
        sizeY: locType.sizeY,
        clipType: locType.clipType,
        ...(forms
            ? {
                  transformVarbit: locType.transformVarbit,
                  transformVarp: locType.transformVarp,
                  forms,
              }
            : {}),
    };
}

// A cache newer than the vendored viewer can contain config opcodes the decoder
// does not know. TypeLoader swallows those and hands back a default-valued type,
// so count them rather than letting bad entries pass silently as name "null".
const decodeFailures: { npcs: number[]; objs: number[] } = { npcs: [], objs: [] };

const npcTypes: Record<number, unknown> = {};
for (const id of [...usedNpcIds].sort((a, b) => a - b)) {
    const npcType = npcTypeLoader.load(id);
    if (npcType.name === "null" && npcType.actions.every((action) => !action)) {
        decodeFailures.npcs.push(id);
    }
    npcTypes[id] = {
        name: npcType.name,
        actions: npcType.actions.filter((action) => !!action),
        combatLevel: npcType.combatLevel,
        size: npcType.size,
    };
}

const objTypes: Record<number, unknown> = {};
for (const id of [...usedObjIds].sort((a, b) => a - b)) {
    const objType = objTypeLoader.load(id);
    objTypes[id] = {
        name: objType.name,
        groundActions: objType.groundActions.filter((action) => !!action),
        isMembers: objType.isMembers,
    };
}

// --- Write ---------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });

function write(fileName: string, value: unknown): void {
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
    const bytes = fs.statSync(filePath).size;
    console.log(`  ${fileName}: ${(bytes / 1048576).toFixed(1)} MB`);
}

console.log("Writing:");
write("chunks.json", chunks);
write("loc-types.json", locTypes);
write("npc-types.json", npcTypes);
write("obj-types.json", objTypes);
write("meta.json", {
    cache: cacheInfo.name,
    // OpenRS2 archive id - what check-cache.ts compares to decide if a run is needed.
    cacheId: rawInfo.id,
    revision: cacheInfo.revision,
    cacheTimestamp: cacheInfo.timestamp,
    generatedAt: new Date().toISOString(),
    viewerCommit: process.env.VIEWER_COMMIT ?? null,
    chunkIdFormat: "((mapX << 8 | mapY) << 6) | (chunkX << 3) | chunkY",
    chunkSize: CHUNK_SIZE,
    chunksPerRegionEdge: CHUNKS_PER_REGION_EDGE,
    counts: {
        regions: regionCount,
        chunks: Object.keys(chunks).length,
        locInstancesTotal: totalInstances,
        locInstancesNamed: keptInstances,
        locTypes: usedLocIds.size,
        npcTypes: usedNpcIds.size,
        objTypes: usedObjIds.size,
    },
    // Types the vendored decoder could not read (cache newer than the viewer).
    // Their entries carry default values, not real data.
    decodeFailures: {
        npcCount: decodeFailures.npcs.length,
        npcIds: decodeFailures.npcs,
    },
    // Locs come from the cache and track it exactly. NPC and item spawns do not
    // exist in a modern OSRS cache and are scraped snapshots that lag badly -
    // anything added to the game after these dates is missing entirely.
    spawnDataSources: {
        npcs: { file: "rs-map-viewer npc-spawns-osrs.json", note: "stale; see README" },
        objs: { file: "rs-map-viewer obj-spawns.json", note: "stale; see README" },
    },
});

console.log("Done.");
