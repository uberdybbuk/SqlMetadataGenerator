import { useEffect, useState } from "react";

export interface AsyncState<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
}

// A simple data-fetching hook. The result is ignored when the component has unmounted, or when
// the dependencies changed and a newer request has started — so a stale answer arriving late
// never overwrites fresh data.
// While enabled is false NO request is sent at all. For queries that should not run until their
// tab is opened (the column list, say), so they cannot slow the main query down.
export function useApi<T>(
    fetcher: () => Promise<T>,
    deps: unknown[],
    enabled = true,
): AsyncState<T> {
    const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: enabled });

    useEffect(() => {
        if (!enabled) {
            return;
        }
        let cancelled = false;
        setState({ data: null, error: null, loading: true });
        fetcher()
            .then((data) => {
                if (!cancelled) {
                    setState({ data, error: null, loading: false });
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    const message = err instanceof Error ? err.message : String(err);
                    setState({ data: null, error: message, loading: false });
                }
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, enabled]);

    return state;
}
