import type { Edge, Node } from '@xyflow/react';
import type { WarningToggles } from '../components/WarningTogglesPanel';
import type { GraphNodeData } from './resolver';

export type NodeRelationship = 'selected' | 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed';
export type HighlightableNode = Node<Record<string, unknown> & GraphNodeData & { relationship?: NodeRelationship; searchMatch?: boolean; }>;

export interface HighlightInput {
    nodes: HighlightableNode[];
    edges: Edge[];
    selectedNode: string | null;
    warningToggles: WarningToggles;
    graphSearchQuery: string;
    micropackageThreshold: number;
}

/**
 * Pure highlight/search computation extracted from App: annotates every
 * node with its relationship to the selected node (upstream/downstream/
 * dedicated/both/dimmed), applies warning toggles + search-match flags,
 * and restyles edges to match. "Dedicated" = downstream node reachable
 * from a root only through the selected node; the root-reachability BFS
 * runs once rather than per node.
 */
export function computeHighlightedGraph({
    nodes,
    edges,
    selectedNode,
    warningToggles,
    graphSearchQuery,
    micropackageThreshold
}: HighlightInput): { nodes: HighlightableNode[]; edges: Edge[]; } {
    // Compute search matches
    const searchLower = graphSearchQuery.trim().toLowerCase();
    const searchMatches = new Set<string>();
    if (searchLower) {
        for (const node of nodes) {
            if (node.data.pkgName.toLowerCase().includes(searchLower)) {
                searchMatches.add(node.id);
            }
        }
    }

    // Add warningToggles and searchMatch to all nodes first
    const nodesWithWarnings = nodes.map((node) => ({
        ...node,
        data: {
            ...node.data,
            warningToggles,
            micropackageThreshold,
            searchMatch: searchMatches.has(node.id)
        }
    }));

    if (!selectedNode) {
        return { nodes: nodesWithWarnings, edges };
    }

    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();

    for (const edge of edges) {
        if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
        if (!incoming.has(edge.target)) incoming.set(edge.target, []);
        outgoing.get(edge.source)!.push(edge.target);
        incoming.get(edge.target)!.push(edge.source);
    }

    const downstreamNodes = new Set<string>();
    const upstreamNodes = new Set<string>();
    const downstreamEdges = new Set<string>();
    const upstreamEdges = new Set<string>();

    const walk = (
        startId: string,
        neighbors: Map<string, string[]>,
        targetNodes: Set<string>,
        targetEdges: Set<string>
    ) => {
        const queue = [startId];
        const visited = new Set<string>([startId]);

        for (let i = 0; i < queue.length; i++) {
            const current = queue[i];
            for (const next of neighbors.get(current) || []) {
                targetEdges.add(`${current}->${next}`);
                if (visited.has(next)) continue;
                visited.add(next);
                targetNodes.add(next);
                queue.push(next);
            }
        }
    };

    walk(selectedNode, outgoing, downstreamNodes, downstreamEdges);
    walk(selectedNode, incoming, upstreamNodes, upstreamEdges);

    // Nodes reachable from any root WITHOUT passing through the selected node.
    // Computed once — a purely-downstream node is "dedicated" iff it isn't in
    // this set (previously this BFS ran once per downstream node).
    const reachableFromRoot = new Set<string>();
    const rootQueue: string[] = [];
    for (const n of nodesWithWarnings) {
        if (n.data.isRoot && n.id !== selectedNode) {
            rootQueue.push(n.id);
            reachableFromRoot.add(n.id);
        }
    }
    for (let i = 0; i < rootQueue.length; i++) {
        const current = rootQueue[i];
        for (const next of outgoing.get(current) || []) {
            if (next === selectedNode) continue; // blocked by selected node
            if (!reachableFromRoot.has(next)) {
                reachableFromRoot.add(next);
                rootQueue.push(next);
            }
        }
    }

    const highlightedNodes = nodesWithWarnings.map((node) => {
        let relationship: NodeRelationship = 'dimmed';
        if (node.id === selectedNode) {
            relationship = 'selected';
        } else if (upstreamNodes.has(node.id) && downstreamNodes.has(node.id)) {
            relationship = 'both';
        } else if (upstreamNodes.has(node.id)) {
            relationship = 'upstream';
        } else if (downstreamNodes.has(node.id)) {
            relationship = reachableFromRoot.has(node.id) ? 'downstream' : 'dedicated';
        }

        const isDimmed = relationship === 'dimmed';

        return {
            ...node,
            data: {
                ...node.data,
                relationship },
            style: {
                ...(node.style || {}),
                opacity: isDimmed ? 0.4 : 1,
                transition: 'opacity 180ms ease' }
        };
    });

    const relationshipByNode = new Map(highlightedNodes.map(n => [n.id, n.data.relationship]));

    const highlightedEdges = edges.map((edge) => {
        const forwardKey = `${edge.source}->${edge.target}`;
        const reverseKey = `${edge.target}->${edge.source}`;
        const isDownstream = downstreamEdges.has(forwardKey);
        const isUpstream = upstreamEdges.has(reverseKey);

        let relationship: 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed' = 'dimmed';
        if (isUpstream && isDownstream) {
            relationship = 'both';
        } else if (isUpstream) {
            relationship = 'upstream';
        } else if (isDownstream) {
            // Find if target node is dedicated
            relationship = relationshipByNode.get(edge.target) === 'dedicated' ? 'dedicated' : 'downstream';
        }

        let stroke = edge.type === 'peer' || edge.type === 'extra' ? '#c084fc' : 'var(--text-muted)';
        let opacity = edge.type === 'peer' || edge.type === 'extra' ? 0.6 : 0.14;
        let strokeWidth = edge.type === 'peer' || edge.type === 'extra' ? 3 : 2;
        let strokeDasharray = edge.type === 'peer' || edge.type === 'extra' ? '6 6' : undefined;

        if (relationship === 'upstream') {
            stroke = 'var(--accent-emerald)';
            opacity = 0.95;
            strokeWidth = 3;
        } else if (relationship === 'downstream') {
            stroke = 'var(--accent-blue)';
            opacity = 0.95;
            strokeWidth = 3;
        } else if (relationship === 'dedicated') {
            stroke = 'var(--accent-blue)';
            opacity = 1;
            strokeWidth = 2;
            // Ensure dedicated peers/extras keep dash style
            strokeDasharray = edge.type === 'peer' || edge.type === 'extra' ? '6 6' : undefined;
        } else if (relationship === 'both') {
            stroke = 'var(--accent-amber)';
            opacity = 1;
            strokeWidth = 3;
        }

        return {
            ...edge,
            style: {
                ...(edge.style || {}),
                stroke,
                opacity,
                strokeWidth,
                strokeDasharray,
                transition: 'opacity 180ms ease, stroke 180ms ease' }
        };
    });

    return { nodes: highlightedNodes, edges: highlightedEdges };
}
