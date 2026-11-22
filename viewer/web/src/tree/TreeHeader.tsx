import { Link } from "react-router-dom";

import { APP_NAME, HOME, SETTINGS_ROUTE } from "../appInfo";
import { Icon } from "../Icon";
import { openShortcuts } from "../shortcuts";

// Above the tree: the way home and to the settings. With no global bar over the page, this is
// where they live, with the list of keyboard shortcuts. Compact under a collapsed tree, which has
// room for the icons only.
export function TreeHeader({ compact = false }: { compact?: boolean }) {
    return (
        <div className={compact ? "otree-app compact" : "otree-app"}>
            <Link to="/app" className="otree-app-home" title={APP_NAME}>
                {compact ? HOME : `${HOME} ${APP_NAME}`}
            </Link>
            <span className="otree-app-tools">
                <button type="button" className="otree-app-settings" title="Keyboard shortcuts (?)" onClick={openShortcuts}>
                    <Icon name="keyboard" size={15} />
                </button>
                <Link to={SETTINGS_ROUTE} className="otree-app-settings" title="Settings">
                    <Icon name="settings" size={15} />
                </Link>
            </span>
        </div>
    );
}
