import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import ELK from 'elkjs/lib/elk-api';
import type { GraphNodeData } from './resolver';

const elk = new ELK({
    workerUrl: new URL('elkjs/lib/elk-worker.min.js', import.meta.url).href
});

const nodeEdgeGap = "40";
const nodeNodeGap = "40";

// Input types for the worker
interface WorkerInputNode extends GraphNodeData {
    id: string;
}

interface WorkerInputEdge {
    source: string;
    target: string;
    type: 'dependency' | 'peer' | 'dev' | 'extra';
}

// Layout configuration tailored for dense dependency graphs
const elkOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT', // Directed Acyclic Graph usually looks best left-to-right
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',

    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',

    "elk.spacing.nodeNode": nodeNodeGap,
    "elk.layered.spacing.nodeNodeBetweenLayers": nodeNodeGap,
    "elk.spacing.edgeNode": nodeEdgeGap,
    "elk.layered.spacing.edgeEdgeBetweenLayers": nodeEdgeGap,
    "elk.layered.spacing.edgeNodeBetweenLayers": nodeEdgeGap,
    "elk.layered.wrapping.additionalEdgeSpacing": nodeEdgeGap,
    "elk.spacing.nodeSelfLoop": nodeEdgeGap
};

self.onmessage = async (e: MessageEvent<{
    nodes: WorkerInputNode[];
    validEdges: WorkerInputEdge[];
    requestId: string;
}>) => {
    try {
        const { nodes: graphNodes, validEdges, requestId } = e.data;

        const idMap = new Map<string, string>(); // realId -> safeId
        const reverseIdMap = new Map<string, string>(); // safeId -> realId
        let idCounter = 0;
        const getSafeId = (realId: string) => {
            if (!idMap.has(realId)) {
                const safeId = `n${idCounter++}`;
                idMap.set(realId, safeId);
                reverseIdMap.set(safeId, realId);
            }
            return idMap.get(realId)!;
        };

        // Sort nodes deterministically by ID so ELK receives the same input
        const nodes = graphNodes
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(n => ({
                id: getSafeId(n.id),
                width: 280, // Approx width of our CustomNode UI
                height: 120, // Approx height
                data: n,
            }));

        // Sort edges deterministically as well
        const edges = validEdges
            .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
            .map((e, idx) => ({
                id: `e${idx}`,
                sources: [getSafeId(e.source)],
                targets: [getSafeId(e.target)],
                data: { type: e.type }
            }));

        const graph = {
            id: 'root',
            layoutOptions: elkOptions,
            children: nodes,
            edges: edges
        };

        const edgeIndex = new Map<string, typeof edges[number]>();
        edges.forEach((edge) => edgeIndex.set(edge.id, edge));

        const layoutedGraph = await elk.layout(graph as unknown as ElkNode);

        // Transform back to React Flow format
        const reactFlowNodes = (layoutedGraph.children || []).map((node) => {
            const delay = Math.min((node.x || 0) / 1000, 1.5);
            const originalData = (node as ElkNode & { data?: GraphNodeData }).data;
            return {
                id: originalData.id, // Use the ORIGINAL ID (e.g., "react@18.2.0") not the safe ID
                position: { x: node.x || 0, y: node.y || 0 },
                data: originalData,
                type: 'custom',
                // Preserve existing style (e.g., comparison diff styles) and add entrance animation
                style: {
                    ...((originalData as GraphNodeData & { style?: React.CSSProperties }).style || {}),
                    animation: `fadeIn 0.5s ease both ${delay}s`
                }
            };
        });

        const safeReactFlowEdges = (layoutedGraph.edges || []).map((elkEdge: ElkExtendedEdge) => {
            const { id, sections } = elkEdge;
            const e = edgeIndex.get(id);

            // Skip if edge not found in index (shouldn't happen, but safety check)
            if (!e) {
                console.warn(`[layout.worker] Edge ${id} not found in edgeIndex`);
                return null;
            }

            const edgeType = e.data.type;
            // Convert safe IDs back to original IDs for React Flow
            const originalSource = reverseIdMap.get(e.sources[0]) || e.sources[0];
            const originalTarget = reverseIdMap.get(e.targets[0]) || e.targets[0];
            return {
                id: `reactflow-e${id}`,
                source: originalSource,
                target: originalTarget,
                type: 'elk',
                animated: edgeType === 'dev',
                style: {
                    stroke: edgeType === 'peer' ? '#c084fc' : 'var(--text-muted)',
                    strokeWidth: edgeType === 'peer' ? 3 : 2,
                    strokeDasharray: edgeType === 'peer' ? '6 6' : undefined,
                    opacity: 0.6,
                    zIndex: edgeType === 'peer' ? 10 : 1
                },
                data: {
                    ...e.data,
                    path: sections?.[0],
                },
            };
        }).filter((edge): edge is NonNullable<typeof edge> => edge !== null);

        self.postMessage({ type: 'success', nodes: reactFlowNodes, edges: safeReactFlowEdges, requestId });
    } catch (err) {
        console.error('ELK Layout Worker Error', err);
        self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err), requestId: e.data?.requestId });
    }
};
