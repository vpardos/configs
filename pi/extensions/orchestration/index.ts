/**
 * orchestration/index.ts — oh-my-opencode-slim-style orchestration for pi,
 * migrated from the user's opencode setup (oh-my-opencode-slim "opencode-go"
 * preset + the custom mathematician agent).
 *
 * Structure:
 *   modes       : lead-agent personas selected with /orchestrator, /mathematician, /solo
 *   agents      : specialist subagents spawned as isolated `pi --mode json`
 *                 child processes (own model, thinking level, tool allowlist, skills)
 *   tools       : task, check_tasks, cancel_task (delegation), question (ask user)
 *   visibility  : children stream their events (tool calls, thinking, text) to the
 *                 parent, which shows a live widget, feeds the foreground progress
 *                 display, writes a per-lane JSONL transcript, and notifies the
 *                 lead automatically when a background lane finishes (no polling).
 *
 * Config: orchestration.json next to this file. Prompts: prompts/*.md.
 * See ~/.pi/agent/PI-CONFIGURATION.md for how to extend this system.
 *
 * Subagent child processes are marked with PI_ORCHESTRATION_CHILD=1; when this
 * extension sees that env var it registers nothing, so subagents never get the
 * task/question tools (no recursive delegation, no user prompts from leaves).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- config ----

interface AgentConfig {
	description: string;
	model: string; // "provider/model-id"
	thinking?: string;
	systemPrompt: string; // path relative to extension dir
	tools?: string[];
	toolMode?: "allow" | "exclude";
	skills?: string[]; // skill names in ~/.agents/skills, "*" for all, [] for none
	timeoutMs?: number;
}

interface ModeConfig {
	label: string;
	systemPrompt: string;
	agents: string[];
	model: string;
	thinking?: string;
}

interface OrchestrationConfig {
	defaultMode: string;
	modes: Record<string, ModeConfig>;
	agents: Record<string, AgentConfig>;
}

// Resolve the extension's own directory portably: config (orchestration.json,
// prompts/) always lives next to index.ts, so a repo checkout symlinked into
// .pi works on any device regardless of where pi keeps its agent dir.
const HERE = dirname(fileURLToPath(import.meta.url));
let extDirCache: string | null = null;
function extDir(): string {
	if (extDirCache) return extDirCache;
	const candidates = [
		process.env.PI_ORCHESTRATION_DIR ?? HERE, // env override or dir of this file
		join(getAgentDir(), "extensions", "orchestration"),
		join(homedir(), ".pi", "agent", "extensions", "orchestration"),
	];
	for (const c of candidates) {
		if (existsSync(join(c, "orchestration.json"))) return (extDirCache = c);
	}
	return (extDirCache = HERE);
}
const SKILLS_DIR = join(homedir(), ".agents", "skills");
function logDir(): string {
	return join(getAgentDir(), "subagent-logs");
}
const PI_BIN = process.env.PI_BIN ?? "pi";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 5_000;
const WIDGET_INTERVAL_MS = 1_000;
const MIN_TASK_TIMEOUT_MS = 30_000;
const MAX_TASK_TIMEOUT_MS = 60 * 60_000;

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function loadConfig(): OrchestrationConfig {
	return readJson<OrchestrationConfig>(join(extDir(), "orchestration.json"));
}

function loadPrompt(relPath: string): string {
	const abs = relPath.startsWith("/") ? relPath : join(extDir(), relPath);
	return readFileSync(abs, "utf-8");
}

// ------------------------------------------------------------ lane tracking -

interface ChildResult {
	text: string; // final assistant text
	stderr: string;
	code: number | null;
	killed: boolean;
	logPath: string;
}

/** Live state of one running subagent lane (foreground or background). */
interface LaneState {
	key: string; // "fg-N" for foreground, "task-N" for background
	taskId: string | null; // background task id, or null
	agent: string;
	description: string;
	startedAt: number;
	deadlineAt: number;
	currentTool?: string; // e.g. `bash {"command":"npm test"}`
	thinkingTail: string; // last ~500 chars of streamed thinking
	textTail: string; // last ~500 chars of streamed response text
	toolCalls: number;
	logPath: string;
}

interface BackgroundTask {
	id: string;
	agent: string;
	mode: string;
	description: string;
	startedAt: number;
	status: "running" | "done" | "error" | "cancelled";
	result?: string;
	error?: string;
	notified?: boolean;
	proc?: ChildProcess;
	laneKey?: string;
}

let taskCounter = 0;
let laneCounter = 0;
const backgroundTasks = new Map<string, BackgroundTask>();
const runningLanes = new Map<string, LaneState>();
const recentLogs: { path: string; agent: string; at: number }[] = [];

function summarizeArgs(args: unknown): string {
	try {
		const s = JSON.stringify(args ?? {});
		return s.length > 120 ? s.slice(0, 117) + "…" : s;
	} catch {
		return "(args)";
	}
}

function summarizeToolCall(toolName: string, args: unknown): string {
	return `${toolName} ${summarizeArgs(args)}`;
}

function laneHeadline(lane: LaneState): string {
	const elapsed = Math.round((Date.now() - lane.startedAt) / 1000);
	const what = lane.currentTool
		? `tool: ${lane.currentTool}`
		: lane.thinkingTail
			? `thinking: ${lane.thinkingTail.slice(-100).replace(/\s+/g, " ")}`
			: lane.textTail
				? `writing: ${lane.textTail.slice(-100).replace(/\s+/g, " ")}`
				: "starting…";
	return `@${lane.agent}${lane.taskId ? ` ${lane.taskId}` : " (fg)"} ${elapsed}s · ${lane.toolCalls} tool calls · ${what}`;
}

// ------------------------------------------------------------- child runner -

function buildChildArgs(agent: AgentConfig, promptText: string): string[] {
	// JSON event mode: the parent parses tool calls, thinking and text deltas live.
	const args: string[] = ["--mode", "json", "--no-session"];

	const [provider, ...rest] = agent.model.split("/");
	const modelId = rest.join("/");
	if (provider && modelId) args.push("--provider", provider, "--model", modelId);
	if (agent.thinking) args.push("--thinking", agent.thinking);

	if (agent.toolMode === "allow" && agent.tools?.length) {
		args.push("--tools", agent.tools.join(","));
	} else if (agent.toolMode === "exclude" && agent.tools?.length) {
		args.push("--exclude-tools", agent.tools.join(","));
	}

	// Skills: [] -> none, ["*"] -> default discovery, [names] -> exactly those.
	const skills = agent.skills ?? [];
	if (!skills.includes("*")) {
		args.push("--no-skills");
		for (const s of skills) {
			const skillPath = s.startsWith("/") || s.startsWith("~") ? resolve(s.replace(/^~/, homedir())) : join(SKILLS_DIR, s);
			if (existsSync(skillPath)) args.push("--skill", skillPath);
			else console.error(`[orchestration] skill not found, skipping: ${skillPath}`);
		}
	}

	args.push("--system-prompt", promptText);
	args.push("--");
	return args;
}

interface SpawnOptions {
	laneKey: string;
	taskId: string | null;
	signal?: AbortSignal;
	timeoutMs?: number;
	onUpdate?: (text: string) => void; // foreground progress display
	onEvent?: () => void; // any notable event (tool call / completion of a tool)
}

function spawnSubagent(
	agentName: string,
	agent: AgentConfig,
	brief: string,
	cwd: string,
	description: string,
	options: SpawnOptions,
): { promise: Promise<ChildResult>; proc: ChildProcess } {
	const promptText = loadPrompt(agent.systemPrompt);
	const args = buildChildArgs(agent, promptText);
	const proc = spawn(PI_BIN, args, {
		cwd,
		env: { ...process.env, PI_ORCHESTRATION_CHILD: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Per-lane transcript: every raw JSON event, tail-able with `tail -f`.
	const LOG_DIR = logDir();
	if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	laneCounter += 1;
	const logPath = join(LOG_DIR, `${stamp}-${agentName}-${options.taskId ?? `fg${laneCounter}`}.jsonl`);
	const logStream: WriteStream = createWriteStream(logPath, { flags: "a" });
	recentLogs.push({ path: logPath, agent: agentName, at: Date.now() });
	while (recentLogs.length > 20) recentLogs.shift();

	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? agent.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TASK_TIMEOUT_MS), MAX_TASK_TIMEOUT_MS);
	const startedAt = Date.now();
	const lane: LaneState = {
		key: options.laneKey,
		taskId: options.taskId,
		agent: agentName,
		description,
		startedAt,
		deadlineAt: startedAt + timeoutMs,
		thinkingTail: "",
		textTail: "",
		toolCalls: 0,
		logPath,
	};
	runningLanes.set(lane.key, lane);
	lane.proc = proc;

	let stderr = "";
	proc.stderr!.setEncoding("utf-8");
	proc.stderr!.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});

	// -- JSON event stream parsing ------------------------------------------
	let stdoutBuf = "";
	let finalText = "";
	let textAccum = "";

	proc.stdout!.setEncoding("utf-8");
	proc.stdout!.on("data", (chunk: string) => {
		stdoutBuf += chunk;
		let idx: number;
		while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
			const line = stdoutBuf.slice(0, idx).trim();
			stdoutBuf = stdoutBuf.slice(idx + 1);
			if (!line) continue;
			logStream.write(line + "\n");
			handleChildEvent(line, lane);
		}
	});

	function handleChildEvent(line: string, lane: LaneState) {
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			return;
		}
		switch (e.type) {
			case "message_update": {
				const ame = e.assistantMessageEvent;
				if (!ame) break;
				if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
					lane.thinkingTail = (lane.thinkingTail + ame.delta).slice(-500);
				} else if (ame.type === "text_delta" && typeof ame.delta === "string") {
					lane.textTail = (lane.textTail + ame.delta).slice(-500);
					textAccum += ame.delta;
				} else if (ame.type === "toolcall_start") {
					lane.currentTool = `${ame.toolName} …`;
				}
				break;
			}
			case "tool_execution_start":
				lane.currentTool = summarizeToolCall(e.toolName, e.args);
				options.onEvent?.();
				break;
			case "tool_execution_end":
				lane.toolCalls += 1;
				lane.currentTool = undefined;
				options.onEvent?.();
				break;
			case "message_end":
				if (e.message?.role === "assistant") {
					const parts: string[] = [];
					for (const c of e.message.content ?? []) {
						if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
					}
					const t = parts.join("\n");
					if (t.trim()) finalText = t;
				}
				break;
			default:
				break;
		}
	}

	// -- timeout + progress ---------------------------------------------------
	let timedOut = false;
	let killTimer: NodeJS.Timeout | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		// Hard kill if the child ignores SIGTERM (e.g. stuck in a syscall).
		killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
	}, timeoutMs);

	// Foreground progress: immediate update on tool events + a 5s heartbeat.
	const progressLine = () => {
		const left = Math.max(0, Math.round((lane.deadlineAt - Date.now()) / 1000));
		const what = lane.currentTool
			? `now: ${lane.currentTool}`
			: lane.thinkingTail
				? `thinking: ${lane.thinkingTail.slice(-200).replace(/\s+/g, " ")}`
				: lane.textTail
					? `writing: ${lane.textTail.slice(-200).replace(/\s+/g, " ")}`
					: "starting…";
		return (
			`@${agentName} running (${Math.round((Date.now() - startedAt) / 1000)}s, deadline in ${left}s) · ${lane.toolCalls} tool calls · ${what}` +
			(stderr ? `\nChild stderr:\n${stderr.slice(-400)}` : "") +
			`\nTranscript: ${logPath}`
		);
	};
	if (options.onUpdate) {
		options.onEvent = () => options.onUpdate?.(progressLine());
	}
	const heartbeat = options.onUpdate
		? setInterval(() => options.onUpdate?.(progressLine()), PROGRESS_INTERVAL_MS)
		: null;

	const promise = new Promise<ChildResult>((resolveP, rejectP) => {
		proc.on("error", (err) => {
			clearTimeout(timer);
			if (heartbeat) clearInterval(heartbeat);
			rejectP(new Error(`failed to spawn '${PI_BIN}': ${err.message}`));
		});
		proc.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (heartbeat) clearInterval(heartbeat);
			runningLanes.delete(lane.key);
			logStream.end();
			if (timedOut) {
				rejectP(
					new Error(
						`subagent ${agentName} timed out after ${Math.round(timeoutMs / 1000)}s and was killed. ` +
							`This usually means the provider stalled (rate limit / network) or the brief was too large. ` +
							`Re-dispatch with a tighter brief, pass a smaller timeout_ms, or run it in background. ` +
							`Partial output:\n${(finalText || textAccum).slice(-4000)}` +
							(stderr ? `\nStderr tail:\n${stderr.slice(-1500)}` : ""),
					),
				);
				return;
			}
			resolveP({ text: (finalText || textAccum).trim(), stderr, code, killed: signal !== null, logPath });
		});
	});

	if (options.signal) {
		const onCancel = () => proc.kill("SIGTERM");
		options.signal.addEventListener("abort", onCancel, { once: true });
		proc.on("exit", () => options.signal!.removeEventListener("abort", onCancel));
	}

	// The brief goes in via stdin (JSON mode merges it into the initial prompt).
	proc.stdin!.write(brief);
	proc.stdin!.end();

	// Unhandled-rejection safety net: if the caller disappears before awaiting
	// (e.g. an exception between spawn and await), a child failure must never
	// crash the host process. The real consumer still receives the rejection.
	promise.catch(() => {});

	return { promise, proc };
}

// --------------------------------------------------------------- extension -

export default function (pi: ExtensionAPI) {
	// Subagent children never get orchestration tools.
	if (process.env.PI_ORCHESTRATION_CHILD === "1") return;

	const config = loadConfig();

	// Latest UI context for widget/status updates from the lane ticker.
	let uiCtx: ExtensionContext | null = null;

	// --- mode state ---------------------------------------------------------
	let mode: string = config.defaultMode && config.modes[config.defaultMode] ? config.defaultMode : "off";
	// CLI override: start in a specific mode (also handy for scripted runs/tests), e.g.
	//   PI_ORCHESTRATION_MODE=mathematician pi
	const envMode = process.env.PI_ORCHESTRATION_MODE;
	if (envMode) mode = config.modes[envMode] ? envMode : "off";

	function modeAgentsTable(activeMode: string): string {
		const modeCfg = config.modes[activeMode];
		if (!modeCfg) return "(no orchestration mode active)";
		const rows = modeCfg.agents
			.map((name) => {
				const a = config.agents[name];
				if (!a) return `| ${name} | (not configured) |`;
				return `| @${name} | ${a.model}${a.thinking ? ` / ${a.thinking}` : ""} | ${a.description} |`;
			})
			.join("\n");
		return [
			`Active subagents for this mode (dispatch with the \`task\` tool, \`agent\` field):`,
			"",
			"| Agent | Model | Job |",
			"| ----- | ----- | --- |",
			rows,
		].join("\n");
	}

	function applyMode(ctx: ExtensionContext, newMode: string, notify = true) {
		mode = newMode;
		const active = pi.getActiveTools();
		const delegation = ["task", "check_tasks", "cancel_task"];
		if (newMode === "off") {
			pi.setActiveTools([...new Set(active.filter((t) => !delegation.includes(t)))]);
		} else {
			pi.setActiveTools([...new Set([...active, ...delegation])]);
		}
		const modeCfg = config.modes[newMode];
		ctx.ui.setStatus("orchestration", newMode === "off" ? undefined : `mode: ${newMode}`);
		if (notify) {
			if (newMode === "off") {
				ctx.ui.notify("Orchestration OFF — you are talking to the base agent. /orchestrator or /mathematician to re-enable.", "info");
			} else {
				ctx.ui.notify(
					`${modeCfg?.label ?? newMode} active. Subagents: ${modeCfg?.agents.join(", ")}. Suggested model: ${modeCfg?.model} (switch with /model).`,
					"info",
				);
			}
			pi.appendEntry("orchestration-mode", { mode: newMode });
		}
	}

	// --- live lane widget ------------------------------------------------------
	// One-line-per-lane activity above the editor while subagents run.
	let widgetTicker: NodeJS.Timeout | null = null;

	function refreshLaneWidget() {
		const ctx = uiCtx;
		if (!ctx) return;
		try {
			if (!ctx.hasUI) return;
			if (runningLanes.size === 0) {
				ctx.ui.setWidget("orchestration", undefined);
				if (widgetTicker) {
					clearInterval(widgetTicker);
					widgetTicker = null;
				}
				return;
			}
			const lines = ["Subagents:"];
			for (const lane of runningLanes.values()) lines.push(`  ${laneHeadline(lane)}`);
			ctx.ui.setWidget("orchestration", lines);
		} catch {
			// ctx went stale (session replaced / reload / shutdown) — drop it and stop.
			uiCtx = null;
			if (widgetTicker) {
				clearInterval(widgetTicker);
				widgetTicker = null;
			}
		}
	}

	function startLaneWidget() {
		refreshLaneWidget();
		if (!widgetTicker) widgetTicker = setInterval(refreshLaneWidget, WIDGET_INTERVAL_MS);
	}

	// --- background completion notifications ---------------------------------
	// When a background lane finishes, push the result into the session as a
	// message. triggerTurn wakes the idle lead, so it never needs to poll/sleep.
	function notifyLaneFinished(entry: BackgroundTask) {
		const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
		const content =
			entry.status === "done"
				? `Background task ${entry.id} (@${entry.agent}) finished in ${elapsed}s.\n\n${entry.result}`
				: `Background task ${entry.id} (@${entry.agent}) FAILED after ${elapsed}s:\n\n${entry.error}`;
		try {
			pi.sendMessage(
				{
					customType: "task-finished",
					content,
					display: true,
					details: { taskId: entry.id, agent: entry.agent, status: entry.status },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			entry.notified = true;
		} catch (err) {
			console.error(`[orchestration] failed to deliver task-finished notification for ${entry.id}: ${err}`);
		}
	}

	// Restore persisted mode from the session entries (survives /reload and resume).
	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		let restored: string | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "orchestration-mode") {
				const m = (entry.data as { mode?: string })?.mode;
				if (m && config.modes[m]) restored = m;
			}
		}
		const target = restored ?? (config.modes[mode] ? mode : "off");
		if (target !== mode || restored) applyMode(ctx, target, false);
		ctx.ui.setStatus("orchestration", target === "off" ? undefined : `mode: ${target}`);
	});

	pi.on("session_shutdown", async () => {
		// Lanes are session-scoped: kill orphaned children on shutdown/reload.
		for (const lane of runningLanes.values()) lane.proc?.kill("SIGTERM");
		for (const entry of backgroundTasks.values()) entry.proc?.kill("SIGTERM");
		backgroundTasks.clear();
		runningLanes.clear();
		if (widgetTicker) {
			clearInterval(widgetTicker);
			widgetTicker = null;
		}
	});

	// --- system prompt injection --------------------------------------------
	pi.on("before_agent_start", async (event) => {
		const modeCfg = config.modes[mode];
		if (!modeCfg) return;
		const leadPrompt = loadPrompt(modeCfg.systemPrompt);
		const injection = [
			"",
			"---",
			"",
			`# Orchestration mode: ${mode}`,
			"",
			leadPrompt,
			"",
			"## Available subagents",
			"",
			modeAgentsTable(mode),
			"",
			"## Delegation tools",
			"",
			"- `task` — dispatch a self-contained brief to a subagent. Foreground: blocks until the report is back. `background: true`: returns a task id immediately and the finished result is delivered to you automatically as a `task-finished` message — you will be woken when it completes.",
			"- `check_tasks` — on-demand lookup of background lanes (status while running, full result once done). Normally unnecessary: finished lanes notify you automatically. Use it only if you missed a notification or after compaction.",
			"- `cancel_task` — kill a running background task by id.",
			"- `question` — ask the user a blocking question (clarification, permission, choices, pasted output).",
			"",
			"## Waiting for background lanes",
			"",
			"- NEVER sleep, poll in a loop, or busy-wait for a background lane. Dispatch, then continue other work or end your turn; each finished lane arrives as a `task-finished` message that triggers your next turn.",
			"- `task-finished` messages carry the full result. Integrate it, then continue the plan. If a lane fails, the message contains the error — re-dispatch with a tighter brief only if the work is still needed.",
		].join("\n");
		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// --- tools ---------------------------------------------------------------

	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Dispatch a self-contained brief to a specialist subagent and get its final report. " +
			"Valid agents depend on the active orchestration mode: " +
			"orchestrator → oracle, librarian, explorer, designer, fixer, observer; " +
			"mathematician → observer-math, solver, writer. " +
			"The subagent is an isolated agent instance: it does NOT see this conversation — the brief must contain everything it needs.",
		promptSnippet: "Dispatch a bounded, self-contained task to a specialist subagent (foreground or background)",
		promptGuidelines: [
			"Use task to delegate bounded specialist work instead of doing multi-step implementation yourself; write a self-contained brief (goal, inputs, constraints, return format).",
			"Use task with background: true for independent lanes; the finished result arrives automatically as a task-finished message — never sleep or poll for it. Use cancel_task only when a lane is obsolete.",
		],
		parameters: Type.Object({
			agent: Type.String({
				description: "Subagent name, e.g. 'oracle', 'fixer', 'solver'. Must be valid for the active orchestration mode.",
			}),
			prompt: Type.String({
				description:
					"Full self-contained brief for the subagent: goal (one sentence), inputs (problem text / file paths / verified solution), constraints (format, length, rigour), and the return format.",
			}),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run in the background: returns a task id immediately, and the full result is delivered to you automatically as a task-finished message when the lane completes (no polling needed). Prefer background for research/web lanes (librarian) so a slow or stalled provider cannot block the turn.",
				}),
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description: "Optional hard deadline in milliseconds (30s to 1h). The subagent process is killed at the deadline and partial output is returned in the error. Defaults to the agent's configured timeout.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentName = params.agent.trim();
			const modeCfg = config.modes[mode];
			if (!modeCfg) {
				throw new Error("No orchestration mode is active. The user can enable one with /orchestrator or /mathematician.");
			}
			if (!modeCfg.agents.includes(agentName)) {
				throw new Error(
					`Unknown agent "${agentName}" for mode "${mode}". Valid agents: ${modeCfg.agents.join(", ")}.`,
				);
			}
			const agent = config.agents[agentName];
			if (!agent) throw new Error(`Agent "${agentName}" is listed in mode "${mode}" but not configured in orchestration.json.`);

			uiCtx = ctx;
			const startedAt = Date.now();
			const description = params.prompt.split("\n")[0].slice(0, 80);

			if (!params.background) {
				laneCounter += 1;
				const { promise } = spawnSubagent(agentName, agent, params.prompt, ctx.cwd, description, {
					laneKey: `fg-${laneCounter}`,
					taskId: null,
					signal,
					timeoutMs: params.timeout_ms,
					onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
				});
				startLaneWidget();
				const result = await promise;
				refreshLaneWidget();
				const text = result.text;
				if (!text) {
					throw new Error(
						`Subagent ${agentName} produced no output (exit code ${result.code}). Stderr tail: ${result.stderr.slice(-1500)}`,
					);
				}
				return {
					content: [{ type: "text", text }],
					details: {
						agent: agentName,
						exitCode: result.code,
						seconds: Math.round((Date.now() - startedAt) / 1000),
						transcript: result.logPath,
					},
				};
			}

			// Background lane.
			taskCounter += 1;
			const id = `task-${taskCounter}`;
			const entry: BackgroundTask = {
				id,
				agent: agentName,
				mode,
				description,
				startedAt,
				status: "running",
			};
			backgroundTasks.set(id, entry);
			const { promise, proc } = spawnSubagent(agentName, agent, params.prompt, ctx.cwd, description, {
				laneKey: id,
				taskId: id,
				signal,
				timeoutMs: params.timeout_ms,
			});
			entry.proc = proc;
			entry.laneKey = id;
			startLaneWidget();
			promise
				.then((result) => {
					entry.status = "done";
					entry.result =
						result.text || `(no output; exit code ${result.code}; stderr: ${result.stderr.slice(-500)})`;
					refreshLaneWidget();
					notifyLaneFinished(entry);
				})
				.catch((err) => {
					entry.status = "error";
					entry.error = err instanceof Error ? err.message : String(err);
					refreshLaneWidget();
					notifyLaneFinished(entry);
				});
			return {
				content: [
					{
						type: "text",
						text:
							`Background task ${id} started: @${agentName} — ${description}\n` +
							`The full result will arrive automatically as a task-finished message when it completes — do NOT poll or sleep, and do not re-dispatch the same work.`,
					},
				],
				details: { taskId: id, agent: agentName },
			};
		},
	});

	pi.registerTool({
		name: "check_tasks",
		label: "Check tasks",
		description:
			"On-demand lookup of background lanes: live status (current tool / thinking) while running, and the full result text for tasks that finished (finished results are removed after being reported). Finished lanes normally deliver their result automatically as a task-finished message, so you rarely need this tool. Omit ids to check all.",
		promptSnippet: "Look up status/results of background task lanes",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Task ids to check, e.g. ['task-1']. Omit for all." })),
		}),
		async execute(_toolCallId, params) {
			const ids = params.ids?.length ? params.ids : [...backgroundTasks.keys()];
			if (ids.length === 0) return { content: [{ type: "text", text: "No background tasks." }], details: {} };
			const parts: string[] = [];
			for (const id of ids) {
				const t = backgroundTasks.get(id);
				if (!t) {
					parts.push(`## ${id}\nUnknown task id.`);
					continue;
				}
				const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
				if (t.status === "running") {
					const lane = t.laneKey ? runningLanes.get(t.laneKey) : undefined;
					const live = lane ? ` Currently: ${laneHeadline(lane)}` : "";
					parts.push(`## ${id}\n@${t.agent} still running (${elapsed}s): ${t.description}.${live}`);
				} else if (t.status === "done") {
					const note = t.notified ? " (already delivered as a task-finished message)" : "";
					parts.push(`## ${id} — @${t.agent} finished (${elapsed}s)${note}\n\n${t.result}`);
					backgroundTasks.delete(id);
				} else if (t.status === "error") {
					const note = t.notified ? " (already delivered as a task-finished message)" : "";
					parts.push(`## ${id} — @${t.agent} FAILED${note}\n\n${t.error}`);
					backgroundTasks.delete(id);
				} else if (t.status === "cancelled") {
					parts.push(`## ${id}\nCancelled by user/orchestrator.`);
					backgroundTasks.delete(id);
				}
			}
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "cancel_task",
		label: "Cancel task",
		description:
			"Cancel a running background task by id. Cancellation is not rollback: reconcile any partial file changes a writer made before launching a replacement lane.",
		promptSnippet: "Cancel an obsolete background task lane",
		parameters: Type.Object({
			id: Type.String({ description: "Task id returned by the task tool, e.g. 'task-1'." }),
		}),
		async execute(_toolCallId, params) {
			const t = backgroundTasks.get(params.id);
			if (!t) throw new Error(`Unknown task id "${params.id}".`);
			if (t.status === "running") {
				t.proc?.kill("SIGTERM");
				t.status = "cancelled";
				return { content: [{ type: "text", text: `Task ${params.id} (@${t.agent}) cancelled. Check for partial file changes before re-dispatching.` }], details: {} };
			}
			backgroundTasks.delete(params.id);
			return { content: [{ type: "text", text: `Task ${params.id} was already ${t.status}; removed from the board.` }], details: {} };
		},
	});

	pi.registerTool({
		name: "question",
		label: "Ask user",
		description:
			"Ask the user a blocking question when their input is required before work can continue: clarification, permission, a choice between options, or pasted command output. Do NOT use it for ordinary dialogue or questions you can answer yourself.",
		promptSnippet: "Ask the user a blocking question (clarification, permission, choices)",
		promptGuidelines: [
			"Use question only when work is blocked on user input; provide a small bounded set of options when the choice is enumerable.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask. Include any context needed to answer it." }),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional answer choices (1-8). If omitted, the user types a free-form answer.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error(
					"No interactive user available in this mode. Proceed with your best judgment and clearly state the assumptions you made.",
				);
			}
			const options = (params.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 8);
			let answer: string | undefined;
			if (options.length > 0) {
				const choice = await ctx.ui.select(`❓ ${params.question}`, options);
				answer = choice;
			} else {
				answer = await ctx.ui.input(`❓ ${params.question}`, "");
			}
			if (answer === undefined || answer === "") {
				return {
					content: [{ type: "text", text: "The user did not answer (cancelled). Ask again only if the work is truly blocked; otherwise proceed with clearly stated assumptions." }],
					details: { cancelled: true },
				};
			}
			return { content: [{ type: "text", text: `User answered: ${answer}` }], details: { answer } };
		},
	});

	// --- commands -------------------------------------------------------------

	pi.registerCommand("orchestrator", {
		description: "Activate the orchestrator (general coding workflow). '/orchestrator off' deactivates.",
		handler: async (args, ctx) => {
			const target = args.trim().toLowerCase() === "off" ? "off" : "orchestrator";
			applyMode(ctx, target);
		},
	});

	pi.registerCommand("mathematician", {
		description: "Activate the mathematician orchestrator (observer-math -> solver -> writer).",
		handler: async (_args, ctx) => {
			applyMode(ctx, "mathematician");
		},
	});

	pi.registerCommand("solo", {
		description: "Deactivate orchestration; talk to the base agent with no subagents.",
		handler: async (_args, ctx) => {
			applyMode(ctx, "off");
		},
	});

	pi.registerCommand("subagents", {
		description: "Show live subagent activity (running lanes) and recent transcripts",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			const lines: string[] = [];
			if (runningLanes.size === 0) {
				lines.push("No subagents currently running.");
			} else {
				lines.push("Running subagents:");
				for (const lane of runningLanes.values()) {
					lines.push(`  ${laneHeadline(lane)}`);
					lines.push(`    brief: ${lane.description}`);
					lines.push(`    transcript: ${lane.logPath}  (tail -f to watch live)`);
				}
			}
			if (recentLogs.length > 0) {
				lines.push("", "Recent transcripts (newest first):");
				for (const l of [...recentLogs].reverse().slice(0, 5)) lines.push(`  ${l.path}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("orchestration", {
		description: "Show orchestration status: active mode, subagents, running background tasks",
		handler: async (_args, ctx) => {
			const lines = [`Mode: ${mode}${mode === "off" ? " (base agent)" : ""}`];
			const modeCfg = config.modes[mode];
			if (modeCfg) {
				lines.push(`Subagents: ${modeCfg.agents.join(", ")}`);
				for (const name of modeCfg.agents) {
					const a = config.agents[name];
					if (a) lines.push(`  @${name}: ${a.model}${a.thinking ? ` (${a.thinking})` : ""} — ${a.description}`);
				}
			}
			const running = [...backgroundTasks.values()].filter((t) => t.status === "running");
			if (running.length) lines.push(`Running background tasks: ${running.map((t) => `${t.id} @${t.agent}`).join(", ")}`);
			else lines.push("No background tasks running.");
			lines.push("Live activity: /subagents · Modes: /orchestrator, /mathematician, /solo");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}