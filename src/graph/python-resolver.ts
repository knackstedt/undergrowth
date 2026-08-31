import { fetchPackageMeta, parseExtras, parseRequiresDist, resolvePythonVersion } from '../api/pypi';
import type { DependencySource, ProgressCallback, ResolvedGraph } from './resolver';
import { MICROPACKAGE_SIZE_THRESHOLD } from './resolver';
import { enrichBulkWithDepsDevData } from '../utils/depsdev-enrichment';

export interface PythonRequirementsManifest {
    name: string;
    version?: string;
    description?: string;
    dependencies: Record<string, string>;
}

async function runBfsPythonResolution(
    graph: ResolvedGraph,
    queue: Array<{ name: string; versionDef: string; parentId: string | null; isPeer?: boolean; isExtra?: boolean; depth?: number }>,
    onProgress?: ProgressCallback
): Promise<void> {
    const inProgress = new Set<string>();
    const resolvedPackages = new Set<string>(); // Track by name to avoid re-resolving same package
    let resolved = 0;
    let total = queue.length;
    const MAX_DEPTH = 100; // Limit dependency depth to prevent explosion

    const detectPythonSource = (_name: string, version: string): DependencySource => {
        if (version.startsWith('git+') || version.startsWith('git://')) return 'github';
        if (version.startsWith('hg+') || version.startsWith('svn+') || version.startsWith('bzr+')) return 'other';
        if (version.startsWith('http://') || version.startsWith('https://')) return 'external';
        return 'pypi';
    };

    const processQueue = async () => {
        const CONCURRENCY = 10;
        const batch = queue.splice(0, CONCURRENCY);

        await Promise.all(batch.map(async ({ name, versionDef, parentId, isPeer, isExtra, depth = 0 }) => {
            // Skip if we've reached max depth
            if (depth >= MAX_DEPTH) {
                resolved++;
                onProgress?.(resolved, total);
                return;
            }

            let resolvedVersion = versionDef;

            try {
                // Skip if we've already resolved this package (by name) to avoid cycles
                if (resolvedPackages.has(name.toLowerCase())) {
                    resolved++;
                    onProgress?.(resolved, total);
                    return;
                }

                const meta = await fetchPackageMeta(name);
                resolvedPackages.add(name.toLowerCase());

                const versions = Object.keys(meta.releases || {});
                if (versions.length === 0) {
                    throw new Error(`No releases found for package ${name}`);
                }

                // Sort versions roughly chronologically by upload time of first file
                versions.sort((a, b) => {
                    const filesA = meta.releases[a];
                    const filesB = meta.releases[b];
                    const timeA = filesA?.[0]?.upload_time || '';
                    const timeB = filesB?.[0]?.upload_time || '';
                    return timeA.localeCompare(timeB);
                });

                resolvedVersion = resolvePythonVersion(versionDef, versions);

                const nodeId = `${name}@${resolvedVersion}`;

                if (parentId) {
                    const edgeType: 'dependency' | 'peer' | 'extra' = isExtra ? 'extra' : 'dependency';
                    if (!graph.edges.find(e => e.source === parentId && e.target === nodeId)) {
                        graph.edges.push({ source: parentId, target: nodeId, type: edgeType });
                    }
                }

                if (graph.nodes.has(nodeId) || inProgress.has(nodeId)) {
                    resolved++;
                    onProgress?.(resolved, total);
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

                // Compute update information from all versions sorted chronologically
                const allVersions = Object.keys(meta.releases || {});
                allVersions.sort((a, b) => {
                    const filesA = meta.releases[a];
                    const filesB = meta.releases[b];
                    const timeA = filesA?.[0]?.upload_time || '';
                    const timeB = filesB?.[0]?.upload_time || '';
                    return timeA.localeCompare(timeB);
                });

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
                total += newDeps.length;
                for (const [depName, depVersion] of newDeps) {
                    queue.push({ name: depName, versionDef: depVersion, parentId: nodeId, depth: depth + 1 });
                }

                // Add extras as optional dependencies (similar to peer deps)
                for (const extraDeps of Object.values(extras)) {
                    const extraDepEntries = Object.entries(extraDeps);
                    total += extraDepEntries.length;
                    for (const [depName, depVersion] of extraDepEntries) {
                        queue.push({ name: depName, versionDef: depVersion, parentId: nodeId, isExtra: true, depth: depth + 1 });
                    }
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Unknown dependency resolution error';
                graph.errors.push({ pkg: name, error: message });

                // Root package failure — re-throw so the caller can show a dialog
                if (parentId === null) {
                    throw err;
                }

                // If this is a dependency (not the root), add a ghost "not found" node
                const ghostId = `${name}@${versionDef}`;
                if (!graph.nodes.has(ghostId)) {
                    graph.nodes.set(ghostId, {
                        id: ghostId,
                        pkgName: name,
                        version: versionDef,
                        description: 'Package could not be resolved',
                        maintainers: 0,
                        lastPublish: new Date().toISOString(),
                        dependencies: {},
                        isNotFound: true,
                        source: detectPythonSource(name, versionDef)
                    });
                    graph.edges.push({ source: parentId, target: ghostId, type: 'dependency' });
                } else if (!graph.edges.find(e => e.source === parentId && e.target === ghostId)) {
                    graph.edges.push({ source: parentId, target: ghostId, type: 'dependency' });
                }
            }

            resolved++;
            onProgress?.(resolved, total);
        }));
    };

    while (queue.length > 0) {
        await processQueue();
    }
}

export async function resolvePythonDependencyTree(
    rootPkg: string,
    rootVersion?: string,
    onProgress?: ProgressCallback
): Promise<ResolvedGraph> {
    const graph: ResolvedGraph = {
        nodes: new Map(),
        edges: [],
        errors: [],
        cycles: []
    };

    const queue = [{ name: rootPkg, versionDef: rootVersion || '*', parentId: null as string | null }];
    await runBfsPythonResolution(graph, queue, onProgress);

    // Note: Cycle detection is done via the resolver's detectDependencyCycles
    // But since Python dependencies don't have as strong cycle guarantees,
    // we'll skip cycle detection for Python for now or use the same logic
    return graph;
}

export async function resolvePythonDependencyTreeFromManifest(
    manifest: PythonRequirementsManifest,
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

    await runBfsPythonResolution(graph, queue, onProgress);

    return graph;
}


/**
 * Enrich a resolved Python graph with metadata from deps.dev.
 */
export async function enrichPythonGraphWithDepsDevData(graph: ResolvedGraph): Promise<void> {
    const pypiNodes = new Map();
    
    for (const [nodeId, node] of graph.nodes.entries()) {
        if (node.source === 'pypi' && !node.isNotFound) {
            pypiNodes.set(nodeId, node);
        }
    }
    
    if (pypiNodes.size > 0) {
        await enrichBulkWithDepsDevData(pypiNodes, 'pypi');
    }
}
