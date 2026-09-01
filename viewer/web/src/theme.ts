import { useEffect, useState } from "react";

export function useDarkMode(): boolean {
    const [dark, setDark] = useState(
        () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    );

    useEffect(() => {
        const query = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = (e: MediaQueryListEvent) => setDark(e.matches);
        query.addEventListener("change", handler);
        return () => query.removeEventListener("change", handler);
    }, []);

    return dark;
}

// Tek hue (mavi), açıktan koyuya sequential rampa — büyüklük kodlaması için.
// Renk ŞEMA KİMLİĞİNİ taşımıyor: şema sayısı kategorik palet slotlarını (8) aşıyor
// ve renk döngüsü yasak. Kimliği treemap'in hiyerarşik gruplaması taşır; renk
// ikinci bir büyüklüğü (satır sayısı) kodlar.
//
// Rampa uçları her modda metnin okunabileceği yarıda tutuldu: açık modda açık
// tonlar + koyu metin, koyu modda koyu tonlar + açık metin. Böylece kutu üstündeki
// etiket her zaman okunur.
const RAMP_LIGHT = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7"];
const RAMP_DARK = ["#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5"];

export function rampFor(dark: boolean): string[] {
    return dark ? RAMP_DARK : RAMP_LIGHT;
}

export function labelColorFor(dark: boolean): string {
    return dark ? "#ffffff" : "#0b0b0b";
}

// t = 0..1 -> rampadaki renk (adımlar arası doğrusal karışım).
export function sampleRamp(ramp: string[], t: number): string {
    const clamped = Math.max(0, Math.min(1, t));
    const scaled = clamped * (ramp.length - 1);
    const index = Math.floor(scaled);
    if (index >= ramp.length - 1) {
        return ramp[ramp.length - 1];
    }
    return mix(ramp[index], ramp[index + 1], scaled - index);
}

function mix(a: string, b: string, t: number): string {
    const pa = parseHex(a);
    const pb = parseHex(b);
    const channel = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function parseHex(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
