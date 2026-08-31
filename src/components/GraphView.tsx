import type { Edge, EdgeTypes, Node, NodeTypes } from '@xyflow/react';
import {
    Background,
    Controls,
    ReactFlow,
    ReactFlowProvider,
    useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useRef } from 'react';
import type { GraphNodeData } from '../graph/resolver';
import { CustomNode } from './CustomNode';
import { ElkEdge } from './ElkEdge';
import { ViewportProvider } from './ViewportContext';

// React Flow requires data to extend Record<string, unknown>
type AppNodeData = GraphNodeData & Record<string, unknown>;
type AppNode = Node<AppNodeData>;

const nodeTypes: NodeTypes = {
    custom: CustomNode,
};

const edgeTypes: EdgeTypes = {
    elk: ElkEdge,
};

export interface GraphViewProps {
    nodes: AppNode[];
    edges: Edge[];
    onNodeClick: (nodeId: string | null) => void;
    /** Increment this to trigger a fitView after new graph data is loaded */
    fitViewSignal?: number;
}

const POINTERMOVE_INTERVAL = 1000 / 60;

/** Inner component: lives inside ReactFlowProvider so it can use useReactFlow */
function FitViewEffect({ signal }: { signal?: number; }) {
    const { fitView } = useReactFlow();
    useEffect(() => {
        if (signal == null || signal === 0) return;
        // Small delay to let React Flow finish rendering nodes before fitting
        const id = setTimeout(() => fitView(), 50);
        return () => clearTimeout(id);
    }, [signal, fitView]);
    return null;
}

export function GraphView({ nodes, edges, onNodeClick, fitViewSignal }: GraphViewProps) {

    const containerRef = useRef<HTMLDivElement>(null);

    const handleNodeClick = useCallback((_event: React.MouseEvent, node: AppNode) => {
        onNodeClick(node.id);
    }, [onNodeClick]);

    const handlePaneClick = useCallback(() => {
        onNodeClick(null);
    }, [onNodeClick]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        let lastTime = 0;
        const onPointerMove = (e: PointerEvent) => {
            const now = performance.now();
            if (now - lastTime < POINTERMOVE_INTERVAL) {
                e.stopPropagation();
            } else {
                lastTime = now;
            }
        };

        el.addEventListener('pointermove', onPointerMove, { capture: true });
        return () => el.removeEventListener('pointermove', onPointerMove, { capture: true });
    }, []);

    return (
        <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
            <ReactFlowProvider>
                <ViewportProvider>
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        onNodeClick={handleNodeClick}
                        onPaneClick={handlePaneClick}
                        // Disable edge click events entirely
                        defaultEdgeOptions={{
                            focusable: false,
                            selectable: false,
                            interactionWidth: 0
                        }}
                        nodesDraggable={false}
                        proOptions={{ hideAttribution: true /* free, personal project */ }}
                        fitView
                        minZoom={0.01}
                    >
                        <FitViewEffect signal={fitViewSignal} />
                        <Background gap={16} color="var(--border-color)" />
                        <Controls />
                    </ReactFlow>
                </ViewportProvider>
            </ReactFlowProvider>
        </div>
    );
}
