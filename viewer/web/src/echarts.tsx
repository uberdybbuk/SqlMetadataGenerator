// All of ECharts produced a ~1.4 MB bundle. Only the pieces we use are registered, which lets
// tree shaking do its work.
import type { CSSProperties, ComponentType } from "react";
import * as echarts from "echarts/core";
import { TreemapChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import * as core from "echarts-for-react/lib/core";

echarts.use([TreemapChart, TooltipComponent, CanvasRenderer]);

interface CoreProps {
    echarts: unknown;
    option: unknown;
    style?: CSSProperties;
    opts?: { renderer?: "canvas" | "svg" };
    onEvents?: Record<string, (params: never) => void>;
}

// echarts-for-react/lib/core is CommonJS. How many "default" layers stand between us and the
// component varies by environment (Vite dev, Rolldown build, Node), so instead of unwrapping a
// fixed number of times we unwrap until we reach the function. Otherwise React is handed an
// object instead of a component and the page never opens, failing with "Element type is invalid".
function unwrapComponent(module: unknown): ComponentType<CoreProps> {
    let candidate = module;
    while (candidate && typeof candidate === "object" && "default" in candidate) {
        candidate = (candidate as { default: unknown }).default;
    }
    if (typeof candidate !== "function") {
        throw new Error("Could not resolve the echarts-for-react/lib/core component.");
    }
    return candidate as ComponentType<CoreProps>;
}

const EChartsCore = unwrapComponent(core);

export function Chart(props: Omit<CoreProps, "echarts">) {
    return <EChartsCore echarts={echarts} {...props} />;
}
