/**
 * mcp-bridge.ts — Bridge stdio MCP servers into pi as custom tools.
 *
 * Config: ~/.pi/agent/mcp-servers.json
 *   { "servers": { "<name>": { "command": [...], "enabled": true, "toolPrefix": "<prefix>" } } }
 *
 * Each MCP tool becomes a pi tool named `<toolPrefix>_<mcpToolName>`
 * (e.g. hound + mcp_smart_search -> hound_mcp_smart_search).
 *
 * Connections are established eagerly during extension load (awaited in the
 * async factory) so bridged tools are registered before the session system
 * prompt is built. A hung server can block startup, so each connect has a
 * hard timeout (default 15s).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ServerConfig {
	command: string[];
	enabled?: boolean;
	toolPrefix?: string;
	description?: string;
	connectTimeoutMs?: number;
	callTimeoutMs?: number;
}

interface BridgesConfig {
	servers: Record<string, ServerConfig>;
}

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

const CONNECT_TIMEOUT_MS_DEFAULT = 15_000;
const CALL_TIMEOUT_MS_DEFAULT = 10 * 60_000;

function loadConfig(): BridgesConfig {
	const path = join(homedir(), ".pi", "agent", "mcp-servers.json");
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (raw && typeof raw === "object" && raw.servers) return raw as BridgesConfig;
	} catch (err) {
		console.error(`[mcp-bridge] Failed to read ${path}: ${err}`);
	}
	return { servers: {} };
}

class McpServerError extends Error {}

/** One stdio JSON-RPC connection to an MCP server. */
class McpServerConn {
	readonly name: string;
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
	>();
	private stdoutBuf = "";
	private stderrBuf = "";
	closed = false;
	lastError = "";

	constructor(name: string, private config: ServerConfig) {
		this.name = name;
	}

	private spawn() {
		const proc = spawn(this.config.command[0], this.config.command.slice(1), {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		this.proc = proc;
		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", (chunk: string) => {
			this.stderrBuf = (this.stderrBuf + chunk).slice(-2000);
		});
		proc.on("error", (err) => this.failAll(new McpServerError(`spawn error: ${err.message}`)));
		proc.on("exit", (code, signal) => {
			this.closed = true;
			this.failAll(
				new McpServerError(
					`MCP server "${this.name}" exited (code=${code} signal=${signal})${
						this.stderrBuf ? `; stderr tail: ${this.stderrBuf}` : ""
					}`,
				),
			);
		});
	}

	private onStdout(chunk: string) {
		this.stdoutBuf += chunk;
		// Newline-delimited JSON-RPC over stdio.
		let idx: number;
		while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
			const line = this.stdoutBuf.slice(0, idx).trim();
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (p.timer) clearTimeout(p.timer);
				if (msg.error) {
					p.reject(new McpServerError(msg.error.message || JSON.stringify(msg.error)));
				} else {
					p.resolve(msg.result);
				}
			}
			// Notifications (logs etc.) are ignored.
		}
	}

	private failAll(err: Error) {
		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
		if (this.closed || !this.proc || this.proc.killed) {
			return Promise.reject(
				new McpServerError(`MCP server "${this.name}" is not running${this.lastError ? ` (${this.lastError})` : ""}`),
			);
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new McpServerError(`MCP request ${method} to "${this.name}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}

	async start(): Promise<void> {
		this.spawn();
		const connectTimeout = this.config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS_DEFAULT;
		await this.request(
			"initialize",
			{
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pi-mcp-bridge", version: "1.0.0" },
			},
			connectTimeout,
		);
		this.proc!.stdin!.write(
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
		);
	}

	async listTools(): Promise<McpToolDef[]> {
		const result = await this.request("tools/list", {}, 30_000);
		const tools = result?.tools;
		return Array.isArray(tools) ? tools : [];
	}

	callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<any> {
		const callTimeout = this.config.callTimeoutMs ?? CALL_TIMEOUT_MS_DEFAULT;
		const pending = this.request("tools/call", { name: toolName, arguments: args }, callTimeout);
		if (signal) {
			const onCancel = () => {
				// Ask the server to cancel in-flight requests (best-effort).
				for (const [pid] of this.pending) {
					this.proc?.stdin?.write(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "notifications/cancelled",
							params: { requestId: pid },
						}) + "\n",
					);
				}
			};
			signal.addEventListener("abort", onCancel, { once: true });
			pending.finally(() => signal.removeEventListener("abort", onCancel));
		}
		return pending;
	}

	stop() {
		this.closed = true;
		this.failAll(new McpServerError("shutting down"));
		if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
	}
}

/** Convert an MCP result into pi tool-result content entries. */
function mcpResultToContent(result: any): any[] {
	const content: any[] = [];
	const items: any[] = Array.isArray(result?.content) ? result.content : [];
	for (const item of items) {
		if (item?.type === "text" && typeof item.text === "string") {
			content.push({ type: "text", text: item.text });
		} else if (item?.type === "image" && typeof item.data === "string") {
			content.push({
				type: "image",
				source: { type: "base64", mediaType: item.mimeType || "image/png", data: item.data },
			});
		} else if (item?.type === "resource") {
			const text =
				typeof item.resource?.text === "string"
					? item.resource.text
					: JSON.stringify(item.resource ?? item);
			content.push({ type: "text", text: `[resource ${item.resource?.uri ?? ""}]\n${text}` });
		} else {
			content.push({ type: "text", text: JSON.stringify(item) });
		}
	}
	if (content.length === 0) content.push({ type: "text", text: JSON.stringify(result ?? {}) });
	return content;
}

function schemaToTypebox(schema: unknown) {
	if (!schema || typeof schema !== "object") return Type.Object({});
	// MCP input schemas are JSON Schema; Type.Unsafe passes them through as-is.
	return Type.Unsafe(schema);
}

function sanitizeToolName(s: string): string {
	return s.replace(/[^a-zA-Z0-9_]/g, (c) => (c === "-" || c === " " ? "_" : "")).toLowerCase();
}

export default async function (pi: ExtensionAPI) {
	const config = loadConfig();
	const conns = new Map<string, McpServerConn>();
	const statuses = new Map<string, string>();
	const serverOfTool = new Map<string, { conn: McpServerConn; mcpTool: string }>();

	for (const [serverName, sc] of Object.entries(config.servers)) {
		if (sc.enabled === false) {
			statuses.set(serverName, "disabled");
			continue;
		}
		const prefix = sanitizeToolName(sc.toolPrefix ?? serverName);
		const conn = new McpServerConn(serverName, sc);
		conns.set(serverName, conn);
		try {
			await conn.start();
			const tools = await conn.listTools();
			for (const tool of tools) {
				const piName = `${prefix}_${sanitizeToolName(tool.name)}`;
				serverOfTool.set(piName, { conn, mcpTool: tool.name });
				const desc =
					(tool.description || `MCP tool ${tool.name} from server ${serverName}`).slice(0, 2048) +
					`\n(MCP server: ${serverName})`;
				pi.registerTool({
					name: piName,
					label: `${serverName}: ${tool.name}`,
					description: desc,
					promptSnippet: `${piName} — ${sc.description ?? serverName}`,
					parameters: schemaToTypebox(tool.inputSchema),
					async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
						if (signal?.aborted) throw new McpServerError("aborted before call");
						const result = await conn.callTool(tool.name, params, signal);
						if (signal?.aborted) throw new McpServerError("aborted");
						const content = mcpResultToContent(result);
						if (result?.isError) {
							const text = content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n");
							throw new McpServerError(text || "MCP tool reported an error");
						}
						return { content, details: { server: serverName, mcpTool: tool.name } };
					},
				});
			}
			statuses.set(serverName, `connected (${tools.length} tools)`);
		} catch (err) {
			conn.lastError = String(err);
			statuses.set(serverName, `failed: ${err instanceof Error ? err.message : String(err)}`);
			conn.stop();
		}
	}

	pi.on("session_shutdown", async () => {
		for (const conn of conns.values()) conn.stop();
	});

	pi.registerCommand("mcp", {
		description: "Show MCP bridge status (servers and bridged tools)",
		handler: async (_args, ctx) => {
			const lines = [`MCP servers (config: ~/.pi/agent/mcp-servers.json)`];
			for (const [name, status] of statuses) lines.push(`  ${name}: ${status}`);
			const tools = [...serverOfTool.keys()];
			if (tools.length) lines.push(`Bridged tools (${tools.length}): ${tools.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}