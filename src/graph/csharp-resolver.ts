import { fetchPackageMeta, fetchVersionDependencies, getBestDependencyGroup, resolveNuGetVersion } from '../api/nuget';
import type { BfsQueueItem, ProgressCallback, ResolvedGraph, ResolverOptions } from './resolver';
import { runBfs } from './resolver';
import { enrichBulkWithDepsDevData } from '../utils/depsdev-enrichment';

export interface CsprojManifest {
    name: string;
    version?: string;
    description?: string;
    targetFramework?: string;
    dependencies: Record<string, string>;
}

const MAX_DEPTH = 100;

async function runBfsCSharpResolution(
    graph: ResolvedGraph,
    queue: BfsQueueItem[],
    targetFramework?: string,
    options: ResolverOptions = {},
    onProgress?: ProgressCallback
): Promise<void> {
    const inProgress = new Set<string>();
    const resolvedPackages = new Set<string>();

    await runBfs(graph, queue, options, onProgress, {
        ghostSource: () => 'nuget',
        process: async ({ name, versionDef, parentId, isPeer, depth = 0 }, ctx) => {
            if (depth >= MAX_DEPTH) {
                return;
            }

            if (resolvedPackages.has(name.toLowerCase())) {
                return;
            }

            const meta = await fetchPackageMeta(name, options.signal);
            resolvedPackages.add(name.toLowerCase());

            const versions = meta.versions.map(v => v.version);
            if (versions.length === 0) {
                throw new Error(`No versions found for package ${name}`);
            }

            const resolvedVersion = resolveNuGetVersion(versionDef, versions);

            const nodeId = `${name}@${resolvedVersion}`;

            if (parentId) {
                ctx.addEdge(parentId, nodeId, isPeer ? 'peer' : 'dependency');
            }

            if (graph.nodes.has(nodeId) || inProgress.has(nodeId)) {
                return;
            }

            inProgress.add(nodeId);

            const versionData = meta.versions.find(v => v.version === resolvedVersion);
            const uploadTime = versionData?.published || '';

            // Fetch dependencies for this specific version (not included in search API)
            const dependencyGroups = await fetchVersionDependencies(name, resolvedVersion, options.signal);
            const bestGroup = getBestDependencyGroup(dependencyGroups, targetFramework);
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
                source: 'nuget' });

            // Add dependencies
            const newDeps = Object.entries(dependencies);
            for (const [depName, depVersion] of newDeps) {
                ctx.enqueue({ name: depName, versionDef: depVersion, parentId: nodeId, depth: depth + 1 });
            }
        }
    });
}

export async function resolveCSharpDependencyTree(
    rootPkg: string,
    rootVersion?: string,
    targetFramework?: string,
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
    await runBfsCSharpResolution(graph, queue, targetFramework, options, onProgress);

    return graph;
}

export async function resolveCSharpDependencyTreeFromManifest(
    manifest: CsprojManifest,
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
        source: 'nuget'
    });

    const queue = Object.entries(manifest.dependencies).map(([name, versionDef]) => ({
        name,
        versionDef,
        parentId: rootId }));

    await runBfsCSharpResolution(graph, queue, manifest.targetFramework, options, onProgress);

    return graph;
}


/**
 * Enrich a resolved C# graph with metadata from deps.dev.
 */
export async function enrichCSharpGraphWithDepsDevData(graph: ResolvedGraph, signal?: AbortSignal): Promise<void> {
    const nugetNodes = new Map();
    
    for (const [nodeId, node] of graph.nodes.entries()) {
        if (node.source === 'nuget' && !node.isNotFound) {
            nugetNodes.set(nodeId, node);
        }
    }
    
    if (nugetNodes.size > 0) {
        await enrichBulkWithDepsDevData(nugetNodes, 'nuget', signal);
    }
}
