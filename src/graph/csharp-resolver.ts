import { fetchPackageMeta, fetchVersionDependencies, getBestDependencyGroup, resolveNuGetVersion } from '../api/nuget';
import type { DependencySource, ProgressCallback, ResolvedGraph } from './resolver';
import { enrichBulkWithDepsDevData } from '../utils/depsdev-enrichment';

export interface CsprojManifest {
    name: string;
    version?: string;
    description?: string;
    targetFramework?: string;
    dependencies: Record<string, string>;
}

async function runBfsCSharpResolution(
    graph: ResolvedGraph,
    queue: Array<{ name: string; versionDef: string; parentId: string | null; isPeer?: boolean; depth?: number }>,
    targetFramework?: string,
    onProgress?: ProgressCallback
): Promise<void> {
    const inProgress = new Set<string>();
    const resolvedPackages = new Set<string>();
    let resolved = 0;
    let total = queue.length;
    const MAX_DEPTH = 100;

    const detectCSharpSource = (): DependencySource => {
        return 'nuget';
    };

    const processQueue = async () => {
        const CONCURRENCY = 10;
        const batch = queue.splice(0, CONCURRENCY);

        await Promise.all(batch.map(async ({ name, versionDef, parentId, isPeer, depth = 0 }) => {
            if (depth >= MAX_DEPTH) {
                resolved++;
                onProgress?.(resolved, total);
                return;
            }

            let resolvedVersion = versionDef;

            try {
                if (resolvedPackages.has(name.toLowerCase())) {
                    resolved++;
                    onProgress?.(resolved, total);
                    return;
                }

                const meta = await fetchPackageMeta(name);
                resolvedPackages.add(name.toLowerCase());

                const versions = meta.versions.map(v => v.version);
                if (versions.length === 0) {
                    throw new Error(`No versions found for package ${name}`);
                }

                resolvedVersion = resolveNuGetVersion(versionDef, versions);

                const nodeId = `${name}@${resolvedVersion}`;

                if (parentId) {
                    const edgeType = isPeer ? 'peer' : 'dependency';
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

                const versionData = meta.versions.find(v => v.version === resolvedVersion);
                const uploadTime = versionData?.published || '';

                // Fetch dependencies for this specific version (not included in search API)
                const dependencyGroups = await fetchVersionDependencies(name, resolvedVersion);
                console.log(`[C#] Fetched ${dependencyGroups.length} dependency groups for ${name}@${resolvedVersion}`);
                const bestGroup = getBestDependencyGroup(dependencyGroups, targetFramework);
                console.log(`[C#] Selected dependency group for targetFramework=${targetFramework}:`, bestGroup?.targetFramework || 'none', 'with', bestGroup?.dependencies?.length || 0, 'deps');
                const dependencies: Record<string, string> = {};

                if (bestGroup) {
                    for (const dep of bestGroup.dependencies) {
                        dependencies[dep.id] = dep.range;
                    }
                }

                graph.nodes.set(nodeId, {
                    id: nodeId,
                    pkgName: name,
                    version: resolvedVersion,
                    description: meta.description || '',
                    maintainers: (() => {
                        if (!meta.authors) return 0;
                        if (typeof meta.authors === 'string') return meta.authors.split(',').length;
                        if (Array.isArray(meta.authors)) return meta.authors.length;
                        return 1;
                    })(),
                    lastPublish: uploadTime || new Date().toISOString(),
                    dependencies: dependencies,
                    isRoot: parentId === null,
                    isPeer: isPeer || false,
                    readme: meta.description,
                    source: detectCSharpSource() });

                // Add dependencies
                const newDeps = Object.entries(dependencies);
                total += newDeps.length;
                for (const [depName, depVersion] of newDeps) {
                    queue.push({ name: depName, versionDef: depVersion, parentId: nodeId, depth: depth + 1 });
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Unknown dependency resolution error';
                graph.errors.push({ pkg: name, error: message });

                if (parentId === null) {
                    throw err;
                }

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
                        source: detectCSharpSource()
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

export async function resolveCSharpDependencyTree(
    rootPkg: string,
    rootVersion?: string,
    targetFramework?: string,
    onProgress?: ProgressCallback
): Promise<ResolvedGraph> {
    const graph: ResolvedGraph = {
        nodes: new Map(),
        edges: [],
        errors: [],
        cycles: []
    };

    const queue = [{ name: rootPkg, versionDef: rootVersion || '*', parentId: null as string | null }];
    await runBfsCSharpResolution(graph, queue, targetFramework, onProgress);

    return graph;
}

export async function resolveCSharpDependencyTreeFromManifest(
    manifest: CsprojManifest,
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
        source: 'nuget'
    });

    const queue = Object.entries(manifest.dependencies).map(([name, versionDef]) => ({
        name,
        versionDef,
        parentId: rootId }));

    await runBfsCSharpResolution(graph, queue, manifest.targetFramework, onProgress);

    return graph;
}


/**
 * Enrich a resolved C# graph with metadata from deps.dev.
 */
export async function enrichCSharpGraphWithDepsDevData(graph: ResolvedGraph): Promise<void> {
    const nugetNodes = new Map();
    
    for (const [nodeId, node] of graph.nodes.entries()) {
        if (node.source === 'nuget' && !node.isNotFound) {
            nugetNodes.set(nodeId, node);
        }
    }
    
    if (nugetNodes.size > 0) {
        await enrichBulkWithDepsDevData(nugetNodes, 'nuget');
    }
}
