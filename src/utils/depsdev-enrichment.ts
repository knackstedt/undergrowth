import {
    fetchVersionInfo,
    getSecurityAdvisories,
    getSPDXLicenses,
    type PackageSystem,
    type DepsDevVersionInfo
} from '../api/depsdev';
import type { DependencySource, GraphNodeData } from '../graph/resolver';

const ENRICHMENT_CONCURRENCY = 8;

function sourceToPackageSystem(source?: DependencySource): PackageSystem | null {
    switch (source) {
        case 'npm': return 'NPM';
        case 'pypi': return 'PYPI';
        case 'crates': return 'CARGO';
        case 'go': return 'GO';
        case 'nuget': return 'NUGET';
        default: return null;
    }
}

export async function enrichWithDepsDevData(
    nodeData: Partial<GraphNodeData>,
    packageName: string,
    version: string,
    source?: DependencySource,
    signal?: AbortSignal
): Promise<Partial<GraphNodeData>> {
    const system = sourceToPackageSystem(source);

    if (!system) {
        return nodeData;
    }

    try {
        const versionInfo = await fetchVersionInfo(system, packageName, version, signal);

        return {
            ...nodeData,
            spdxLicenses: getSPDXLicenses(versionInfo),
            depsDevAdvisories: getSecurityAdvisories(versionInfo),
            externalLinks: versionInfo.links || []
        };
    } catch (error) {
        if (signal?.aborted) return nodeData;
        console.warn(`[deps.dev] Failed to enrich ${packageName}@${version}:`, error);
        return nodeData;
    }
}

export async function enrichBulkWithDepsDevData(
    nodes: Map<string, GraphNodeData>,
    source?: DependencySource,
    signal?: AbortSignal
): Promise<void> {
    const system = sourceToPackageSystem(source);

    if (!system) {
        return;
    }

    // Process with a bounded worker pool — firing one request per node at once
    // would hammer api.deps.dev and trigger rate limiting + retries
    const entries = Array.from(nodes.values());
    let cursor = 0;

    const worker = async () => {
        while (cursor < entries.length && !signal?.aborted) {
            const nodeData = entries[cursor++];
            try {
                const versionInfo = await fetchVersionInfo(system, nodeData.pkgName, nodeData.version, signal);
                nodeData.spdxLicenses = getSPDXLicenses(versionInfo);
                nodeData.depsDevAdvisories = getSecurityAdvisories(versionInfo);
                nodeData.externalLinks = versionInfo.links || [];
            } catch (error) {
                if (signal?.aborted) return;
                console.warn(`[deps.dev] Failed to enrich ${nodeData.pkgName}@${nodeData.version}:`, error);
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, entries.length) }, () => worker())
    );
}

export function getDepsDevVersionInfo(
    system: PackageSystem,
    packageName: string,
    version: string,
    signal?: AbortSignal
): Promise<DepsDevVersionInfo> {
    return fetchVersionInfo(system, packageName, version, signal);
}
