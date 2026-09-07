import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "./Icon";
import { useFillHeight } from "./useFillHeight";

const SqlEditor = lazy(() => import("./SqlEditor"));

// The query and its result are one workbench, not two blocks stacked on a scrolling page: reading
// a result means looking at the query that produced it, and scrolling one out of view to see the
// other is exactly what a database tool must not make you do. The pair fills the window, and the
// bar between them is the handle that decides how the height is shared.
const MIN_SHARE = 12;
const MAX_SHARE = 88;
const DEFAULT_SHARE = 45;
const STORE_KEY = "sqlbrowser.querypane.split";

interface QueryPaneProps {
    // The query to start from. It fills the editor until the user types, and never overwrites what
    // they have written afterwards.
    sql: string;
    result: ReactNode;
    // Runs the text currently in the editor. Bound to the button and to Alt+X / F5.
    onExecute: (sql: string) => void;
    // Aborts the request in flight; disabled while nothing is running.
    onCancel: () => void;
    running: boolean;
}

export function QueryPane({ sql, result, onExecute, onCancel, running }: QueryPaneProps) {
    const [text, setText] = useState(sql);
    // Once someone has typed, the incoming sql prop stops being an instruction and becomes just
    // the query this pane happened to open with. The preview's text arrives a moment after the
    // pane mounts, and it must not land on top of a query being written.
    const edited = useRef(false);
    useEffect(() => {
        if (!edited.current) {
            setText(sql);
        }
    }, [sql]);

    const onEdit = useCallback((next: string) => {
        edited.current = true;
        setText(next);
    }, []);
    const [share, setShare] = useState(readShare);
    // The pane reaches the bottom of the window whatever sits above it. Shared with the scripting
    // panel, which needs exactly the same measurement.
    const { frame, height } = useFillHeight();

    const startDrag = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        const el = frame.current;
        if (!el) {
            return;
        }
        const box = el.getBoundingClientRect();
        const onMove = (e: MouseEvent) => {
            const pct = ((e.clientY - box.top) / box.height) * 100;
            setShare(Math.min(MAX_SHARE, Math.max(MIN_SHARE, pct)));
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.classList.remove("row-resizing");
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.classList.add("row-resizing");
    }, []);

    // Remembered per browser: a split is a working preference, and having to drag it back on every
    // table would make the handle a chore rather than a convenience.
    useEffect(() => {
        try {
            localStorage.setItem(STORE_KEY, String(Math.round(share)));
        } catch {
            // A private window can refuse storage; the split simply resets next time.
        }
    }, [share]);

    // The shortcuts are the ones a SQL Server user already has in their fingers. F5 has to be
    // taken off the browser, which would otherwise reload the page and lose the result entirely.
    //
    // Alt+X is matched on e.code, not e.key. On a Mac, Option+X does not produce "x" — it produces
    // "≈", because Option is the layout's alt-graph key. Reading e.key looked right in a synthetic
    // test and did nothing at all under a real keyboard.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const execute = e.key === "F5" || (e.altKey && e.code === "KeyX");
            if (execute) {
                e.preventDefault();
                onExecute(textRef.current);
                return;
            }
            if (e.key === "Escape" && running) {
                e.preventDefault();
                onCancel();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onExecute, onCancel, running]);

    // The shortcut handler is attached once; a ref keeps it reading the current text without
    // re-binding the listener on every keystroke.
    const textRef = useRef(text);
    textRef.current = text;

    return (
        <div className="workbench" ref={frame} style={height ? { height } : undefined}>
            <div className="qtoolbar">
                <button type="button" className="tool run" onClick={() => onExecute(text)} title="Execute (Alt+X, F5)">
                    <Icon name="play" size={14} />
                    Execute
                </button>
                <button
                    type="button"
                    className="tool"
                    onClick={onCancel}
                    disabled={!running}
                    title="Cancel (Esc)"
                >
                    <Icon name="stop" size={13} />
                    Cancel
                </button>
                {running && (
                    <>
                        <span className="tool-sep" />
                        <span className="tool-hint">running…</span>
                    </>
                )}
            </div>
            <div className="pane" style={{ height: `${share}%` }}>
                <Suspense fallback={<div className="editor-placeholder" />}>
                    <SqlEditor
                        value={text}
                        readOnly={false}
                        onChange={onEdit}
                        onExecute={() => onExecute(textRef.current)}
                    />
                </Suspense>
            </div>
            <div
                className="splitter"
                onMouseDown={startDrag}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize query and results"
            />
            <div className="pane result-pane">{result}</div>
        </div>
    );
}

function readShare(): number {
    try {
        const stored = Number(localStorage.getItem(STORE_KEY));
        if (Number.isFinite(stored) && stored >= MIN_SHARE && stored <= MAX_SHARE) {
            return stored;
        }
    } catch {
        // Ignore: an unreadable store just means the default split.
    }
    return DEFAULT_SHARE;
}
