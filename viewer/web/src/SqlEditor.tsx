import { useEffect, useLayoutEffect, useRef } from "react";

// "monaco-editor" ana girişi HER dili ve dil servisini paketliyor — TypeScript
// worker'ı tek başına ~7 MB. Bize yalnızca editör çekirdeği ve SQL renklendirmesi
// lazım, o yüzden editor.api girişini kullanıp tek dil katkısını elle ekliyoruz.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/sql/register";
import editorWorker from "monaco-editor/editor/editor.worker?worker";

import { useDarkMode } from "./theme";

// Monaco varsayılan olarak kendini bir CDN'den yükler. Bu yerel bir araç ve
// internet olmadan da çalışmalı, o yüzden paketten gelen kopyayı veriyoruz.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };

const LINE_HEIGHT = 19;

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

// Uygulama tek sayfa; editörü her açılışta yeniden kurmanın anlamı yok.
// Bir örnek bir kez kurulur, kullanılmadığı sürece ekran dışında bir "park
// yerinde" bekler, gerektiğinde ilgili slota taşınır. Böylece Monaco'nun pahalı
// ilk kurulumu (tema, font ölçümü, tokenizer) uygulama ömrü boyunca bir kez olur.
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

// Uygulama açılışında çağrılır: pahalı kurulum kullanıcı beklerken değil,
// boşta yapılır. Örnek atılmaz, park yerinde ilk kullanımı bekler.
export function warmUp(): void {
    if (!shared) {
        shared = build(true);
    }
}

// Aynı anda ikinci bir editör gerekirse (ileride sorgu + WHERE alanı) paylaşılan
// örnek meşguldür; o durumda ayrı bir örnek kurulur ve bırakılırken yok edilir.
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
}

export default function SqlEditor({ value }: SqlEditorProps) {
    const slot = useRef<HTMLDivElement>(null);
    const instance = useRef<Instance | null>(null);
    const dark = useDarkMode();

    useLayoutEffect(() => {
        const acquired = acquire();
        instance.current = acquired;
        slot.current?.appendChild(acquired.host);
        acquired.editor.layout();
        return () => {
            instance.current = null;
            release(acquired);
        };
    }, []);

    useEffect(() => {
        const editor = instance.current?.editor;
        if (!editor) {
            return;
        }
        // setValue geri alma yığınını da sıfırlar; önceki tablonun kaydırma
        // konumu yeni sorguda kalmasın diye başa alınır.
        editor.setValue(value);
        editor.setScrollTop(0);
    }, [value]);

    useEffect(() => {
        monaco.editor.setTheme(dark ? "vs-dark" : "vs");
    }, [dark]);

    const lines = Math.min(Math.max(value.split("\n").length, 3), 14);
    return <div ref={slot} style={{ height: lines * LINE_HEIGHT + 16 }} />;
}
