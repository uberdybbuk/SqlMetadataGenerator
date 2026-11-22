import { useCallback, useEffect, useRef, useState } from "react";

import { api, type QueryResult } from "./api";
import { useCurrentTab } from "./tabs/TabStore";

export interface QueryRunner {
    data: QueryResult | null;
    error: string | null;
    loading: boolean;
    // True once a query has been run here, which is what decides whether the grid shows the
    // preview it loaded with or the answer to what the user actually asked.
    ran: boolean;
    // How long the last query had been running when the user cancelled it; null otherwise.
    cancelledAfterMs: number | null;
    run: (sql: string) => void;
    cancel: () => void;
}

type RunnerState = Omit<QueryRunner, "run" | "cancel">;

const IDLE: RunnerState = { data: null, error: null, loading: false, ran: false, cancelledAfterMs: null };

// Running a query is an action, not a subscription: it happens when someone asks, and asking again
// with the same text must run it again. That is the opposite of useApi, which fetches from
// dependencies and would treat an unchanged query as nothing to do.
export function useQueryRunner(alias: string, db: string): QueryRunner {
    const [state, setState] = useState<RunnerState>(IDLE);
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
    // then, and showing it under a different table's editor would be a lie. The controller is let
    // go first, so the aborted request does not come back reporting a cancel nobody asked for.
    useEffect(() => {
        const previous = controller.current;
        controller.current = null;
        previous?.abort();
        setState(IDLE);
    }, [alias, db]);

    const run = useCallback(
        (sql: string) => {
            const previous = controller.current;
            const abort = new AbortController();
            controller.current = abort;
            previous?.abort();
            const started = performance.now();
            setState({ data: null, error: null, loading: true, ran: true, cancelledAfterMs: null });
            api.query(alias, db, sql, abort.signal)
                .then((data) => {
                    if (alive.current && controller.current === abort) {
                        setState({ data, error: null, loading: false, ran: true, cancelledAfterMs: null });
                    }
                })
                .catch((err: unknown) => {
                    // Unmounted, or replaced by a newer run (or a move to another database) that
                    // already owns the state: nothing here is for the screen any more.
                    if (!alive.current || controller.current !== abort) {
                        return;
                    }
                    // Still the current request and aborted: the user pressed Cancel. Not an error
                    // to report, but the screen has to leave "Running" behind. Returning early on
                    // every abort, as this did, left the query running on screen for ever after
                    // the server had already stopped it.
                    if (abort.signal.aborted) {
                        setState({
                            data: null,
                            error: null,
                            loading: false,
                            ran: true,
                            cancelledAfterMs: Math.round(performance.now() - started),
                        });
                        return;
                    }
                    const message = err instanceof Error ? err.message : String(err);
                    setState({ data: null, error: message, loading: false, ran: true, cancelledAfterMs: null });
                });
        },
        [alias, db],
    );

    const cancel = useCallback(() => controller.current?.abort(), []);

    // The tab shows that something is running in it, which matters most when it is not the one
    // in front. Leaving the tab (closing it unmounts this) aborts the query above.
    const tab = useCurrentTab();
    const setBusy = tab?.setBusy;
    useEffect(() => {
        if (!setBusy) {
            return;
        }
        setBusy(state.loading);
        return () => setBusy(false);
    }, [setBusy, state.loading]);

    return { ...state, run, cancel };
}
