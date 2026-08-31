import {
    fetchVersionInfo,
    getSecurityAdvisories,
    getSPDXLicenses,
    type PackageSystem,
    type DepsDevVersionInfo
} from '../api/depsdev';
import type { DependencySource, GraphNodeData } from '../graph/resolver';

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
    source?: DependencySource
): Promise<Partial<GraphNodeData>> {
    const system = sourceToPackageSystem(source);
    
    if (!system) {
        return nodeData;
    }

    try {
        const versionInfo = await fetchVersionInfo(system, packageName, version);
        
        return {
            ...nodeData,
            spdxLicenses: getSPDXLicenses(versionInfo),
            depsDevAdvisories: getSecurityAdvisories(versionInfo),
            externalLinks: versionInfo.links || []
        };
    } catch (error) {
        console.warn(`[deps.dev] Failed to enrich ${packageName}@${version}:`, error);
        return nodeData;
    }
}

export async function enrichBulkWithDepsDevData(
    nodes: Map<string, GraphNodeData>,
    source?: DependencySource
): Promise<void> {
    const system = sourceToPackageSystem(source);
    
    if (!system) {
        return;
    }

    const enrichmentPromises = Array.from(nodes.entries()).map(async ([, nodeData]) => {
        try {
            const versionInfo = await fetchVersionInfo(system, nodeData.pkgName, nodeData.version);
            
            nodeData.spdxLicenses = getSPDXLicenses(versionInfo);
            nodeData.depsDevAdvisories = getSecurityAdvisories(versionInfo);
            nodeData.externalLinks = versionInfo.links || [];
        } catch (error) {
            console.warn(`[deps.dev] Failed to enrich ${nodeData.pkgName}@${nodeData.version}:`, error);
        }
    });

    await Promise.allSettled(enrichmentPromises);
}

export function getDepsDevVersionInfo(
    system: PackageSystem,
    packageName: string,
    version: string
): Promise<DepsDevVersionInfo> {
    return fetchVersionInfo(system, packageName, version);
}
