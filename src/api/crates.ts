import semver from 'semver';
import { PersistentCache } from '../utils/cache';
import { PermanentError, withRetry } from '../utils/retry';

export interface CratesVersion {
    id: number;
    num: string;
    dl_path: string;
    readme_path: string;
    created_at: string;
    updated_at: string;
    downloads: number;
    features: Record<string, string[]>;
    yanked: boolean;
    license: string | null;
    crate_size: number | null;
    published_by: {
        id: number;
        login: string;
        name: string | null;
        email: string | null;
        url: string;
        avatar: string;
    } | null;
    audit_actions: Array<{
        action: string;
        user: {
            id: number;
            login: string;
            name: string | null;
        };
        time: string;
    }>;
    // Dependency data from dependencies endpoint
    dependencies?: CratesDependency[];
}

export interface CratesDependency {
    id: number;
    crate_id: string;
    req: string; // version requirement
    optional: boolean;
    default_features: boolean;
    features: string[];
    kind: 'normal' | 'dev' | 'build';
}

export interface CratesCrate {
    id: string;
    name: string;
    updated_at: string;
    versions: number[]; // version IDs
    created_at: string;
    downloads: number;
    recent_downloads: number;
    max_version: string;
    max_stable_version: string | null;
    description: string | null;
    homepage: string | null;
    documentation: string | null;
    repository: string | null;
    license: string | null;
    exact_match: boolean;
    categories: Array<{
        id: string;
        category: string;
        slug: string;
        description: string;
        crates_cnt: number;
    }>;
    keywords: Array<{
        id: string;
        keyword: string;
        slug: string;
        crates_cnt: number;
    }>;
    badges: unknown[];
    readme: string | null;
}

export interface CratesPackageMeta {
    crate: CratesCrate;
    versions: CratesVersion[];
    keywords: unknown[];
    categories: unknown[];
}

// In-memory cache for in-flight requests (prevents duplicate concurrent fetches)
const inFlightCache = new Map<string, Promise<CratesPackageMeta>>();

export async function fetchPackageMeta(name: string, signal?: AbortSignal): Promise<CratesPackageMeta> {
    const cacheKey = `crates:${name.toLowerCase()}`;

    // Check in-memory cache for in-flight requests first
    if (inFlightCache.has(cacheKey)) {
        return inFlightCache.get(cacheKey)!;
    }

    // Use persistent cache with fallback to fetch
    const fetchAndCache = async (): Promise<CratesPackageMeta> => {
        try {
            return await withRetry(async () => {
                // First fetch the crate metadata
                const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, { signal });
                if (res.status >= 400 && res.status < 500) {
                    throw new PermanentError(`Crate "${name}" not found (${res.status})`);
                }
                if (!res.ok) {
                    throw new Error(`Failed to fetch crate ${name}: ${res.statusText} (${res.status})`);
                }
                const data = await res.json() as CratesPackageMeta;

                // Then fetch dependencies for the latest stable version
                // (versions[0] is not guaranteed to be the newest — resolve by semver)
                const latestVersion = resolveCargoVersion(
                    data.crate.max_stable_version || data.crate.max_version || '*',
                    data.versions.map(v => v.num)
                );
                const latestVersionData = data.versions.find(v => v.num === latestVersion);
                if (latestVersionData) {
                    try {
                        const depsRes = await fetch(
                            `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${latestVersionData.num}/dependencies`,
                            { signal }
                        );
                        if (depsRes.ok) {
                            const depsData = await depsRes.json();
                            latestVersionData.dependencies = depsData.dependencies || [];
                        }
                    } catch {
                        // Ignore dependency fetch errors
                    }
                }

                // Cache the result
                await PersistentCache.setRegistry(cacheKey, data);

                return data;
            }, 5, 2500, signal);
        } catch (err) {
            // Remove from in-flight cache on failure
            inFlightCache.delete(cacheKey);
            throw err;
        }
    };

    // Use persistent cache with TTL
    const promise = PersistentCache.getOrComputeRegistry(cacheKey, fetchAndCache);
    inFlightCache.set(cacheKey, promise);
    return promise;
}

// In-memory cache for in-flight dependency requests
const inFlightDepCache = new Map<string, Promise<CratesDependency[]>>();

/**
 * Fetch dependencies for a specific version of a crate.
 */
export async function fetchVersionDependencies(
    name: string,
    version: string,
    signal?: AbortSignal
): Promise<CratesDependency[]> {
    const cacheKey = `crates:deps:${name.toLowerCase()}:${version}`;

    // Check in-memory cache for in-flight requests first
    if (inFlightDepCache.has(cacheKey)) {
        return inFlightDepCache.get(cacheKey)!;
    }

    // Use persistent cache with fallback to fetch
    const fetchAndCache = async (): Promise<CratesDependency[]> => {
        try {
            return await withRetry(async () => {
                const res = await fetch(
                    `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/dependencies`,
                    { signal }
                );
                if (!res.ok) {
                    throw new Error(`Failed to fetch dependencies: ${res.statusText} (${res.status})`);
                }
                const data = await res.json();
                const deps = data.dependencies || [];

                // Cache the result
                await PersistentCache.setRegistry(cacheKey, deps);

                return deps;
            }, 5, 2500, signal);
        } catch (err) {
            // Remove from in-flight cache on failure
            inFlightDepCache.delete(cacheKey);
            throw err;
        }
    };

    // Use persistent cache with TTL
    const promise = PersistentCache.getOrComputeRegistry(cacheKey, fetchAndCache).catch(() => []);
    inFlightDepCache.set(cacheKey, promise);
    return promise;
}

/**
 * Resolve a Cargo.toml-style version requirement to the latest satisfying version.
 * Cargo semantics: a bare version means caret-compatible ("1.2" ≡ "^1.2"),
 * and resolution picks the maximum satisfying version.
 */
export function resolveCargoVersion(
    requirement: string,
    availableVersions: string[]
): string {
    const versions = availableVersions.filter(v => semver.valid(v)).sort(semver.compare);
    const latest = versions[versions.length - 1] || availableVersions[availableVersions.length - 1];
    if (!latest) return requirement;

    const req = (requirement || '*').trim();
    if (req === '*' || req === 'latest' || req === '') {
        return latest;
    }

    // Fully-qualified version that exists in the list — use it directly.
    // (Partial versions like "1.2" keep Cargo's implied-caret semantics below.)
    if (/^v?\d+\.\d+\.\d+/.test(req) && versions.includes(req)) {
        return req;
    }

    // Translate Cargo requirement syntax to a semver range:
    // - comma-separated clauses become space-separated
    // - bare versions get an implicit caret ("1.2" ≡ "^1.2", Cargo semantics)
    // - "=" prefix means exact match
    const clauses = req.split(',').map(c => c.trim()).filter(Boolean).map(clause => {
        if (clause.startsWith('=')) return clause.slice(1);
        if (/^[\^~<>=*]/.test(clause)) return clause;
        if (/^v?\d/.test(clause)) return `^${clause.replace(/^v/, '')}`;
        return clause;
    });
    const range = clauses.join(' ');

    try {
        const max = semver.maxSatisfying(versions, range, { includePrerelease: /\d-/.test(range) });
        return max ?? latest;
    } catch {
        return latest;
    }
}
