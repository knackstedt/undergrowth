import { PersistentCache } from '../utils/cache';
import { PermanentError, withRetry } from '../utils/retry';

export interface NuGetPackageVersion {
    version: string;
    downloads: number;
    published: string;
    licenseUrl?: string;
    licenseExpression?: string;
    deprecation?: {
        message?: string;
        alternatePackage?: {
            id?: string;
            versionRange?: string;
        };
    };
}

export interface NuGetPackageMeta {
    id: string;
    authors: string | string[];
    description: string;
    projectUrl?: string;
    iconUrl?: string;
    licenseUrl?: string;
    licenseExpression?: string;
    tags: string[];
    totalDownloads: number;
    verified: boolean;
    packageTypes: string[];
    versions: NuGetPackageVersion[];
    dependencyGroups?: NuGetDependencyGroup[];
}

export interface NuGetDependencyGroup {
    targetFramework: string;
    dependencies: NuGetDependency[];
}

export interface NuGetDependency {
    id: string;
    range: string;
    // NuGet doesn't have optional deps at the dependency level,
    // but has developmentDependency flag at package level
}

export interface NuGetRegistrationIndex {
    items: NuGetRegistrationPage[];
}

export interface NuGetRegistrationPage {
    items?: NuGetRegistrationLeaf[];
    lower: string;
    upper: string;
}

export interface NuGetRegistrationLeaf {
    catalogEntry: NuGetCatalogEntry;
}

export interface NuGetCatalogEntry {
    id: string;
    version: string;
    published: string;
    deprecation?: {
        message?: string;
        alternatePackage?: {
            id?: string;
            versionRange?: string;
        };
    };
    licenseUrl?: string;
    licenseExpression?: string;
}

const NUGET_INDEX_URL = 'https://api.nuget.org/v3/index.json';

let nugetServiceIndex: { resources: Array<{ '@type': string; '@id': string }> } | null = null;

async function getServiceIndex(): Promise<{ resources: Array<{ '@type': string; '@id': string }> }> {
    if (nugetServiceIndex) {
        return nugetServiceIndex;
    }

    const response = await fetch(NUGET_INDEX_URL);
    if (!response.ok) {
        throw new Error(`Failed to fetch NuGet service index: ${response.statusText}`);
    }

    nugetServiceIndex = await response.json() as { resources: Array<{ '@type': string; '@id': string }> };
    return nugetServiceIndex;
}

function getResourceUrl(serviceIndex: { resources: Array<{ '@type': string; '@id': string }> }, type: string): string | null {
    const resource = serviceIndex.resources.find(r => r['@type'] === type || r['@type'].startsWith(type));
    return resource?.['@id'] ?? null;
}

// In-memory cache for in-flight requests (prevents duplicate concurrent fetches)
const inFlightCache = new Map<string, Promise<NuGetPackageMeta>>();

export async function fetchPackageMeta(name: string): Promise<NuGetPackageMeta> {
    const cacheKey = `nuget:${name.toLowerCase()}`;

    // Check in-memory cache for in-flight requests first
    if (inFlightCache.has(cacheKey)) {
        return inFlightCache.get(cacheKey)!;
    }

    // Use persistent cache with fallback to fetch
    const fetchAndCache = async (): Promise<NuGetPackageMeta> => {
        try {
            return await withRetry(async () => {
                const serviceIndex = await getServiceIndex();
                const searchBaseUrl = getResourceUrl(serviceIndex, 'SearchQueryService');

                if (!searchBaseUrl) {
                    throw new Error('NuGet SearchQueryService not available');
                }

                // Search for the package
                const searchUrl = `${searchBaseUrl}?q=packageid:${encodeURIComponent(name)}&take=1&prerelease=false&semVerLevel=2.0.0`;
                const searchRes = await fetch(searchUrl);

                if (!searchRes.ok) {
                    throw new Error(`Failed to search NuGet package ${name}: ${searchRes.statusText}`);
                }

                const searchData = await searchRes.json() as { data: NuGetPackageMeta[] };

                if (!searchData.data || searchData.data.length === 0) {
                    throw new PermanentError(`Package "${name}" not found on NuGet`);
                }

                const packageData = searchData.data[0];

                // Normalize version data
                if (packageData.versions) {
                    packageData.versions = packageData.versions.map(v => ({
                        ...v,
                        version: normalizeVersion(v.version)
                    }));
                }

                // Cache the result
                await PersistentCache.setRegistry(cacheKey, packageData);

                return packageData;
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
const inFlightDepCache = new Map<string, Promise<NuGetDependencyGroup[]>>();

/**
 * Fetch dependencies for a specific version of a package.
 * NuGet dependencies are framework-specific, so we need to handle that.
 */
export async function fetchVersionDependencies(
    name: string,
    version: string
): Promise<NuGetDependencyGroup[]> {
    const cacheKey = `nuget:deps:${name.toLowerCase()}:${version}`;

    // Check in-memory cache for in-flight requests first
    if (inFlightDepCache.has(cacheKey)) {
        return inFlightDepCache.get(cacheKey)!;
    }

    // Use persistent cache with fallback to fetch
    const fetchAndCache = async (): Promise<NuGetDependencyGroup[]> => {
        try {
            return await withRetry(async () => {
                const serviceIndex = await getServiceIndex();
                const regBaseUrl = getResourceUrl(serviceIndex, 'RegistrationsBaseUrl');

                if (!regBaseUrl) {
                    console.warn(`[NuGet] No RegistrationsBaseUrl found for ${name}@${version}`);
                    return [];
                }

                // Normalize version for URL
                const normalizedVersion = normalizeVersion(version);
                const lowerName = name.toLowerCase();

                // Build registration URL - ensure trailing slash on base URL
                const baseUrl = regBaseUrl.endsWith('/') ? regBaseUrl : `${regBaseUrl}/`;
                const regUrl = `${baseUrl}${lowerName}/${normalizedVersion}.json`;

                console.log(`[NuGet] Fetching dependencies from: ${regUrl}`);
                const res = await fetch(regUrl);

                let groups: NuGetDependencyGroup[] = [];

                if (!res.ok) {
                    console.warn(`[NuGet] Registration fetch failed: ${res.status} ${res.statusText} for ${name}@${version}`);
                    // Fallback: try to get dependencies from the package metadata
                    const meta = await fetchPackageMeta(name);
                    console.log(`[NuGet] Fallback meta.dependencyGroups:`, meta.dependencyGroups);
                    groups = meta.dependencyGroups || [];
                } else {
                    const data = await res.json() as { dependencyGroups?: NuGetDependencyGroup[]; catalogEntry?: { dependencyGroups?: NuGetDependencyGroup[] } | string };
                    console.log(`[NuGet] Response keys:`, Object.keys(data));

                    groups = data.dependencyGroups || [];

                    // If catalogEntry is a URL string, fetch it to get dependency groups
                    if (typeof data.catalogEntry === 'string') {
                        console.log(`[NuGet] Fetching catalogEntry from: ${data.catalogEntry}`);
                        const catalogRes = await fetch(data.catalogEntry);
                        if (catalogRes.ok) {
                            const catalogData = await catalogRes.json() as { dependencyGroups?: NuGetDependencyGroup[] };
                            groups = catalogData.dependencyGroups || [];
                        }
                    } else if (typeof data.catalogEntry === 'object' && data.catalogEntry) {
                        // catalogEntry is an embedded object
                        groups = data.catalogEntry.dependencyGroups || [];
                    }
                }

                console.log(`[NuGet] Fetched ${groups.length} dependency groups for ${name}@${version}`);

                // Cache the result
                await PersistentCache.setRegistry(cacheKey, groups);

                return groups;
            });
        } catch (err) {
            // Remove from in-flight cache on failure
            inFlightDepCache.delete(cacheKey);
            console.warn(`[NuGet] Error fetching dependencies for ${name}@${version}:`, err);
            return [];
        }
    };

    // Use persistent cache with TTL
    const promise = PersistentCache.getOrComputeRegistry(cacheKey, fetchAndCache).catch(() => []);
    inFlightDepCache.set(cacheKey, promise);
    return promise;
}

/**
 * NuGet uses normalized versions (no leading zeros in version parts).
 * Convert version to normalized form.
 */
function normalizeVersion(version: string): string {
    // Remove leading zeros from version parts
    // 1.01.02 -> 1.1.2
    return version
        .split('.')
        .map(part => part.replace(/^0+(?=\d)/, '')) // Remove leading zeros but keep "0"
        .join('.');
}

/**
 * Parse a NuGet version range into a simple version spec.
 * NuGet version ranges: https://docs.microsoft.com/en-us/nuget/concepts/package-versioning
 *
 * Examples:
 * - "1.0" -> exact 1.0
 * - "[1.0]" -> exact 1.0
 * - "(1.0,)" -> greater than 1.0
 * - "[1.0,)" -> 1.0 or greater
 * - "(,2.0]" -> 2.0 or lower
 * - "[1.0,2.0]" -> between 1.0 and 2.0 (inclusive)
 * - "(1.0,2.0)" -> between 1.0 and 2.0 (exclusive)
 */
export function resolveNuGetVersion(
    range: string,
    availableVersions: string[]
): string {
    if (!range || range === '*') {
        return availableVersions[availableVersions.length - 1];
    }

    // Handle plain version (treat as exact or minimum)
    if (/^\d/.test(range) && !range.includes('[') && !range.includes('(')) {
        const normalized = normalizeVersion(range);
        if (availableVersions.includes(normalized)) {
            return normalized;
        }
        // Fall back to latest compatible version
        for (let i = availableVersions.length - 1; i >= 0; i--) {
            if (compareNuGetVersions(availableVersions[i], normalized) >= 0) {
                return availableVersions[i];
            }
        }
        return availableVersions[availableVersions.length - 1];
    }

    // Parse range format [1.0,2.0) etc.
    // eslint-disable-next-line no-useless-escape
    const rangeMatch = range.match(/^([\[(])?([^,\]]*),?([^\])]*)?([\])])?$/);
    if (rangeMatch) {
        const minInclusive = rangeMatch[1] === '[';
        const minVer = rangeMatch[2]?.trim();
        const maxVer = rangeMatch[3]?.trim();
        const maxInclusive = rangeMatch[4] === ']';

        let candidates = [...availableVersions];

        // Filter by minimum version
        if (minVer) {
            const minComp = minInclusive ? 0 : 1;
            candidates = candidates.filter(v => compareNuGetVersions(v, minVer) >= minComp);
        }

        // Filter by maximum version
        if (maxVer) {
            const maxComp = maxInclusive ? 0 : -1;
            candidates = candidates.filter(v => compareNuGetVersions(v, maxVer) <= maxComp);
        }

        if (candidates.length > 0) {
            // Return the highest matching version
            return candidates[candidates.length - 1];
        }
    }

    // Default to latest
    return availableVersions[availableVersions.length - 1];
}

/**
 * Compare two NuGet versions.
 * Returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
 */
function compareNuGetVersions(v1: string, v2: string): number {
    const parts1 = v1.split(/[.-]/).map(p => {
        const num = parseInt(p, 10);
        return isNaN(num) ? p.toLowerCase() : num;
    });
    const parts2 = v2.split(/[.-]/).map(p => {
        const num = parseInt(p, 10);
        return isNaN(num) ? p.toLowerCase() : num;
    });

    const maxLen = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < maxLen; i++) {
        const a = parts1[i] ?? 0;
        const b = parts2[i] ?? 0;

        if (typeof a === 'number' && typeof b === 'number') {
            if (a < b) return -1;
            if (a > b) return 1;
        } else if (typeof a === 'string' && typeof b === 'string') {
            const cmp = a.localeCompare(b);
            if (cmp !== 0) return cmp;
        } else {
            // Numbers have higher precedence than strings (prerelease)
            return typeof a === 'number' ? 1 : -1;
        }
    }
    return 0;
}

/**
 * Check if a dependency is a development-only dependency.
 * In NuGet, this is determined by the <developmentDependency> flag in the nuspec.
 */
export function isDevelopmentDependency(): boolean {
    // NuGet doesn't mark individual dependencies as dev dependencies
    // The entire package can be marked as developmentDependency
    return false;
}

/**
 * Get the best matching dependency group for a target framework.
 * Returns the most compatible dependency group.
 */
export function getBestDependencyGroup(
    groups: NuGetDependencyGroup[],
    targetFramework?: string
): NuGetDependencyGroup | null {
    if (!groups || groups.length === 0) {
        return null;
    }

    if (!targetFramework) {
        // Return the group with the most dependencies, or first one
        return groups.reduce((best, current) =>
            (current.dependencies?.length || 0) > (best.dependencies?.length || 0) ? current : best
        );
    }

    // Try exact match first
    const exact = groups.find(g =>
        g.targetFramework.toLowerCase() === targetFramework.toLowerCase()
    );
    if (exact) return exact;

    // Try to find compatible framework
    // Standard TFMs: net9.0, net8.0, netstandard2.1, netstandard2.0, net481, net48, net472, etc.
    const tfm = targetFramework.toLowerCase();

    // For .NET Core / .NET 5+, fall back to netstandard if available
    if (tfm.startsWith('net') && !tfm.includes('standard')) {
        const netVersion = parseFloat(tfm.substring(3));
        if (!isNaN(netVersion)) {
            if (netVersion >= 5.0) {
                const std21 = groups.find(g => g.targetFramework.toLowerCase() === 'netstandard2.1');
                if (std21) return std21;
            }
            if (netVersion >= 2.0) {
                const std20 = groups.find(g => g.targetFramework.toLowerCase() === 'netstandard2.0');
                if (std20) return std20;
            }
        }
    }

    // Return the group with the most dependencies as a fallback
    return groups.reduce((best, current) =>
        (current.dependencies?.length || 0) > (best.dependencies?.length || 0) ? current : best
    );
}

/**
 * Get downloads for a specific version.
 */
export function getVersionDownloads(pkg: NuGetPackageMeta, version: string): number {
    const versionData = pkg.versions?.find(v => v.version === version);
    return versionData?.downloads || 0;
}
