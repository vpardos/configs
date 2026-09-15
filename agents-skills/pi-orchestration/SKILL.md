---
name: pi-orchestration
description: Configure and improve this user's pi orchestration system (orchestrator + mathematician modes, specialist subagents, MCP bridge, question tool). Use when the user wants to tune agent models, add/remove subagents or modes, edit subagent prompts, add MCP servers, adjust per-agent skills/tool access, or when recurring workflow friction suggests a safe config or prompt improvement.
---

# pi Orchestration System — Configuration Skill

You help the user configure, customize, and safely improve their pi
orchestration setup: an oh-my-opencode-slim-style multi-agent system migrated
to pi.

The goal is not just to answer configuration questions. When useful, help the
user make their agent system better for future runs: tune models, adjust
agent prompts, add focused subagents, wire new MCP servers, and document
restart requirements.

## What This System Is

pi has no built-in subagents. This system is two pi extensions plus config:

| Piece | Location | Purpose |
|---|---|---|
| Orchestration extension | `~/.pi/agent/extensions/orchestration/` | Modes, `task`/`check_tasks`/`cancel_task`/`question` tools, subagent spawning |
| Orchestration config | `~/.pi/agent/extensions/orchestration/orchestration.json` | Modes, per-agent model/thinking/tools/skills/timeouts |
| Subagent prompts | `~/.pi/agent/extensions/orchestration/prompts/*.md` | One system prompt per lead agent and subagent |
| MCP bridge extension | `~/.pi/agent/extensions/mcp-bridge.ts` | Bridges stdio MCP servers as pi tools |
| MCP server list | `~/.pi/agent/mcp-servers.json` | Which MCP servers to spawn and their tool prefixes |
| Global skills | `~/.agents/skills/` | Shared skill pool (main agent + subagents) |
| Global settings | `~/.pi/agent/settings.json` | Packages, extra skill paths |
| Full docs | `~/.pi/agent/PI-CONFIGURATION.md` | How everything fits together + extension recipes |

Runtime model:

- The **main session** is the lead agent. A mode system prompt (orchestrator
  or mathematician) is appended to its system prompt by the extension.
- The `task` tool spawns an **isolated `pi --mode json` child process** per
  subagent, with the subagent's own model, thinking level, tool allowlist,
  skills, and system prompt. The child does **not** see the parent
  conversation — briefs must be self-contained.
- When a background lane finishes, its full result is **pushed to the lead
  automatically as a `task-finished` message** (waking it if idle). The lead
  must never sleep or poll; `check_tasks` is an on-demand lookup only.
- Live visibility: running lanes appear in a **widget above the editor**
  (current tool / thinking tail per lane), foreground task progress shows the
  same activity inline, every lane writes a **JSONL transcript** to
  `~/.pi/agent/subagent-logs/` (`tail -f` to watch), and `/subagents` shows
  live status + recent transcript paths.
- Children are marked `PI_ORCHESTRATION_CHILD=1`; the orchestration extension
  registers nothing inside children (no recursive delegation, no user
  prompts from leaves).
- `background: true` lanes are tracked in an in-memory job registry polled
  via `check_tasks` and killed via `cancel_task`.
- The `question` tool asks the user a blocking question (select or input).

## Modes

| Command | Mode | Subagents |
|---|---|---|
| `/orchestrator` | general coding workflow | oracle, librarian, explorer, designer, fixer, observer |
| `/mathematician` | math pipeline | observer-math, solver, writer |
| `/solo` | base agent, no delegation | — |
| `/orchestration` | status: mode, roster, running tasks | — |

The default mode is `orchestrator` (`defaultMode` in orchestration.json).
`PI_ORCHESTRATION_MODE=<mode>` overrides the startup mode for one run.
Mode choice is per-session and persisted in the session file; it survives
`/reload` and resume.

## Safe Improvement Rules

Configuration changes affect future agent behavior. Treat them as
user-owned.

1. **Ask before changing config or prompts.**
   - Explain the proposed improvement briefly.
   - State which file would change.
   - Ask for confirmation unless the user explicitly requested the exact
     edit.
2. **Prefer narrow changes.**
   - Do not rewrite large prompts when a small rule solves the problem.
   - Do not add subagents for one-off tasks.
3. **Preserve existing settings.**
   - Merge with current JSON rather than regenerating from scratch.
   - Keep the file valid JSON after editing (validate with a JSON parse).
4. **Avoid hidden behavior changes.**
   - Mention cost, tool-access, or delegation changes before applying them.
   - Be explicit if a model change increases spend.
5. **Tell the user about activation.**
   - Config/prompt changes apply on the next pi run; use `/reload` to apply
     immediately without restarting.

## Common Customizations

### Tune a subagent's model or thinking level

Edit `agents.<name>` in `~/.pi/agent/extensions/orchestration/orchestration.json`:

```jsonc
"oracle": {
  "model": "ollama-cloud/glm-5.3",
  "thinking": "max",
  ...
}
```

Use `pi --list-models` to see valid provider/model ids.

### Set or override a timeout

Every subagent has a hard deadline (`timeoutMs` in the agent entry; the `task`
tool's `timeout_ms` argument overrides it per call, clamped to 30s–1h). At the
deadline the child is killed and the lead gets the partial output in the
error. If one agent's provider stalls repeatedly, tighten its `timeoutMs` or
switch its model.

### Change a subagent's tool access

`toolMode: "allow"` → the listed tools are the strict allowlist passed as
`--tools` to the child. `toolMode: "exclude"` → everything except the listed
tools (`--exclude-tools`). Use `exclude` when the agent should keep MCP/web
tools; use `allow` for hermetic built-in-only agents.

### Change a subagent's skills

`skills: ["*"]` → all discovered skills; `[]` → none; a name list → exactly
those skills, resolved from `~/.agents/skills/<name>` (or absolute paths).

### Append behavior rules to a lead agent or subagent

Edit the relevant `prompts/*.md` file directly (e.g.
`prompts/orchestrator.md`, `prompts/solver.md`). Keep edits small and
targeted; these files are the single source of the agent's behavior.

### Add a new subagent

1. Add an entry under `agents` in `orchestration.json` (model, thinking,
   systemPrompt path, tools, skills, timeoutMs, description).
2. Create `prompts/<name>.md` with the subagent's system prompt.
3. Add the name to the appropriate `modes.<mode>.agents` array.
4. `/reload` (or restart pi).

See PI-CONFIGURATION.md for the full recipe, including new modes and new MCP
servers.

## Verification Checklist

After any change:

- [ ] JSON files still parse (`python3 -m json.tool <file>` or equivalent).
- [ ] Model ids exist (`pi --list-models`).
- [ ] Skill names exist under `~/.agents/skills/`.
- [ ] Referenced prompt files exist.
- [ ] User was told how to activate the change (`/reload` or restart).
- [ ] `/orchestration` in a live session shows the expected roster.