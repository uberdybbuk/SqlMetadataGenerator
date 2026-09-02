import { useEffect, useState } from "react";

export interface AsyncState<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
}

// Basit veri çekme kancası. İstek sonucu, bileşen sökülmüşse veya bağımlılıklar
// değişip yeni bir istek başlamışsa yok sayılır — böylece geç gelen eski cevap
// yeni veriyi ezmez.
// enabled false iken istek HİÇ gönderilmez. Sekmesine basılmadan çalışmaması
// gereken sorgular (ör. kolon listesi) ana sorgunun hızını etkilemesin diye.
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
