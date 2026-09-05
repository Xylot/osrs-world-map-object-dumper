import fs from "fs";

import { cacheName, fetchLatestCache } from "./openrs2";

/**
 * Cheap "is there anything to do?" check, meant to run before the ~220 MB cache
 * download. Compares the newest cache in the archive against the one recorded in
 * data/meta.json and reports whether a dump is needed.
 *
 * Writes needed/cache_id/cache_name to $GITHUB_OUTPUT when running in Actions.
 * Exit code is always 0 - "nothing to do" is a normal outcome, not a failure.
 */

const META_PATH = "./data/meta.json";

async function main() {
    const latest = await fetchLatestCache();
    const name = cacheName(latest);

    let dumpedId: number | undefined;
    if (fs.existsSync(META_PATH)) {
        const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
        dumpedId = meta.cacheId;
    }

    // Fall back to a dump when meta.json predates cacheId being recorded, rather
    // than silently treating "unknown" as "already done".
    const needed = dumpedId === undefined || dumpedId !== latest.id;

    console.log(`Latest available: ${name} (OpenRS2 id ${latest.id}, rev ${latest.builds[0].major})`);
    console.log(`Already dumped:   ${dumpedId ?? "none"}`);
    console.log(needed ? "-> dump needed" : "-> up to date, nothing to do");

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `needed=${needed}\ncache_id=${latest.id}\ncache_name=${name}\n`,
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
