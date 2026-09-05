export const ARCHIVE = "https://archive.openrs2.org";

export type OpenRs2Cache = {
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

export function cacheName(cache: OpenRs2Cache): string {
    return `osrs-${cache.builds[0].major}_${cache.timestamp!.split("T")[0]}`;
}

/** The newest valid live OSRS cache in the archive. */
export async function fetchLatestCache(): Promise<OpenRs2Cache> {
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

    const latest = candidates[0];
    if (!latest) {
        throw new Error("No valid live OSRS cache found");
    }
    return latest;
}
