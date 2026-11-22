import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "./Icon";
import { ResultsToggle } from "./resultsToggle";
import { isModKey, MOD } from "./shortcuts";
import { useCurrentTab } from "./tabs/TabStore";
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
    // Keeps the query somewhere a colleague can open it and answers with the link. Absent where
    // there is nothing to share against, which leaves the button out entirely rather than
    // showing one that cannot work.
    onShare?: (sql: string) => Promise<string>;
    // Puts the cursor in the editor when the pane opens. A query tab wants it; a table's data tab,
    // where the query is already written, does not.
    autoFocus?: boolean;
}

// What the Share button is doing. The link is held so it can be shown after copying: a clipboard
// write that reports success and leaves nothing visible is indistinguishable from one that failed.
type ShareState =
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "done"; url: string }
    | { kind: "failed"; message: string };

export function QueryPane({ sql, result, onExecute, onCancel, running, onShare, autoFocus }: QueryPaneProps) {
    // The tab keeps what was typed here, so the text survives a reload. A tab that has a draft
    // opens on it instead of on the query it was given.
    const tab = useCurrentTab();
    const tabRef = useRef(tab);
    tabRef.current = tab;
    const active = tab?.active ?? true;

    const [text, setText] = useState(tab?.draft ?? sql);
    // Once someone has typed, the incoming sql prop stops being an instruction and becomes just
    // the query this pane happened to open with. The preview's text arrives a moment after the
    // pane mounts, and it must not land on top of a query being written.
    const edited = useRef(tab?.draft !== undefined);
    useEffect(() => {
        if (!edited.current) {
            setText(sql);
        }
    }, [sql]);

    // The shortcut handler is attached once; a ref keeps it reading the current text without
    // re-binding the listener on every keystroke. It is written on the keystroke itself, not
    // only when React gets round to re-rendering: Execute pressed straight after a paste (or a
    // burst of typing while other tabs keep the page busy) otherwise ran the text from before
    // it, which for a new query was nothing at all.
    const textRef = useRef(text);
    textRef.current = text;

    // Typing in a preview tab keeps it: the next click in the tree must not throw the text away.
    const onEdit = useCallback((next: string) => {
        edited.current = true;
        textRef.current = next;
        setText(next);
        tabRef.current?.setDraft(next);
        tabRef.current?.pin();
    }, []);
    const [share, setShare] = useState(readShare);
    // The pane reaches the bottom of the window whatever sits above it. Shared with the scripting
    // panel, which needs exactly the same measurement.
    const { frame, element: frameElement, height } = useFillHeight();

    // The editor pane, measured during a drag. The share sizes THIS element, and it does not
    // start at the top of the frame — the toolbar is above it. Measuring from the frame instead
    // put the handle a toolbar's height below the cursor (40px here) the moment the drag began.
    const editorPane = useRef<HTMLDivElement>(null);

    const startDrag = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const el = frameElement;
        const pane = editorPane.current;
        if (!el || !pane) {
            return;
        }
        const box = el.getBoundingClientRect();
        const paneTop = pane.getBoundingClientRect().top;
        // Where within the handle it was grabbed, so the handle stays under the cursor instead of
        // jumping to centre itself on it.
        const grip = event.clientY - event.currentTarget.getBoundingClientRect().top;
        const onMove = (e: MouseEvent) => {
            const pct = ((e.clientY - grip - paneTop) / box.height) * 100;
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
    }, [frameElement]);

    // Remembered per browser: a split is a working preference, and having to drag it back on every
    // table would make the handle a chore rather than a convenience.
    useEffect(() => {
        try {
            localStorage.setItem(STORE_KEY, String(Math.round(share)));
        } catch {
            // A private window can refuse storage; the split simply resets next time.
        }
    }, [share]);

    // As in SSMS: with text selected, Execute runs the selection alone; with nothing selected,
    // the whole editor. Only whether there IS a selection is state, for the button's label; the
    // text itself is read when Execute is pressed.
    const selection = useRef("");
    const [hasSelection, setHasSelection] = useState(false);
    const onSelection = useCallback((selected: string) => {
        selection.current = selected;
        setHasSelection(selected.trim() !== "");
    }, []);
    const runnable = () => (selection.current.trim() !== "" ? selection.current : textRef.current);

    // Cmd/Ctrl+R hides the results and gives the editor the whole height, as in SSMS. Per pane and
    // not remembered: it is a moment's room to write, not a way of working.
    const [resultsHidden, setResultsHidden] = useState(false);
    const toggleResults = useCallback(() => setResultsHidden((hidden) => !hidden), []);
    // A query is run to see what it returns, so running one brings the results back.
    const execute = (sql: string) => {
        setResultsHidden(false);
        onExecute(sql);
    };
    const executeRef = useRef(execute);
    executeRef.current = execute;

    // The shortcuts are the ones a SQL Server user already has in their fingers. F5 has to be
    // taken off the browser, which would otherwise reload the page and lose the result entirely.
    //
    // Alt+X is matched on e.code, not e.key. On a Mac, Option+X does not produce "x" — it produces
    // "≈", because Option is the layout's alt-graph key. Reading e.key looked right in a synthetic
    // test and did nothing at all under a real keyboard.
    useEffect(() => {
        // Every open tab keeps its pane mounted. Only the one in front may take the keys.
        if (!active) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            const execute = e.key === "F5" || (e.altKey && e.code === "KeyX");
            if (execute) {
                e.preventDefault();
                executeRef.current(runnable());
                return;
            }
            // Cmd+R would otherwise reload the page and lose the result.
            if (isModKey(e, "r")) {
                e.preventDefault();
                toggleResults();
                return;
            }
            if (e.key === "Escape" && running) {
                e.preventDefault();
                onCancel();
            }
        };
        // Capture phase, so the editor does not get the keys first.
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onCancel, running, active, toggleResults]);

    const [shared, setShared] = useState<ShareState>({ kind: "idle" });
    // A link made from an older version of the text would be a quiet lie, so editing clears it.
    useEffect(() => setShared({ kind: "idle" }), [text]);

    const copyLink = async () => {
        if (!onShare) {
            return;
        }
        setShared({ kind: "saving" });
        try {
            const url = await onShare(textRef.current);
            try {
                await navigator.clipboard.writeText(url);
            } catch {
                // Clipboard access can be refused; the link is on screen either way, which is
                // what makes that survivable rather than a dead end.
            }
            setShared({ kind: "done", url });
        } catch (err) {
            setShared({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
        }
    };

    return (
        <div className="workbench" ref={frame} style={height ? { height } : undefined}>
            <div className="qtoolbar">
                <button
                    type="button"
                    className="tool run"
                    onClick={() => execute(runnable())}
                    title={hasSelection ? "Execute the selected text only (Alt+X, F5)" : "Execute (Alt+X, F5)"}
                >
                    <Icon name="play" size={14} />
                    {hasSelection ? "Execute selection" : "Execute"}
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
                {onShare && (
                    <>
                        <span className="tool-sep" />
                        <button
                            type="button"
                            className="tool"
                            onClick={copyLink}
                            disabled={shared.kind === "saving" || text.trim() === ""}
                            title="Save this query and copy a link to it"
                        >
                            <Icon name="link" size={14} />
                            Share
                        </button>
                    </>
                )}
                {running && (
                    <>
                        <span className="tool-sep" />
                        <span className="tool-hint">running…</span>
                    </>
                )}
            </div>

            {shared.kind === "done" && (
                <div className="sharebar">
                    <span className="muted">Link copied — it opens the query without running it.</span>
                    <input className="mono" readOnly value={shared.url} onFocus={(e) => e.currentTarget.select()} />
                </div>
            )}
            {shared.kind === "failed" && <div className="error">{shared.message}</div>}
            <div
                className={resultsHidden ? "pane editor-pane full" : "pane editor-pane"}
                ref={editorPane}
                style={resultsHidden ? undefined : { height: `${share}%` }}
            >
                <Suspense fallback={<div className="editor-placeholder" />}>
                    <SqlEditor
                        value={text}
                        readOnly={false}
                        onChange={onEdit}
                        onExecute={() => executeRef.current(runnable())}
                        onSelection={onSelection}
                        // Only in the tab in front: tabs brought back after a reload all open at
                        // once, and the keyboard belongs to the one you see.
                        autoFocus={autoFocus && active}
                    />
                </Suspense>
            </div>
            {resultsHidden ? (
                <div className="results-hidden">
                    <button type="button" className="tool" onClick={toggleResults} title={`Show the results (${MOD}R)`}>
                        <Icon name="panel-bottom-open" label="" aria-hidden />
                        Show results
                    </button>
                </div>
            ) : (
                <>
                    <div
                        className="splitter"
                        onMouseDown={startDrag}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize query and results"
                    />
                    <div className="pane result-pane">
                        <ResultsToggle.Provider value={toggleResults}>{result}</ResultsToggle.Provider>
                    </div>
                </>
            )}
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
