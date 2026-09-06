import { Suspense, lazy } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { Icon, type IconName } from "../Icon";

const SqlEditor = lazy(() => import("../SqlEditor"));

const ICONS: Record<string, IconName> = {
    views: "view",
    procedures: "procedure",
    functions: "function",
    triggers: "trigger",
    synonyms: "synonym",
    sequences: "sequence",
    types: "type",
};

// SQL_STORED_PROCEDURE -> stored procedure.
function readableType(typeDesc: string): string {
    return typeDesc.replace(/^SQL_/, "").replace(/_/g, " ").toLowerCase();
}

export function ObjectDetailPage() {
    const { alias = "", db = "", section = "", schema = "", name = "" } = useParams();
    const detail = useApi(
        () => api.objectDetail(alias, db, section, schema, name),
        [alias, db, section, schema, name],
    );

    // The frame is drawn before the request answers, so the editor does not arrive by pushing the
    // page around. Its height is fixed for the same reason the preview editor's is.
    return (
        <>
            <h1 className="mono with-icon">
                <Icon name={ICONS[section] ?? "table"} size={22} />
                {schema}.{name}
            </h1>
            <p className="subtitle">
                <span className="mono">{db}</span> database · <span className="mono">{alias}</span> server
                {detail.data && <> · {readableType(detail.data.typeDesc)}</>}
            </p>

            {detail.data && (
                <div className="badges">
                    {detail.data.generated ? (
                        <span className="badge" title="The catalog stores this object as parts, not as a statement. This is the script the generator would write.">
                            composed by the generator
                        </span>
                    ) : (
                        <span className="badge" title="Returned by sys.sql_modules — the text the server itself stores.">
                            definition from the server
                        </span>
                    )}
                    {!detail.data.generated && (
                        // Seconds are enough on a badge; the sub-second digits sys.objects keeps
                        // are noise next to "when was this last changed".
                        <span className="badge">
                            modified {detail.data.modifyDate.slice(0, 19).replace("T", " ")}
                        </span>
                    )}
                </div>
            )}

            {detail.error && <div className="error">{detail.error}</div>}

            <div className="editor-wrap tall">
                <Suspense fallback={<div className="editor-placeholder" />}>
                    <SqlEditor value={detail.data?.definition ?? ""} />
                </Suspense>
            </div>
        </>
    );
}
