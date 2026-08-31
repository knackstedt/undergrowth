import { useContext, useEffect, useState } from 'react';
import type { ViewportSnapshot } from './viewportContext';
import { VIEWPORT_BUFFER, ViewportContext } from './viewportContext';

const lodZoom = 0.125;
const lodZoomMid = 0.5;

export interface NodeVisibility {
    isOutsideViewport: boolean;
    /** True when zoomed out past the dot threshold */
    isLOD: boolean;
    /** True when between dot threshold and full-detail threshold (shows name label only) */
    isNameLOD: boolean;
    /** Current viewport zoom, useful for inverse-scaling text */
    zoom: number;
}

function computeVisibility(
    vp: ViewportSnapshot,
    posX: number,
    posY: number,
    nodeWidth: number,
    nodeHeight: number,
): NodeVisibility {
    const screenX = posX * vp.zoom + vp.x;
    const screenY = posY * vp.zoom + vp.y;

    const isOutsideViewport =
        screenX + nodeWidth * vp.zoom < -VIEWPORT_BUFFER ||
        screenX > vp.width + VIEWPORT_BUFFER ||
        screenY + nodeHeight * vp.zoom < -VIEWPORT_BUFFER ||
        screenY > vp.height + VIEWPORT_BUFFER;

    return {
        isOutsideViewport,
        isLOD: vp.zoom <= lodZoom,
        isNameLOD: vp.zoom > lodZoom && vp.zoom <= lodZoomMid,
        zoom: vp.zoom,
    };
}

export function useNodeVisibility(
    posX: number,
    posY: number,
    nodeWidth: number,
    nodeHeight: number,
): NodeVisibility {
    const ctx = useContext(ViewportContext);

    const [visibility, setVisibility] = useState<NodeVisibility>(() => {
        if (!ctx) return { isOutsideViewport: false, isLOD: false, isNameLOD: false, zoom: 1 };
        return computeVisibility(ctx.getViewport(), posX, posY, nodeWidth, nodeHeight);
    });

    useEffect(() => {
        if (!ctx) return;

        return ctx.subscribe(() => {
            const next = computeVisibility(ctx.getViewport(), posX, posY, nodeWidth, nodeHeight);
            setVisibility((prev) =>
                prev.isOutsideViewport === next.isOutsideViewport &&
                    prev.isLOD === next.isLOD &&
                    prev.isNameLOD === next.isNameLOD &&
                    prev.zoom === next.zoom
                    ? prev
                    : next
            );
        });
    }, [ctx, posX, posY, nodeWidth, nodeHeight]);

    return visibility;
}
