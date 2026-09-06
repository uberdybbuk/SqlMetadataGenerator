import { useEffect, useLayoutEffect, useRef } from "react";

// The "monaco-editor" main entry bundles EVERY language and language service — the TypeScript
// worker alone is ~7 MB. All we need is the editor core and SQL highlighting, so we use the
// editor.api entry and add the single language contribution by hand.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/sql/register";
import editorWorker from "monaco-editor/editor/editor.worker?worker";

import { useDarkMode } from "./theme";

// By default Monaco loads itself from a CDN. This is a local tool and has to work without
// internet access, so we hand it the copy that comes from the bundle.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };

const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
    language: "sql",
    readOnly: true,
    domReadOnly: true,
    minimap: { enabled: false },
    lineNumbers: "off",
    folding: false,
    scrollBeyondLastLine: false,
    renderLineHighlight: "none",
    overviewRulerLanes: 0,
    scrollbar: { vertical: "auto", horizontalScrollbarSize: 8, verticalScrollbarSize: 8 },
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    padding: { top: 8, bottom: 8 },
    wordWrap: "on",
    contextmenu: false,
    automaticLayout: true,
};

// The application is a single page; there is no point rebuilding the editor on every open.
// One instance is created once and, while it is unused, waits off-screen in a "parking spot",
// moving into the relevant slot when it is needed. That way Monaco's expensive first setup
// (theme, font measurement, tokenizer) happens once for the lifetime of the application.
interface Instance {
    host: HTMLDivElement;
    editor: monaco.editor.IStandaloneCodeEditor;
    shared: boolean;
}

let shared: Instance | null = null;
let sharedBusy = false;
let parking: HTMLDivElement | null = null;

function parkingLot(): HTMLDivElement {
    if (!parking) {
        parking = document.createElement("div");
        parking.setAttribute("aria-hidden", "true");
        parking.style.cssText = "position:absolute;left:-10000px;top:0;width:800px;height:200px;";
        document.body.appendChild(parking);
    }
    return parking;
}

function build(isShared: boolean): Instance {
    const host = document.createElement("div");
    host.style.cssText = "width:100%;height:100%;";
    parkingLot().appendChild(host);
    return { host, editor: monaco.editor.create(host, { ...OPTIONS, value: "" }), shared: isShared };
}

// Called at application start: the expensive setup happens while idle, not while the user is
// waiting. The instance is not discarded; it waits in the parking spot for its first use.
export function warmUp(): void {
    if (!shared) {
        shared = build(true);
    }
}

// If a second editor is ever needed at the same time (a query plus a WHERE field, later on) the
// shared instance is busy; a separate instance is created then and disposed of on release.
function acquire(): Instance {
    if (!sharedBusy) {
        warmUp();
        sharedBusy = true;
        return shared!;
    }
    return build(false);
}

function release(instance: Instance): void {
    if (instance.shared) {
        sharedBusy = false;
        parkingLot().appendChild(instance.host);
        return;
    }
    instance.editor.dispose();
    instance.host.remove();
}

interface SqlEditorProps {
    value: string;
    // Read-only is the default: most places here show SQL rather than invite it.
    readOnly?: boolean;
    onChange?: (value: string) => void;
}

export default function SqlEditor({ value, readOnly = true, onChange }: SqlEditorProps) {
    const slot = useRef<HTMLDivElement>(null);
    const instance = useRef<Instance | null>(null);
    const dark = useDarkMode();
    // Held in a ref so the change listener is attached once and still calls the current handler.
    const changed = useRef(onChange);
    changed.current = onChange;
    // setValue fires the same event a keystroke does; without this the editor would report our
    // own writes back as if the user had typed them.
    const writing = useRef(false);

    useLayoutEffect(() => {
        const acquired = acquire();
        instance.current = acquired;
        slot.current?.appendChild(acquired.host);
        acquired.editor.updateOptions({ readOnly, domReadOnly: readOnly });
        acquired.editor.layout();
        const subscription = acquired.editor.onDidChangeModelContent(() => {
            if (!writing.current) {
                changed.current?.(acquired.editor.getValue());
            }
        });
        return () => {
            subscription.dispose();
            instance.current = null;
            release(acquired);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const editor = instance.current?.editor;
        if (!editor || editor.getValue() === value) {
            return;
        }
        // setValue also resets the undo stack; the scroll position is sent back to the top so
        // the previous table's position does not carry into the new query.
        writing.current = true;
        editor.setValue(value);
        editor.setScrollTop(0);
        writing.current = false;
    }, [value]);

    useEffect(() => {
        instance.current?.editor.updateOptions({ readOnly, domReadOnly: readOnly });
    }, [readOnly]);

    useEffect(() => {
        monaco.editor.setTheme(dark ? "vs-dark" : "vs");
    }, [dark]);

    // The height is fixed by .editor-wrap and never follows the query. Sizing to the text meant
    // every table opened at three lines and then jumped to its real height once the preview
    // landed, pushing the grid down the page — which read as slowness, not as loading.
    return <div ref={slot} className="editor-slot" />;
}
