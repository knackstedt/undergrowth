import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import type { ElkEdgeSection } from "elkjs/lib/elk-api";

export type ElkEdgeData = Edge<
	{
		path?: ElkEdgeSection;
	},
	"elk"
>;

const getRoundedPath = (points, radius = 10) => {
	if (points.length < 2) return "";
	if (points.length === 2) {
		return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`;
	}

	let path = `M${points[0].x},${points[0].y}`;

	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1];
		const curr = points[i];
		const next = points[i + 1];

		// Calculate vector from current to prev and next
		const lenPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y);
		const lenNext = Math.hypot(next.x - curr.x, next.y - curr.y);

		// Ensure radius isn't larger than half the line length
		const r = Math.min(radius, lenPrev / 2, lenNext / 2);

		// Points where the curve starts and ends
		const before = {
			x: curr.x - (r * (curr.x - prev.x)) / lenPrev,
			y: curr.y - (r * (curr.y - prev.y)) / lenPrev,
		};
		const after = {
			x: curr.x + (r * (next.x - curr.x)) / lenNext,
			y: curr.y + (r * (next.y - curr.y)) / lenNext,
		};

		path += ` L${before.x},${before.y} Q${curr.x},${curr.y} ${after.x},${after.y}`;
	}

	const last = points[points.length - 1];
	path += ` L${last.x},${last.y}`;
	return path;
};

export function ElkEdge(props: EdgeProps<ElkEdgeData>) {
	const { data, id, markerEnd, style } = props;
	const { startPoint, endPoint, bendPoints = [] } = data.path || {};

	if (!startPoint || !endPoint) return null;

	// 1. Combine all points into a single array
	const allPoints = [startPoint, ...bendPoints, endPoint];

	// 2. Use the utility to create a smooth SVG path
	const smoothedPath = getRoundedPath(allPoints, 12); // 12px radius

	const isPeer = data && 'type' in data && data.type === 'peer';

	return (
		<BaseEdge
			id={id}
			path={smoothedPath}
			markerEnd={markerEnd}
			style={{
				strokeWidth: isPeer ? 1.5 : 1,
				stroke: isPeer ? 'var(--accent-purple)' : '#b1b1b7',
				strokeDasharray: isPeer ? '6 4' : undefined,
				...style,
			}}
		/>
	);
}