import { autoUpdate, flip, hide, offset, shift, size, useFloating } from "@floating-ui/react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";

// The full text of a grid cell that does not fit. Two steps, as in Eclipse and VS Code hovers:
//
//   1. Hovering a cut-off cell opens a small popup next to it. The pointer can move into it, so
//      its text can be selected and scrolled, which a native title tooltip never allows.
//   2. Clicking the popup opens the value in a large, resizable dialog with wrap and copy.
//
// The browser's own tooltip was not enough: it waits about a second, cannot be selected, and
// cuts a long value off with its own ellipsis — a stack trace stopped after four lines.

export interface PeekInfo {
    // Column name, row number and type, for the dialog's header.
    label: string;
    row: number;
    type?: string;
    // Something the reader should know about the value, e.g. that it was truncated on the server.
    note?: string;
    // The full value as text. Without it the cell's own text is used, which may be cut short.
    text?: string;
}

interface Peek extends PeekInfo {
    cell: HTMLElement;
    text: string;
}

const OPEN_DELAY = 250;
// Long enough to cross from the cell into the popup, or over a cell border on the way.
const CLOSE_DELAY = 200;

export function useCellPeek() {
    const [peek, setPeek] = useState<Peek | null>(null);
    const [expanded, setExpanded] = useState<Peek | null>(null);
    const openTimer = useRef<number | undefined>(undefined);
    const closeTimer = useRef<number | undefined>(undefined);
    // The popup on screen, read from event handlers without making them depend on it.
    const shown = useRef<Peek | null>(null);
    useEffect(() => {
        shown.current = peek;
    }, [peek]);

    const cancelOpen = () => window.clearTimeout(openTimer.current);
    const cancelClose = () => window.clearTimeout(closeTimer.current);

    const scheduleClose = useCallback(() => {
        cancelClose();
        closeTimer.current = window.setTimeout(() => setPeek(null), CLOSE_DELAY);
    }, []);

    // The grid calls this for every cell the pointer enters. A cell that fits closes the popup;
    // one that overflows opens it — at once when a popup is already showing, so running the
    // pointer down a column reads value after value without waiting for each.
    const hoverCell = useCallback(
        (cell: HTMLElement, info: PeekInfo | null) => {
            cancelOpen();
            const shownText = cell.textContent ?? "";
            const text = info?.text ?? shownText;
            // Worth opening when the cell cuts the value off: by width, by the grid's own cap on
            // long text, or by line breaks — the grid shows a value on one line and the breaks
            // are part of what it says.
            const worth =
                info !== null &&
                (cell.scrollWidth > cell.clientWidth || text.length > shownText.length || text.includes("\n"));
            if (!worth) {
                scheduleClose();
                return;
            }
            cancelClose();
            const next = { ...info, cell, text };
            if (!shown.current) {
                openTimer.current = window.setTimeout(() => setPeek(next), OPEN_DELAY);
            } else if (shown.current.cell !== cell) {
                setPeek(next);
            }
        },
        [scheduleClose],
    );

    const leaveGrid = useCallback(() => {
        cancelOpen();
        scheduleClose();
    }, [scheduleClose]);

    // New rows replace the cells; a popup must not point at one that is gone.
    const reset = useCallback(() => {
        cancelOpen();
        cancelClose();
        setPeek(null);
    }, []);

    useEffect(() => () => {
        cancelOpen();
        cancelClose();
    }, []);

    const element = (
        <>
            {peek && (
                <PeekPopup
                    peek={peek}
                    onEnter={cancelClose}
                    onLeave={(buttons) => {
                        // Selecting text that runs past the popup's edge must not close it.
                        if (buttons === 0) {
                            scheduleClose();
                        }
                    }}
                    onExpand={() => {
                        setExpanded(peek);
                        setPeek(null);
                    }}
                />
            )}
            {expanded && <PeekDialog peek={expanded} onClose={() => setExpanded(null)} />}
        </>
    );

    return { hoverCell, leaveGrid, reset, element };
}

function PeekPopup({
    peek,
    onEnter,
    onLeave,
    onExpand,
}: {
    peek: Peek;
    onEnter: () => void;
    onLeave: (buttons: number) => void;
    onExpand: () => void;
}) {
    const { refs, floatingStyles, middlewareData } = useFloating({
        strategy: "fixed",
        placement: "bottom-start",
        elements: { reference: peek.cell },
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(2),
            flip({ padding: 8 }),
            shift({ padding: 8 }),
            size({
                padding: 8,
                apply({ availableHeight, elements }) {
                    elements.floating.style.maxHeight = `${Math.max(80, Math.min(280, availableHeight))}px`;
                },
            }),
            hide(),
        ],
    });

    return createPortal(
        <div
            ref={refs.setFloating}
            className="cell-peek"
            style={{
                ...floatingStyles,
                // The cell scrolled out of the grid: the popup has nothing left to point at.
                visibility: middlewareData.hide?.referenceHidden ? "hidden" : undefined,
            }}
            onMouseEnter={onEnter}
            onMouseLeave={(e) => onLeave(e.buttons)}
            onClick={() => {
                // The click that ends a text selection is not a request to expand.
                if (!window.getSelection()?.toString()) {
                    onExpand();
                }
            }}
        >
            <pre>{peek.text}</pre>
            <div className="cell-peek-hint">
                <span>Click to expand</span>
                <span className="grow" />
                <span>{describeSize(peek.text)}</span>
            </div>
        </div>,
        document.body,
    );
}

function PeekDialog({ peek, onClose }: { peek: Peek; onClose: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    // On by default: a long line is read without scrolling sideways. Turning it off is the choice.
    const [wrap, setWrap] = useState(true);
    const [copied, setCopied] = useState(false);
    // Whether the press that ends in a click started on the backdrop. See onClick below.
    const pressedOutside = useRef(false);

    useLayoutEffect(() => {
        const el = dialog.current;
        if (!el) {
            return;
        }
        el.showModal();
        // Opened centred by the browser (margin: auto), then pinned at that spot with an explicit
        // left/top. A centred box grows to both sides when resized, so the grip ran away from the
        // pointer at half its speed; pinned, it grows to the right and down only, under the pointer.
        const box = el.getBoundingClientRect();
        pin(el, box.left, box.top);
    }, []);

    async function copy() {
        await navigator.clipboard.writeText(peek.text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
    }

    // The header moves the dialog, so the value can sit next to the row it came from.
    function startMove(event: React.PointerEvent<HTMLElement>) {
        const el = dialog.current;
        if (!el || event.button !== 0 || (event.target as HTMLElement).closest("button")) {
            return;
        }
        event.preventDefault();
        const box = el.getBoundingClientRect();
        const dx = event.clientX - box.left;
        const dy = event.clientY - box.top;
        const header = event.currentTarget;
        header.setPointerCapture(event.pointerId);
        const onMove = (e: PointerEvent) => {
            // Some of the header always stays on screen, or there would be nothing left to grab.
            const left = clamp(e.clientX - dx, 80 - box.width, window.innerWidth - 80);
            const top = clamp(e.clientY - dy, 0, window.innerHeight - 40);
            pin(el, left, top);
        };
        const onUp = () => {
            header.removeEventListener("pointermove", onMove);
            header.removeEventListener("pointerup", onUp);
            header.removeEventListener("pointercancel", onUp);
        };
        header.addEventListener("pointermove", onMove);
        header.addEventListener("pointerup", onUp);
        header.addEventListener("pointercancel", onUp);
    }

    return createPortal(
        <dialog
            ref={dialog}
            className="cell-peek-dialog"
            aria-label={`${peek.label}, row ${peek.row}`}
            // Esc closes a native dialog by itself; this hears it and drops the state.
            onClose={onClose}
            onPointerDown={(e) => {
                pressedOutside.current = e.target === e.currentTarget && isOutside(e.currentTarget, e);
            }}
            onClick={(e) => {
                // A click on the backdrop lands on the dialog element itself. So does a press that
                // starts inside — on the header, in the text, on the resize grip — and is released
                // outside, since the click goes to the nearest element holding both ends. Only a
                // press that STARTED on the backdrop closes; anything else was a drag.
                if (pressedOutside.current && e.target === e.currentTarget && isOutside(e.currentTarget, e)) {
                    e.currentTarget.close();
                }
                pressedOutside.current = false;
            }}
        >
            <header onPointerDown={startMove}>
                <span className="name">{peek.label}</span>
                <span className="muted">
                    · row {peek.row}
                    {peek.type && ` · ${peek.type}`}
                </span>
                <span className="grow" />
                <button type="button" className="tool" aria-pressed={wrap} onClick={() => setWrap((on) => !on)}>
                    Wrap
                </button>
                <button type="button" className="tool" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                </button>
                <button type="button" className="icon-button" onClick={() => dialog.current?.close()}>
                    <Icon name="x" size={14} label="close" />
                </button>
            </header>
            {/* Focus lands here rather than on the first button, which would light up Wrap. */}
            <pre className={wrap ? "wrap" : undefined} tabIndex={0} autoFocus>
                {peek.text}
            </pre>
            <footer>
                <span>{describeSize(peek.text)}</span>
                {peek.note && <span className="warn-line">{peek.note}</span>}
                <span className="grow" />
                <span>Esc to close</span>
            </footer>
        </dialog>,
        document.body,
    );
}

function pin(el: HTMLElement, left: number, top: number) {
    el.style.margin = "0";
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
}

function isOutside(el: HTMLElement, e: { clientX: number; clientY: number }): boolean {
    const box = el.getBoundingClientRect();
    return e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function describeSize(text: string): string {
    const lines = text.split("\n").length;
    const chars = `${text.length.toLocaleString()} ${text.length === 1 ? "char" : "chars"}`;
    return lines > 1 ? `${chars} · ${lines} lines` : chars;
}
