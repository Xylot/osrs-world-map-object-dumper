import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

import { ARCHIVE, cacheName, fetchLatestCache } from "./openrs2";

/**
 * Downloads the newest valid live OSRS cache from the OpenRS2 archive into ./cache/.
 *
 * rs-map-viewer ships scripts/download-caches.js, but it prompts on stdin and
 * fetches many caches at once - neither works unattended in CI. This grabs
 * exactly one cache and never prompts.
 */

const CACHE_DIR = "./cache";

async function main() {
    console.log("Fetching cache list from OpenRS2...");
    const cache = await fetchLatestCache();

    const revision = cache.builds[0].major;
    const name = cacheName(cache);
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
