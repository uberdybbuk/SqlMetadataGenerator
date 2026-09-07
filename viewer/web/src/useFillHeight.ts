import { useLayoutEffect, useRef, useState } from "react";

// A pane that reaches the bottom of the window, whatever sits above it.
//
// The height is MEASURED rather than assumed: the header above it differs per page and wraps on a
// narrow window, so any constant here would be wrong on some page at some width. Extracted from
// the query workbench because the scripting panel needs exactly the same behaviour, and a second
// copy of a measurement this fiddly is a second place for it to go stale.
export function useFillHeight(minimum = 320) {
    const frame = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState<number | null>(null);

    useLayoutEffect(() => {
        const measure = () => {
            const el = frame.current;
            if (!el) {
                return;
            }
            const top = el.getBoundingClientRect().top + window.scrollY;
            // 24 is the shell's bottom padding: leaving it out would make the page scroll by exactly
            // that much, which is the empty strip this layout exists to remove.
            setHeight(Math.max(minimum, window.innerHeight - top - 24));
        };
        measure();
        window.addEventListener("resize", measure);
        const observer = new ResizeObserver(measure);
        if (document.body) {
            observer.observe(document.body);
        }
        return () => {
            window.removeEventListener("resize", measure);
            observer.disconnect();
        };
    }, [minimum]);

    return { frame, height };
}
