import { useCallback, useEffect, useRef, useState } from "react";

import { api, type QueryResult } from "./api";

export interface QueryRunner {
    data: QueryResult | null;
    error: string | null;
    loading: boolean;
    // True once a query has been run here, which is what decides whether the grid shows the
    // preview it loaded with or the answer to what the user actually asked.
    ran: boolean;
    run: (sql: string) => void;
    cancel: () => void;
}

// Running a query is an action, not a subscription: it happens when someone asks, and asking again
// with the same text must run it again. That is the opposite of useApi, which fetches from
// dependencies and would treat an unchanged query as nothing to do.
export function useQueryRunner(alias: string, db: string): QueryRunner {
    const [state, setState] = useState<{ data: QueryResult | null; error: string | null; loading: boolean; ran: boolean }>({
        data: null,
        error: null,
        loading: false,
        ran: false,
    });
    const controller = useRef<AbortController | null>(null);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            controller.current?.abort();
        };
    }, []);

    // Leaving the table drops the previous answer: it belonged to the query that was on screen
    // then, and showing it under a different table's editor would be a lie.
    useEffect(() => {
        controller.current?.abort();
        setState({ data: null, error: null, loading: false, ran: false });
    }, [alias, db]);

    const run = useCallback(
        (sql: string) => {
            controller.current?.abort();
            const abort = new AbortController();
            controller.current = abort;
            setState({ data: null, error: null, loading: true, ran: true });
            api.query(alias, db, sql, abort.signal)
                .then((data) => {
                    if (alive.current && !abort.signal.aborted) {
                        setState({ data, error: null, loading: false, ran: true });
                    }
                })
                .catch((err: unknown) => {
                    if (!alive.current || abort.signal.aborted) {
                        return;
                    }
                    // An abort is the user's own doing; it is not an error to report back.
                    if (err instanceof DOMException && err.name === "AbortError") {
                        setState({ data: null, error: null, loading: false, ran: true });
                        return;
                    }
                    const message = err instanceof Error ? err.message : String(err);
                    setState({ data: null, error: message, loading: false, ran: true });
                });
        },
        [alias, db],
    );

    const cancel = useCallback(() => controller.current?.abort(), []);

    return { ...state, run, cancel };
}
