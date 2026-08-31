import type { Edge, Node } from '@xyflow/react';
import type { GraphNodeData, ResolvedGraph } from './resolver';

export type TimelineNodeStatus = 'added' | 'updated' | 'removed' | 'unchanged' | 'pending-removal';

export interface TimelineVersion {
    version: string;
    date: string;
    isPrerelease: boolean;
}

export interface TimelineState {
    nodes: Map<string, GraphNodeData>;
    edges: Array<{ source: string; target: string; type: 'dependency' | 'peer' | 'dev' | 'extra' }>;
    version: string;
}

export interface TimelineDiff {
    added: string[];
    removed: string[];
    updated: string[];
    unchanged: string[];
}

/**
 * Parse a version string into semver components
 */
function parseSemver(version: string): { major: number; minor: number; patch: number; prerelease: string[] } | null {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) return null;
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
        prerelease: match[4] ? match[4].split('.') : []
    };
}

/**
 * Check if a version is a prerelease
 */
export function isPrerelease(version: string): boolean {
    const parsed = parseSemver(version);
    if (!parsed) return /-(alpha|beta|rc|pre|canary|next|dev|snapshot)/i.test(version);
    return parsed.prerelease.length > 0;
}

/**
 * Get the semver level of change between two versions
 */
export function getVersionChangeLevel(oldVersion: string, newVersion: string): 'major' | 'minor' | 'patch' | 'none' {
    const oldParsed = parseSemver(oldVersion);
    const newParsed = parseSemver(newVersion);

    if (!oldParsed || !newParsed) return 'none';

    if (oldParsed.major !== newParsed.major) return 'major';
    if (oldParsed.minor !== newParsed.minor) return 'minor';
    if (oldParsed.patch !== newParsed.patch) return 'patch';
    return 'none';
}

/**
 * Distill versions to the most notable ones based on count
 */
export function distillVersions(versions: TimelineVersion[]): TimelineVersion[] {
    const totalCount = versions.length;

    // If 20 or fewer, show all
    if (totalCount <= 20) {
        return versions;
    }

    // Count prereleases
    const prereleaseCount = versions.filter(v => v.isPrerelease).length;
    const nonPrereleaseCount = totalCount - prereleaseCount;

    // If many prereleases, filter them out
    if (prereleaseCount > nonPrereleaseCount && nonPrereleaseCount > 0) {
        versions = versions.filter(v => !v.isPrerelease);
    }

    // If still too many, keep only major/minor versions
    if (versions.length > 50) {
        const majorMinorVersions: TimelineVersion[] = [];
        let lastKept: TimelineVersion | null = null;

        for (const version of versions) {
            const parsed = parseSemver(version.version);
            if (!parsed) {
                majorMinorVersions.push(version);
                lastKept = version;
                continue;
            }

            if (!lastKept) {
                majorMinorVersions.push(version);
                lastKept = version;
                continue;
            }

            const lastParsed = parseSemver(lastKept.version);
            if (!lastParsed) {
                majorMinorVersions.push(version);
                lastKept = version;
                continue;
            }

            // Keep if major or minor changed
            if (parsed.major !== lastParsed.major || parsed.minor !== lastParsed.minor) {
                majorMinorVersions.push(version);
                lastKept = version;
            }
        }

        versions = majorMinorVersions;
    }

    return versions;
}

/**
 * Calculate animation speed based on version count
 * Target: 1-3 minutes total duration, with max 3 seconds per step for small graphs
 */
export function calculateAnimationSpeed(versionCount: number): number {
    const MIN_SPEED = 500; // Fastest: 0.5s per version
    const MAX_SPEED = 3000; // Slowest: 3s per version

    // Target up to 3 minutes max duration
    const targetDurationMax = 180 * 1000; // 3 minutes

    // Calculate speed for target duration
    const speedForMax = Math.floor(targetDurationMax / versionCount);

    // Clamp to reasonable bounds
    const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speedForMax));

    return speed;
}

/**
 * Compare two dependency graphs to find differences
 */
export function compareGraphs(
    previous: ResolvedGraph | null,
    current: ResolvedGraph
): TimelineDiff {
    const previousIds = previous ? new Set(previous.nodes.keys()) : new Set<string>();
    const currentIds = new Set(current.nodes.keys());

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];

    // Find added nodes
    for (const id of currentIds) {
        if (!previousIds.has(id)) {
            // Check if this is an update (same package, different version)
            const currentNode = current.nodes.get(id)!;
            const baseName = currentNode.pkgName;

            let foundUpdate = false;
            for (const prevId of previousIds) {
                const prevNode = previous?.nodes.get(prevId);
                if (prevNode && prevNode.pkgName === baseName) {
                    updated.push(id);
                    foundUpdate = true;
                    break;
                }
            }

            if (!foundUpdate) {
                added.push(id);
            }
        } else {
            unchanged.push(id);
        }
    }

    // Find removed nodes
    for (const id of previousIds) {
        if (!currentIds.has(id)) {
            removed.push(id);
        }
    }

    return { added, removed, updated, unchanged };
}

/**
 * Convert ResolvedGraph to React Flow nodes and edges with timeline status
 */
export function convertToTimelineGraph(
    graph: ResolvedGraph,
    diff: TimelineDiff,
    previousState: TimelineState | null,
    nextGraph?: ResolvedGraph | null
): {
    nodes: Node<Record<string, unknown> & GraphNodeData & { timelineStatus: TimelineNodeStatus; previousVersion?: string }>[];
    edges: Edge[];
} {
    const nodes: Node<Record<string, unknown> & GraphNodeData & { timelineStatus: TimelineNodeStatus; previousVersion?: string }>[] = [];
    const edges: Edge[] = [];

    // Build node status map
    const nodeStatus = new Map<string, TimelineNodeStatus>();

    // Determine which nodes will be removed in the NEXT version
    const willBeRemoved = new Set<string>();
    if (nextGraph) {
        for (const [id] of graph.nodes) {
            if (!nextGraph.nodes.has(id)) {
                willBeRemoved.add(id);
            }
        }
    }

    // Add current nodes
    for (const [id, nodeData] of graph.nodes) {
        let status: TimelineNodeStatus = 'unchanged';
        let previousVersion: string | undefined;

        if (diff.updated.includes(id)) {
            // Updated takes priority - show old version as orange
            status = 'updated';
            // Find previous version
            const baseName = nodeData.pkgName;
            if (previousState) {
                for (const [prevId, prevNode] of previousState.nodes) {
                    if (prevNode.pkgName === baseName && prevId !== id) {
                        previousVersion = prevNode.version;
                        break;
                    }
                }
            }
        } else if (willBeRemoved.has(id)) {
            // Node will be removed in next version - show it red in THIS version
            status = 'removed';
        } else if (diff.added.includes(id)) {
            status = 'added';
        }

        nodes.push({
            id,
            type: 'custom',
            position: { x: 0, y: 0 }, // Layout will set this
            data: {
                ...nodeData,
                timelineStatus: status,
                previousVersion,
            }
        });

        nodeStatus.set(id, status);
    }

    // Convert edges
    for (const edge of graph.edges) {
        const sourceStatus = nodeStatus.get(edge.source);
        const targetStatus = nodeStatus.get(edge.target);

        // Skip edges to/from removed nodes unless they're still visible
        if (sourceStatus === 'removed' && targetStatus === 'removed') {
            continue;
        }

        edges.push({
            id: `${edge.source}->${edge.target}`,
            source: edge.source,
            target: edge.target,
            type: 'elk',
            animated: edge.type === 'peer',
            data: { type: edge.type }
        });
    }

    return { nodes, edges };
}

/**
 * Build a timeline from package metadata
 */
export function buildTimelineFromVersions<T extends { time?: Record<string, string> | string }>(
    versions: Record<string, T>,
    publishedTimes: Record<string, string>
): TimelineVersion[] {
    const timeline: TimelineVersion[] = [];

    for (const [version, data] of Object.entries(versions)) {
        // Handle both string time and Record<string, string> time
        let date: string | undefined;
        if (typeof data.time === 'string') {
            date = data.time;
        } else if (typeof data.time === 'object' && data.time !== null) {
            // It's a Record, try to find version-specific time
            date = data.time[version];
        }
        if (!date) {
            date = publishedTimes[version] || publishedTimes.modified;
        }
        if (date) {
            timeline.push({
                version,
                date,
                isPrerelease: isPrerelease(version)
            });
        }
    }

    // Sort by date ascending (oldest first)
    return timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}
