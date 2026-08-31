import type { GoModDependency } from '../api/go';
import { fetchPackageMeta, fetchVersionDependencies, fetchModuleSize, resolveGoVersion } from '../api/go';
import type { DependencySource, ProgressCallback, ResolvedGraph } from './resolver';
import { MICROPACKAGE_SIZE_THRESHOLD } from './resolver';
import { enrichBulkWithDepsDevData } from '../utils/depsdev-enrichment';

export interface GoModManifest {
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

async function runBfsGoResolution(
    graph: ResolvedGraph,
    queue: QueueItem[],
    options: { showPeerDeps?: boolean } = {},
    onProgress?: ProgressCallback
): Promise<void> {
    // Track resolved packages: name -> Set of resolved versions (to avoid duplicate nodes for same version)
    const resolvedPackages = new Map<string, Set<string>>();
    // Track which optional dependency edges have already been created to prevent cycles
    const resolvedOptionalEdges = new Set<string>();
    let resolved = 0;
    let total = queue.length;
    const MAX_DEPTH = 30; // Lower depth limit for Go modules
    const MAX_OPTIONAL_DEPTH = 2; // Strict limit for optional (indirect) dependency expansion

    const detectGoSource = (name: string, version: string): DependencySource => {
        // Go modules can reference:
        // - Standard library (stdlib) - these are built-in, skip
        // - External modules via proxy
        // - Local replacements with file paths
        if (version.startsWith('file://') || version.startsWith('./') || version.startsWith('../')) {
            return 'other';
        }
        // Standard library packages don't have a version in go.mod
        if (!version || version === 'builtin' || name.startsWith('internal/')) {
            return 'other';
        }
        return 'go';
    };

    const isStdlibPackage = (name: string): boolean => {
        // Common stdlib packages - these shouldn't be resolved through the proxy
        const stdlibPrefixes = [
            'archive/', 'bufio', 'bytes', 'compress/', 'container/', 'context', 'crypto/',
            'database/', 'debug/', 'embed', 'encoding/', 'errors', 'expvar', 'flag',
            'fmt', 'go/', 'hash/', 'html/', 'image/', 'index/', 'io/', 'log/',
            'math/', 'mime', 'net/', 'os/', 'path/', 'plugin', 'reflect', 'regexp/',
            'runtime/', 'sort', 'strconv', 'strings', 'sync/', 'syscall', 'testing/',
            'text/', 'time', 'unicode/', 'unsafe'
        ];
        // Direct stdlib packages
        const stdlibDirect = [
            'bufio', 'bytes', 'context', 'crypto', 'encoding', 'errors', 'fmt', 'hash',
            'image', 'io', 'log', 'math', 'mime', 'net', 'os', 'path', 'reflect',
            'regexp', 'runtime', 'sort', 'strconv', 'strings', 'sync', 'testing',
            'text', 'time', 'unicode', 'unsafe'
        ];
        // Internal/golang packages that don't resolve via proxy
        const internalPrefixes = [
            'golang.org/x/',
            'internal/',
            'google.golang.org/',
            'cloud.google.com/',
            'k8s.io/kubernetes',
            'sigs.k8s.io/'
        ];
        
        if (stdlibDirect.includes(name)) return true;
        if (stdlibPrefixes.some(prefix => name.startsWith(prefix))) return true;
        return internalPrefixes.some(prefix => name.startsWith(prefix));
    };

    const processQueue = async () => {
        const CONCURRENCY = 10;
        const batch = queue.splice(0, CONCURRENCY);

        await Promise.all(batch.map(async ({ name, versionDef, parentId, depth, isOptional }) => {
            // Skip stdlib packages - they don't need resolution
            if (isStdlibPackage(name)) {
                resolved++;
                onProgress?.(resolved, total);
                return;
            }

            // Skip if we've reached max depth
            if (depth >= MAX_DEPTH) {
                resolved++;
                onProgress?.(resolved, total);
                return;
            }

            // For optional (indirect) deps, use a much stricter depth limit
            if (isOptional && depth >= MAX_OPTIONAL_DEPTH) {
                resolved++;
                onProgress?.(resolved, total);
                return;
            }

            try {
                const meta = await fetchPackageMeta(name);
                const resolvedName = meta.name;

                // Get available versions (already sorted)
                const versions = meta.versions;

                if (versions.length === 0) {
                    throw new Error(`No versions found for module ${resolvedName}`);
                }

                // Resolve the version based on the version requirement
                const resolvedVersion = resolveGoVersion(versionDef, versions);
                const nodeId = `${resolvedName}@${resolvedVersion}`;

                // Check if we've already created this exact version node
                const resolvedVersions = resolvedPackages.get(resolvedName.toLowerCase());
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
                if (!resolvedPackages.has(resolvedName.toLowerCase())) {
                    resolvedPackages.set(resolvedName.toLowerCase(), new Set());
                }
                resolvedPackages.get(resolvedName.toLowerCase())!.add(resolvedVersion);

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

                // Fetch dependencies for this specific version
                const rawDependencies: GoModDependency[] = await fetchVersionDependencies(resolvedName, resolvedVersion);

                // Parse dependencies - only direct (non-indirect) dependencies
                const dependencies: Record<string, string> = {};
                // Parse optional dependencies (indirect - only when showPeerDeps is enabled)
                const optionalDeps: Record<string, string> = {};

                for (const dep of rawDependencies) {
                    // Skip stdlib packages
                    if (isStdlibPackage(dep.path)) continue;
                    
                    if (!dep.indirect) {
                        dependencies[dep.path] = dep.version;
                    }
                    // Include indirect dependencies when showPeerDeps is enabled
                    if (options.showPeerDeps && dep.indirect) {
                        optionalDeps[dep.path] = dep.version;
                    }
                }

                // Fetch size asynchronously
                const size = await fetchModuleSize(resolvedName, resolvedVersion);

                const hasSizeData = size !== undefined && size > 0;
                const isMicropackage = hasSizeData && size < MICROPACKAGE_SIZE_THRESHOLD;

                graph.nodes.set(nodeId, {
                    id: nodeId,
                    pkgName: resolvedName,
                    version: resolvedVersion,
                    description: meta.description || '',
                    maintainers: 0, // Go proxy doesn't expose maintainer info
                    lastPublish: '', // Go proxy doesn't expose this directly
                    dependencies: dependencies,
                    isRoot: parentId === null,
                    readme: '',
                    source: detectGoSource(resolvedName, versionDef),
                    size,
                    isMicropackage
                });

                // Add regular dependencies to queue
                const newDeps = Object.entries(dependencies);
                total += newDeps.length;
                for (const [depName, depVersion] of newDeps) {
                    queue.push({ name: depName, versionDef: depVersion, parentId: nodeId, depth: depth + 1 });
                }

                // Add optional (indirect) dependencies to queue as peers when showPeerDeps is enabled
                // But only for the first level to prevent exponential explosion
                if (options.showPeerDeps && depth < 1) {
                    const optDepEntries = Object.entries(optionalDeps);
                    total += optDepEntries.length;
                    for (const [depName, depVersion] of optDepEntries) {
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
                        source: detectGoSource(name, versionDef)
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

export async function resolveGoDependencyTree(
    rootPkg: string,
    rootVersion?: string,
    options?: { showPeerDeps?: boolean },
    onProgress?: ProgressCallback
): Promise<ResolvedGraph> {
    const graph: ResolvedGraph = {
        nodes: new Map(),
        edges: [],
        errors: [],
        cycles: []
    };

    const queue: QueueItem[] = [{ name: rootPkg, versionDef: rootVersion || 'latest', parentId: null, depth: 0 }];
    await runBfsGoResolution(graph, queue, options, onProgress);

    return graph;
}

export async function resolveGoDependencyTreeFromManifest(
    manifest: GoModManifest,
    options?: { showPeerDeps?: boolean },
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
        source: 'go'
    });

    const queue: QueueItem[] = Object.entries(manifest.dependencies).map(([name, versionDef]) => ({
        name,
        versionDef,
        parentId: rootId,
        depth: 0
    }));

    await runBfsGoResolution(graph, queue, options, onProgress);

    return graph;
}


/**
 * Enrich a resolved Go graph with metadata from deps.dev.
 */
export async function enrichGoGraphWithDepsDevData(graph: ResolvedGraph): Promise<void> {
    const goNodes = new Map();
    
    for (const [nodeId, node] of graph.nodes.entries()) {
        if (node.source === 'go' && !node.isNotFound) {
            goNodes.set(nodeId, node);
        }
    }
    
    if (goNodes.size > 0) {
        await enrichBulkWithDepsDevData(goNodes, 'go');
    }
}
