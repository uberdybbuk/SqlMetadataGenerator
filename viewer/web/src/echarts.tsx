// ECharts'ın tamamı ~1.4 MB bundle üretiyordu. Yalnızca kullandığımız parçaları
// kaydedip ağaç budamasına izin veriyoruz.
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

// echarts-for-react/lib/core CommonJS. Bileşene ulaşmak için gereken "default"
// katmanı sayısı ortama göre değişiyor (Vite dev, Rolldown build, Node), bu yüzden
// sabit bir sarmalama yerine fonksiyona ulaşana kadar açıyoruz. Aksi hâlde React'e
// bileşen yerine nesne geçiyor ve sayfa "Element type is invalid" ile hiç açılmıyor.
function unwrapComponent(module: unknown): ComponentType<CoreProps> {
    let candidate = module;
    while (candidate && typeof candidate === "object" && "default" in candidate) {
        candidate = (candidate as { default: unknown }).default;
    }
    if (typeof candidate !== "function") {
        throw new Error("echarts-for-react/lib/core bileşeni çözümlenemedi.");
    }
    return candidate as ComponentType<CoreProps>;
}

const EChartsCore = unwrapComponent(core);

export function Chart(props: Omit<CoreProps, "echarts">) {
    return <EChartsCore echarts={echarts} {...props} />;
}
