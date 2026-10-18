import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, type DatabaseGraph, type GraphLink, type GraphTable, type LinkConfidence } from "../api";
import { useApi } from "../useApi";
import { useFillHeight } from "../useFillHeight";
import { Icon } from "../Icon";
import { layout, type LayoutEdge, type LayoutNode } from "./layout";

// Start from one table and grow outward.
//
// A 233-table schema drawn all at once is a wall, and choosing 12 tables off a checklist means
// already knowing which 12. So the diagram starts from a table you name and the boxes carry the
// neighbours they could pull in — exploring the schema IS the interaction.
//
// Every edge is inferred from column names, so every edge says how sure it is: solid for a
// column that names its table outright, dashed for a key matched by name, faint for two tables
// that merely share a column. The last two are off until you ask for them.

const ROW_HEIGHT = 15;
const HEADER_HEIGHT = 26;
const PADDING = 10;
// 11px in the monospace stack measures a shade under 6.6px per character. Estimated rather than
// measured: the layout has to run before anything is in the DOM, and being a few pixels out
// costs a little whitespace, not a broken diagram.
const CHAR = 6.6;
// The title is 11.5px semibold in the same stack — a shade wider per character than the rows.
const TITLE_CHAR = 7.1;
const MIN_WIDTH = 170;
const MAX_WIDTH = 330;

// The seed list's width. Schema-qualified names run long — "Intelligence.AssessmentCriteria"
// is 31 characters — so a fixed column truncated most of them and you could not tell two
// candidates apart. Remembered per browser: it is a working preference, not a per-visit choice.
const LIST_MIN = 180;
const LIST_MAX = 620;
const LIST_DEFAULT = 280;
const LIST_KEY = "sqlbrowser.diagram.list";

function readListWidth(): number {
    try {
        const stored = Number(localStorage.getItem(LIST_KEY));
        if (Number.isFinite(stored) && stored >= LIST_MIN && stored <= LIST_MAX) {
            return stored;
        }
    } catch {
        // A private window can refuse storage; the default width is no worse than a guess.
    }
    return LIST_DEFAULT;
}

const RANK: Record<LinkConfidence, number> = { high: 0, medium: 1, low: 2 };

const keyOf = (schema: string, name: string) => `${schema}.${name}`;

interface DiagramPanelProps {
    alias: string;
    db: string;
}

export function DiagramPanel({ alias, db }: DiagramPanelProps) {
    const graph = useApi(() => api.graph(alias, db), [alias, db]);
    const navigate = useNavigate();
    const { frame, height } = useFillHeight(460);

    const [shown, setShown] = useState<Set<string>>(() => new Set());
    // Collapsed, not expanded: a box shows every column unless it has been folded up. Seeing
    // which column carries a relationship is the point of the picture.
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [search, setSearch] = useState("");
    const [listWidth, setListWidth] = useState(readListWidth);
    const [loose, setLoose] = useState(false);
    const [showDangling, setShowDangling] = useState(false);
    const [hover, setHover] = useState<string | null>(null);
    // The info bar follows the SELECTED table, not the hovered one. Driven by hover it vanished
    // the moment you moved towards it, so its own links could never be clicked.
    const [picked, setPicked] = useState<string | null>(null);

    // Pan and zoom live in the viewBox — no library, and the SVG stays exportable as it is.
    //
    // The viewBox is a WINDOW onto the graph at a chosen scale, not the whole graph scaled to
    // fit. Fitting everything sounds right and is useless: a hub with 27 spokes lays out 828
    // wide and 2216 tall, and fitting that into a 790px pane is 0.35x — a picture of a diagram
    // rather than one you can read.
    const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
    const svgRef = useRef<SVGSVGElement>(null);
    const canvasRef = useRef<HTMLDivElement | null>(null);
    const observerRef = useRef<ResizeObserver | null>(null);
    const [pane, setPane] = useState({ width: 800, height: 600 });

    // A CALLBACK ref, not an effect: the canvas does not exist on the first render (the panel is
    // still reading the schema), so an effect with no dependencies measures nothing and never
    // runs again. The viewBox then keeps the placeholder's 4:3 ratio and the drawing sits
    // letterboxed in the middle of a wide pane.
    const attachCanvas = useCallback((el: HTMLDivElement | null) => {
        observerRef.current?.disconnect();
        canvasRef.current = el;
        if (!el) {
            observerRef.current = null;
            return;
        }
        const measure = () => setPane({ width: el.clientWidth, height: el.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        observerRef.current = observer;
    }, []);

    const data: DatabaseGraph = useMemo(
        () => graph.data ?? { tables: [], links: [], dangling: [] },
        [graph.data],
    );

    const tables = useMemo(() => {
        const map = new Map<string, GraphTable>();
        for (const t of data.tables) {
            map.set(keyOf(t.schema, t.name), t);
        }
        return map;
    }, [data.tables]);

    // Only the links the confidence toggle admits. Everything downstream — what a box can expand
    // into, what is drawn — reads this, so the toggle changes the whole picture coherently.
    const links = useMemo(
        () => data.links.filter((l) => RANK[l.confidence] <= (loose ? 2 : 0)),
        [data.links, loose],
    );

    const neighbours = useMemo(() => {
        const map = new Map<string, Set<string>>();
        const add = (a: string, b: string) => {
            const set = map.get(a);
            if (set) {
                set.add(b);
            } else {
                map.set(a, new Set([b]));
            }
        };
        for (const l of links) {
            const from = keyOf(l.fromSchema, l.fromName);
            const to = keyOf(l.toSchema, l.toName);
            if (from !== to) {
                add(from, to);
                add(to, from);
            }
        }
        return map;
    }, [links]);

    const danglingBy = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const d of data.dangling) {
            const key = keyOf(d.schema, d.name);
            const list = map.get(key);
            if (list) {
                list.push(d.column);
            } else {
                map.set(key, [d.column]);
            }
        }
        return map;
    }, [data.dangling]);

    // Where the view goes when the picture is too big to show at a readable size: the table you
    // last asked for, not the centroid of everything.
    const [anchor, setAnchor] = useState<string | null>(null);

    const add = useCallback((key: string) => {
        setShown((s) => new Set(s).add(key));
        setAnchor(key);
    }, []);
    const drop = useCallback(
        (key: string) =>
            setShown((s) => {
                const next = new Set(s);
                next.delete(key);
                return next;
            }),
        [],
    );
    const expandFrom = useCallback(
        (key: string) =>
            setShown((s) => {
                const next = new Set(s);
                for (const n of neighbours.get(key) ?? []) {
                    next.add(n);
                }
                return next;
            }),
        [neighbours],
    );

    // ---- what is on the canvas ----
    const visible = useMemo(() => [...shown].filter((k) => tables.has(k)), [shown, tables]);
    const visibleSet = useMemo(() => new Set(visible), [visible]);

    const drawnLinks = useMemo(
        () =>
            links.filter(
                (l) =>
                    visibleSet.has(keyOf(l.fromSchema, l.fromName)) &&
                    visibleSet.has(keyOf(l.toSchema, l.toName)),
            ),
        [links, visibleSet],
    );

    // Which columns of a box are worth showing: its key, anything that references out, and
    // anything referenced from elsewhere. The rest are counted, not listed — a 30-column box
    // makes a ten-table diagram unreadable.
    const interesting = useMemo(() => {
        const map = new Map<string, Set<string>>();
        const mark = (key: string, column: string) => {
            const set = map.get(key);
            if (set) {
                set.add(column);
            } else {
                map.set(key, new Set([column]));
            }
        };
        for (const l of drawnLinks) {
            mark(keyOf(l.fromSchema, l.fromName), l.fromColumn);
            mark(keyOf(l.toSchema, l.toName), l.toColumn);
        }
        if (showDangling) {
            for (const [key, columns] of danglingBy) {
                for (const c of columns) {
                    mark(key, c);
                }
            }
        }
        return map;
    }, [drawnLinks, danglingBy, showDangling]);

    const boxes = useMemo(() => {
        return visible.map((key) => {
            const table = tables.get(key)!;
            const marked = interesting.get(key) ?? new Set<string>();
            const rows = collapsed.has(key)
                ? table.columns.filter((c) => c.isPrimaryKey || marked.has(c.name))
                : table.columns;
            const hidden = table.columns.length - rows.length;
            // Where each visible column sits, so an edge can start and end on the row that
            // actually carries the reference rather than on the middle of the box.
            const rowAt = new Map<string, number>();
            rows.forEach((c, i) => rowAt.set(c.name, i));
            const widest = Math.max(
                key.length,
                ...rows.map((c) => c.name.length + c.typeName.length + 3),
                18,
            );
            // A box is foldable when folding it would actually hide something: a table whose
            // every column carries a key or a reference has nothing to fold away.
            const keepsWhenFolded = table.columns.filter((c) => c.isPrimaryKey || marked.has(c.name)).length;
            return {
                key,
                table,
                rows,
                rowAt,
                hidden,
                foldable: keepsWhenFolded < table.columns.length,
                width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widest * CHAR + PADDING * 2)),
                height:
                    HEADER_HEIGHT +
                    rows.length * ROW_HEIGHT +
                    (keepsWhenFolded < table.columns.length ? ROW_HEIGHT : 0) +
                    6,
            };
        });
    }, [visible, tables, collapsed, interesting]);

    const boxByKey = useMemo(() => new Map(boxes.map((b) => [b.key, b])), [boxes]);

    // Columns are coloured by the part they play: one that points somewhere, and one that is
    // pointed at. Without it you can see that two tables are related but not through what.
    const roles = useMemo(() => {
        const out = new Map<string, Set<string>>();
        const into = new Map<string, Set<string>>();
        const mark = (m: Map<string, Set<string>>, key: string, column: string) => {
            const set = m.get(key);
            if (set) {
                set.add(column);
            } else {
                m.set(key, new Set([column]));
            }
        };
        for (const l of drawnLinks) {
            mark(out, keyOf(l.fromSchema, l.fromName), l.fromColumn);
            mark(into, keyOf(l.toSchema, l.toName), l.toColumn);
        }
        return { out, into };
    }, [drawnLinks]);


    // Parallel edges collapse into one.
    //
    // Loose matching produces a link per shared column name, so two tables sharing four names
    // drew four identical lines — noise to read, and dagre cannot route them (59 duplicate pairs
    // in the measured schema made it throw outright). One edge per ordered pair, carrying the
    // strongest confidence and listing every column pair in its tooltip.
    const edgeGroups = useMemo(() => {
        const groups = new Map<string, { link: GraphLink; members: GraphLink[] }>();
        for (const l of drawnLinks) {
            const id = `${keyOf(l.fromSchema, l.fromName)}>${keyOf(l.toSchema, l.toName)}`;
            const held = groups.get(id);
            if (!held) {
                groups.set(id, { link: l, members: [l] });
            } else {
                held.members.push(l);
                if (RANK[l.confidence] < RANK[held.link.confidence]) {
                    held.link = l;
                }
            }
        }
        return [...groups].map(([id, g]) => ({ id, ...g }));
    }, [drawnLinks]);

    const placed = useMemo(() => {
        const nodes: LayoutNode[] = boxes.map((b) => ({ id: b.key, width: b.width, height: b.height }));
        const edges: LayoutEdge[] = edgeGroups.map((g) => ({
            id: g.id,
            from: keyOf(g.link.fromSchema, g.link.fromName),
            to: keyOf(g.link.toSchema, g.link.toName),
        }));
        return layout(nodes, edges);
    }, [boxes, edgeGroups]);

    // The y of a column's row inside its box, in layout coordinates. Falls back to the middle of
    // the box when the column is folded away.
    const anchorY = useCallback(
        (key: string, column: string) => {
            const at = placed.nodes.get(key);
            const box = boxByKey.get(key);
            if (!at) {
                return 0;
            }
            const row = box?.rowAt.get(column);
            return row === undefined
                ? at.y + at.height / 2
                : at.y + HEADER_HEIGHT + 11 + row * ROW_HEIGHT - 4;
        },
        [placed.nodes, boxByKey],
    );

    // ---- the seed list ----
    const needle = search.trim().toLowerCase();
    const candidates = useMemo(() => {
        const all = [...tables.keys()].sort((a, b) => a.localeCompare(b));
        return needle ? all.filter((k) => k.toLowerCase().includes(needle)) : all;
    }, [tables, needle]);

    // Scaling to fit is only worth doing while the result can still be read. Below this the
    // type turns to grey mush — at 0.45 an 11.5px title renders at 5px — so the view stops
    // shrinking, sits on the table you asked for, and you pan to see the rest.
    const MIN_FIT = 0.8;
    const startResize = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = listWidth;
        const onMove = (e: MouseEvent) => {
            setListWidth(Math.min(LIST_MAX, Math.max(LIST_MIN, startWidth + e.clientX - startX)));
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.classList.remove("resizing");
            try {
                localStorage.setItem(LIST_KEY, String(Math.round(listWidthRef.current)));
            } catch {
                // Ignore: an unreadable store just means the default next time.
            }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.classList.add("resizing");
    }, [listWidth]);

    // The width at the moment the drag ends, without re-binding the listeners on every pixel.
    const listWidthRef = useRef(listWidth);
    listWidthRef.current = listWidth;

    const fit = useCallback(() => {
        const gw = placed.width + 48;
        const gh = placed.height + 48;
        if (gw <= 0 || gh <= 0) {
            setView({ x: 0, y: 0, scale: 1 });
            return;
        }

        const whole = Math.min(pane.width / gw, pane.height / gh);
        if (whole >= MIN_FIT) {
            const scale = Math.min(1, whole);
            setView({
                x: -24 + (gw - pane.width / scale) / 2,
                y: -24 + (gh - pane.height / scale) / 2,
                scale,
            });
            return;
        }

        const on = (anchor && placed.nodes.get(anchor)) || [...placed.nodes.values()][0];
        setView({
            x: on ? on.x + on.width / 2 - pane.width / MIN_FIT / 2 : 0,
            y: on ? on.y + on.height / 2 - pane.height / MIN_FIT / 2 : 0,
            scale: MIN_FIT,
        });
    }, [placed, pane.width, pane.height, anchor]);

    // Re-frame when the set of boxes changes, so seeding and expanding always land somewhere
    // you can see. Keyed on the shape of the graph, not on every render.
    const shape = `${visible.length}:${Math.round(placed.width)}x${Math.round(placed.height)}`;
    const framed = useRef("");
    useEffect(() => {
        if (framed.current !== shape && visible.length > 0) {
            framed.current = shape;
            fit();
        }
    }, [shape, visible.length, fit]);

    const onWheel = (e: React.WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) {
            return;
        }
        e.preventDefault();
        setView((v) => {
            const next = Math.min(2.5, Math.max(0.2, v.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
            // Keep whatever is under the pointer under the pointer.
            const box = canvasRef.current?.getBoundingClientRect();
            if (!box) {
                return { ...v, scale: next };
            }
            const px = (e.clientX - box.left) / v.scale + v.x;
            const py = (e.clientY - box.top) / v.scale + v.y;
            return {
                scale: next,
                x: px - (e.clientX - box.left) / next,
                y: py - (e.clientY - box.top) / next,
            };
        });
    };

    const startPan = (e: React.MouseEvent) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(".dgbox")) {
            return;
        }
        const from = { x: e.clientX, y: e.clientY };
        const base = { ...view };
        const move = (ev: MouseEvent) => {
            setView({
                ...base,
                x: base.x - (ev.clientX - from.x) / base.scale,
                y: base.y - (ev.clientY - from.y) / base.scale,
            });
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };

    if (graph.loading) {
        return <div className="state">Reading the schema…</div>;
    }
    if (graph.error) {
        return <div className="error">{graph.error}</div>;
    }

    const base = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}`;
    const vb = `${view.x} ${view.y} ${pane.width / view.scale} ${pane.height / view.scale}`;

    return (
        <div className="diagram" ref={frame} style={height ? { height } : undefined}>
            <div className="qtoolbar">
                <span className="muted">
                    {visible.length} of {tables.size} tables · {edgeGroups.length} links
                </span>
                <span className="tool-sep" />
                <label className="opt" title="Also show keys matched by name, and tables that merely share a column name">
                    <input type="checkbox" checked={loose} onChange={(e) => setLoose(e.target.checked)} />
                    loose matching
                </label>
                <label className="opt" title="Columns that look like references but resolve to nothing">
                    <input
                        type="checkbox"
                        checked={showDangling}
                        onChange={(e) => setShowDangling(e.target.checked)}
                    />
                    unresolved columns
                </label>
                <span className="grow" />
                <button className="tool" onClick={fit} disabled={visible.length === 0}>
                    Reset view
                </button>
                <button className="tool" onClick={() => setShown(new Set())} disabled={visible.length === 0}>
                    Clear
                </button>
            </div>

            <div className="dgsplit">
                <div className="spane source" style={{ flexBasis: listWidth }}>
                    <div className="pane-head">
                        <div className="searchrow">
                            <input
                                type="search"
                                className="search"
                                placeholder="Start from a table…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                            <span className="ratio">
                                {candidates.length} / {tables.size}
                            </span>
                        </div>
                    </div>
                    <div className="picker-rows">
                        {candidates.slice(0, 300).map((key) => {
                            const on = visibleSet.has(key);
                            const degree = neighbours.get(key)?.size ?? 0;
                            return (
                                <div
                                    key={key}
                                    className={on ? "orow chosen" : "orow"}
                                    onClick={() => (on ? drop(key) : add(key))}
                                >
                                    <Icon name="table" size={13} />
                                    <span className="pname mono">{key}</span>
                                    <span className="grow" />
                                    <span className="rowcol" title="related tables">
                                        {degree > 0 ? degree : ""}
                                    </span>
                                </div>
                            );
                        })}
                        {candidates.length === 0 && <div className="state">Nothing matches.</div>}
                    </div>
                </div>

                <div
                    className="dgresizer"
                    onMouseDown={startResize}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize the table list"
                />

                <div className="dgcanvas" ref={attachCanvas} onWheel={onWheel} onMouseDown={startPan}>
                    {visible.length === 0 ? (
                        <div className="empty">
                            <b>Pick a table to start from</b>
                            <span>Then expand it along its relationships.</span>
                        </div>
                    ) : (
                        <svg ref={svgRef} viewBox={vb} width="100%" height="100%">
                            <defs>
                                <marker id="dgarrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                                    <path d="M0,0 L8,4 L0,8 z" className="dgarrowhead" />
                                </marker>
                            </defs>

                            {edgeGroups.map(({ id, link: l, members }) => {
                                const points = placed.edges.get(id);
                                const from = placed.nodes.get(keyOf(l.fromSchema, l.fromName));
                                const to = placed.nodes.get(keyOf(l.toSchema, l.toName));
                                if (l.self && from) {
                                    // A loop on the box's own right edge; dagre has nothing to say
                                    // about an edge whose ends are the same node.
                                    const x = from.x + from.width;
                                    const y = from.y + from.height / 2;
                                    return (
                                        <path
                                            key={id}
                                            className={`dgedge ${l.confidence}`}
                                            d={`M${x},${y - 8} C${x + 40},${y - 24} ${x + 40},${y + 24} ${x},${y + 8}`}
                                            markerEnd="url(#dgarrow)"
                                        >
                                            <title>
                                                {`${l.fromName}: ` +
                                                    members.map((m) => `${m.fromColumn} → ${m.toColumn}`).join(", ")}
                                            </title>
                                        </path>
                                    );
                                }
                                if (!points || points.length < 2 || !from || !to) {
                                    return null;
                                }

                                // dagre routes between BOXES; the ends are then moved onto the
                                // rows that carry the reference. Its middle is kept only when the
                                // edge skips a rank — then there is a box in the way to go
                                // around. Between neighbouring ranks dagre's lone midpoint sits at
                                // the boxes' centre height, and keeping it pulled every line down
                                // into a V. One path per column pair, so two tables joined on two
                                // columns draw two lines.
                                const middle = points.length > 3 ? points.slice(1, -1) : [];
                                return members.map((m) => {
                                    const sx = from.x + from.width;
                                    const sy = anchorY(keyOf(m.fromSchema, m.fromName), m.fromColumn);
                                    const tx = to.x;
                                    const ty = anchorY(keyOf(m.toSchema, m.toName), m.toColumn);
                                    const d = curveThrough([{ x: sx, y: sy }, ...middle, { x: tx, y: ty }]);
                                    return (
                                        <path
                                            key={`${id}|${m.fromColumn}|${m.toColumn}`}
                                            className={`dgedge ${m.confidence}`}
                                            d={d}
                                            markerEnd="url(#dgarrow)"
                                        >
                                            <title>
                                                {`${m.fromName}.${m.fromColumn} → ${m.toName}.${m.toColumn}` +
                                                    `  (${m.confidence}, ${m.rule})`}
                                            </title>
                                        </path>
                                    );
                                });
                            })}

                            {boxes.map((box) => {
                                const at = placed.nodes.get(box.key);
                                if (!at) {
                                    return null;
                                }
                                const unresolved = showDangling ? (danglingBy.get(box.key) ?? []) : [];
                                const more = (neighbours.get(box.key)?.size ?? 0) -
                                    [...(neighbours.get(box.key) ?? [])].filter((n) => visibleSet.has(n)).length;
                                return (
                                    <g
                                        key={box.key}
                                        className={
                                            "dgbox" +
                                            (hover === box.key ? " hot" : "") +
                                            (picked === box.key ? " picked" : "")
                                        }
                                        transform={`translate(${at.x},${at.y})`}
                                        onMouseEnter={() => setHover(box.key)}
                                        onMouseLeave={() => setHover(null)}
                                        onClick={() => setPicked(box.key)}
                                    >
                                        {/* Fill, then header, then the border ON TOP. With the frame drawn
                                            first the header's fill painted over the inner half of its stroke,
                                            so the outline thinned out across the title. */}
                                        <rect className="dgfill" width={at.width} height={at.height} rx="5" />
                                        <rect
                                            className="dghead"
                                            x="1"
                                            y="1"
                                            width={at.width - 2}
                                            height={HEADER_HEIGHT - 1}
                                            rx="4"
                                        />
                                        <rect className="dgframe" width={at.width} height={at.height} rx="5" />
                                        <text className="dgtitle" x={PADDING} y={17}>
                                            {/* Truncated here rather than clipped: SVG text has
                                                no ellipsis, and left to itself the name ran
                                                straight under the chip in the corner. */}
                                            {clip(box.key, at.width - PADDING * 2 - (more > 0 ? 28 : 0))}
                                        </text>

                                        {more > 0 && (
                                            <g
                                                className="dgexpand"
                                                transform={`translate(${at.width - 26},5)`}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    expandFrom(box.key);
                                                }}
                                            >
                                                <rect width="21" height="16" rx="8" />
                                                <text x="10.5" y="12">{`+${more}`}</text>
                                                <title>{`Add ${more} related table${more === 1 ? "" : "s"}`}</title>
                                            </g>
                                        )}

                                        {box.rows.map((c, i) => {
                                            const pointsOut = roles.out.get(box.key)?.has(c.name) ?? false;
                                            const pointedAt = roles.into.get(box.key)?.has(c.name) ?? false;
                                            return (
                                            <g key={c.name} transform={`translate(0,${HEADER_HEIGHT + 11 + i * ROW_HEIGHT})`}>
                                                <text
                                                    className={
                                                        "dgcol" +
                                                        (c.isPrimaryKey ? " pk" : "") +
                                                        (pointsOut ? " out" : "") +
                                                        (pointedAt ? " into" : "")
                                                    }
                                                    x={PADDING}
                                                >
                                                    {c.isPrimaryKey ? "◆ " : pointsOut ? "→ " : ""}
                                                    {c.name}
                                                </text>
                                                <text className="dgtype" x={at.width - PADDING} textAnchor="end">
                                                    {unresolved.includes(c.name) ? "?" : c.typeName}
                                                </text>
                                            </g>
                                            );
                                        })}

                                        {box.foldable && hover === box.key && (
                                            <text
                                                className="dgmore"
                                                x={at.width / 2}
                                                textAnchor="middle"
                                                y={HEADER_HEIGHT + 11 + box.rows.length * ROW_HEIGHT}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setCollapsed((s) => {
                                                        const next = new Set(s);
                                                        if (next.has(box.key)) {
                                                            next.delete(box.key);
                                                        } else {
                                                            next.add(box.key);
                                                        }
                                                        return next;
                                                    });
                                                }}
                                            >
                                                {box.hidden > 0 ? `▾  ${box.hidden} more` : "▴  fewer"}
                                            </text>
                                        )}
                                    </g>
                                );
                            })}

                            {/* Its own layer, drawn after every box. Inside the box's group a
                                later box painted over it, and the toolbar for the one you are
                                pointing at is the one thing that must never be behind anything. */}
                            {(() => {
                                const at = hover ? placed.nodes.get(hover) : null;
                                const box = hover ? boxByKey.get(hover) : null;
                                if (!at || !box) {
                                    return null;
                                }
                                return (
                                    <g
                                        className="dgtools"
                                        // ADJACENT to the box, sharing its top edge. Any gap at all is a strip
                                        // where neither the box nor the bar is hovered, so the bar disappears
                                        // while you are on your way to it. 24 is the bar's own height.
                                        transform={`translate(${at.x + at.width - 112},${at.y - 25})`}
                                        onMouseEnter={() => setHover(box.key)}
                                    >
                                        <rect className="dgtoolsbg" width="112" height="24" rx="6" />
                                        {/* An invisible bridge across the border. The pill stops just short of
                                            the box so it does not sit on the outline, and without this that
                                            two-pixel strip would be hovered by neither — the bar vanishing
                                            halfway to it is exactly the bug this is avoiding. */}
                                        <rect className="dgbridge" y="24" width="112" height="8" />
                                        <g
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                navigate(
                                                    `${base}/tables/${encodeURIComponent(box.table.schema)}/${encodeURIComponent(box.table.name)}`,
                                                );
                                            }}
                                        >
                                            <rect x="4" y="4" width="48" height="16" rx="4" />
                                            <text x="28" y="15">open</text>
                                            <title>Open this table</title>
                                        </g>
                                        <g
                                            className="drop"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                drop(box.key);
                                                setPicked((c) => (c === box.key ? null : c));
                                                setHover(null);
                                            }}
                                        >
                                            <rect x="56" y="4" width="52" height="16" rx="4" />
                                            <text x="82" y="15">remove</text>
                                            <title>Take off the diagram</title>
                                        </g>
                                    </g>
                                );
                            })()}
                        </svg>
                    )}
                </div>
            </div>

            {/* Always present, so it never moves the canvas, and driven by the SELECTED table so
                its own controls can be reached with the mouse. */}
            <div className="dgfoot">
                {picked && tables.has(picked) ? (
                    <>
                        <b className="mono">{picked}</b>
                        <span className="muted">
                            {tables.get(picked)!.columns.length} columns ·{" "}
                            {roles.out.get(picked)?.size ?? 0} out · {roles.into.get(picked)?.size ?? 0} in
                        </span>
                        <span className="grow" />
                        <span className="muted">open and remove are on the box itself</span>
                    </>
                ) : (
                    <span className="muted">Click a table in the diagram to see its details.</span>
                )}
            </div>
        </div>
    );
}

// SVG text has no ellipsis, so a name that will not fit is cut here. Measured in characters
// against the monospace stack's width, which is exact enough for a title.
function clip(text: string, available: number): string {
    const max = Math.floor(available / TITLE_CHAR);
    return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + "…";
}

// A path through the points that leaves and enters each one horizontally — the diagram runs left
// to right, so a line meets a box's side square on and bends smoothly instead of kinking. Two
// points at the same height come out as a straight line.
function curveThrough(points: { x: number; y: number }[]): string {
    let d = `M${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const mx = (a.x + b.x) / 2;
        d += ` C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
    }
    return d;
}
