import { PersistentCache } from '../utils/cache';

export interface PyPIPackageVersion {
    name: string;
    version: string;
    summary: string;
    description: string;
    requires_python: string | null;
    requires_dist: string[];
    author: string;
    author_email: string;
    maintainer: string;
    maintainer_email: string;
    home_page: string;
    project_urls: Record<string, string> | null;
    package_url: string;
    release_url: string;
    files: Array<{
        filename: string;
        url: string;
        size: number;
    }>;
}

export interface PyPIPackageMeta {
    info: {
        name: string;
        summary: string;
        description: string;
        author: string;
        author_email: string;
        maintainer: string;
        maintainer_email: string;
        project_urls: Record<string, string> | null;
        home_page: string;
        package_url: string;
        requires_dist: string[] | null;
        requires_python: string | null;
        license: string;
    };
    releases: Record<string, Array<{
        filename: string;
        url: string;
        size: number;
        upload_time: string;
    }>>;
    urls: Array<{
        filename: string;
        url: string;
        size: number;
        upload_time: string;
    }>;
}

// In-memory cache for in-flight requests (prevents duplicate concurrent fetches)
const inFlightCache = new Map<string, Promise<PyPIPackageMeta>>();

export async function fetchPackageMeta(name: string): Promise<PyPIPackageMeta> {
    const cacheKey = `pypi:${name.toLowerCase()}`;

    // Check in-memory cache for in-flight requests first
    if (inFlightCache.has(cacheKey)) {
        return inFlightCache.get(cacheKey)!;
    }

    // Use persistent cache with fallback to fetch
    const fetchAndCache = async (): Promise<PyPIPackageMeta> => {
        try {
            const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
            if (res.status === 404) {
                throw new Error(`Package "${name}" not found on PyPI`);
            }
            if (!res.ok) {
                throw new Error(`Failed to fetch package ${name}: ${res.statusText} (${res.status})`);
            }
            const data = await res.json() as PyPIPackageMeta;

            // Cache the result
            await PersistentCache.setRegistry(cacheKey, data);

            return data;
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

/**
 * Parse a PEP 440 requirement specifier into package name and version constraint.
 * Examples:
 *   - "requests>=2.28.0" -> { name: "requests", specifier: ">=2.28.0" }
 *   - "numpy==1.24.0" -> { name: "numpy", specifier: "==1.24.0" }
 *   - "django>=3.0,<4.0" -> { name: "django", specifier: ">=3.0,<4.0" }
 *   - "git+https://github.com/..." -> { name: "git+https://...", specifier: null, source: "git" }
 *   - "-r requirements.txt" -> null (skip)
 *   - "# comment" -> null (skip)
 */
export function parseRequirement(line: string): { name: string; specifier: string | null; source: 'pypi' | 'git' | 'url' } | null {
    line = line.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#') || line.startsWith('-')) {
        return null;
    }

    // Handle git URLs
    if (line.startsWith('git+') || line.startsWith('git://')) {
        return { name: line, specifier: null, source: 'git' };
    }

    // Handle other VCS (hg+, svn+)
    if (line.match(/^(hg|svn|bzr)\+/)) {
        return { name: line, specifier: null, source: 'git' };
    }

    // Handle direct URLs
    if (line.startsWith('http://') || line.startsWith('https://')) {
        // Extract package name from URL if possible
        const match = line.match(/\/([^/]+)\.(tar\.gz|tar\.bz2|tgz|zip|whl)$/);
        const name = match ? match[1].replace(/-\d.*/, '') : line;
        return { name, specifier: line, source: 'url' };
    }

    // Parse name and version specifier
    // Match package name (can contain letters, numbers, hyphens, underscores, dots)
    // followed by optional version specifier
    const match = line.match(/^([a-zA-Z0-9][-a-zA-Z0-9._]*)(.*)$/);
    if (!match) {
        return null;
    }

    const name = match[1];
    const specifier = match[2].trim() || null;

    return { name, specifier, source: 'pypi' };
}

/**
 * Parse a requirements.txt file content into an array of dependencies.
 */
export function parseRequirementsTxt(content: string): Array<{ name: string; specifier: string | null; source: 'pypi' | 'git' | 'url' }> {
    const lines = content.split('\n');
    const dependencies: Array<{ name: string; specifier: string | null; source: 'pypi' | 'git' | 'url' }> = [];

    for (const line of lines) {
        const parsed = parseRequirement(line);
        if (parsed) {
            dependencies.push(parsed);
        }
    }

    return dependencies;
}

/**
 * Parse requires_dist array from PyPI metadata into simple dependencies.
 * This handles PEP 508 dependency specifiers.
 * 
 * Filters out:
 * - Dependencies with extras (optional features)
 * - Dependencies with environment markers (platform/python version specific)
 * - Development/test dependencies
 */
export function parseRequiresDist(requiresDist: string[] | null): Record<string, string> {
    const dependencies: Record<string, string> = {};

    if (!requiresDist) {
        return dependencies;
    }

    for (const req of requiresDist) {
        // Skip if it has environment markers (e.g., ; python_version < "3.8")
        // These are conditional deps we can't evaluate
        if (req.includes(';')) {
            const markerPart = req.split(';')[1].trim();
            // Skip if it's an extra (optional feature)
            if (markerPart.includes('extra')) {
                continue;
            }
            // Skip if it's a complex environment marker we can't evaluate
            if (markerPart.includes('python_version') || 
                markerPart.includes('platform_') ||
                markerPart.includes('sys_platform') ||
                markerPart.includes('implementation_')) {
                continue;
            }
        }

        // Parse PEP 508: name[extras] (version) ; markers
        // Extract just the package name and version specifier
        // Skip if it has extras like package[extra1,extra2]
        const match = req.match(/^([a-zA-Z0-9][-a-zA-Z0-9._]*)(?:\[.*?\])?\s*(.*)$/);
        if (match) {
            const name = match[1];
            let versionSpec = match[2] || '';

            // Remove environment markers (after semicolon) - already checked above but strip anyway
            versionSpec = versionSpec.split(';')[0].trim();

            // Clean up version specifier
            if (versionSpec) {
                dependencies[name] = versionSpec;
            } else {
                dependencies[name] = '*';
            }
        }
    }

    return dependencies;
}

/**
 * Parse extras (optional dependencies) from requires_dist array.
 * Returns a map of extra name to its dependencies.
 * Example: { 'security': { 'cryptography': '>=3.0' }, 'socks': { 'PySocks': '>=1.5' } }
 */
export function parseExtras(requiresDist: string[] | null): Record<string, Record<string, string>> {
    const extras: Record<string, Record<string, string>> = {};

    if (!requiresDist) {
        return extras;
    }

    for (const req of requiresDist) {
        // Look for extras: package[extra] (version) ; extra == "extra_name"
        const extraMatch = req.match(/^([a-zA-Z0-9][-a-zA-Z0-9._]*)\[.*?\]?\s*(.*?)(?:\s*;\s*(.*))?$/);
        if (!extraMatch) continue;

        const name = extraMatch[1];
        const versionSpec = extraMatch[2]?.trim() || '';
        const marker = extraMatch[3];

        // Check if this is an extra dependency
        if (marker && marker.includes('extra')) {
            // Extract extra name from marker like: extra == "security"
            const extraNameMatch = marker.match(/extra\s*==\s*["']([^"']+)["']/);
            if (extraNameMatch) {
                const extraName = extraNameMatch[1];
                if (!extras[extraName]) {
                    extras[extraName] = {};
                }
                extras[extraName][name] = versionSpec || '*';
            }
        }
    }

    return extras;
}

/**
 * Resolve a version specifier to a concrete version from available releases.
 * For simplicity, returns the latest version that satisfies the constraint,
 * or the latest available if no constraint or constraint cannot be satisfied.
 */
export function resolvePythonVersion(
    specifier: string | null,
    availableVersions: string[]
): string {
    if (!specifier || specifier === '*') {
        return availableVersions[availableVersions.length - 1];
    }

    // Handle exact version (==version)
    if (specifier.startsWith('==')) {
        const version = specifier.slice(2).trim();
        if (availableVersions.includes(version)) {
            return version;
        }
    }

    // Handle plain version without operator (treat as exact match)
    // This handles "9.0.0" when user types "pillow@9.0.0"
    if (/^\d/.test(specifier) && !specifier.startsWith('>=') && !specifier.startsWith('<=') &&
        !specifier.startsWith('>') && !specifier.startsWith('<') && !specifier.startsWith('~=') &&
        !specifier.startsWith('!=')) {
        if (availableVersions.includes(specifier)) {
            return specifier;
        }
    }

    // Handle >=, <=, >, <, ~= (compatible release), !=
    // For simplicity, we'll try to find a matching version or fall back to latest
    // A proper implementation would use a PEP 440 parser

    // Try to find any version that might satisfy basic constraints
    for (const version of [...availableVersions].reverse()) {
        // Basic constraint checking - not a full PEP 440 implementation
        if (specifier.startsWith('>=')) {
            const minVersion = specifier.slice(2).trim();
            if (comparePythonVersions(version, minVersion) >= 0) {
                return version;
            }
        } else if (specifier.startsWith('<=')) {
            const maxVersion = specifier.slice(2).trim();
            if (comparePythonVersions(version, maxVersion) <= 0) {
                return version;
            }
        } else if (specifier.startsWith('>')) {
            const minVersion = specifier.slice(1).trim();
            if (comparePythonVersions(version, minVersion) > 0) {
                return version;
            }
        } else if (specifier.startsWith('<')) {
            const maxVersion = specifier.slice(1).trim();
            if (comparePythonVersions(version, maxVersion) < 0) {
                return version;
            }
        }
    }

    // Fallback to latest
    return availableVersions[availableVersions.length - 1];
}

/**
 * Simple version comparison for Python versions.
 * Returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
 */
function comparePythonVersions(v1: string, v2: string): number {
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
