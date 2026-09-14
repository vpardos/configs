# PI Configuration — Orchestration, Subagents & MCP System

This document explains the agent infrastructure installed in this pi
instance and how another agent (or the user) can extend it. It was migrated
from an opencode setup (oh-my-opencode-slim + a custom mathematician agent)
to pi's extension model.

Everything here lives under `~/.pi/agent/` (global) and `~/.agents/skills/`
(shared skills). Reload everything with `/reload` inside a running pi
session, or restart pi.

---

## 1. System map

| Path | What it is |
|---|---|
| `~/.pi/agent/settings.json` | Global settings: packages (`npm:pi-ollama-cloud`), extra skill paths (`/home/vpardos/open-design/skills`) |
| `~/.pi/agent/extensions/mcp-bridge.ts` | Bridges stdio MCP servers into pi as custom tools (eager connect at startup) |
| `~/.pi/agent/mcp-servers.json` | MCP server registry (command, enabled, toolPrefix) |
| `~/.pi/agent/extensions/orchestration/index.ts` | Orchestration extension: modes, `task`/`check_tasks`/`cancel_task`/`question` tools |
| `~/.pi/agent/extensions/orchestration/orchestration.json` | Modes + subagent definitions (model, thinking, tools, skills, timeouts, prompts) |
| `~/.pi/agent/extensions/orchestration/prompts/*.md` | System prompts: 2 lead agents + 9 subagents |
| `~/.agents/skills/` | Global skill pool used by the main agent and subagents |
| `~/.pi/agent/npm/` | User-scoped pi packages (pi-ollama-cloud: ollama-cloud provider + `ollama_web_search`/`ollama_web_fetch` tools) |

### Runtime model

- pi has **no native subagents**. This system implements them with two
  building blocks:
  1. **Mode system prompts** — `/orchestrator` and `/mathematician` append a
     lead-agent prompt plus a subagent roster to the *main session's* system
     prompt (via the `before_agent_start` event).
  2. **Child-process subagents** — the `task` tool spawns an isolated
     `pi --print --no-session` child per dispatch, configured with the
     subagent's own model, thinking level, tool allowlist, skills, and
     system prompt. Children do **not** see the parent conversation.
- Children run with `PI_ORCHESTRATION_CHILD=1` in their environment. The
  orchestration extension **registers nothing** when it sees that variable,
  so subagents never get `task`/`check_tasks`/`cancel_task`/`question`
  (no recursive delegation, no user prompts from leaves). Preserve this
  contract if you touch the extension.
- Background lanes (`task ... background: true`) are tracked in an in-memory
  registry (lost on restart — by design) and managed with `check_tasks` /
  `cancel_task`.
- **Timeouts**: every subagent run has a hard deadline (`timeoutMs` per agent,
  or the `timeout_ms` argument on the `task` call, clamped to 30s–1h). At the
  deadline the child gets SIGTERM (SIGKILL after 10s if stuck), and the lead
  receives the partial stdout + stderr tail in the error. Foreground task
  progress updates every 5s show elapsed time, the deadline countdown, and
  any child stderr (e.g. provider errors). Note: print-mode stdout is buffered
  until the child finishes, so "no output yet" in progress is normal — there
  is deliberately no inactivity watchdog (it would kill healthy long runs).
- The `question` tool asks the user a blocking question (bounded options →
  select dialog; otherwise free-form input). It works in interactive and RPC
  modes; in print/JSON mode it errors and tells the agent to proceed with
  stated assumptions.

### Modes

| Command | Mode | Lead prompt | Subagents |
|---|---|---|---|
| `/orchestrator` | general coding workflow | `prompts/orchestrator.md` | oracle, librarian, explorer, designer, fixer, observer |
| `/mathematician` | math pipeline (observer-math → solver → writer) | `prompts/mathematician.md` | observer-math, solver, writer |
| `/solo` | base agent, no delegation | — | — |
| `/orchestration` | status: mode, roster, running lanes | — | — |

Default mode: `orchestrator` (set `defaultMode` in orchestration.json). The env var
`PI_ORCHESTRATION_MODE=<mode>` overrides the startup mode for one run (also
handy for scripted sessions; invalid names fall back to "off").
Mode choice persists per session (custom session entry `orchestration-mode`)
and survives `/reload` and resume.

### Subagent roster (opencode-go preset models)

| Agent | Model | Thinking | Access | Skills |
|---|---|---|---|---|
| oracle | ollama-cloud/glm-5.3 | max | read-only built-ins | simplify |
| librarian | ollama-cloud/deepseek-v4-flash:0731 | high | everything except edit/write/question (keeps web + MCP) | — |
| explorer | ollama-cloud/nemotron-3-nano:30b | max | read, grep, find, ls | — |
| designer | ollama-cloud/glm-5.3-flash | max | read, edit, write, bash, grep, find, ls | — |
| fixer | ollama-cloud/deepseek-v4-flash:0731 | max | read, edit, write, bash, grep, find, ls | — |
| observer | ollama-cloud/minimax-m3 | max | read, bash, grep, find, ls (vision) | — |
| observer-math | ollama-cloud/minimax-m3 | max | everything except edit/question (vision, pdf2img) | pdf2img |
| solver | ollama-cloud/glm-5.3 | max | everything except edit/question (keeps write for scratchpads) | math-olympiad, math-reasoning |
| writer | ollama-cloud/glm-5.3-flash | max | everything except question | typst, math-reasoning, math-olympiad |

### MCP servers (bridged tools)

Tool naming: `<toolPrefix>_<mcp-tool-name>`.

| Server | Command | Prefix | Tools |
|---|---|---|---|
| hound | `hound` | `hound_` | hound_mcp_smart_search, hound_mcp_smart_fetch, hound_mcp_smart_crawl, hound_mcp_screenshot, hound_cache_clear, hound_version |
| open-design | `node /home/vpardos/open-design/apps/daemon/bin/od.mjs mcp --daemon-url http://127.0.0.1:7456` | `opendesign_` | 19 tools: list_projects, get_artifact, start_run, get_run, … |

`/mcp` shows live bridge status. open-design tools require the daemon
running on port 7456.

---

## 2. How to extend the system

### 2.1 Add a new subagent

1. **Create the prompt**: `~/.pi/agent/extensions/orchestration/prompts/<name>.md`.
   Rules that make subagents work well:
   - State the role, capabilities, behavior, and output format explicitly.
   - State the constraints (read-only? leaf? no web?). The prompt is the only
     behavioral control the child has beyond its tool allowlist.
   - Keep output formats structured (`<summary>…</summary>` blocks or
     Markdown contracts) so the lead agent can verify them.
2. **Register it** in `~/.pi/agent/extensions/orchestration/orchestration.json`
   under `agents`:

   ```json
   "api-reviewer": {
     "description": "Reviews API design, compat, and migration risk. READ-ONLY.",
     "model": "ollama-cloud/glm-5.3",
     "thinking": "high",
     "systemPrompt": "prompts/api-reviewer.md",
     "tools": ["read", "bash", "grep", "find", "ls"],
     "toolMode": "allow",
     "skills": [],
     "timeoutMs": 900000
   }
   ```

   Field reference:

   | Field | Meaning |
   |---|---|
   | `model` | `"provider/model-id"` — must exist (`pi --list-models`). Split into `--provider`/`--model` for the child (colon in a model id is safe) |
   | `thinking` | `off, minimal, low, medium, high, xhigh, max` |
   | `systemPrompt` | path relative to the extension dir |
   | `tools` + `toolMode` | `allow` → strict `--tools` allowlist; `exclude` → `--exclude-tools`. Use `exclude` when the agent should keep web/MCP tools |
   | `skills` | `["*"]` all, `[]` none (`--no-skills`), or exact names resolved from `~/.agents/skills/<name>` |
   | `timeoutMs` | child killed with SIGTERM (then SIGKILL after 10s) at this deadline; the error returned to the lead includes partial stdout + stderr tail (default 600000; live override via the `task` tool's `timeout_ms` param, clamped to 30s–1h) |

3. **Wire it into a mode**: add `"api-reviewer"` to
   `modes.orchestrator.agents` (or `modes.mathematician.agents`, or a new
   mode). Only agents listed in the active mode can be dispatched — the
   `task` tool validates the `agent` argument against the mode roster.
4. **Reload**: `/reload` (or restart pi). Verify with `/orchestration`.

Optionally document when the lead should route to it: add a routing rule to
the lead prompt (`prompts/orchestrator.md`) — e.g. the existing
"Never handle UI/design work directly — always route to @designer" rule.

### 2.2 Add a new mode (a new lead orchestrator)

1. Write `prompts/<mode>.md` for the lead agent. Model it on
   `prompts/mathematician.md`: role, subagent table, delegation rules,
   verification of subagent output, failure recovery.
2. Add to `orchestration.json`:

   ```json
   "modes": {
     "security-reviewer": {
       "label": "Security review workflow",
       "systemPrompt": "prompts/security-reviewer.md",
       "agents": ["oracle", "explorer", "fixer"],
       "model": "ollama-cloud/glm-5.3",
       "thinking": "high"
     }
   }
   ```

   `model`/`thinking` are the *suggested* main-session model — the extension
   does not force it (the user picks with `/model`).
3. Register a command for it in `index.ts` (copy the `/mathematician`
   handler, change the mode name), then `/reload`.

### 2.3 Add an MCP server

1. Edit `~/.pi/agent/mcp-servers.json`:

   ```json
   "context7": {
     "command": ["npx", "-y", "@upstash/context7-mcp"],
     "enabled": true,
     "toolPrefix": "context7",
     "description": "Official docs lookup for libraries"
   }
   ```

2. `/reload` (or restart). The bridge spawns the server at startup, does the
   JSON-RPC handshake, and registers every tool it lists as
   `<toolPrefix>_<name>`.
3. Verify with `/mcp`.

Notes:
- Set `"enabled": false` to keep a server configured but disconnected.
- `connectTimeoutMs` (default 15000) guards startup; `callTimeoutMs`
  (default 600000) guards each tool call.
- If the server is a stdio JSON-RPC MCP server, no other work is needed.
  Non-stdio transports (HTTP/SSE) would require extending `mcp-bridge.ts`
  (the client is a small stdio JSON-RPC loop — swap the transport).
- Bridged tools are automatically available to the main agent **and** all
  subagents whose toolMode isn't a strict `allow` list.

### 2.4 Add or change skills

- **Install a skill**: create `~/.agents/skills/<name>/SKILL.md` (frontmatter
  with `name` + `description`, per the Agent Skills standard). It is picked
  up by the main agent and by any subagent whose `skills` includes it.
- **Scope a skill to a subagent**: list it in that agent's `skills` array in
  orchestration.json. Skill names resolve from `~/.agents/skills/`; absolute
  paths are also accepted.
- **Extra skill directories**: add paths to the `skills` array in
  `~/.pi/agent/settings.json` (e.g. the existing
  `/home/vpardos/open-design/skills` entry).

### 2.5 Change the question tool

The `question` tool is registered in
`~/.pi/agent/extensions/orchestration/index.ts`. Its behavior: 1–8 options →
`ctx.ui.select`; no options → `ctx.ui.input`; no UI (print/JSON mode) →
error telling the agent to proceed with stated assumptions. Keep it
blocking-only — it is for work-stopping questions, not chat.

---

## 3. Invariants — do not break these

1. **`PI_ORCHESTRATION_CHILD=1` guard**: the first line of the orchestration
   extension's factory must bail in child processes. Breaking this gives
   subagents the `task` tool (infinite delegation) and `question` (leaf
   agents blocking on the user).
2. **`--no-session` on children**: subagent runs are ephemeral by design;
   removing it pollutes the user's session list.
3. **Mode-validated dispatch**: the `task` tool rejects agents not in the
   active mode's roster. When adding an agent, always add it to a mode.
4. **Briefs are the only context**: children never see the parent
   conversation. Lead prompts must keep demanding self-contained briefs.
5. **MCP tool naming**: `<prefix>_<tool>` — prompts reference these names
   (e.g. `hound_mcp_smart_search` in librarian/mathematician prompts). If you
   change a prefix, grep the prompts.

## 4. Testing checklist after changes

```bash
# 1. JSON validity
python3 -m json.tool ~/.pi/agent/settings.json > /dev/null
python3 -m json.tool ~/.pi/agent/mcp-servers.json > /dev/null
python3 -m json.tool ~/.pi/agent/extensions/orchestration/orchestration.json > /dev/null

# 2. Extensions load (should print a trivial reply, no extension errors)
echo "Reply with exactly: OK" | pi --print --no-session --thinking off --

# 3. Tools visible to the main agent (expect MCP + task/check_tasks/cancel_task/question)
pi --print --no-session --thinking off --system-prompt \
  "List the names of ALL tools available to you, one per line, nothing else." -- <<< "List tools."

# 4. Subagent dispatch (simulate exactly what the task tool runs)
SP=$(cat ~/.pi/agent/extensions/orchestration/prompts/explorer.md)
echo "Where is the main function in this repo? One sentence." | \
  PI_ORCHESTRATION_CHILD=1 pi --print --no-session \
  --provider ollama-cloud --model nemotron-3-nano:30b --thinking max \
  --tools read,grep,find,ls --no-skills --system-prompt "$SP" --
```

Interactive checks: `/mcp` (bridge status), `/orchestration` (mode + roster),
then dispatch a real task in-session.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `Unknown provider` in a subagent | Model id typo in orchestration.json; check `pi --list-models` |
| Extension load error at startup | Run `pi -ne` to start clean, then re-enable extensions one at a time; check the hinted file |
| Subagent "produced no output" | Child crashed — rerun the Testing checklist step 4 manually and read the stderr tail included in the error |
| MCP tools missing | `/mcp` shows per-server status; check the command in mcp-servers.json runs manually |
| `task` says "No orchestration mode is active" | Session started in `/solo`; run `/orchestrator` or `/mathematician` |
| open-design tools error | Daemon not running on `http://127.0.0.1:7456`; start it and `/reload` |
| Subagent timed out and was killed | Usually a provider stall (rate limit / network) or an oversized brief. Re-dispatch with a tighter brief, a smaller `timeout_ms`, or `background: true` so the lane cannot block the turn |
| Subagent "didn't respond" for minutes | Check the progress countdown + child stderr shown while running; if the provider stalls repeatedly for one agent, switch its `model` in orchestration.json to a more reliable one |
| Background task vanished after restart | In-memory registry by design; re-dispatch |

## 6. Provenance

Migrated from opencode (`~/.config/opencode/`):

- **oh-my-opencode-slim** (opencode-go preset) → orchestrator + oracle,
  librarian, explorer, designer, fixer, observer, with their original
  prompts (adapted to pi's tool set) and models.
- **mathematician agent** (opencode.json) → `/mathematician` mode +
  observer-math, solver, writer with their original prompts and models.
- **MCP servers** hound + open-design → mcp-bridge extension.
- **Skills** → `~/.agents/skills/` (clonedeps, codemap, deepwork, pdf2img,
  reflect, simplify, verification-planning, worktrees were copied;
  impeccable/math-olympiad/math-reasoning/typst were already installed;
  the oh-my-opencode-slim config skill became the `pi-orchestration` skill;
  the mathematician skill's agent prompts became orchestration prompts).
- opencode's `smart_search`/`smart_fetch`/`webfetch` MCP references in
  prompts → `hound_mcp_smart_search`, `hound_mcp_smart_fetch`,
  `ollama_web_fetch`.