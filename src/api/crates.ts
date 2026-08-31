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

export async function fetchPackageMeta(name: string): Promise<CratesPackageMeta> {
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
                const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
                if (res.status >= 400 && res.status < 500) {
                    throw new PermanentError(`Crate "${name}" not found (${res.status})`);
                }
                if (!res.ok) {
                    throw new Error(`Failed to fetch crate ${name}: ${res.statusText} (${res.status})`);
                }
                const data = await res.json() as CratesPackageMeta;

                // Then fetch dependencies for the latest version
                if (data.versions.length > 0) {
                    const latestVersion = data.versions[0];
                    try {
                        const depsRes = await fetch(
                            `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${latestVersion.num}/dependencies`
                        );
                        if (depsRes.ok) {
                            const depsData = await depsRes.json();
                            latestVersion.dependencies = depsData.dependencies || [];
                        }
                    } catch {
                        // Ignore dependency fetch errors
                    }
                }

                // Cache the result
                await PersistentCache.setRegistry(cacheKey, data);

                return data;
            });
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
    version: string
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
                    `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/dependencies`
                );
                if (!res.ok) {
                    throw new Error(`Failed to fetch dependencies: ${res.statusText} (${res.status})`);
                }
                const data = await res.json();
                const deps = data.dependencies || [];

                // Cache the result
                await PersistentCache.setRegistry(cacheKey, deps);

                return deps;
            });
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
 * Parse Cargo.toml-style version requirement to extract a simple version spec.
 * Returns the latest version that satisfies the requirement from available versions.
 */
export function resolveCargoVersion(
    requirement: string,
    availableVersions: string[]
): string {
    if (!requirement || requirement === '*') {
        return availableVersions[availableVersions.length - 1];
    }

    // Handle caret (^) requirements - compatible version
    if (requirement.startsWith('^')) {
        const version = requirement.slice(1).trim();
        return findCompatibleVersion(version, availableVersions);
    }

    // Handle tilde (~) requirements - approximate version
    if (requirement.startsWith('~')) {
        const version = requirement.slice(1).trim();
        return findCompatibleVersion(version, availableVersions);
    }

    // Handle exact (=) requirements
    if (requirement.startsWith('=')) {
        const version = requirement.slice(1).trim();
        if (availableVersions.includes(version)) {
            return version;
        }
    }

    // Handle comparison operators
    if (requirement.startsWith('>=')) {
        const minVersion = requirement.slice(2).trim();
        return findMinVersion(minVersion, availableVersions);
    }

    if (requirement.startsWith('>')) {
        const minVersion = requirement.slice(1).trim();
        return findGreaterVersion(minVersion, availableVersions);
    }

    if (requirement.startsWith('<=')) {
        const maxVersion = requirement.slice(2).trim();
        return findMaxVersion(maxVersion, availableVersions);
    }

    if (requirement.startsWith('<')) {
        const maxVersion = requirement.slice(1).trim();
        return findLessVersion(maxVersion, availableVersions);
    }

    // Handle version ranges with comma (e.g., ">=1.0, <2.0")
    if (requirement.includes(',')) {
        // For simplicity, try to find the latest that satisfies the lower bound
        const parts = requirement.split(',');
        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.startsWith('>=')) {
                const minVersion = trimmed.slice(2).trim();
                return findMinVersion(minVersion, availableVersions);
            }
            if (trimmed.startsWith('>')) {
                const minVersion = trimmed.slice(1).trim();
                return findGreaterVersion(minVersion, availableVersions);
            }
        }
    }

    // Default: if it's a plain version string that exactly matches an available version, use it
    if (availableVersions.includes(requirement)) {
        return requirement;
    }

    // Otherwise treat as a caret-style compatible version
    return findCompatibleVersion(requirement, availableVersions);
}

function findCompatibleVersion(version: string, availableVersions: string[]): string {
    const parts = version.split('.');
    const major = parts[0] || '0';
    const minor = parts[1] || '0';

    // Find latest version with same major and at least same minor
    for (let i = availableVersions.length - 1; i >= 0; i--) {
        const v = availableVersions[i];
        const vParts = v.split('.');
        const vMajor = vParts[0] || '0';
        const vMinor = vParts[1] || '0';

        if (vMajor === major && parseInt(vMinor) >= parseInt(minor)) {
            return v;
        }
        if (parseInt(vMajor) > parseInt(major)) {
            // Too far ahead, stop looking
            break;
        }
    }

    return availableVersions[availableVersions.length - 1] || version;
}

function findMinVersion(minVersion: string, availableVersions: string[]): string {
    for (const v of availableVersions) {
        if (compareVersions(v, minVersion) >= 0) {
            return v;
        }
    }
    return availableVersions[availableVersions.length - 1] || minVersion;
}

function findGreaterVersion(minVersion: string, availableVersions: string[]): string {
    for (const v of availableVersions) {
        if (compareVersions(v, minVersion) > 0) {
            return v;
        }
    }
    return availableVersions[availableVersions.length - 1] || minVersion;
}

function findMaxVersion(maxVersion: string, availableVersions: string[]): string {
    for (let i = availableVersions.length - 1; i >= 0; i--) {
        if (compareVersions(availableVersions[i], maxVersion) <= 0) {
            return availableVersions[i];
        }
    }
    return availableVersions[0] || maxVersion;
}

function findLessVersion(maxVersion: string, availableVersions: string[]): string {
    for (let i = availableVersions.length - 1; i >= 0; i--) {
        if (compareVersions(availableVersions[i], maxVersion) < 0) {
            return availableVersions[i];
        }
    }
    return availableVersions[0] || maxVersion;
}

/**
 * Compare two semantic versions.
 * Returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split(/[.-]/).map(p => parseInt(p, 10) || 0);
    const parts2 = v2.split(/[.-]/).map(p => parseInt(p, 10) || 0);

    const maxLen = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < maxLen; i++) {
        const a = parts1[i] || 0;
        const b = parts2[i] || 0;
        if (a < b) return -1;
        if (a > b) return 1;
    }
    return 0;
}
