// Brings the whole project up with one command.
//
//   bun start             API and UI in this terminal; Ctrl+C stops both
//   bun start --detach    the same in the background, output to .run/start.log
//   --no-open             with either of the above: do not open the browser once it is ready
//   bun stop              stops a running instance, foreground or background
//
// The API (ASP.NET Core) and the UI (Vite) run side by side. The UI waits until the API answers,
// so the first page load does not land on a proxy error. If either one exits on its own the other
// is stopped too: half a running app only looks like it works.
//
// The ports are fixed. Vite's proxy and the browser bookmarks point at them, so a port that is
// already taken is an error here, not a reason to quietly move to the next one.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

const API_PORT = 7751;
const UI_PORT = 7750;
// The first run builds the API, which can take a while on a cold machine.
const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 10_000;

const root = import.meta.dir;
const web = join(root, "viewer", "web");
const runDir = join(root, ".run");
const pidFile = join(runDir, "pids.json");
const logFile = join(runDir, "start.log");
const isWindows = process.platform === "win32";

// The background instance is this same script, started again with an internal flag. It is the
// only one that knows it has no terminal: it writes plain text to the log and marks itself ready
// in the pid file, which is what the starting side waits for.
const CHILD_FLAG = "--detached-child";

// What a running instance leaves behind so that 'stop' can find it from another terminal. The
// groups are recorded as well as the script's own pid: if the script was killed outright, its
// children are still running and the groups are the only way left to reach them.
interface RunState {
    pid: number;
    groups: number[];
    ready: boolean;
}

// ---------------------------------------------------------------- output

const useColor = process.stdout.isTTY === true;
const colors = { api: "\x1b[36m", web: "\x1b[35m", start: "\x1b[33m", reset: "\x1b[0m" };

function log(source: "api" | "web" | "start", line: string): void {
    console.log(useColor ? `${colors[source]}[${source}]${colors.reset} ${line}` : `[${source}] ${line}`);
}

function fail(message: string): never {
    log("start", message);
    process.exit(1);
}

// ---------------------------------------------------------------- run state

function readState(): RunState | null {
    try {
        return JSON.parse(readFileSync(pidFile, "utf8")) as RunState;
    } catch {
        return null;
    }
}

function writeState(state: RunState): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(pidFile, JSON.stringify(state));
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// A group outlives its leader: 'dotnet run' can be gone while the API it started is still
// serving, so a group is checked as a group, not by its first pid. Windows has no process
// groups; there the tree is stopped with taskkill and the pid is all there is to check.
function groupAlive(pid: number): boolean {
    if (isWindows) {
        return isAlive(pid);
    }
    try {
        process.kill(-pid, 0);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- checks

function requireTool(name: string): void {
    const probe = spawnSync(name, ["--version"], { shell: isWindows, stdio: "ignore" });
    if (probe.status !== 0) {
        fail(`'${name}' was not found on PATH.`);
    }
}

// A port is taken when something accepts a connection on it. Checked up front so the error names
// the port, instead of surfacing later as a bind failure buried in one of the two logs.
//
// Both loopback addresses are tried. Vite listens on "localhost", which on macOS can be ::1 only,
// and an old Vite holding [::1]:5173 (the old UI port) passed a 127.0.0.1-only check — the readiness probe then
// reached THAT server through "localhost" and reported ready while the new one had failed to bind.
function portInUseOn(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ port, host });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

async function portInUse(port: number): Promise<boolean> {
    const answers = await Promise.all(["127.0.0.1", "::1"].map((host) => portInUseOn(port, host)));
    return answers.some(Boolean);
}

async function preflight(): Promise<void> {
    const running = readState();
    if (running && isAlive(running.pid)) {
        fail(`Already running (pid ${running.pid}). 'bun stop' stops it.`);
    }

    requireTool("dotnet");
    requireTool("npm");

    for (const [name, port] of [["API", API_PORT], ["UI", UI_PORT]] as const) {
        if (await portInUse(port)) {
            fail(`Port ${port} (${name}) is already in use. Stop whatever is running there first.`);
        }
    }
}

// npm install only when it can have something to do: no node_modules yet, or the lock file has
// changed since the last install. Running it every time costs several seconds for nothing.
function installIfNeeded(): void {
    const marker = join(web, "node_modules", ".package-lock.json");
    const lock = join(web, "package-lock.json");
    const stale = !existsSync(marker) || statSync(lock).mtimeMs > statSync(marker).mtimeMs;
    if (!stale) {
        return;
    }

    log("start", "Installing UI packages (npm install)...");
    const install = spawnSync("npm", ["install"], { cwd: web, shell: isWindows, stdio: "inherit" });
    if (install.status !== 0) {
        fail("npm install failed.");
    }
}

// ---------------------------------------------------------------- browser

const APP_URL = `http://localhost:${UI_PORT}/app`;

// Opened only once both servers answer, so the first page is the app and not a connection error.
// A browser that cannot be opened is not a failure: the URL is printed either way.
function openBrowser(): void {
    if (process.argv.includes("--no-open")) {
        return;
    }
    const [command, args] = isWindows
        ? ["cmd", ["/c", "start", "", APP_URL]]
        : process.platform === "darwin"
            ? ["open", [APP_URL]]
            : ["xdg-open", [APP_URL]];
    try {
        spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
    } catch {
        // No browser to open; the printed URL is enough.
    }
}

// ---------------------------------------------------------------- the two processes

const children: ChildProcess[] = [];
let stopping = false;

// Each child is started in its own process group and the whole group is stopped. 'dotnet run'
// and 'npx' both start the real program as a child of their own, and signalling only the parent
// left the API running in the background with the port still taken.
function run(source: "api" | "web", command: string, args: string[], cwd: string): ChildProcess {
    const child = spawn(command, args, {
        cwd,
        shell: isWindows,
        detached: !isWindows,
        env: useColor ? { ...process.env, FORCE_COLOR: "1" } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    for (const stream of [child.stdout, child.stderr]) {
        if (stream) {
            createInterface({ input: stream }).on("line", (line) => log(source, line));
        }
    }

    child.once("exit", (code) => {
        if (!stopping) {
            log("start", `${source} exited (code ${code ?? "?"}); stopping the rest.`);
            shutdown(code ?? 1);
        }
    });

    children.push(child);
    writeState({ pid: process.pid, groups: children.flatMap((c) => (c.pid ? [c.pid] : [])), ready: false });
    return child;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        if (isWindows) {
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } else {
            process.kill(-pid, signal);
        }
    } catch {
        // Already gone.
    }
}

function shutdown(code: number): void {
    if (stopping) {
        return;
    }
    stopping = true;
    for (const child of children) {
        if (child.exitCode === null && child.pid !== undefined) {
            killGroup(child.pid, "SIGTERM");
        }
    }
    rmSync(pidFile, { force: true });
    process.exit(code);
}

// Any HTTP answer means the server is listening; the status does not matter here.
async function waitFor(name: string, url: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            await fetch(url);
            return;
        } catch {
            await Bun.sleep(500);
        }
    }
    log("start", `The ${name} did not answer at ${url} within ${READY_TIMEOUT_MS / 1000} s.`);
    shutdown(1);
}

async function startHere(): Promise<void> {
    // SIGHUP is what closing the terminal window sends. The children run in their own process
    // groups, so it never reaches them; without this they outlived the window and kept both ports.
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.on("SIGHUP", () => shutdown(0));

    log("start", `Starting the API on http://localhost:${API_PORT} ...`);
    run("api", "dotnet", ["run", "--project", join("src", "SqlMetadataGenerator.Web"), "--urls", `http://localhost:${API_PORT}`], root);
    await waitFor("API", `http://localhost:${API_PORT}/api/servers`);

    log("start", `Starting the UI on http://localhost:${UI_PORT} ...`);
    run("web", "npx", ["vite", "--port", String(UI_PORT), "--strictPort"], web);
    await waitFor("UI", `http://localhost:${UI_PORT}/`);

    writeState({ ...readState()!, ready: true });
    const detached = process.argv.includes(CHILD_FLAG);
    log("start", `Ready: ${APP_URL}  (${detached ? "'bun stop' stops it" : "Ctrl+C stops both"})`);
    // The background instance leaves it to the side that started it, which runs in the user's session.
    if (!detached) {
        openBrowser();
    }
}

// ---------------------------------------------------------------- detach

// Starts this script again in the background and waits until it reports ready, so that the
// command returns only once the app can actually be opened — or with the reason it could not.
async function detach(): Promise<void> {
    mkdirSync(runDir, { recursive: true });
    const out = openSync(logFile, "w");
    const child = spawn(process.execPath, [import.meta.path, CHILD_FLAG], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
    });
    child.unref();

    log("start", `Starting in the background (pid ${child.pid}); output goes to ${logFile}`);
    const deadline = Date.now() + READY_TIMEOUT_MS + 5_000;
    while (Date.now() < deadline) {
        if (readState()?.ready) {
            log("start", `Ready: ${APP_URL}  ('bun stop' stops it)`);
            openBrowser();
            return;
        }
        if (child.pid === undefined || !isAlive(child.pid)) {
            break;
        }
        await Bun.sleep(500);
    }

    // The background instance stopped (or never got ready): its log says why.
    const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-15) : [];
    tail.forEach((line) => console.log(`  ${line}`));
    fail(`Did not start. Full output: ${logFile}`);
}

// ---------------------------------------------------------------- stop

async function stop(): Promise<void> {
    const state = readState();
    if (!state) {
        log("start", "Nothing to stop: no running instance is recorded.");
        return;
    }

    // The script itself first: its own shutdown stops both children in the normal way.
    if (isAlive(state.pid)) {
        if (isWindows) {
            killGroup(state.pid, "SIGTERM");
        } else {
            process.kill(state.pid, "SIGTERM");
        }
    }

    // If the script was already gone, or does not finish in time, the recorded groups are
    // stopped directly — politely first, then for good.
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    const remaining = () => [isAlive(state.pid), ...state.groups.map(groupAlive)].filter(Boolean);
    while (remaining().length > 0 && Date.now() < deadline) {
        state.groups.forEach((pid) => killGroup(pid, "SIGTERM"));
        await Bun.sleep(300);
    }
    state.groups.filter(groupAlive).forEach((pid) => killGroup(pid, "SIGKILL"));

    rmSync(pidFile, { force: true });
    log("start", "Stopped.");
}

// ---------------------------------------------------------------- entry

const args = process.argv.slice(2);

if (args[0] === "stop") {
    await stop();
} else if (args.includes(CHILD_FLAG)) {
    // Checked again here rather than trusted from the parent: the ports may have been taken in
    // the moment between the two.
    await preflight();
    installIfNeeded();
    await startHere();
} else {
    await preflight();
    installIfNeeded();
    if (args.includes("--detach")) {
        await detach();
    } else {
        await startHere();
    }
}
