import { useLayoutEffect, useState } from "react";

import { useTabActive } from "./tabs/TabStore";

// A pane that reaches the bottom of the window, whatever sits above it.
//
// The height is MEASURED rather than assumed: the header above it differs per page and wraps on a
// narrow window, so any constant here would be wrong on some page at some width. Extracted from
// the query workbench because the scripting panel needs exactly the same behaviour, and a second
// copy of a measurement this fiddly is a second place for it to go stale.
//
// The element is held through a callback ref, not a ref object, so measuring starts when the
// element appears rather than when the component mounts. A panel that first returns a "Reading…"
// line mounts with nothing to measure. Its frame arrives later, and the body around it may not
// change size (the object tree already holds it at the window's height), so nothing else would
// trigger a measurement: the frame kept no height and its panes collapsed to nothing.
export function useFillHeight(minimum = 320) {
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const [height, setHeight] = useState<number | null>(null);
    // A hidden tab has nothing to measure: everything in it is at zero. It is measured again when
    // it comes to the front, since the window may have been resized in the meantime.
    const active = useTabActive();

    useLayoutEffect(() => {
        if (!element || !active) {
            return;
        }
        const measure = () => {
            const top = element.getBoundingClientRect().top + window.scrollY;
            // The tab frame's bottom padding is read, not assumed: it is 12px on most pages and 0
            // around the query workbench. Leaving it out would make the page scroll by exactly that
            // much, which is the empty strip this layout exists to remove.
            const frame = element.closest(".tab-frame");
            const below = frame ? parseFloat(getComputedStyle(frame).paddingBottom) || 0 : 0;
            setHeight(Math.max(minimum, window.innerHeight - top - below));
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
    }, [element, minimum, active]);

    return { frame: setElement, element, height };
}
