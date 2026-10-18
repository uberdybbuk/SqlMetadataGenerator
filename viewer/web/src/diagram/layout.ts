import * as dagre from "@dagrejs/dagre";

// Where the boxes go.
//
// dagre is used for layout only — nothing it produces reaches the DOM. It is kept behind this
// one function so the rest of the diagram deals in plain rectangles and point lists, and so
// swapping the algorithm later touches one file.

export interface LayoutNode {
    id: string;
    width: number;
    height: number;
}

export interface LayoutEdge {
    id: string;
    from: string;
    to: string;
}

export interface Placed {
    // Top-left, because that is what an SVG rect wants. dagre works in centres.
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Layout {
    nodes: Map<string, Placed>;
    edges: Map<string, { x: number; y: number }[]>;
    width: number;
    height: number;
}

export function layout(nodes: LayoutNode[], edges: LayoutEdge[]): Layout {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    // Left to right: a reference reads "child points at parent", and rows of boxes with the
    // referenced tables to the right matches how the relationships are written.
    g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of nodes) {
        g.setNode(node.id, { width: node.width, height: node.height });
    }
    for (const edge of edges) {
        // A self-reference has nothing to lay out — dagre would collapse the rank. It is drawn
        // as a loop on the box itself, so it is kept out of the graph entirely.
        if (edge.from !== edge.to) {
            g.setEdge(edge.from, edge.to, {}, edge.id);
        }
    }

    // A layout failure must never take the panel down with it. dagre throws on inputs it cannot
    // route; the caller gets a plain column of boxes instead of a blank screen.
    try {
        dagre.layout(g);
    } catch {
        return fallback(nodes);
    }

    const placed = new Map<string, Placed>();
    for (const id of g.nodes()) {
        const n = g.node(id);
        if (n) {
            placed.set(id, { x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height });
        }
    }

    const routes = new Map<string, { x: number; y: number }[]>();
    for (const e of g.edges()) {
        const edge = g.edge(e);
        if (edge?.points && e.name) {
            routes.set(e.name, edge.points);
        }
    }

    const size = g.graph();
    return {
        nodes: placed,
        edges: routes,
        width: size.width ?? 0,
        height: size.height ?? 0,
    };
}

// Boxes stacked in a column, in the order they were given. Not a layout anyone wants — it exists
// so that a diagram still appears when dagre refuses the graph.
function fallback(nodes: LayoutNode[]): Layout {
    const placed = new Map<string, Placed>();
    let y = 24;
    let width = 0;
    for (const node of nodes) {
        placed.set(node.id, { x: 24, y, width: node.width, height: node.height });
        y += node.height + 24;
        width = Math.max(width, node.width + 48);
    }
    return { nodes: placed, edges: new Map(), width, height: y };
}
