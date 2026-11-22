import { useEffect, useRef } from "react";

import { Icon } from "./Icon";
import { isTyping, OPEN_SHORTCUTS_EVENT, SHORTCUTS } from "./shortcuts";

// The list of keyboard shortcuts, opened with "?" as in Gmail or GitHub, or from the keyboard
// button above the tree. A native dialog: Esc closes it and focus stays inside while it is open.
export function ShortcutHelp() {
    const dialog = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const open = () => {
            if (!dialog.current?.open) {
                dialog.current?.showModal();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
                e.preventDefault();
                if (dialog.current?.open) {
                    dialog.current.close();
                } else {
                    open();
                }
            }
        };
        document.addEventListener("keydown", onKey);
        window.addEventListener(OPEN_SHORTCUTS_EVENT, open);
        return () => {
            document.removeEventListener("keydown", onKey);
            window.removeEventListener(OPEN_SHORTCUTS_EVENT, open);
        };
    }, []);

    return (
        <dialog
            className="shortcuts"
            ref={dialog}
            aria-label="Keyboard shortcuts"
            onClick={(e) => {
                // A click on the backdrop lands on the dialog element itself.
                if (e.target === e.currentTarget) {
                    e.currentTarget.close();
                }
            }}
        >
            <div className="shortcuts-body">
                <div className="shortcuts-head">
                    <b>Keyboard shortcuts</b>
                    <button type="button" className="shortcuts-close" onClick={() => dialog.current?.close()}>
                        <Icon name="x" size={14} label="close" />
                    </button>
                </div>
                {SHORTCUTS.map((group) => (
                    <section key={group.title}>
                        <div className="plabel">{group.title}</div>
                        <table>
                            <tbody>
                                {group.items.map((item) => (
                                    <tr key={item.label}>
                                        <td className="shortcuts-keys">
                                            {item.keys.map((key, i) => (
                                                <span key={key}>
                                                    {i > 0 && <span className="muted"> or </span>}
                                                    <kbd>{key}</kbd>
                                                </span>
                                            ))}
                                        </td>
                                        <td>{item.label}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                ))}
            </div>
        </dialog>
    );
}
