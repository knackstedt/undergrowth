import { comparePythonVersions, fetchPackageMeta, parseExtras, parseRequiresDist, resolvePythonVersion } from '../api/pypi';
import type { BfsQueueItem, DependencySource, ProgressCallback, ResolvedGraph, ResolverOptions } from './resolver';
import { MICROPACKAGE_SIZE_THRESHOLD, runBfs } from './resolver';
import { enrichBulkWithDepsDevData } from '../utils/depsdev-enrichment';

export interface PythonRequirementsManifest {
    name: string;
    version?: string;
    description?: string;
    dependencies: Record<string, string>;
}

interface PyQueueItem extends BfsQueueItem {
    isExtra?: boolean;
}

const MAX_DEPTH = 100; // Limit dependency depth to prevent explosion

const detectPythonSource = (_name: string, version: string): DependencySource => {
    if (version.startsWith('git+') || version.startsWith('git://')) return 'github';
    if (version.startsWith('hg+') || version.startsWith('svn+') || version.startsWith('bzr+')) return 'other';
    if (version.startsWith('http://') || version.startsWith('https://')) return 'external';
    return 'pypi';
};

async function runBfsPythonResolution(
    graph: ResolvedGraph,
    queue: PyQueueItem[],
    options: ResolverOptions = {},
    onProgress?: ProgressCallback
): Promise<void> {
    const inProgress = new Set<string>();
    const resolvedPackages = new Set<string>(); // Track by name to avoid re-resolving same package

    await runBfs(graph, queue, options, onProgress, {
        ghostSource: (item) => detectPythonSource(item.name, item.versionDef),
        ghostEdgeType: (item) => item.isExtra ? 'extra' : 'dependency',
        process: async ({ name, versionDef, parentId, isPeer, isExtra, depth = 0 }, ctx) => {
            // Skip if we've reached max depth
            if (depth >= MAX_DEPTH) {
                return;
            }

            // Skip if we've already resolved this package (by name) to avoid cycles
            if (resolvedPackages.has(name.toLowerCase())) {
                return;
            }

            const meta = await fetchPackageMeta(name, options.signal);
            resolvedPackages.add(name.toLowerCase());

            const versions = Object.keys(meta.releases || {}).sort(comparePythonVersions);
            if (versions.length === 0) {
                throw new Error(`No releases found for package ${name}`);
            }

            const resolvedVersion = resolvePythonVersion(versionDef, versions);

            const nodeId = `${name}@${resolvedVersion}`;

            if (parentId) {
                ctx.addEdge(parentId, nodeId, isExtra ? 'extra' : 'dependency');
            }

            if (graph.nodes.has(nodeId) || inProgress.has(nodeId)) {
                return;
            }

            inProgress.add(nodeId);

            const releaseFiles = meta.releases[resolvedVersion];
            const uploadTime = releaseFiles?.[0]?.upload_time || '';

            // Parse dependencies from requires_dist
            const dependencies = parseRequiresDist(meta.info.requires_dist);

            // Parse extras (optional dependencies)
            const extras = parseExtras(meta.info.requires_dist);

            // Compute size from release files (sum of all distribution file sizes)
            const size = releaseFiles && releaseFiles.length > 0
                ? releaseFiles.reduce((sum, f) => sum + (f.size || 0), 0)
                : undefined;

            // Compute update information from all versions in PEP 440 order
            const allVersions = Object.keys(meta.releases || {}).sort(comparePythonVersions);

            const resolvedIdx = allVersions.indexOf(resolvedVersion);
            const newerVersions = resolvedIdx >= 0 && resolvedIdx < allVersions.length - 1
                ? allVersions.slice(resolvedIdx + 1)
                : [];

            const latestVersion = allVersions.length > 0 ? allVersions[allVersions.length - 1] : resolvedVersion;
            const isOutdated = resolvedVersion !== latestVersion && newerVersions.length > 0;

            // PEP 440 prerelease detection
            const isPythonPrerelease = (v: string): boolean => {
                return /(?:a|b|rc|alpha|beta|pre)\d*$/i.test(v) || /\.dev\d+$/i.test(v);
            };

            const prereleaseVersions = newerVersions.filter(isPythonPrerelease);
            const isPrereleaseAvailable = prereleaseVersions.length > 0;

            const hasSizeData = size !== undefined && size > 0;
            const isMicropackage = hasSizeData && size < MICROPACKAGE_SIZE_THRESHOLD;

            graph.nodes.set(nodeId, {
                id: nodeId,
                pkgName: name,
                version: resolvedVersion,
                description: meta.info.summary || meta.info.description || '',
                maintainers: meta.info.maintainer ? 1 : meta.info.author ? 1 : 0,
                lastPublish: uploadTime || new Date().toISOString(),
                dependencies: dependencies,
                isRoot: parentId === null,
                isPeer: isPeer || false,
                readme: meta.info.description,
                source: detectPythonSource(name, versionDef),
                repoUrl: meta.info.project_urls?.['Source']
                    || meta.info.project_urls?.['Source Code']
                    || meta.info.project_urls?.['Repository']
                    || meta.info.home_page
                    || undefined,
                size,
                license: meta.info.license || undefined,
                isOutdated,
                latestVersion: isOutdated ? latestVersion : undefined,
                newerVersions: newerVersions.length > 0 ? newerVersions : undefined,
                prereleaseVersions: prereleaseVersions.length > 0 ? prereleaseVersions : undefined,
                isPrereleaseAvailable,
                isMicropackage
            });

            // Add regular dependencies
            const newDeps = Object.entries(dependencies);
            for (const [depName, depVersion] of newDeps) {
                ctx.enqueue({ name: depName, versionDef: depVersion, parentId: nodeId, depth: depth + 1 });
            }

            // Add extras as optional dependencies (similar to peer deps),
            // only when the optional-deps toggle is on — otherwise they
            // balloon the graph with every declared extra's subtree
            for (const extraDeps of options.showPeerDeps ? Object.values(extras) : []) {
                for (const [depName, depVersion] of Object.entries(extraDeps)) {
                    ctx.enqueue({ name: depName, versionDef: depVersion, parentId: nodeId, isExtra: true, depth: depth + 1 });
                }
            }
        }
    });
}

export async function resolvePythonDependencyTree(
    rootPkg: string,
    rootVersion?: string,
    options?: ResolverOptions,
    onProgress?: ProgressCallback
): Promise<ResolvedGraph> {
    const graph: ResolvedGraph = {
        nodes: new Map(),
        edges: [],
        errors: [],
        cycles: []
    };

    const queue = [{ name: rootPkg, versionDef: rootVersion || '*', parentId: null as string | null }];
    await runBfsPythonResolution(graph, queue, options, onProgress);

    // Note: Cycle detection is done via the resolver's detectDependencyCycles
    // But since Python dependencies don't have as strong cycle guarantees,
    // we'll skip cycle detection for Python for now or use the same logic
    return graph;
}

export async function resolvePythonDependencyTreeFromManifest(
    manifest: PythonRequirementsManifest,
    options?: ResolverOptions,
    onProgress?: ProgressCallback
): Promise<ResolvedGraph> {
    const graph: ResolvedGraph = {
        nodes: new Map(),
        edges: [],
        errors: [],
        cycles: []
    };

    const rootId = `${manifest.name}@${manifest.version || 'local'}`;

    graph.nodes.set(rootId, {
        id: rootId,
        pkgName: manifest.name,
        version: manifest.version || 'local',
        description: manifest.description || '',
        maintainers: 0,
        lastPublish: new Date().toISOString(),
        dependencies: manifest.dependencies,
        isRoot: true,
        isPythonRoot: true, // Mark as Python requirements.txt entrypoint
        source: 'pypi'
    });

    const queue = Object.entries(manifest.dependencies).map(([name, versionDef]) => ({
        name,
        versionDef,
        parentId: rootId }));

    await runBfsPythonResolution(graph, queue, options, onProgress);

    return graph;
}


/**
 * Enrich a resolved Python graph with metadata from deps.dev.
 */
export async function enrichPythonGraphWithDepsDevData(graph: ResolvedGraph, signal?: AbortSignal): Promise<void> {
    const pypiNodes = new Map();
    
    for (const [nodeId, node] of graph.nodes.entries()) {
        if (node.source === 'pypi' && !node.isNotFound) {
            pypiNodes.set(nodeId, node);
        }
    }
    
    if (pypiNodes.size > 0) {
        await enrichBulkWithDepsDevData(pypiNodes, 'pypi', signal);
    }
}
