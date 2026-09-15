import { parseGoMod } from '../api/go';
import { parseRequirementsTxt } from '../api/pypi';
import type { CsprojManifest } from '../graph/csharp-resolver';
import type { CargoManifest } from '../graph/rust-resolver';
import type { GoModManifest } from '../graph/go-resolver';
import type { PythonRequirementsManifest } from '../graph/python-resolver';
import type { LocalManifest } from '../graph/resolver';

export type { CargoManifest, GoModManifest };

export type FetchedManifest =
    | { type: 'npm'; data: LocalManifest }
    | { type: 'pypi'; data: PythonRequirementsManifest }
    | { type: 'crates'; data: CargoManifest }
    | { type: 'go'; data: GoModManifest }
    | { type: 'nuget'; data: CsprojManifest }
    | null;

/**
 * Detect if input is a URL to a manifest file.
 * Returns the file type or null if not a manifest URL.
 */
export function detectManifestUrl(input: string): { type: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget'; url: string } | null {
    const trimmed = input.trim();

    // Must be a URL
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return null;
    }

    try {
        const url = new URL(trimmed);
        const pathname = url.pathname.toLowerCase();

        // Check for package.json (npm)
        if (pathname.endsWith('package.json')) {
            return { type: 'npm', url: trimmed };
        }

        // Check for requirements.txt (pypi)
        if (pathname.endsWith('requirements.txt') || pathname.endsWith('.txt')) {
            return { type: 'pypi', url: trimmed };
        }

        // Check for Cargo.toml (crates/rust)
        if (pathname.endsWith('cargo.toml')) {
            return { type: 'crates', url: trimmed };
        }

        // Check for go.mod (Go)
        if (pathname.endsWith('go.mod')) {
            return { type: 'go', url: trimmed };
        }

        // Check for .csproj (C# / NuGet)
        if (pathname.endsWith('.csproj')) {
            return { type: 'nuget', url: trimmed };
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Detect the ecosystem a dropped/local manifest file belongs to from its
 * filename. Returns null for unrecognized files.
 */
export function detectManifestFileName(name: string): 'npm' | 'pypi' | 'crates' | 'go' | 'nuget' | null {
    if (name === 'package.json') return 'npm';
    if (name === 'requirements.txt' || name.endsWith('.txt')) return 'pypi';
    if (name === 'Cargo.toml') return 'crates';
    if (name === 'go.mod') return 'go';
    if (name.endsWith('.csproj')) return 'nuget';
    return null;
}

/**
 * Fetch and parse a manifest file from a URL.
 */
export async function fetchManifestFromUrl(url: string, type: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget', signal?: AbortSignal): Promise<FetchedManifest> {
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new Error(`Failed to fetch manifest: ${response.statusText} (${response.status})`);
    }

    const text = await response.text();
    return parseManifestContent(text, type, url);
}

/**
 * Parse manifest file contents. `sourceLabel` is only used to derive a display
 * name for the synthetic root node — it can be a URL or a plain filename.
 */
export function parseManifestContent(content: string, type: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget', sourceLabel: string): FetchedManifest {
    switch (type) {
        case 'npm':
            return parsePackageJson(content);
        case 'pypi':
            return parseRequirementsTxtManifest(content, sourceLabel);
        case 'crates':
            return parseCargoToml(content);
        case 'go':
            return parseGoModManifest(content, sourceLabel);
        case 'nuget':
            return parseCsprojManifest(content, sourceLabel);
        default:
            return null;
    }
}

function parsePackageJson(content: string): FetchedManifest {
    try {
        const pkg = JSON.parse(content);

        if (!pkg.name) {
            throw new Error('package.json missing name field');
        }

        const dependencies: Record<string, string> = {};

        // Merge all dependency types
        if (pkg.dependencies) {
            Object.assign(dependencies, pkg.dependencies);
        }
        if (pkg.devDependencies) {
            Object.assign(dependencies, pkg.devDependencies);
        }
        if (pkg.peerDependencies) {
            Object.assign(dependencies, pkg.peerDependencies);
        }

        if (Object.keys(dependencies).length === 0) {
            throw new Error('package.json has no dependencies to graph');
        }

        return {
            type: 'npm',
            data: {
                name: pkg.name,
                version: pkg.version,
                description: pkg.description,
                dependencies,
                devDependencies: pkg.devDependencies,
                peerDependencies: pkg.peerDependencies
            }
        };
    } catch (err) {
        if (err instanceof Error) {
            throw err;
        }
        throw new Error('Failed to parse package.json');
    }
}

function parseRequirementsTxtManifest(content: string, sourceLabel: string): FetchedManifest {
    const deps = parseRequirementsTxt(content);

    const pypiDeps = deps.filter(d => d.source === 'pypi');

    if (pypiDeps.length === 0) {
        throw new Error('requirements.txt has no dependencies to graph');
    }

    // Extract a name from the source label (URL path or filename)
    const filename = sourceLabel.split('/').pop() || 'requirements';

    return {
        type: 'pypi',
        data: {
            name: filename.replace('.txt', ''),
            version: 'remote',
            description: `Python requirements from ${sourceLabel}`,
            dependencies: Object.fromEntries(pypiDeps.map(d => [d.name, d.specifier || '*']))
        }
    };
}

function parseCargoToml(content: string): FetchedManifest {
    // Simple TOML parser for Cargo.toml - only extracts what we need
    const lines = content.split('\n');
    let inDependencies = false;
    let inPackage = false;

    const manifest: CargoManifest = {
        name: '',
        version: '0.1.0',
        description: '',
        dependencies: {}
    };

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Track sections
        if (trimmed === '[package]') {
            inPackage = true;
            inDependencies = false;
            continue;
        }
        if (trimmed === '[dependencies]') {
            inDependencies = true;
            inPackage = false;
            continue;
        }
        if (trimmed.startsWith('[')) {
            inDependencies = false;
            inPackage = false;
            continue;
        }

        // Parse key-value pairs
        const match = trimmed.match(/^([^=]+)=\s*(.+)$/);
        if (!match) continue;

        const key = match[1].trim();
        let value = match[2].trim();

        // Remove quotes from string values
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }

        if (inPackage) {
            if (key === 'name') manifest.name = value;
            if (key === 'version') manifest.version = value;
            if (key === 'description') manifest.description = value;
        } else if (inDependencies) {
            // Parse dependency - value could be a version string or a table
            if (value.startsWith('{')) {
                // Complex dependency table - try to extract version
                const versionMatch = value.match(/version\s*=\s*"([^"]+)"/);
                manifest.dependencies[key] = versionMatch ? versionMatch[1] : '*';
            } else {
                // Simple version string
                manifest.dependencies[key] = value;
            }
        }
    }

    if (!manifest.name) {
        // Try to extract name from the file or use a default
        manifest.name = 'unknown-crate';
    }

    if (Object.keys(manifest.dependencies).length === 0) {
        throw new Error('Cargo.toml has no dependencies to graph');
    }

    return {
        type: 'crates',
        data: manifest
    };
}

function parseGoModManifest(content: string, sourceLabel: string): FetchedManifest {
    const deps = parseGoMod(content);

    // Filter out stdlib packages and indirect deps (those will be resolved if showPeerDeps is on)
    const directDeps = deps.filter(d => !d.indirect);

    if (directDeps.length === 0) {
        throw new Error('go.mod has no direct dependencies to graph');
    }

    // Extract a name from the source label (URL path or filename)
    const filename = sourceLabel.split('/').pop() || 'go.mod';
    const folderName = sourceLabel.split('/').slice(-2, -1)[0] || 'module';

    // Try to get module name from the go.mod content
    const moduleMatch = content.match(/^module\s+(\S+)/m);
    const moduleName = moduleMatch ? moduleMatch[1] : folderName;

    return {
        type: 'go',
        data: {
            name: moduleName,
            version: 'local',
            description: `Go module from ${filename}`,
            dependencies: Object.fromEntries(directDeps.map(d => [d.path, d.version]))
        }
    };
}

function parseCsprojManifest(content: string, sourceLabel: string): FetchedManifest {
    const dependencies: Record<string, string> = {};

    // Parse PackageReference elements from XML
    // Format: <PackageReference Include="PackageName" Version="1.0.0" />
    // Or: <PackageReference Include="PackageName"><Version>1.0.0</Version></PackageReference>
    const packageRefRegex = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)"|\s*>\s*<Version>([^<]+)<\/Version>\s*<\/PackageReference>)/gi;

    let match;
    while ((match = packageRefRegex.exec(content)) !== null) {
        const name = match[1];
        const version = match[2] || match[3] || '*';
        dependencies[name] = version;
    }

    // Also try to parse Version element inside PackageReference
    const versionElementRegex = /<PackageReference\s+Include="([^"]+)"[^>]*>[\s\S]*?<Version>([^<]+)<\/Version>[\s\S]*?<\/PackageReference>/gi;
    while ((match = versionElementRegex.exec(content)) !== null) {
        const name = match[1];
        const version = match[2];
        dependencies[name] = version;
    }

    if (Object.keys(dependencies).length === 0) {
        throw new Error('.csproj has no PackageReference dependencies to graph');
    }

    // Extract name from the source label (URL path or filename)
    const filename = sourceLabel.split('/').pop() || 'project.csproj';
    const projectName = filename.replace('.csproj', '');

    // Try to get target framework
    const tfmMatch = content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i);
    const targetFramework = tfmMatch ? tfmMatch[1] : undefined;

    return {
        type: 'nuget',
        data: {
            name: projectName,
            version: 'local',
            description: `C# project from ${filename}`,
            targetFramework,
            dependencies
        }
    };
}
