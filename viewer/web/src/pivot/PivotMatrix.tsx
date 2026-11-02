import type { ReactNode } from "react";

import type { PivotRowField } from "../api";

import { ADDITIVE, formatLabel, formatMeasure, keyOf, type Cell, type ColumnHead, type Matrix, type RowNode } from "./matrix";

// Excel's compact layout: one label column, a group's subtotal on its own line with its members
// indented under it, the grand total at the foot. Column fields become a header band above the
// values, their subtotals after their members and the grand total on the right.

interface PivotMatrixProps {
    matrix: Matrix;
    rows: RowNode[];
    collapsed: Set<string>;
    onToggle: (key: string) => void;
}

export function PivotMatrix({ matrix, rows, collapsed, onToggle }: PivotMatrixProps) {
    const { rowFields, columnFields, measures, heads, root } = matrix;
    const c = columnFields.length;
    const m = measures.length;
    const crossTab = c > 0;

    // Without column fields every additive measure also gets its share of the grand total. In a
    // cross-tab the share would have to say "of what" — the row, the column or the corner — and
    // a column that cannot say it is better left out.
    const withShare = (i: number) => !crossTab && ADDITIVE.has(measures[i].agg);
    const grandOf = (i: number) => Number(root.values.get(keyOf([]))?.[i]);

    const rowCaption = rowFields.map((f) => fieldName(f)).join(" › ");
    const columnCaption = columnFields.map((f) => fieldName(f)).join(" › ");
    const headerRows = crossTab ? c + (m > 1 ? 1 : 0) : 1;

    const valueCells = (node: RowNode, total: boolean): ReactNode[] =>
        heads.flatMap((head) => {
            const values = node.values.get(head.key);
            const isTotal = total || head.kind !== "leaf";
            return measures.flatMap((_, i) => {
                const value: Cell = values?.[i] ?? null;
                const out = [
                    <td key={`${head.key}#${i}`} className={isTotal ? "tot" : undefined}>
                        {formatMeasure(value)}
                    </td>,
                ];
                if (withShare(i)) {
                    const grand = grandOf(i);
                    const share = typeof value === "number" && grand ? (value / grand) * 100 : null;
                    out.push(
                        <td key={`${head.key}#${i}%`} className={isTotal ? "tot share" : "share"}>
                            {share === null ? "" : `${share.toFixed(2)}%`}
                        </td>,
                    );
                }
                return out;
            });
        });

    return (
        <div className="pmatrix-scroll">
            <table className="pmatrix">
                <thead>
                    {crossTab ? (
                        <>
                            {Array.from({ length: c }, (_, level) => (
                                <tr key={level}>
                                    {level === 0 && (
                                        <th className="corner" rowSpan={headerRows}>
                                            <span className="axis">
                                                {m === 1 ? `${measures[0].name} · ` : ""}
                                                {columnCaption} →
                                            </span>
                                            <span>{rowCaption}</span>
                                        </th>
                                    )}
                                    {headerBand(heads, level, c, m, columnFields)}
                                </tr>
                            ))}
                            {m > 1 && (
                                <tr>
                                    {heads.flatMap((head) =>
                                        measures.map((measure, i) => (
                                            <th key={`${head.key}#${i}`} className={head.kind === "leaf" ? undefined : "tot"}>
                                                {measure.name}
                                            </th>
                                        )),
                                    )}
                                </tr>
                            )}
                        </>
                    ) : (
                        <tr>
                            <th className="corner">{rowCaption}</th>
                            {measures.flatMap((measure, i) => [
                                <th key={i}>{measure.name}</th>,
                                ...(withShare(i) ? [<th key={`${i}%`}>% of total</th>] : []),
                            ])}
                        </tr>
                    )}
                </thead>
                <tbody>
                    {rows.map((node) => {
                        const depth = node.path.length - 1;
                        const group = node.children.length > 0;
                        const open = !collapsed.has(node.key);
                        return (
                            <tr key={node.key} className={group ? "sub" : undefined}>
                                <th className="label" style={{ paddingLeft: 10 + depth * 18 }}>
                                    {group ? (
                                        <button
                                            type="button"
                                            className="twist"
                                            onClick={() => onToggle(node.key)}
                                            aria-expanded={open}
                                            aria-label={open ? "Collapse" : "Expand"}
                                        >
                                            {open ? "▾" : "▸"}
                                        </button>
                                    ) : (
                                        <span className="twist" />
                                    )}
                                    <span className={node.path[depth] === null ? "null-label" : undefined}>
                                        {formatLabel(node.path[depth], rowFields[depth])}
                                    </span>
                                </th>
                                {valueCells(node, false)}
                            </tr>
                        );
                    })}
                    <tr className="grand">
                        <th className="label">Grand total</th>
                        {valueCells(root, true)}
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

function fieldName(field: PivotRowField): string {
    return field.grain && field.grain !== "none" ? `${field.column} (${field.grain})` : field.column;
}

// One row of the column header band. A group spans its members and its own subtotal; a subtotal
// starts at the level below its group and runs to the bottom of the band; the grand total spans
// the whole band.
function headerBand(heads: ColumnHead[], level: number, depth: number, measures: number, fields: PivotRowField[]) {
    const cells: ReactNode[] = [];
    let i = 0;
    while (i < heads.length) {
        const head = heads[i];
        if (head.path.length < level) {
            i++;
            continue;
        }
        if (head.path.length === level) {
            const label = level === 0 ? "Total" : `${formatLabel(head.path[level - 1], fields[level - 1])} Total`;
            cells.push(
                <th key={head.key} className="tot" colSpan={measures} rowSpan={depth - level}>
                    {label}
                </th>,
            );
            i++;
            continue;
        }
        const prefix = keyOf(head.path.slice(0, level + 1));
        let span = 0;
        while (i < heads.length && heads[i].path.length > level && keyOf(heads[i].path.slice(0, level + 1)) === prefix) {
            span++;
            i++;
        }
        cells.push(
            <th key={`${level}:${prefix}`} colSpan={span * measures} className={head.path[level] === null ? "null-label" : undefined}>
                {formatLabel(head.path[level], fields[level])}
            </th>,
        );
    }
    return cells;
}
