import type { Edge, Node } from '@xyflow/react';
import type { GraphNodeData, ResolvedGraph } from './resolver';

// Singleton worker instance so we don't pay the ELK initialization cost multiple times
let layoutWorker: Worker | null = null;

// React Flow requires data to extend Record<string, unknown>
type AppNodeData = GraphNodeData & Record<string, unknown>;
type AppNode = Node<AppNodeData>;

export async function layoutGraph(graphContent: ResolvedGraph): Promise<{ nodes: AppNode[]; edges: Edge[] }> {
    if (!layoutWorker) {
        layoutWorker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    }

    // Generate unique request ID to match response
    const requestId = Math.random().toString(36).substring(2, 15);

    // Process nodes and edges to send to the worker
    const nodes = Array.from(graphContent.nodes.values());
    const validEdges = graphContent.edges.filter(
        (e) => graphContent.nodes.has(e.source) && graphContent.nodes.has(e.target)
    );

    return new Promise((resolve, reject) => {
        const handleMessage = (e: MessageEvent) => {
            const data = e.data;
            // Only process responses matching our request ID
            if (data.requestId !== requestId) return;

            if (data.type === 'success') {
                cleanup();
                resolve({ nodes: data.nodes, edges: data.edges });
            } else if (data.type === 'error') {
                cleanup();
                reject(new Error(data.error));
            }
        };

        const handleError = (e: ErrorEvent) => {
            cleanup();
            reject(new Error(e.message));
        };

        const cleanup = () => {
            layoutWorker?.removeEventListener('message', handleMessage);
            layoutWorker?.removeEventListener('error', handleError);
        };

        layoutWorker!.addEventListener('message', handleMessage);
        layoutWorker!.addEventListener('error', handleError);

        layoutWorker!.postMessage({ nodes, validEdges, requestId });
    });
}
