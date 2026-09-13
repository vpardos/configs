/**
 * orchestration/index.ts — oh-my-opencode-slim-style orchestration for pi,
 * migrated from the user's opencode setup (oh-my-opencode-slim "opencode-go"
 * preset + the custom mathematician agent).
 *
 * Structure:
 *   modes       : lead-agent personas selected with /orchestrator, /mathematician, /solo
 *   agents      : specialist subagents spawned as isolated `pi --print` child
 *                 processes (own model, thinking level, tool allowlist, skills)
 *   tools       : task, check_tasks, cancel_task (delegation), question (ask user)
 *
 * Config: orchestration.json next to this file. Prompts: prompts/*.md.
 * See ~/.pi/agent/PI-CONFIGURATION.md for how to extend this system.
 *
 * Subagent child processes are marked with PI_ORCHESTRATION_CHILD=1; when this
 * extension sees that env var it registers nothing, so subagents never get the
 * task/question tools (no recursive delegation, no user prompts from leaves).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

const EXT_DIR =
	process.env.PI_ORCHESTRATION_DIR ?? join(homedir(), ".pi", "agent", "extensions", "orchestration");
const SKILLS_DIR = join(homedir(), ".agents", "skills");
const PI_BIN = process.env.PI_BIN ?? "pi";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 4_000;

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function loadConfig(): OrchestrationConfig {
	return readJson<OrchestrationConfig>(join(EXT_DIR, "orchestration.json"));
}

function loadPrompt(relPath: string): string {
	const abs = relPath.startsWith("/") ? relPath : join(EXT_DIR, relPath);
	return readFileSync(abs, "utf-8");
}

// ------------------------------------------------------------- child runner -

interface ChildResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
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
	proc?: ChildProcess;
}

let taskCounter = 0;
const backgroundTasks = new Map<string, BackgroundTask>();

function buildChildArgs(agent: AgentConfig, promptText: string): string[] {
	const args: string[] = ["--print", "--no-session"];

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

function spawnSubagent(
	agentName: string,
	agent: AgentConfig,
	brief: string,
	cwd: string,
	onProgress?: (tail: string) => void,
	signal?: AbortSignal,
): { promise: Promise<ChildResult>; proc: ChildProcess } {
	const promptText = loadPrompt(agent.systemPrompt);
	const args = buildChildArgs(agent, promptText);
	const proc = spawn(PI_BIN, args, {
		cwd,
		env: { ...process.env, PI_ORCHESTRATION_CHILD: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let stdoutBuf = "";
	proc.stdout!.setEncoding("utf-8");
	proc.stdout!.on("data", (chunk: string) => {
		stdout += chunk;
		stdoutBuf = (stdoutBuf + chunk).slice(-1000);
	});
	proc.stderr!.setEncoding("utf-8");
	proc.stderr!.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});

	const timeoutMs = agent.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
	}, timeoutMs);

	const interval = onProgress
		? setInterval(() => onProgress(stdoutBuf.slice(-400)), PROGRESS_INTERVAL_MS)
		: null;

	const promise = new Promise<ChildResult>((resolveP, rejectP) => {
		proc.on("error", (err) => {
			clearTimeout(timer);
			if (interval) clearInterval(interval);
			rejectP(new Error(`failed to spawn '${PI_BIN}': ${err.message}`));
		});
		proc.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (interval) clearInterval(interval);
			if (timedOut) {
				rejectP(new Error(`subagent ${agentName} timed out after ${timeoutMs}ms. Partial stdout:\n${stdout.slice(-4000)}`));
				return;
			}
			resolveP({ stdout, stderr, code, killed: signal !== null });
		});
	});

	if (signal) {
		const onCancel = () => proc.kill("SIGTERM");
		signal.addEventListener("abort", onCancel, { once: true });
		proc.on("exit", () => signal.removeEventListener("abort", onCancel));
	}

	// The brief goes in via stdin; a short message arg tells pi what to do with it.
	proc.stdin!.write(brief);
	proc.stdin!.end();

	return { promise, proc };
}

// --------------------------------------------------------------- extension -

export default function (pi: ExtensionAPI) {
	// Subagent children never get orchestration tools.
	if (process.env.PI_ORCHESTRATION_CHILD === "1") return;

	const config = loadConfig();

	// --- mode state ---------------------------------------------------------
	let mode: string = config.defaultMode && config.modes[config.defaultMode] ? config.defaultMode : "off";

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

	// Restore persisted mode from the session entries (survives /reload and resume).
	pi.on("session_start", async (_event, ctx) => {
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
			"- `task` — dispatch a self-contained brief to a subagent. Use `background: true` for independent lanes; you get a task id back.",
			"- `check_tasks` — poll background tasks: status while running, full result text once done (results are removed after reporting).",
			"- `cancel_task` — kill a running background task by id.",
			"- `question` — ask the user a blocking question (clarification, permission, choices, pasted output).",
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
		promptSnippet: "Dispatch a bounded, self-contained task to a specialist subagent (optionally in background)",
		promptGuidelines: [
			"Use task to delegate bounded specialist work instead of doing multi-step implementation yourself; write a self-contained brief (goal, inputs, constraints, return format).",
			"Use task with background: true for independent lanes, then collect results with check_tasks; use cancel_task only when a lane is obsolete.",
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
					description: "Run in the background and return a task id immediately. Collect results with check_tasks.",
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

			const startedAt = Date.now();
			const description = params.prompt.split("\n")[0].slice(0, 80);

			if (!params.background) {
				const { promise } = spawnSubagent(
					agentName,
					agent,
					params.prompt,
					ctx.cwd,
					(tail) =>
						onUpdate?.({
							content: [{ type: "text", text: `@${agentName} still working (${Math.round((Date.now() - startedAt) / 1000)}s). Recent output:\n${tail}` }],
						}),
					signal,
				);
				const result = await promise;
				const text = result.stdout.trim();
				if (!text) {
					throw new Error(
						`Subagent ${agentName} produced no output (exit code ${result.code}). Stderr tail: ${result.stderr.slice(-1500)}`,
					);
				}
				return {
					content: [{ type: "text", text }],
					details: { agent: agentName, exitCode: result.code, seconds: Math.round((Date.now() - startedAt) / 1000) },
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
			const { promise, proc } = spawnSubagent(agentName, agent, params.prompt, ctx.cwd, undefined, signal);
			entry.proc = proc;
			promise
				.then((result) => {
					entry.status = "done";
					entry.result = result.stdout.trim() || `(no output; exit code ${result.code}; stderr: ${result.stderr.slice(-500)})`;
				})
				.catch((err) => {
					entry.status = "error";
					entry.error = err instanceof Error ? err.message : String(err);
				});
			return {
				content: [
					{
						type: "text",
						text: `Background task ${id} started: @${agentName} — ${description}\nCollect the result with check_tasks (id: ${id}). Do not re-dispatch the same work.`,
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
			"Check background tasks. Returns each task's status, and the full result text for tasks that finished (finished results are removed after being reported). Omit ids to check all.",
		promptSnippet: "Check status/results of background task lanes",
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
					parts.push(`## ${id}\n@${t.agent} still running (${elapsed}s): ${t.description}`);
				} else if (t.status === "done") {
					parts.push(`## ${id} — @${t.agent} finished (${elapsed}s)\n\n${t.result}`);
					backgroundTasks.delete(id);
				} else if (t.status === "error") {
					parts.push(`## ${id} — @${t.agent} FAILED\n\n${t.error}`);
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
			lines.push("Modes: /orchestrator, /mathematician, /solo");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}