import { fetchPackageMeta, fetchVersionDependencies, resolveCargoVersion } from '../api/crates';
import type { DependencySource, ProgressCallback, ResolvedGraph, ResolverOptions } from './resolver';
import { MICROPACKAGE_SIZE_THRESHOLD } from './resolver';
import { enrichBulkWithDepsDevData } from '../utils/depsdev-enrichment';

export interface CargoManifest {
    name: string;
    version?: string;
    description?: string;
    dependencies: Record<string, string>;
}

interface QueueItem {
    name: string;
    versionDef: string;
    parentId: string | null;
    depth: number;
    isOptional?: boolean;
}

async function runBfsRustResolution(
    graph: ResolvedGraph,
    queue: QueueItem[],
    options: ResolverOptions = {},
    onProgress?: ProgressCallback
): Promise<void> {
    // Track resolved packages: name -> Set of resolved versions (to avoid duplicate nodes for same version)
    const resolvedPackages = new Map<string, Set<string>>();
    // Track which optional dependency edges have already been created to prevent cycles
    const resolvedOptionalEdges = new Set<string>();
    let resolved = 0;
    let total = queue.length;
    const MAX_DEPTH = 30; // Lower depth limit for peer deps
    const MAX_OPTIONAL_DEPTH = 3; // Strict limit for optional dependency expansion

    const detectRustSource = (_name: string, version: string): DependencySource => {
        if (version.startsWith('git+') || version.startsWith('git://')) return 'github';
        if (version.startsWith('path://')) return 'other';
        if (version.startsWith('http://') || version.startsWith('https://')) return 'external';
        return 'crates';
    };

    const processQueue = async () => {
        const CONCURRENCY = 10;
        const batch = queue.splice(0, CONCURRENCY);

        await Promise.all(batch.map(async ({ name, versionDef, parentId, depth, isOptional }) => {
            // Skip if we've reached max depth
            if (depth >= MAX_DEPTH) {
                resolved++;
                onProgress?.(resolved, total);
                return;
            }

            // For optional deps, use a much stricter depth limit
            if (isOptional && depth >= MAX_OPTIONAL_DEPTH) {
                resolved++;
                onProgress?.(resolved, total);
                return;
            }

            try {
                const meta = await fetchPackageMeta(name);

                // Get available versions from the versions array (sorted ascending)
                const versions = meta.versions.map(v => v.num).sort((a, b) => {
                    const partsA = a.split('.').map(Number);
                    const partsB = b.split('.').map(Number);
                    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
                        const diff = (partsA[i] || 0) - (partsB[i] || 0);
                        if (diff !== 0) return diff;
                    }
                    return 0;
                });

                if (versions.length === 0) {
                    throw new Error(`No versions found for crate ${name}`);
                }

                // Resolve the version based on the version requirement
                const resolvedVersion = resolveCargoVersion(versionDef, versions);
                const nodeId = `${name}@${resolvedVersion}`;

                // Check if we've already created this exact version node
                const resolvedVersions = resolvedPackages.get(name.toLowerCase());
                if (resolvedVersions?.has(resolvedVersion)) {
                    // Exact version already resolved - just create edge from parent if needed
                    if (parentId) {
                        const edgeKey = `${parentId}->${nodeId}`;
                        if (!resolvedOptionalEdges.has(edgeKey)) {
                            resolvedOptionalEdges.add(edgeKey);
                            const edgeExists = graph.edges.find(e => e.source === parentId && e.target === nodeId);
                            if (!edgeExists) {
                                graph.edges.push({
                                    source: parentId,
                                    target: nodeId,
                                    type: isOptional ? 'peer' : 'dependency'
                                });
                            }
                        }
                    }
                    resolved++;
                    onProgress?.(resolved, total);
                    return;
                }

                // Record this version as resolved
                if (!resolvedPackages.has(name.toLowerCase())) {
                    resolvedPackages.set(name.toLowerCase(), new Set());
                }
                resolvedPackages.get(name.toLowerCase())!.add(resolvedVersion);

                // Create edge from parent
                if (parentId) {
                    const edgeKey = `${parentId}->${nodeId}`;
                    resolvedOptionalEdges.add(edgeKey);
                    const edgeExists = graph.edges.find(e => e.source === parentId && e.target === nodeId);
                    if (!edgeExists) {
                        graph.edges.push({ 
                            source: parentId, 
                            target: nodeId, 
                            type: isOptional ? 'peer' : 'dependency' 
                        });
                    }
                }

                // Check if node already exists (same package+version already processed)
                if (graph.nodes.has(nodeId)) {
                    resolved++;
                    onProgress?.(resolved, total);
                    return;
                }

                const versionData = meta.versions.find(v => v.num === resolvedVersion);
                const uploadTime = versionData?.created_at || '';

                // Fetch dependencies for this specific version
                const rawDependencies = versionData?.dependencies || await fetchVersionDependencies(name, resolvedVersion);

                // Parse dependencies - only normal (non-dev, non-build, non-optional) dependencies
                const dependencies: Record<string, string> = {};
                // Parse optional dependencies (only when showPeerDeps is enabled)
                const optionalDeps: Record<string, string> = {};
                
                for (const dep of rawDependencies) {
                    if (dep.kind === 'normal' && !dep.optional) {
                        dependencies[dep.crate_id] = dep.req;
                    }
                    // Include optional dependencies when showPeerDeps is enabled
                    if (options.showPeerDeps && dep.optional) {
                        optionalDeps[dep.crate_id] = dep.req;
                    }
                }

                const size = versionData?.crate_size ?? undefined;

                graph.nodes.set(nodeId, {
                    id: nodeId,
                    pkgName: name,
                    version: resolvedVersion,
                    description: meta.crate.description || '',
                    maintainers: versionData?.published_by ? 1 : 0,
                    lastPublish: uploadTime || new Date().toISOString(),
                    downloads: versionData?.downloads || meta.crate.downloads,
                    dependencies: dependencies,
                    isRoot: parentId === null,
                    readme: meta.crate.readme,
                    source: detectRustSource(name, versionDef),
                    size,
                    isMicropackage: size !== undefined && size > 0 && size < MICROPACKAGE_SIZE_THRESHOLD
                });

                // Add regular dependencies to queue
                const newDeps = Object.entries(dependencies);
                total += newDeps.length;
                for (const [depName, depVersion] of newDeps) {
                    queue.push({ name: depName, versionDef: depVersion, parentId: nodeId, depth: depth + 1 });
                }

                // Add optional dependencies to queue as peers when showPeerDeps is enabled
                // But only for the first level (direct optional deps of the root package)
                // to prevent exponential explosion
                if (options.showPeerDeps && depth < 1) {
                    const optDepEntries = Object.entries(optionalDeps);
                    total += optDepEntries.length;
                    for (const [depName, depVersion] of optDepEntries) {
                        // Don't expand optional deps recursively - just add them as nodes
                        queue.push({ 
                            name: depName, 
                            versionDef: depVersion, 
                            parentId: nodeId, 
                            depth: depth + 1,
                            isOptional: true 
                        });
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
                        source: detectRustSource(name, versionDef)
                    });
                    graph.edges.push({ source: parentId, target: ghostId, type: isOptional ? 'peer' : 'dependency' });
                } else {
                    const edgeExists = graph.edges.find(e => e.source === parentId && e.target === ghostId);
                    if (!edgeExists) {
                        graph.edges.push({ source: parentId, target: ghostId, type: isOptional ? 'peer' : 'dependency' });
                    }
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

export async function resolveRustDependencyTree(
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

    const queue: QueueItem[] = [{ name: rootPkg, versionDef: rootVersion || '*', parentId: null, depth: 0 }];
    await runBfsRustResolution(graph, queue, options, onProgress);

    return graph;
}

export async function resolveRustDependencyTreeFromManifest(
    manifest: CargoManifest,
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
        source: 'crates'
    });

    const queue: QueueItem[] = Object.entries(manifest.dependencies).map(([name, versionDef]) => ({
        name,
        versionDef,
        parentId: rootId,
        depth: 0
    }));

    await runBfsRustResolution(graph, queue, options, onProgress);

    return graph;
}


/**
 * Enrich a resolved Rust graph with metadata from deps.dev.
 */
export async function enrichRustGraphWithDepsDevData(graph: ResolvedGraph): Promise<void> {
    const cratesNodes = new Map();
    
    for (const [nodeId, node] of graph.nodes.entries()) {
        if (node.source === 'crates' && !node.isNotFound) {
            cratesNodes.set(nodeId, node);
        }
    }
    
    if (cratesNodes.size > 0) {
        await enrichBulkWithDepsDevData(cratesNodes, 'crates');
    }
}
