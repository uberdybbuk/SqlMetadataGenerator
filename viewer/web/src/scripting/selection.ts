// What the scripting picker remembers.
//
// NOT a set of ticked objects. A selection is a small list of RULES, each one a statement about a
// part of the inventory — "all tables", "nothing in Log", "this one view". Three properties come
// out of that and none of them come out of a set:
//
//   * Ticking a container is one entry, not one per child. "All tables" stays one rule whether the
//     database has 6 tables or 6,000.
//   * A rule keeps meaning something after the inventory is re-read. "All tables" still covers a
//     table created since the panel was opened; a set of names quietly wouldn't.
//   * The tree can be grouped by type or by schema without translating anything, because rules are
//     about the objects themselves, not about rows in a particular tree.
//
// Resolution is MOST SPECIFIC WINS, and on a tie, MOST RECENT WINS. Specificity is the obvious
// ordering — one object beats one kind-within-a-schema beats a whole kind beats everything. The
// recency tiebreak only ever comes up across the two groupings (a "kind" rule and a "schema" rule
// both cover Log's tables and neither is inside the other), and there it says the plain thing: the
// box you clicked last is the one that meant it.

export interface ScriptableObject {
    kind: string;
    schema: string;
    name: string;
}

export type Scope = "all" | "kind" | "schema" | "kindSchema" | "object";

// What a click acts on. Every node in either grouping is one of these.
export type Target =
    | { scope: "all" }
    | { scope: "kind"; kind: string }
    | { scope: "schema"; schema: string }
    | { scope: "kindSchema"; kind: string; schema: string }
    | { scope: "object"; kind: string; schema: string; name: string };

export interface Rule {
    target: Target;
    include: boolean;
    // Monotonic. Breaks a specificity tie in favour of the more recent click.
    seq: number;
}

export interface Selection {
    rules: Rule[];
    next: number;
}

export const EMPTY: Selection = { rules: [], next: 1 };

export const NONE = 0;
export const PARTIAL = 1;
export const ALL = 2;
export type CheckState = typeof NONE | typeof PARTIAL | typeof ALL;

// SQL Server identifiers are case-insensitive in every collation this tool is pointed at, and the
// inventory and the click come from two different reads. NUL separates the parts because it is the
// one character an identifier cannot contain.
export function idOf(o: ScriptableObject): string {
    return `${o.kind}\u0000${o.schema.toLowerCase()}\u0000${o.name.toLowerCase()}`;
}

function specificity(scope: Scope): number {
    switch (scope) {
        case "all":
            return 0;
        // A kind and a schema cut the inventory two different ways and neither contains the other.
        // Equal rank, and the seq tiebreak decides — see the note at the top.
        case "kind":
        case "schema":
            return 1;
        case "kindSchema":
            return 2;
        case "object":
            return 3;
    }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function covers(target: Target, o: ScriptableObject): boolean {
    switch (target.scope) {
        case "all":
            return true;
        case "kind":
            return same(target.kind, o.kind);
        case "schema":
            return same(target.schema, o.schema);
        case "kindSchema":
            return same(target.kind, o.kind) && same(target.schema, o.schema);
        case "object":
            return same(target.kind, o.kind) && same(target.schema, o.schema) && same(target.name, o.name);
    }
}

// Resolves every object against the rules. Nothing is selected by default: a picker that starts
// with the whole database ticked is one misclick away from scripting it.
export function resolve(objects: ScriptableObject[], selection: Selection): Set<string> {
    const selected = new Set<string>();

    for (const o of objects) {
        let best: Rule | null = null;
        for (const rule of selection.rules) {
            if (!covers(rule.target, o)) {
                continue;
            }
            if (
                best === null ||
                specificity(rule.target.scope) > specificity(best.target.scope) ||
                (specificity(rule.target.scope) === specificity(best.target.scope) && rule.seq > best.seq)
            ) {
                best = rule;
            }
        }
        if (best?.include) {
            selected.add(idOf(o));
        }
    }

    return selected;
}

// Is the existing rule's reach strictly inside the target's?
//
// This is the non-obvious half of the design, and skipping it makes unticking a container look
// broken: after picking eleven tables one by one, unticking "Tables" would do NOTHING, because
// those eleven object rules are more specific and go on winning. Acting on a container is a
// statement about everything under it, so what is under it is stale and goes.
//
// It is also what keeps the rule list short — unticking a kind after a bulk select collapses
// hundreds of rules back into one.
function isUnder(target: Target, rule: Target): boolean {
    switch (target.scope) {
        case "all":
            return rule.scope !== "all";
        case "kind":
            return (
                (rule.scope === "kindSchema" || rule.scope === "object") && same(rule.kind, target.kind)
            );
        case "schema":
            return (
                (rule.scope === "kindSchema" || rule.scope === "object") && same(rule.schema, target.schema)
            );
        case "kindSchema":
            return rule.scope === "object" && same(rule.kind, target.kind) && same(rule.schema, target.schema);
        case "object":
            return false;
    }
}

function sameTarget(a: Target, b: Target): boolean {
    if (a.scope !== b.scope) {
        return false;
    }
    switch (a.scope) {
        case "all":
            return true;
        case "kind":
            return same(a.kind, (b as { kind: string }).kind);
        case "schema":
            return same(a.schema, (b as { schema: string }).schema);
        case "kindSchema": {
            const other = b as { kind: string; schema: string };
            return same(a.kind, other.kind) && same(a.schema, other.schema);
        }
        case "object": {
            const other = b as { kind: string; schema: string; name: string };
            return same(a.kind, other.kind) && same(a.schema, other.schema) && same(a.name, other.name);
        }
    }
}

export function apply(selection: Selection, target: Target, include: boolean): Selection {
    const kept = selection.rules.filter((r) => !sameTarget(target, r.target) && !isUnder(target, r.target));
    return { rules: [...kept, { target, include, seq: selection.next }], next: selection.next + 1 };
}

// Rewrites the rules from scratch so they describe exactly this set of objects, coarsest first.
//
// Used for every BULK action — select all, deselect all, invert. Doing those by writing one rule
// per object would work and would also turn a 4,000-match bulk select into 4,000 rules that then
// have to be pruned away later. Rebuilding stops as soon as a group is uniform, so the rule count
// follows the shape of the boundary, not the size of the database.
//
// It also means invert is a real selection afterwards, not a flag saying "the answer is backwards
// now" — a flag leaks into every later click, because ticking a box would then have to mean untick.
export function rebuild(objects: ScriptableObject[], wanted: Set<string>): Selection {
    if (objects.length === 0) {
        return EMPTY;
    }
    if (wanted.size === objects.length) {
        return { rules: [{ target: { scope: "all" }, include: true, seq: 1 }], next: 2 };
    }
    if (wanted.size === 0) {
        return EMPTY;
    }

    // Grouped by kind, then by schema — the type grouping. The schema grouping would produce a
    // different but equally correct rule set; one canonical shape keeps the output predictable.
    const byKind = new Map<string, Map<string, ScriptableObject[]>>();
    for (const o of objects) {
        let schemas = byKind.get(o.kind);
        if (!schemas) {
            schemas = new Map();
            byKind.set(o.kind, schemas);
        }
        const list = schemas.get(o.schema);
        if (list) {
            list.push(o);
        } else {
            schemas.set(o.schema, [o]);
        }
    }

    const rules: Rule[] = [];
    let seq = 1;
    const emit = (target: Target) => rules.push({ target, include: true, seq: seq++ });

    for (const [kind, schemas] of byKind) {
        const inKind = [...schemas.values()].flat();
        const takenInKind = inKind.filter((o) => wanted.has(idOf(o))).length;
        if (takenInKind === 0) {
            // Nothing to say: not selected is the default.
            continue;
        }
        if (takenInKind === inKind.length) {
            emit({ scope: "kind", kind });
            continue;
        }

        for (const [schema, list] of schemas) {
            const taken = list.filter((o) => wanted.has(idOf(o))).length;
            if (taken === 0) {
                continue;
            }
            if (taken === list.length) {
                emit({ scope: "kindSchema", kind, schema });
                continue;
            }
            for (const o of list) {
                if (wanted.has(idOf(o))) {
                    emit({ scope: "object", kind: o.kind, schema: o.schema, name: o.name });
                }
            }
        }
    }

    return { rules, next: seq };
}

// A container's box is DERIVED from what is under it, never stored. A group with nothing in it
// reads as unticked and cannot be ticked, which is right — it has nothing to be ticked about.
export function stateOf(members: ScriptableObject[], selected: Set<string>): CheckState {
    if (members.length === 0) {
        return NONE;
    }
    let taken = 0;
    for (const o of members) {
        if (selected.has(idOf(o))) {
            taken++;
        }
    }
    return taken === 0 ? NONE : taken === members.length ? ALL : PARTIAL;
}

// The three bulk actions, each over an explicit list of objects. The caller passes the objects the
// action is scoped to — every object in the database, or every match of the current filter — and
// the button that triggers it says which, with the count in its label. A bare "Select all" next to
// a filter box is how someone acts on a set they never looked at.
export function bulk(
    objects: ScriptableObject[],
    selected: Set<string>,
    scope: ScriptableObject[],
    action: "select" | "deselect" | "invert",
): Selection {
    const wanted = new Set(selected);
    for (const o of scope) {
        const id = idOf(o);
        if (action === "select") {
            wanted.add(id);
        } else if (action === "deselect") {
            wanted.delete(id);
        } else if (wanted.has(id)) {
            wanted.delete(id);
        } else {
            wanted.add(id);
        }
    }
    return rebuild(objects, wanted);
}
