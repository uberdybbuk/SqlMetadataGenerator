import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
    // Runs the request again with the same arguments.
    reload: () => void;
    // Aborts the request in flight. Nothing happens when none is running.
    cancel: () => void;
}

// A simple data-fetching hook. The result is ignored when the component has unmounted, or when
// the dependencies changed and a newer request has started — so a stale answer arriving late
// never overwrites fresh data.
// While enabled is false NO request is sent at all. For queries that should not run until their
// tab is opened (the column list, say), so they cannot slow the main query down.
//
// The fetcher is handed an AbortSignal. Passing it to fetch is what makes Cancel mean the request
// actually stops rather than its answer being quietly dropped: a cancelled query that keeps
// running still holds a connection and still costs the server the work.
export function useApi<T>(
    fetcher: (signal: AbortSignal) => Promise<T>,
    deps: unknown[],
    enabled = true,
): AsyncState<T> {
    const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
        data: null,
        error: null,
        loading: enabled,
    });
    const [nonce, setNonce] = useState(0);
    const controller = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!enabled) {
            return;
        }
        const abort = new AbortController();
        controller.current = abort;
        let cancelled = false;
        setState({ data: null, error: null, loading: true });
        fetcher(abort.signal)
            .then((data) => {
                if (!cancelled) {
                    setState({ data, error: null, loading: false });
                }
            })
            .catch((err: unknown) => {
                if (cancelled) {
                    return;
                }
                // An abort is not a failure: the user asked for it and already knows.
                if (err instanceof DOMException && err.name === "AbortError") {
                    setState({ data: null, error: null, loading: false });
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                setState({ data: null, error: message, loading: false });
            });
        return () => {
            cancelled = true;
            abort.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, enabled, nonce]);

    const reload = useCallback(() => setNonce((n) => n + 1), []);
    const cancel = useCallback(() => controller.current?.abort(), []);

    return { ...state, reload, cancel };
}
