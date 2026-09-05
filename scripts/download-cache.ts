import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

/**
 * Downloads the newest valid live OSRS cache from the OpenRS2 archive into ./cache/.
 *
 * rs-map-viewer ships scripts/download-caches.js, but it prompts on stdin and
 * fetches many caches at once - neither works unattended in CI. This grabs
 * exactly one cache and never prompts.
 */

const CACHE_DIR = "./cache";
const ARCHIVE = "https://archive.openrs2.org";

type OpenRs2Cache = {
    id: number;
    scope: string;
    game: string;
    environment: string;
    language: string;
    builds: { major: number; minor: number | null }[];
    timestamp: string | null;
    size: number;
    indexes: number | null;
    valid_indexes: number | null;
    groups: number | null;
    valid_groups: number | null;
    valid_keys: number | null;
};

/** Same validity bar rs-map-viewer applies: all indexes present, >=90% of groups. */
function isValid(cache: OpenRs2Cache): boolean {
    if (cache.valid_indexes === null || cache.valid_indexes !== cache.indexes) {
        return false;
    }
    if (cache.groups === null || cache.valid_groups === null) {
        return false;
    }
    return cache.valid_groups / cache.groups >= 0.9;
}

async function main() {
    console.log("Fetching cache list from OpenRS2...");
    const response = await fetch(`${ARCHIVE}/caches.json`);
    if (!response.ok) {
        throw new Error(`OpenRS2 caches.json returned ${response.status}`);
    }
    const all: OpenRs2Cache[] = await response.json();

    const candidates = all
        .filter(
            (cache) =>
                cache.scope === "runescape" &&
                cache.game === "oldschool" &&
                cache.environment === "live" &&
                cache.language === "en" &&
                cache.builds.length > 0 &&
                cache.timestamp !== null &&
                isValid(cache),
        )
        .sort((a, b) => {
            const build = b.builds[0].major - a.builds[0].major;
            return build !== 0 ? build : Date.parse(b.timestamp!) - Date.parse(a.timestamp!);
        });

    const cache = candidates[0];
    if (!cache) {
        throw new Error("No valid live OSRS cache found");
    }

    const revision = cache.builds[0].major;
    const date = cache.timestamp!.split("T")[0];
    const name = `osrs-${revision}_${date}`;
    console.log(`Selected ${name} (id ${cache.id}, ${(cache.size / 1048576).toFixed(0)} MiB)`);

    // Skip the download when the same cache is already on disk (local reruns).
    const infoPath = path.join(CACHE_DIR, "info.json");
    if (fs.existsSync(infoPath)) {
        const existing = JSON.parse(fs.readFileSync(infoPath, "utf8"));
        if (existing.id === cache.id) {
            console.log("Already downloaded, skipping.");
            return;
        }
        fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    console.log("Downloading disk.zip...");
    const zipResponse = await fetch(`${ARCHIVE}/caches/${cache.scope}/${cache.id}/disk.zip`);
    if (!zipResponse.ok) {
        throw new Error(`disk.zip returned ${zipResponse.status}`);
    }
    const zip = new AdmZip(Buffer.from(await zipResponse.arrayBuffer()), { readEntries: true });
    // The archive nests everything under cache/; flatten it into CACHE_DIR.
    zip.extractEntryTo("cache/", CACHE_DIR, false, true);

    console.log("Downloading XTEA keys...");
    const keysResponse = await fetch(`${ARCHIVE}/caches/${cache.scope}/${cache.id}/keys.json`);
    if (!keysResponse.ok) {
        throw new Error(`keys.json returned ${keysResponse.status}`);
    }
    const keys: { group: number; key: number[] }[] = await keysResponse.json();

    const xteas: Record<string, number[]> = {};
    for (const entry of keys) {
        xteas[entry.group.toString()] = entry.key;
    }

    fs.writeFileSync(path.join(CACHE_DIR, "keys.json"), JSON.stringify(xteas), "utf8");
    fs.writeFileSync(
        infoPath,
        JSON.stringify({ ...cache, name, game: "oldschool", revision }, null, 2),
        "utf8",
    );

    console.log(`Cache ready in ${CACHE_DIR} (${Object.keys(xteas).length} XTEA keys)`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
