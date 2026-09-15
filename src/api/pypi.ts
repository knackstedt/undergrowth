import { PersistentCache } from '../utils/cache';
import { PermanentError, withRetry } from '../utils/retry';

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
    /** Version → release files. Only the fields the graph needs are kept. */
    releases: Record<string, Array<{
        size: number;
        upload_time: string;
    }>>;
}

export async function fetchPackageMeta(name: string, signal?: AbortSignal): Promise<PyPIPackageMeta> {
    const cacheKey = `pypi:${name.toLowerCase()}`;

    // getOrComputeRegistry dedupes concurrent fetches and caches results with TTL
    const fetchAndCache = async (): Promise<PyPIPackageMeta> => {
        return await withRetry(async () => {
            const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal });
            if (res.status >= 400 && res.status < 500) {
                throw new PermanentError(`Package "${name}" not found on PyPI (${res.status})`);
            }
            if (!res.ok) {
                throw new Error(`Failed to fetch package ${name}: ${res.statusText} (${res.status})`);
            }
            const raw = await res.json() as {
                info: PyPIPackageMeta['info'];
                releases?: Record<string, Array<{ size?: number; upload_time?: string }>>;
            };

            // Strip everything we don't use before it hits memory and IndexedDB.
            // The raw response carries per-release file lists with digests/URLs
            // and a top-level `urls` array that duplicate the latest release.
            const releases: PyPIPackageMeta['releases'] = {};
            for (const [version, files] of Object.entries(raw.releases || {})) {
                releases[version] = (files || []).map(f => ({
                    size: f.size || 0,
                    upload_time: f.upload_time || ''
                }));
            }

            return { info: raw.info, releases };
        }, 5, 2500, signal);
    };

    return PersistentCache.getOrComputeRegistry(cacheKey, fetchAndCache);
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
 * Resolve a PEP 440 version specifier to a concrete version from available releases.
 * Supports compound specifiers (">=2.0,<3.0"), ~=, !=, ==, and wildcard equality.
 * Returns the highest version satisfying all clauses, or latest as a fallback.
 */
export function resolvePythonVersion(
    specifier: string | null,
    availableVersions: string[]
): string {
    const sorted = [...availableVersions].sort(comparePythonVersions);
    // "Latest" means the latest stable release, matching PyPI's notion —
    // prereleases only surface via an explicit specifier.
    const latest = sorted.filter(v => !isPythonPrerelease(v)).pop() ?? sorted[sorted.length - 1];

    if (!specifier || specifier === '*' || specifier === 'latest') {
        return latest;
    }

    // Bare version string (e.g., user typed "pillow@9.0.0") — treat as exact
    const trimmed = specifier.trim();
    if (/^v?\d+(\.\d+)*$/.test(trimmed) && !trimmed.includes('*')) {
        if (sorted.includes(trimmed)) return trimmed;
        const stripped = trimmed.replace(/^v/, '');
        if (sorted.includes(stripped)) return stripped;
        // Fall through to clause matching (acts as ==)
    }

    const candidates = sorted.filter(v => satisfiesSpecifier(v, trimmed));
    if (candidates.length === 0) {
        return latest;
    }
    // Prefer stable releases over prereleases when both satisfy
    const stable = candidates.filter(v => !isPythonPrerelease(v));
    const pool = stable.length > 0 ? stable : candidates;
    return pool[pool.length - 1];
}

const PY_PRE_ORDER: Record<string, number> = {
    a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2
};

interface ParsedPyVersion {
    epoch: number;
    release: number[];
    /** -1 = dev-only, 0=a, 1=b, 2=rc, 3 = final (no prerelease) */
    preRank: number;
    preNum: number;
    /** -1 = no post release (sorts before any post) */
    postNum: number;
    /** dev number; versions WITH dev sort before same-stage versions without */
    devNum: number;
    valid: boolean;
}

function parsePyVersion(version: string): ParsedPyVersion {
    const invalid: ParsedPyVersion = { epoch: 0, release: [], preRank: 3, preNum: 0, postNum: -1, devNum: Infinity, valid: false };
    let v = version.trim().toLowerCase().split('+')[0]; // strip local segment
    if (!v) return invalid;

    let epoch = 0;
    const epochMatch = v.match(/^(\d+)!/);
    if (epochMatch) {
        epoch = parseInt(epochMatch[1], 10);
        v = v.slice(epochMatch[0].length);
    }
    if (v.startsWith('v')) v = v.slice(1); // leading 'v' is allowed by PEP 440

    const releaseMatch = v.match(/^\d+(\.\d+)*/);
    if (!releaseMatch) return invalid;
    const release = releaseMatch[0].split('.').map(Number);
    let rest = v.slice(releaseMatch[0].length);

    let preRank = 3;
    let preNum = 0;
    let postNum = -1;
    let devNum = Infinity;

    const preMatch = rest.match(/^[._-]?(a|alpha|b|beta|c|rc|pre|preview)(\d*)/);
    if (preMatch) {
        preRank = PY_PRE_ORDER[preMatch[1]] ?? 2;
        preNum = preMatch[2] ? parseInt(preMatch[2], 10) : 0;
        rest = rest.slice(preMatch[0].length);
    }

    // Post release: .postN, -N (legacy implicit), .revN, .rN
    const postMatch = rest.match(/^(?:\.post|-(?!dev)|\.rev|\.r)(\d+)/);
    if (postMatch) {
        postNum = parseInt(postMatch[1], 10);
        rest = rest.slice(postMatch[0].length);
    }

    const devMatch = rest.match(/^\.?dev(\d*)/);
    if (devMatch) {
        devNum = devMatch[1] ? parseInt(devMatch[1], 10) : 0;
        rest = rest.slice(devMatch[0].length);
    }

    // A bare .devN (no pre/post) sorts before any prerelease
    if (devNum !== Infinity && preRank === 3 && postNum === -1) {
        preRank = -1;
    }

    if (rest.length > 0) return invalid; // trailing garbage
    return { epoch, release, preRank, preNum, postNum, devNum, valid: true };
}

function isPythonPrerelease(version: string): boolean {
    const p = parsePyVersion(version);
    return p.valid && (p.preRank >= -1 && p.preRank < 3 || p.devNum !== Infinity);
}

/**
 * Compare two Python versions per PEP 440 ordering.
 * Returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2.
 */
export function comparePythonVersions(v1: string, v2: string): number {
    const a = parsePyVersion(v1);
    const b = parsePyVersion(v2);
    if (!a.valid && !b.valid) return v1.localeCompare(v2);
    if (!a.valid) return -1;
    if (!b.valid) return 1;

    if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;

    const maxLen = Math.max(a.release.length, b.release.length);
    for (let i = 0; i < maxLen; i++) {
        const x = a.release[i] ?? 0;
        const y = b.release[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }

    if (a.preRank !== b.preRank) return a.preRank < b.preRank ? -1 : 1;
    if (a.preNum !== b.preNum) return a.preNum < b.preNum ? -1 : 1;
    if (a.postNum !== b.postNum) return a.postNum < b.postNum ? -1 : 1;
    if (a.devNum !== b.devNum) return a.devNum < b.devNum ? -1 : 1;
    return 0;
}

/** Check whether a version satisfies a full PEP 440 specifier set (comma-separated clauses) */
function satisfiesSpecifier(version: string, specifier: string): boolean {
    const clauses = specifier.split(',').map(c => c.trim()).filter(Boolean);
    const parsed = parsePyVersion(version);

    for (const clause of clauses) {
        const m = clause.match(/^(===|==|~=|!=|>=|<=|>|<)\s*(.+)$/);
        const op = m ? m[1] : '==';
        const val = (m ? m[2] : clause).trim();

        // Wildcard equality: ==1.2.* / !=1.2.*
        if ((op === '==' || op === '!=') && val.endsWith('.*')) {
            const prefix = val.slice(0, -2);
            const matches = version === prefix || version.startsWith(prefix + '.');
            if (op === '==' ? !matches : matches) return false;
            continue;
        }

        // ~=V — compatible release: >=V, <V with last release segment bumped
        if (op === '~=') {
            const parts = val.split('.').map(Number);
            if (parts.length < 2) return false; // invalid ~= spec
            const upper = parts.slice(0, -1);
            upper[upper.length - 1] += 1;
            if (comparePythonVersions(version, val) < 0 ||
                comparePythonVersions(version, upper.join('.')) >= 0) return false;
            continue;
        }

        if (op === '===' || op === '==' || op === '!=') {
            // Exact match; tolerate a leading 'v' or missing trailing segments
            const eq = version === val || version === 'v' + val ||
                (parsed.valid && comparePythonVersions(version, val) === 0);
            if (op === '!=' ? eq : !eq) return false;
            continue;
        }

        const cmp = comparePythonVersions(version, val);
        if (op === '>=' && cmp < 0) return false;
        if (op === '<=' && cmp > 0) return false;
        if (op === '>' && cmp <= 0) return false;
        if (op === '<' && cmp >= 0) return false;
    }
    return true;
}
