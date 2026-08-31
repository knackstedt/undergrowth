import { PersistentCache } from '../utils/cache';
import { PermanentError, withRetry } from '../utils/retry';

export interface GoModuleVersion {
    Version: string;
    Time: string;
}

export interface GoModuleInfo {
    Version: string;
    Time: string;
}

export interface GoModDependency {
    path: string;
    version: string;
    indirect?: boolean;
}

export interface GoModuleMeta {
    name: string;
    versions: string[];
    latestVersion: string;
    description?: string;
    dependencies: GoModDependency[];
}

// Go module proxy uses special encoding for module paths
// See: https://go.dev/ref/mod#goproxy-protocol
function encodeModulePath(modulePath: string): string {
    // Replace uppercase letters with !<lowercase>
    return modulePath
        .split('')
        .map(c => {
            if (c >= 'A' && c <= 'Z') {
                return '!' + c.toLowerCase();
            }
            return c;
        })
        .join('');
}

const GOPROXY_BASE = 'https://proxy.golang.org';

// In-memory cache for in-flight requests (prevents duplicate concurrent fetches)
const inFlightCache = new Map<string, Promise<GoModuleMeta>>();

interface GitHubRepo {
    full_name: string;
    stargazers_count: number;
}

interface GitHubSearchResult {
    items: GitHubRepo[];
}

/**
 * Search GitHub for a Go module by short name (e.g., "gin" -> "github.com/gin-gonic/gin").
 * Uses the GitHub Search API which supports CORS, unlike pkg.go.dev.
 * Returns the full module path or null if no match found.
 */
async function searchGoModule(shortName: string): Promise<string | null> {
    try {
        const res = await fetch(
            `https://api.github.com/search/repositories?q=${encodeURIComponent(shortName)}+language:go&sort=stars&order=desc&per_page=5`
        );
        if (!res.ok) return null;
        const data = (await res.json()) as GitHubSearchResult;

        const repos = data.items || [];
        // Prefer exact name match, otherwise take highest-starred result
        const exactMatch = repos.find(r => r.full_name.split('/')[1]?.toLowerCase() === shortName.toLowerCase());
        const bestMatch = exactMatch || repos[0];
        if (bestMatch) {
            return `github.com/${bestMatch.full_name}`;
        }
        return null;
    } catch {
        return null;
    }
}

export async function fetchPackageMeta(name: string): Promise<GoModuleMeta> {
    const cacheKey = `go:${name.toLowerCase()}`;

    // Check in-memory cache for in-flight requests first
    if (inFlightCache.has(cacheKey)) {
        return inFlightCache.get(cacheKey)!;
    }

    // Use persistent cache with fallback to fetch
    const fetchAndCache = async (): Promise<GoModuleMeta> => {
        let resolvedName = name;

        // If the name doesn't look like a full Go module path (no dot = no domain),
        // try searching pkg.go.dev for the full path
        if (!name.includes('.')) {
            const found = await searchGoModule(name);
            if (found) {
                resolvedName = found;
            } else {
                throw new PermanentError(
                    `Module "${name}" not found. Go modules require full import paths (e.g., github.com/gin-gonic/gin).`
                );
            }
        }

        try {
            return await withRetry(async () => {
                const encodedPath = encodeModulePath(resolvedName);

                // Fetch the list of versions
                const listRes = await fetch(`${GOPROXY_BASE}/${encodedPath}/@v/list`);
                if (listRes.status >= 400 && listRes.status < 500) {
                    throw new PermanentError(`Module "${resolvedName}" not found (${listRes.status})`);
                }
                if (!listRes.ok) {
                    throw new Error(`Failed to fetch module ${resolvedName}: ${listRes.statusText} (${listRes.status})`);
                }

                const versionsText = await listRes.text();
                const versions = versionsText.trim().split('\n').filter(v => v);

                if (versions.length === 0) {
                    throw new Error(`No versions found for module ${resolvedName}`);
                }

                // Get the latest version
                const latestVersion = versions[versions.length - 1];

                // Fetch the go.mod file for the latest version to get dependencies
                const modRes = await fetch(`${GOPROXY_BASE}/${encodedPath}/@v/${latestVersion}.mod`);
                let dependencies: GoModDependency[] = [];

                if (modRes.ok) {
                    const modContent = await modRes.text();
                    dependencies = parseGoMod(modContent);
                }

                const result = {
                    name: resolvedName,
                    versions,
                    latestVersion,
                    description: '', // Go proxy doesn't provide descriptions
                    dependencies
                };

                // Cache the result
                await PersistentCache.setRegistry(cacheKey, result);

                return result;
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
const inFlightDepCache = new Map<string, Promise<GoModDependency[]>>();

/**
 * Fetch dependencies for a specific version of a module.
 */
export async function fetchVersionDependencies(
    name: string,
    version: string
): Promise<GoModDependency[]> {
    const cacheKey = `go:deps:${name.toLowerCase()}:${version}`;

    // Check in-memory cache for in-flight requests first
    if (inFlightDepCache.has(cacheKey)) {
        return inFlightDepCache.get(cacheKey)!;
    }

    // Use persistent cache with fallback to fetch
    const fetchAndCache = async (): Promise<GoModDependency[]> => {
        try {
            return await withRetry(async () => {
                const encodedPath = encodeModulePath(name);
                const res = await fetch(`${GOPROXY_BASE}/${encodedPath}/@v/${version}.mod`);
                if (!res.ok) {
                    throw new Error(`Failed to fetch go.mod: ${res.statusText} (${res.status})`);
                }
                const content = await res.text();
                const deps = parseGoMod(content);

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
 * Fetch the zipped module size (in bytes) from proxy.golang.org via HEAD request.
 * Returns undefined if the size cannot be determined.
 */
export async function fetchModuleSize(name: string, version: string): Promise<number | undefined> {
    try {
        const encodedPath = encodeModulePath(name);
        const res = await fetch(`${GOPROXY_BASE}/${encodedPath}/@v/${version}.zip`, { method: 'HEAD' });
        if (!res.ok) return undefined;
        const contentLength = res.headers.get('content-length');
        if (contentLength) {
            return parseInt(contentLength, 10);
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * Parse a go.mod file content and extract dependencies.
 * 
 * go.mod format:
 * module example.com/mymodule
 * 
 * go 1.21
 * 
 * require (
 *     github.com/some/pkg v1.2.3
 *     github.com/other/pkg v2.0.0 // indirect
 * )
 * 
 * require github.com/single/pkg v1.0.0
 * 
 * replace example.com/original => example.com/fork v1.0.0
 */
export function parseGoMod(content: string): GoModDependency[] {
    const dependencies: GoModDependency[] = [];
    const lines = content.split('\n');
    let inRequireBlock = false;
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        // Skip empty lines and comments
        if (!line || line.startsWith('//')) continue;
        
        // Track require blocks
        if (line === 'require (') {
            inRequireBlock = true;
            continue;
        }
        if (line === ')') {
            inRequireBlock = false;
            continue;
        }
        
        // Skip non-require sections entirely
        if (line.startsWith('replace ') || line.startsWith('exclude ') || line.startsWith('retract ')) {
            continue;
        }
        
        // Skip module and go directives
        if (line.startsWith('module ') || line.startsWith('go ')) {
            continue;
        }
        
        // Handle inline require: require github.com/pkg v1.0.0
        let isInRequire = inRequireBlock;
        if (line.startsWith('require ') && !line.includes('(')) {
            line = line.slice(8).trim(); // Remove "require " prefix
            isInRequire = true;
        }
        
        // Only parse if we're in a require context
        if (!isInRequire) continue;
        
        // Parse dependency line
        // Format: module/path vX.Y.Z [// indirect]
        const match = line.match(/^([^\s]+)\s+(v[^\s]+)/);
        if (match) {
            const [, path, version] = match;
            const isIndirect = line.includes('// indirect');
            
            dependencies.push({
                path,
                version,
                indirect: isIndirect
            });
        }
    }
    
    return dependencies;
}

/**
 * Parse go.mod-style version requirement.
 * Go uses semantic versioning with the 'v' prefix (v1.2.3).
 * 
 * Go's module system has:
 * - Exact versions: v1.2.3
 * - Version ranges via minimum version selection (MVS)
 * - Pseudo-versions for commits: v0.0.0-20240101120000-abcdef123456
 */
export function resolveGoVersion(
    requirement: string,
    availableVersions: string[]
): string {
    // Remove 'v' prefix if present for comparison
    const cleanReq = requirement.startsWith('v') ? requirement.slice(1) : requirement;
    
    // Direct version match
    if (availableVersions.includes(requirement)) {
        return requirement;
    }
    
    // Try without v prefix
    const versionWithV = 'v' + cleanReq;
    if (availableVersions.includes(versionWithV)) {
        return versionWithV;
    }
    
    // For Go modules, find the highest version that satisfies >= requirement
    // Go uses Minimum Version Selection - we'll approximate with latest matching
    
    // Clean available versions for comparison
    const cleanVersions = availableVersions.map(v => ({
        original: v,
        clean: v.startsWith('v') ? v.slice(1) : v
    }));
    
    // Try to find a version that matches the requirement
    // Handle pseudo-versions by extracting timestamp
    if (cleanReq.includes('-')) {
        // Pseudo-version: v0.0.0-20240101120000-abcdef123456
        // Find the latest version
        return availableVersions[availableVersions.length - 1];
    }
    
    // For exact version requirement, try to find compatible higher version
    // Go allows ^ prefix in some contexts, but typically uses exact or latest
    if (cleanReq.match(/^\d/)) {
        const reqParts = cleanReq.split('.').map(Number);
        
        for (let i = cleanVersions.length - 1; i >= 0; i--) {
            const { original, clean } = cleanVersions[i];
            const availParts = clean.split('.').map(Number);
            
            // Check if available version is >= required
            let isCompatible = true;
            for (let j = 0; j < Math.max(reqParts.length, availParts.length); j++) {
                const reqPart = reqParts[j] || 0;
                const availPart = availParts[j] || 0;
                
                if (availPart > reqPart) break;
                if (availPart < reqPart) {
                    isCompatible = false;
                    break;
                }
            }
            
            if (isCompatible) {
                return original;
            }
        }
    }
    
    // Default to latest
    return availableVersions[availableVersions.length - 1];
}

/**
 * Check if a dependency is an optional/indirect dependency.
 * In Go, "indirect" dependencies are those not directly imported by the module's code,
 * but required by dependencies.
 */
export function isOptionalDependency(dep: GoModDependency): boolean {
    return dep.indirect === true;
}
