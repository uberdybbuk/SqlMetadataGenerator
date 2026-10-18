import { useParams, useSearchParams } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { useQueryRunner } from "../useQueryRunner";
import { QueryPane } from "../QueryPane";
import { ResultGrid, type ResultColumn } from "../ResultGrid";
import { shareLinkFor } from "../share";

// A query on its own, not hanging off a table.
//
// This is where a shared link lands (?q=<id>), and it is also the page to open when the question
// is not about one table — which until now meant picking an unrelated table just to reach an
// editor.
export function QueryPage() {
    const { alias = "", db = "" } = useParams();
    const [params] = useSearchParams();
    const sharedId = params.get("q");

    // Only fetched when the URL names one. A share that has been deleted reports the server's
    // own message rather than opening an empty editor as though nothing was asked for.
    const shared = useApi(() => api.sharedQuery(sharedId ?? ""), [sharedId], sharedId !== null);
    const runner = useQueryRunner(alias, db);

    const columns: ResultColumn[] = (runner.data?.columns ?? []).map((column) => ({
        name: column.name,
        typeName: column.typeName,
        truncated: false,
    }));

    const result = runner.error ? (
        <div className="error">{runner.error}</div>
    ) : runner.loading ? (
        <div className="result">
            <div className="state">Running query…</div>
        </div>
    ) : runner.data ? (
        <ResultGrid
            columns={columns}
            rows={runner.data.rows}
            elapsedMs={runner.data.elapsedMs}
            messages={runner.data.messages}
            limitNote={runner.data.capped ? "stopped at 1000 rows" : undefined}
        />
    ) : (
        <div className="result">
            <div className="state">
                {shared.loading
                    ? "Opening the shared query…"
                    : "Write a query and press Execute (Alt+X, F5)."}
            </div>
        </div>
    );

    return (
        <>
            <h1>Query</h1>
            <p className="subtitle">
                <span className="mono">{db}</span> on <span className="mono">{alias}</span>
                {shared.data?.title && <> · {shared.data.title}</>}
            </p>

            {shared.error && <div className="error">{shared.error}</div>}

            <QueryPane
                sql={shared.data?.sql ?? ""}
                result={result}
                onExecute={(text) => runner.run(text)}
                onCancel={() => runner.cancel()}
                running={runner.loading}
                onShare={shareLinkFor(alias, db)}
            />
        </>
    );
}
