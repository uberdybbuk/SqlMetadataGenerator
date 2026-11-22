import type { ScriptJobPhase, ScriptJobResult, ScriptJobStatus } from "../api";

// The two faces of a long script job: where it is while it runs, and what came out when the
// output was too big for the editor. A short job shows neither. Its script simply appears.

interface JobProgressProps {
    db: string;
    status: ScriptJobStatus | null;
    summary: string;
    cancelling: boolean;
    onCancel: () => void;
}

export function JobProgress({ db, status, summary, cancelling, onCancel }: JobProgressProps) {
    const phases = status?.phases ?? [];
    return (
        <div className="job">
            <div className="job-head">
                <b>Scripting {db}</b>
                <span className="muted">{summary}</span>
                <span className="grow" />
                <span className="muted mono">{status ? clock(status.seconds) : ""}</span>
                <button className="tool" onClick={onCancel} disabled={cancelling}>
                    {cancelling ? "Cancelling…" : "Cancel"}
                </button>
            </div>
            <Bar fraction={overall(phases)} />
            <div className="phases">
                {phases.map((p) => (
                    <PhaseRow key={p.key} phase={p} />
                ))}
            </div>
        </div>
    );
}

function PhaseRow({ phase }: { phase: ScriptJobPhase }) {
    const steps = phase.state === "running" ? (phase.steps ?? []) : [];
    // A phase made of parallel steps says which of them it is waiting for. That answers more than
    // a bar standing at six of seven.
    const counted = phase.state === "running" && phase.total !== null && phase.total > 1 && steps.length === 0;
    return (
        <>
            <span className={"ic " + phase.state}>
                {phase.state === "done" ? "✓" : phase.state === "running" ? <span className="spin" /> : "○"}
            </span>
            <span className={"lbl " + phase.state}>{phase.title}</span>
            <span className="num">{countText(phase)}</span>
            <span className="t">{phase.state === "waiting" ? "" : duration(phase.seconds)}</span>
            {(counted || (phase.state === "running" && phase.detail)) && (
                <span className="sub">
                    {counted && <Bar fraction={phase.done / phase.total!} />}
                    {phase.state === "running" && phase.detail && <span className="mono">{phase.detail}</span>}
                </span>
            )}
            {steps.length > 0 && <Steps steps={steps} />}
        </>
    );
}

// Finished steps on one line with their times, then each one still running on a line of its own
// with its clock, so the slow query is the one that stands out.
function Steps({ steps }: { steps: ScriptJobPhase["steps"] }) {
    const done = steps.filter((s) => s.state === "done");
    const open = steps.filter((s) => s.state !== "done");
    return (
        <span className="steps-list">
            {done.length > 0 && (
                <span className="step-done">
                    <span className="ic done">✓</span>
                    <span>{done.map((s) => `${s.name} ${duration(s.seconds)}`).join(" · ")}</span>
                </span>
            )}
            {open.map((s) => (
                <span key={s.name} className={"step-open " + s.state}>
                    <span className={"ic " + s.state}>{s.state === "running" ? <span className="spin" /> : "○"}</span>
                    <span className="grow">{s.name}</span>
                    <span className="t">{s.state === "running" ? duration(s.seconds) : ""}</span>
                </span>
            ))}
        </span>
    );
}

interface JobDoneProps {
    result: ScriptJobResult;
    status: ScriptJobStatus;
    limitMb: number;
    // Null once the server no longer keeps the file.
    downloadUrl: string | null;
}

// A script over the editor's limit: it went to the downloads instead. What stays here is enough
// to know what was made, and a way to get it again while the server still has it.
export function JobDone({ result, status, limitMb, downloadUrl }: JobDoneProps) {
    const spent = status.phases.filter((p) => p.seconds >= 0.5);
    return (
        <div className="job">
            <div className="bigdone">
                <span className="icon-dl">⤓</span>
                <div className="grow">
                    <div className="bigdone-title">
                        <b>{result.fileName}</b> went to your downloads
                    </div>
                    <div className="facts">
                        <b>{bytes(result.bytes)}</b>
                        {result.lines !== null && <> · {result.lines.toLocaleString("en-US")} lines</>} ·{" "}
                        {result.scripted.toLocaleString("en-US")} scripted · too big to show here (limit {limitMb} MB)
                    </div>
                </div>
                {downloadUrl ? (
                    <a className="tool" href={downloadUrl} download={result.fileName}>
                        Download again
                    </a>
                ) : (
                    <span className="muted" title="The server keeps a finished script only for the time set in Settings.">
                        No longer kept. Generate again.
                    </span>
                )}
            </div>
            <div className="job-foot muted">
                <span className="ok">✓</span>
                Done in {clock(status.seconds)}
                {spent.map((p) => (
                    <span key={p.key}>
                        · {p.title.replace(/^Reading /, "").toLowerCase()} {duration(p.seconds)}
                    </span>
                ))}
            </div>
        </div>
    );
}

function Bar({ fraction }: { fraction: number }) {
    return (
        <div className="bar">
            <i style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
        </div>
    );
}

// Every phase weighs the same: the server cannot know in advance which read will be the slow one.
// A phase with a count fills in by its count, one without counts as half done while it runs.
function overall(phases: ScriptJobPhase[]): number {
    if (phases.length === 0) {
        return 0;
    }
    const sum = phases.reduce((acc, p) => {
        if (p.state === "done") {
            return acc + 1;
        }
        if (p.state === "running") {
            return acc + (p.total ? p.done / p.total : 0.5);
        }
        return acc;
    }, 0);
    return sum / phases.length;
}

function countText(p: ScriptJobPhase): string {
    if (p.state === "done") {
        return p.detail ?? "";
    }
    if (p.state === "running" && p.total !== null && p.total > 1) {
        return `${p.done.toLocaleString("en-US")} / ${p.total.toLocaleString("en-US")} ${p.unit ?? ""}`.trim();
    }
    return "";
}

function duration(seconds: number): string {
    return seconds < 60 ? `${seconds.toFixed(1)} s` : clock(seconds);
}

function clock(seconds: number): string {
    const whole = Math.floor(seconds);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function bytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
