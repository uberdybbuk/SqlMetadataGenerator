import { useMemo } from "react";
// "monaco-editor" ana girişi HER dili ve dil servisini paketliyor — TypeScript
// worker'ı tek başına ~7 MB. Bize yalnızca editör çekirdeği ve SQL renklendirmesi
// lazım, o yüzden editor.api girişini kullanıp tek dil katkısını elle ekliyoruz.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/sql/register";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import Editor, { loader } from "@monaco-editor/react";

import { useDarkMode } from "./theme";

// Monaco varsayılan olarak kendini bir CDN'den yükler. Bu yerel bir araç ve
// internet olmadan da çalışmalı, o yüzden paketten gelen kopyayı veriyoruz.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

interface SqlEditorProps {
    value: string;
    // Şimdilik salt-okunur: burada gösterilen, önizlemeyi üreten sorgunun kendisi.
    // Serbest sorgu çalıştırma ayrı bir karar (ve ayrı bir güvenlik yüzeyi).
    readOnly?: boolean;
}

export default function SqlEditor({ value, readOnly = true }: SqlEditorProps) {
    const dark = useDarkMode();

    // Yükseklik içeriğe göre; tek satırlık sorgu için 300px'lik boşluk açmayalım.
    const height = useMemo(() => {
        const lines = value.split("\n").length;
        return Math.min(Math.max(lines, 3), 14) * 19 + 16;
    }, [value]);

    return (
        <Editor
            height={height}
            language="sql"
            value={value}
            theme={dark ? "vs-dark" : "vs"}
            options={{
                readOnly,
                domReadOnly: readOnly,
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
            }}
        />
    );
}
