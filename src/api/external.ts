import { PersistentCache } from '../utils/cache';

/**
 * Optional third-party metadata feeds for rendered graph nodes.
 *
 * - bundlephobia: minified/gzip size for npm packages
 * - ungh.cc:      GitHub repository stats (stars, forks, last push)
 * - repology:     which OS package repositories ship the project
 * - libraries.io: dependents/rank (requires VITE_LIBRARIES_IO_KEY)
 *
 * Every fetch is best-effort: failures return null/empty rather than
 * throwing, since these feeds are additive metadata, never blocking.
 */

export interface BundleSize {
    size: number;
    gzip: number;
}

export interface RepoStats {
    stars: number;
    forks: number;
    pushedAt?: string;
}

export interface LibrariesIoInfo {
    dependents?: number;
    stars?: number;
    rank?: number;
}

/**
 * Extract a GitHub `owner/repo` pair from common repository URL shapes:
 * `https://github.com/o/r`, `git+https://github.com/o/r.git`,
 * `git://github.com/o/r`, `github:o/r`.
 */
export function extractGithubRepo(url: string | undefined): { owner: string; repo: string; } | null {
    if (!url) return null;

    const shortHand = url.match(/^github:([^/\s]+)\/([^/\s]+)$/);
    if (shortHand) {
        return { owner: shortHand[1], repo: shortHand[2].replace(/\.git$/, '') };
    }

    const match = url.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/);
    if (!match) return null;

    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

/** bundlephobia — published bundle size for an npm package. */
export async function fetchBundleSize(name: string, version: string, signal?: AbortSignal): Promise<BundleSize | null> {
    return PersistentCache.getOrComputeRegistry(`bundlephobia:${name}@${version}`, async () => {
        try {
            const res = await fetch(`https://bundlephobia.com/api/size?package=${encodeURIComponent(name)}@${encodeURIComponent(version)}`, { signal });
            if (!res.ok) return null;
            const data = await res.json();
            if (typeof data?.size !== 'number' || typeof data?.gzip !== 'number') return null;
            return { size: data.size, gzip: data.gzip };
        } catch {
            return null;
        }
    });
}

/** ungh.cc — GitHub repo stats without requiring a token. */
export async function fetchRepoStats(owner: string, repo: string, signal?: AbortSignal): Promise<RepoStats | null> {
    return PersistentCache.getOrComputeRegistry(`ungh:${owner}/${repo}`, async () => {
        try {
            const res = await fetch(`https://ungh.cc/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { signal });
            if (!res.ok) return null;
            const data = await res.json();
            const r = data?.repo;
            if (!r || typeof r.stars !== 'number') return null;
            return { stars: r.stars, forks: r.forks ?? 0, pushedAt: r.pushedAt || undefined };
        } catch {
            return null;
        }
    });
}

/** repology — distinct package repositories that ship this project. */
export async function fetchRepologyRepos(name: string, signal?: AbortSignal): Promise<string[]> {
    return PersistentCache.getOrComputeRegistry(`repology:${name}`, async () => {
        try {
            const res = await fetch(`https://repology.org/api/v1/project/${encodeURIComponent(name)}`, { signal });
            if (!res.ok) return [];
            const data = await res.json();
            if (!Array.isArray(data)) return [];
            const repos = new Set<string>();
            for (const entry of data) {
                if (entry?.repo && typeof entry.repo === 'string') repos.add(entry.repo);
            }
            return Array.from(repos).sort();
        } catch {
            return [];
        }
    });
}

const LIBRARIES_IO_PLATFORMS: Record<string, string> = {
    npm: 'npm',
    pypi: 'pypi',
    crates: 'cargo',
    go: 'go',
    nuget: 'nuget'
};

const librariesIoKey = (import.meta.env?.VITE_LIBRARIES_IO_KEY as string | undefined) || '';

export function isLibrariesIoEnabled(): boolean {
    return librariesIoKey.length > 0;
}

/** libraries.io — dependents/rank. Disabled unless an API key is configured. */
export async function fetchLibrariesIoInfo(source: string, name: string, signal?: AbortSignal): Promise<LibrariesIoInfo | null> {
    const platform = LIBRARIES_IO_PLATFORMS[source];
    if (!platform || !librariesIoKey) return null;

    return PersistentCache.getOrComputeRegistry(`librariesio:${platform}:${name}`, async () => {
        try {
            const res = await fetch(
                `https://libraries.io/api/${platform}/${encodeURIComponent(name)}?api_key=${encodeURIComponent(librariesIoKey)}`,
                { signal }
            );
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || typeof data !== 'object') return null;
            return {
                dependents: typeof data.dependents_count === 'number' ? data.dependents_count : undefined,
                stars: typeof data.stars === 'number' ? data.stars : undefined,
                rank: typeof data.rank === 'number' ? data.rank : undefined
            };
        } catch {
            return null;
        }
    });
}
