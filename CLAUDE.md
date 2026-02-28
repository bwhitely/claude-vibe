# VIBE — Autonomous Project Builder for Claude Code

This file defines the `/vibe` command system: a multi-agent pipeline that takes a single goal and produces a fully implemented, tested, documented, and optionally deployed project with minimal human intervention.

---

## Command

```
/vibe "<goal>"
```

**Example:**
```
/vibe "build a modern CRM that rivals HubSpot"
```

Optional project-level config (gitignored):
```
.vibe-deploy.json   — deploy targets, MCP auth preferences, auto-deploy flag
```

---

## Invocation Modes

### `/vibe "goal"` — build from scratch

The standard mode. Takes a natural language goal and builds a complete project from zero.

### `/vibe continue` — resume or improve an existing project

Run inside an existing project directory. Behaviour depends on pipeline state:

**If `.vibe/state.json` exists and has incomplete phases** — resumes the interrupted pipeline exactly as described in the Resumption section. No prompt, no confirmation, just continues.

**If `.vibe/state.json` exists and `status` is `complete`** — the project was previously finished. The orchestrator runs an orientation pass before re-entering the Critic loop:

1. Read `state.json`, `prd.md`, `architecture.md`, and the git log summary (last 20 vibe commits) to reconstruct project context
2. Read any user-provided continuation note from `.vibe/continue.md` if present (see below)
3. Re-enter at phase 8 (Critic) with full project context, treating the entire codebase diff since the last vibe session as the input diff

**If no `.vibe/` directory exists** — the orchestrator infers project intent from `README.md`, `package.json`, and top-level source structure, synthesises a minimal `prd.md`, scaffolds `.vibe/`, and enters at the Critic. Useful for retrofitting vibe onto an existing project.

### `.vibe/continue.md` — optional continuation context

Drop this file before running `/vibe continue` to give the pipeline focused direction:

```markdown
## What to improve
- Add rate limiting to all API endpoints
- The contacts search is slow on large datasets
- UX feedback: the dashboard feels cluttered

## Known issues
- Auth token refresh is broken on mobile
- Email notifications not sending in production
```

The orchestrator reads this file at the start of a `continue` run and injects the relevant sections into the Critic and Implementer context. After the run completes, `.vibe/continue.md` is archived to `.vibe/logs/continue_<timestamp>.md` and cleared, so it doesn't bleed into future sessions.

---

## Bootstrap Sequence

When `/vibe "goal"` is first invoked, the orchestrator performs these steps **before any agent runs**:

**1. Initialise git repo if not already present**
```bash
git init && git add . && git commit -m "chore(vibe): initialise project"
```

**2. Scaffold `.vibe/` directory structure** — create all directories and an empty `state.json`:
```json
{
  "goal": "<user goal>",
  "phase": 0,
  "status": "initialising",
  "started_at": "<ISO timestamp>",
  "iterations": { "critic_fixer": 0, "max_critic_fixer": 3 },
  "gates": { "prd_coverage": null, "test_coverage": null, "critic_score": null, "security": null, "performance": null },
  "thresholds": { "test_coverage": 70, "critic_score": 80, "prd_required_coverage": 100, "prd_nicetohave_coverage": 80 },
  "token_warning_threshold": 8000,
  "detected_features": {},
  "token_totals": { "in": 0, "out": 0 },
  "agents": {}
}
```

**3. Install UI dependencies** (once only — skip if `node_modules` already present):
```bash
cd .vibe/ui && npm install
```

**4. Boot the UI monitor:**
```bash
node .vibe/ui/server.js &
echo "VIBE monitor running at http://localhost:4242"
```

**5. Commit scaffold:**
```bash
git add .vibe/ && git commit -m "chore(vibe): scaffold .vibe directory"
```

**6. Begin pipeline at phase 1 (Research).**

The orchestrator owns this entire sequence. Claude Code should not prompt the user at any point during bootstrap.

---

## Resumption

Handled by `/vibe continue` — see Invocation Modes above for full behaviour.

**Partial phase rollback:** If an agent was `running` at interruption its status in `state.json` will be `running` rather than `passed` or `failed`. The orchestrator resets it to `pending` and reruns it from the beginning of that phase. Partial work is discarded via `git checkout` back to the most recent clean vibe commit — identified by scanning git log for the last commit with a `[vibe-agent: ...]` trailer from a `passed` agent.

**What is never re-run:** Any phase with status `passed` in `state.json`. Skipped entirely — no token spend on completed work.

---

## Principles

- **Token efficiency is non-negotiable.** Every agent receives the minimum context required for its task. No agent reads the full codebase unless its job explicitly requires it. Prefer diffs over full files. Prefer summaries over raw artifacts where fidelity is not lost.
- **Agents are isolated processes, not subagents.** Every agent is invoked as a fresh headless `claude -p` process. Never use Claude Code's Task tool to spawn subagents within the same conversation thread — doing so inherits the full conversation context and defeats all token efficiency rules.
- **Structured over verbose.** Agent outputs are typed artifacts (markdown or JSON), not freeform prose. The orchestrator reads structure, not narrative.
- **One-shot output only.** Every agent is instructed to produce its full output in a single response. No clarifying questions, no preamble, no "here's my plan." If output is malformed, the orchestrator retries once with the parse error appended — it does not continue a conversation.
- **Every unit of work is committed.** No agent completes a phase without a structured git commit.
- **All decisions are logged.** Every agent action, token count, decision rationale, and gate result is appended to an audit log.
- **Done is defined, not felt.** Completion is determined by explicit gates, not agent self-assessment.
- **Deployment is always user-confirmed.** No agent pushes to production without explicit user choice.
- **Skills are quality multipliers, not defaults.** Claude skills are injected selectively based on project type. Injecting a skill adds tokens — only do it where the quality uplift justifies the cost.

---

## Directory Structure

The orchestrator initialises this structure before any agent runs:

```
.vibe/
  state.json                    # pipeline status, gate results, iteration counts
  logs/
    agent_actions.jsonl         # append-only audit log
    continue_<timestamp>.md     # archived continuation notes
  continue.md                   # optional user-provided context for /vibe continue (gitignored)
  artifacts/
    research.md
    prd.md
    architecture.md
    threat_model.md
    ux_spec.md
    review_findings.md
    security_findings.md
    performance_findings.md
    done_report.md
    deploy_options.md
  context/                      # orchestrator-constructed per-agent inputs (ephemeral, not committed)
    <agent>_input.md            # slim context built by orchestrator before each invocation
  prompts/                      # agent system prompts (committed, loaded at invocation time)
    01_research.md
    02_analyst.md
    03_architect.md
    04_security_planner.md
    05_ux_designer.md
    06_implementer.md
    07_test_writer.md
    08_critic.md
    09_fixer.md
    10_security_auditor.md
    10b_performance_agent.md
    11_completeness_judge.md
    12_documenter.md
    13_deployer.md
  ui/                           # local monitor server (committed)
    server.js                   # Express SSE server, watches state.json + agent_actions.jsonl
    index.html                  # single-file React app, no build step
    package.json
```

`.vibe/` is committed to the repo. `.vibe/context/` is gitignored (ephemeral working files). `.vibe-deploy.json` is gitignored.

---

## Agent Roster

Agents run in order. Some loop. Each has a defined input contract, output artifact, and commit requirement.

---

### 1. Research Agent

**Goal:** Survey the competitive landscape and establish feature expectations for the goal domain.

**Input contract:**
- User goal string only

**Actions:**
- Use web search MCP (if available) to research top competitors in the domain
- Identify must-have features (present in >80% of competitors)
- Identify differentiating features worth including
- Surface common user complaints from review sites, Reddit, HN
- Note current technology standards for the domain

**Output:** `.vibe/artifacts/research.md`

```markdown
## Competitive Landscape
...
## Must-Have Features
- [FEAT-001] ...
## Differentiating Opportunities
...
## Common User Pain Points
...
## Tech Standards
...
```

**Token budget:** User goal only as input. Do not load any prior artifacts.

---

### 2. Analyst Agent

**Goal:** Produce a structured PRD with uniquely identified, prioritised requirements.

**Input contract:**
- `.vibe/artifacts/research.md` (full)
- User goal string

**Actions:**
- Define functional requirements tagged `REQ-F-001`, `REQ-F-002`...
- Define non-functional requirements tagged `REQ-NF-001`...
- Mark each requirement as `required` or `nice-to-have`
- Define the MVP scope explicitly — **cap MVP at 12 `required` functional requirements maximum**. If the goal demands more, promote only the highest-value 12 and defer the rest to a `post-mvp` bucket in the PRD.
- List explicitly out-of-scope items
- **Keep the entire PRD under 800 tokens.** Requirements are one-liners, not paragraphs.

**Output:** `.vibe/artifacts/prd.md`

**Token budget:** research.md + goal only.

---

### 3. Architect Agent

**Goal:** Define the technical architecture, stack, and data model.

**Input contract:**
- `.vibe/artifacts/prd.md` — requirements and MVP scope only (omit raw feature descriptions if redundant)

**Actions:**
- Choose stack with rationale tied to requirements
- Define service boundaries and responsibilities
- Produce entity/data model
- Define API surface at the interface level (not implementation)
- Specify infrastructure requirements

**Output:** `.vibe/artifacts/architecture.md`

**Token budget:** prd.md summary (~600 tokens max). Architect should request only REQ IDs + descriptions, not full PRD prose.

---

### 4. Security Planner Agent

**Goal:** Define the security posture before a line of code is written.

**Input contract:**
- `.vibe/artifacts/architecture.md` — interfaces and data flows section only

**Actions:**
- Identify attack surface
- Define authentication and authorisation strategy
- Flag sensitive data flows requiring encryption or special handling
- Produce security requirements that feed into implementation

**Output:** `.vibe/artifacts/threat_model.md`

**Token budget:** Architecture interfaces/data flows only (~400 tokens).

---

### 5. UX Designer Agent

**Goal:** Define user flows, screen inventory, and component hierarchy before implementation begins.

**Input contract:**
- `.vibe/artifacts/prd.md` — functional requirements only
- `.vibe/artifacts/architecture.md` — API surface section only

**Actions:**
- List all screens/views
- Define primary user flows as numbered steps
- Define component hierarchy per screen
- Note key UX decisions and rationale

**Output:** `.vibe/artifacts/ux_spec.md`

**Token budget:** REQ-F list + API surface (~500 tokens).

---

### 6. Implementer Agent

**Goal:** Write the application code iteratively, diff-aware.

**Input contract (initial pass):**
- `.vibe/artifacts/architecture.md` (full)
- `.vibe/artifacts/threat_model.md` (full)
- `.vibe/artifacts/ux_spec.md` (full)

**Input contract (subsequent passes — fixer loop):**
- `.vibe/artifacts/review_findings.md` — blocking issues only
- Git diff of files relevant to those issues only

**Actions:**
- Implement per architecture, respecting security requirements and UX spec
- Do not gold-plate beyond MVP scope unless a REQ explicitly requires it
- Write clean, modular code — no unnecessary comments, no boilerplate padding
- Each logical unit of work (service, module, feature) gets its own commit before moving on
- **After the initial pass: run the application and verify it boots without errors.** If it fails to start, fix it before signalling completion. This is a hard requirement — a codebase that doesn't run is not a completed phase.

**Smoke test contract:** Execute the project's start command (inferred from `package.json`, `Makefile`, `docker-compose.yml`, etc.). The app must start and respond to a health check or root request within 30 seconds. Log the result to `agent_actions.jsonl` under `"smoke_test": "passed|failed"`.

**Token budget:** Full artifacts on first pass only. All subsequent passes use targeted diffs + findings. Never re-read unchanged files.

---

### 7. Test Writer Agent

**Goal:** Produce a test suite that enforces a coverage gate.

**Input contract:**
- Public interfaces and exported functions (extracted, not full files)
- Existing test file patterns if any exist (structure only)

**Actions:**
- Write unit tests for all public interfaces
- Write integration tests for critical flows
- Coverage gate: **70% minimum** (configurable in `state.json`)
- Do not test implementation details — test behaviour

**Output:** Test files committed to repo

**Token budget:** Public interfaces only. Do not load implementation files unless resolving a specific ambiguity.

---

### 8. Critic Agent

**Goal:** Score the current implementation against quality, correctness, and requirement coverage.

**Input contract:**
- Git diff since last Critic pass (not full codebase)
- `.vibe/artifacts/prd.md` — REQ IDs and descriptions only

**Actions:**
- Score 0–100
- Classify issues as `blocking` or `warning`
- Map blocking issues to specific files and line ranges where possible
- Output structured JSON

**Output:** `.vibe/artifacts/review_findings.md`

```json
{
  "score": 74,
  "passed": false,
  "threshold": 80,
  "blocking_issues": [
    { "id": "C-001", "file": "src/auth/middleware.ts", "description": "JWT secret read from hardcoded string" }
  ],
  "warnings": [
    { "id": "W-001", "description": "Missing pagination on /contacts endpoint" }
  ]
}
```

**Token budget:** Diff + REQ ID list only. Hard limit: do not load full source files.

---

### 9. Fixer Agent

**Goal:** Resolve blocking issues identified by the Critic.

**Input contract:**
- `.vibe/artifacts/review_findings.md` — blocking issues only
- Contents of specific files referenced in blocking issues only

**Actions:**
- Fix each blocking issue
- Do not refactor unrelated code
- Commit fixes, then signal orchestrator to re-run Critic

**Loop limit:** Maximum **3 Critic→Fixer iterations**. If blocking issues remain after 3 loops, escalate to user with `done_report.json` showing unresolved items.

**Token budget:** Findings JSON + referenced files only.

---

### 10. Security Auditor Agent

**Goal:** Post-implementation security review against the original threat model.

**Input contract:**
- `.vibe/artifacts/threat_model.md` (full)
- Git diff of all implementation changes (not full codebase)

**Actions:**
- Verify each threat model item has been addressed
- Flag any new attack surface introduced during implementation
- Output `cleared: true/false` with findings

**Output:** `.vibe/artifacts/security_findings.md`

```json
{
  "cleared": true,
  "verified_items": ["auth strategy", "input validation", "secrets management"],
  "new_findings": []
}
```

**Token budget:** Threat model + implementation diff only.

---

### 10b. Performance Agent

**Goal:** Identify common performance anti-patterns introduced during implementation before the completeness gate is evaluated.

Runs **in parallel with the Security Auditor** (phases 10 and 10b). Neither blocks the other. Both must clear before the Completeness Judge runs.

**Input contract:**
- Git diff of all implementation changes (not full codebase)
- `.vibe/artifacts/architecture.md` — data model and service boundaries only

**Checklist (exhaustive — flag only what is present in the diff):**

| Category | Pattern to detect |
|---|---|
| Database | N+1 queries — loops containing queries not using eager loading or joins |
| Database | Missing indexes on foreign keys and frequently filtered columns |
| Database | Unbounded queries — SELECT without LIMIT on endpoints returning lists |
| Database | Fetching full rows when only specific columns are needed |
| API | Synchronous operations that should be async (file I/O, email, webhooks) |
| API | Missing pagination on any list endpoint |
| API | No caching headers on read-heavy, low-volatility endpoints |
| Frontend | Rendering large lists without virtualisation |
| Frontend | Unnecessary re-renders from missing memoisation on expensive components |
| Compute | Blocking the event loop with synchronous CPU-intensive operations |

The agent flags only what it finds in the diff. It does not speculatively flag things that might become a problem. No padding.

**Output:** `.vibe/artifacts/performance_findings.md`

```json
{
  "cleared": false,
  "blocking_issues": [
    {
      "id": "P-001",
      "category": "Database",
      "pattern": "N+1",
      "file": "src/contacts/contacts.service.ts",
      "line": 84,
      "description": "Fetching tags for each contact in a loop — use JOIN or eager load"
    }
  ],
  "warnings": [
    {
      "id": "PW-001",
      "category": "API",
      "pattern": "Missing pagination",
      "file": "src/deals/deals.controller.ts",
      "description": "GET /deals returns unbounded list"
    }
  ]
}
```

`cleared` is `true` only when `blocking_issues` is empty. Warnings do not block.

If blocking issues exist, the Fixer agent handles them in a targeted pass (same diff-scoped contract as the Critic→Fixer loop) before the Completeness Judge runs.

**Token budget:** Implementation diff + data model section of architecture.md only. Hard limit: do not load full source files.

---

### 11. Completeness Judge Agent

**Goal:** Evaluate all completion gates and produce a binary done/not-done verdict.

**Input contract:**
- `.vibe/artifacts/prd.md` — REQ IDs only
- `.vibe/artifacts/review_findings.md`
- `.vibe/artifacts/security_findings.md`
- `.vibe/artifacts/performance_findings.md`
- Test coverage report (numeric output only)
- Git log summary (agent commit list)

**Gates evaluated:**

| Gate | Condition | Default Threshold |
|---|---|---|
| PRD Coverage | All `required` REQs implemented | 100% required, ≥80% nice-to-have |
| Test Coverage | Coverage tool output | 70% |
| Critic Score | review_findings.json `score` | ≥80, zero blocking |
| Security | security_findings.json `cleared` | true |
| Performance | performance_findings.json `cleared` | true (blocking issues only) |

**Output:** `.vibe/artifacts/done_report.md`

```json
{
  "done": true,
  "gates": {
    "prd_coverage":   { "passed": true,  "score": "96%" },
    "test_coverage":  { "passed": true,  "score": "74%" },
    "critic_score":   { "passed": true,  "score": 83 },
    "security":       { "passed": true },
    "performance":    { "passed": true }
  },
  "action": "proceed_to_documenter"
}
```

If `done: false` and max iterations exhausted, `action` becomes `escalate_to_user` and the orchestrator surfaces the report and halts.

---

### 12. Documenter Agent

**Goal:** Produce developer and user-facing documentation.

**Input contract:**
- `.vibe/artifacts/prd.md` — feature list only
- `.vibe/artifacts/architecture.md` — service map and API surface only
- Public interfaces (extracted, not full implementation files)

**Actions:**
- Write `README.md` — project overview, setup, environment variables, running locally
- Write `docs/API.md` — endpoint reference derived from actual interfaces
- Write `docs/DEPLOYMENT.md` — environment requirements and configuration

**Token budget:** Summaries and interfaces only. Do not load implementation.

---

### 13. Deployer Agent

**Goal:** Present deployment options and either execute or walk the user through deployment.

**Phase A — Options Generation (autonomous):**

Read `.vibe-deploy.json` if present. Detect stack from `architecture.md`. Check for available and authenticated MCPs matching target names.

Generate `.vibe/artifacts/deploy_options.md` ranking 3–4 options:

```
─────────────────────────────────────────────────
  VIBE: Ready to deploy
  Project: modern-crm
  Stack: Node/Postgres, 4 services

  [1] Railway       — MCP detected + authed → AUTO DEPLOY available
  [2] Fly.io        — MCP detected, not authed → walkthrough
  [3] AWS ECS       — no MCP → instructions only
  [4] Docker Compose — self-hosted, no credentials needed

  Choose [1–4]:
─────────────────────────────────────────────────
```

**Phase B — Execution (user-triggered):**

- **Auto deploy** (MCP present + authed + `auto_deploy: true` in config): Execute deployment via MCP, stream output, report live URL on completion.
- **MCP present, not authed**: Provide auth steps, then offer to re-attempt auto deploy once authed.
- **No MCP / instructions only**: Output a numbered, copy-pasteable walkthrough in `docs/DEPLOYMENT.md`. Each step is a single command or action. No ambiguity.

---

## Git Commit Contract

Every agent commits before signalling completion. Format:

```
type(vibe/agent-name): short imperative description

- Bullet summary of what was done
- Key decisions made

[vibe-agent: <name> | phase: <N> | tokens-in: <N> | tokens-out: <N>]
```

**Examples:**
```
feat(vibe/analyst): generate PRD from competitive research

- Defined 14 functional requirements (REQ-F-001 to REQ-F-014)
- Defined 4 non-functional requirements
- Scoped MVP to 8 required features

[vibe-agent: analyst | phase: 2 | tokens-in: 1840 | tokens-out: 620]
```

```
fix(vibe/fixer): resolve 3 blocking critic issues

- Moved JWT secret to environment variable (C-001)
- Added input validation to POST /contacts (C-002)
- Fixed SQL injection risk in search query (C-003)

[vibe-agent: fixer | phase: 9.2 | tokens-in: 980 | tokens-out: 440]
```

The `[vibe-agent: ...]` trailer is machine-readable for log parsing and reporting.

---

## Audit Log

Every agent action appends a line to `.vibe/logs/agent_actions.jsonl`:

```json
{
  "timestamp": "2025-02-28T09:14:22Z",
  "agent": "critic",
  "phase": 8,
  "iteration": 2,
  "tokens_in": 1840,
  "tokens_out": 312,
  "context": {
    "artifacts_read": ["prd.md (REQ IDs only)", "git diff since phase 8.1"],
    "skills_injected": [],
    "token_warning": false
  },
  "decision": "score 74, not passing — 3 blocking issues",
  "artifact_written": ".vibe/artifacts/review_findings.md",
  "commit": "a3f91bc",
  "gate_result": null
}
```

The `context.artifacts_read` field is written by the orchestrator before invocation — it describes exactly what was passed, not just which files were referenced. "prd.md (REQ IDs only)" is more useful than "prd.md" when debugging a Critic that missed something. `skills_injected` lists any skill fragments appended to the system prompt. `token_warning` is true if input exceeded `token_warning_threshold`.

---

## State File

`.vibe/state.json` tracks pipeline state between agent invocations:

```json
{
  "goal": "build a modern CRM that rivals HubSpot",
  "phase": 8,
  "status": "running",
  "iterations": {
    "critic_fixer": 2,
    "max_critic_fixer": 3
  },
  "gates": {
    "prd_coverage": null,
    "test_coverage": null,
    "critic_score": null,
    "security": null,
    "performance": null
  },
  "thresholds": {
    "test_coverage": 70,
    "critic_score": 80,
    "prd_required_coverage": 100,
    "prd_nicetohave_coverage": 80
  },
  "deploy": {
    "config_file_present": true,
    "preferred_target": "railway",
    "auto_deploy": true
  },
  "token_totals": {
    "in": 18240,
    "out": 6810
  },
  "token_warning_threshold": 8000,
  "detected_features": {
    "has_ui": true,
    "has_document_export": false,
    "has_spreadsheet_export": true,
    "has_pdf_generation": false,
    "has_presentations": false
  },
  "agents": {
    "research":           { "status": "passed",  "activity": null, "tokens_in": 420,  "tokens_out": 980 },
    "analyst":            { "status": "running", "activity": "Defining functional requirements", "tokens_in": 980, "tokens_out": 0 }
  }
}
```

---

## Deploy Config File

`.vibe-deploy.json` (gitignored, optional):

```json
{
  "targets": ["railway", "fly"],
  "preferred": "railway",
  "auto_deploy": true
}
```

If absent, Deployer generates options based on detected stack and prompts user to choose.

---

## Escalation Behaviour

The orchestrator halts and surfaces to the user when:

- Critic→Fixer loop exceeds `max_critic_fixer` iterations with unresolved blocking issues
- Security Auditor returns `cleared: false` after implementation
- Completeness Judge returns `done: false` with exhausted retries
- Any agent throws an unrecoverable error

On escalation, the orchestrator prints a structured summary from `done_report.md` or the relevant artifact, identifying exactly what is unresolved and why, so the user can make an informed decision to continue, adjust scope, or abort.

---

## Token Efficiency Rules (enforced by orchestrator)

### Process isolation

Every agent is a fresh `claude -p` invocation. The orchestrator explicitly constructs each agent's input — no context inheritance from prior agents or from this conversation thread. This is the single most important token efficiency rule.

```bash
# Correct — isolated process, explicit input only
claude -p --system-prompt .vibe/prompts/03_architect.md < .vibe/context/architect_input.md

# Wrong — Task subagent inherits full conversation context
# Do not use Claude Code's Task tool for vibe agents
```

### Prompt caching

Agent system prompts are static. Mark them with `cache_control: {"type": "ephemeral"}` when invoking via the API. This is particularly valuable for the Critic and Fixer which may be called 3+ times in a loop — the system prompt tokens are billed once and cached for subsequent calls within the cache TTL.

### Artifact compression before handoff

Before passing an artifact to the next agent, the orchestrator runs a lightweight extraction pass — a minimal `claude -p` call that strips the artifact down to only the fields the receiving agent's input contract requires. This is not a full agent invocation; it uses a generic extraction prompt and a tight token budget (≤200 tokens output).

Example: `prd.md` is ~800 tokens full. The Architect only needs REQ IDs + one-line descriptions — ~150 tokens. The orchestrator extracts this before invoking the Architect, not during.

### Diff scoping

After the first Implementer pass, all diffs passed to Critic, Fixer, Security Auditor, and Performance Agent are filtered to source files only. The orchestrator strips the following from diffs before passing them:

- `*.md`, `*.json`, `*.lock`, `*.yaml`, `*.yml` (config/docs)
- `**/migrations/**` (generated)
- `**/generated/**`, `**/*.generated.*`
- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`

### No agent reads unchanged files

If a file was not modified since the last agent of the same type ran, it is not included in context. The orchestrator tracks a `last_seen_commit` per agent type in `state.json` and diffs only from that point.

### One-shot output contract

Every agent system prompt ends with:

> Produce your complete output in a single response. No preamble, no plan, no commentary before the output. If you cannot complete the task with the provided context, output a JSON error object: `{"error": true, "reason": "..."}`. Do not ask clarifying questions.

If an agent returns malformed output, the orchestrator retries exactly once, appending the parse error. If the retry also fails, it escalates to the user.

### Token warning threshold

If any single agent invocation exceeds 8,000 input tokens (configurable in `state.json` as `token_warning_threshold`), the orchestrator logs a warning to `agent_actions.jsonl` and sets a `token_warning` badge on that agent's UI node. This is a signal that the input contract for that agent should be tightened.

---

## Skill Injection

Claude skills are pre-written domain expertise fragments that improve output quality when injected into agent system prompts. They add tokens, so injection is selective — only where the quality-per-token ratio is clearly positive.

### Unconditional injections

These are injected regardless of project type:

| Skill | Injected into | Rationale |
|---|---|---|
| `frontend-design` | UX Designer, Implementer | Any project with a UI benefits from opinionated, non-generic design direction. The skill is 43 lines — low cost, high signal. Prevents the Implementer from defaulting to Inter font + purple gradient aesthetics. |

### Conditional injections

The orchestrator scans `prd.md` after the Analyst runs and sets feature flags in `state.json` under `"detected_features"`. These flags control which additional skills are injected:

```json
"detected_features": {
  "has_ui": true,
  "has_document_export": false,
  "has_spreadsheet_export": true,
  "has_pdf_generation": false,
  "has_presentations": false
}
```

| Flag | Skill | Injected into | Injected content |
|---|---|---|---|
| `has_spreadsheet_export` | `xlsx` | Implementer | Zero formula errors rule, data formatting standards only — not the full skill (292 lines). Extract ~20 lines. |
| `has_document_export` | `docx` | Implementer | Structure and formatting conventions only. Extract relevant section. |
| `has_pdf_generation` | `pdf` | Implementer | PDF generation patterns only. Extract relevant section. |
| `has_presentations` | `pptx` | Implementer | Slide structure conventions only. Extract relevant section. |

### Injection mechanics

Skills are never injected whole unless they are short enough to justify it (`frontend-design` at 43 lines qualifies). For longer skills, the orchestrator extracts only the relevant section using a minimal `claude -p` extraction pass before the target agent is invoked.

Skill files are read from the Claude Code skill library path at invocation time. The orchestrator resolves skill paths as:

```
/mnt/skills/public/<skill-name>/SKILL.md
```

If a skill file is not found at the expected path, the orchestrator logs a warning and proceeds without it — skill injection failure is never a pipeline blocker.

### Detection keywords for feature flagging

The orchestrator scans `prd.md` for the following patterns to set feature flags:

```
has_document_export  → "export", "download", "Word", "docx", "document generation"
has_spreadsheet_export → "export", "CSV", "Excel", "spreadsheet", "reporting", "data export"
has_pdf_generation   → "PDF", "invoice", "receipt", "report generation", "print"
has_presentations    → "presentation", "slides", "deck", "PowerPoint"
has_ui               → always true unless "CLI", "API only", "headless", "no frontend" detected
```

---

## Local Monitor UI

When `/vibe` starts, the orchestrator boots a local server at `http://localhost:4242` before running any agents. This server stays alive for the duration of the pipeline and shuts down automatically after the deploy step completes or the user aborts.

The UI displays a live node graph of the pipeline with real-time agent state. It requires no external services — it runs entirely from `.vibe/ui/` and reads only `.vibe/state.json` and `.vibe/logs/agent_actions.jsonl` via file watching.

### Server (`server.js`)

- Express server on port 4242
- Serves `index.html` as the single-page app
- Exposes `GET /events` as a Server-Sent Events (SSE) stream
- Watches `.vibe/state.json` and `.vibe/logs/agent_actions.jsonl` using `chokidar`
- On any file change, reads both files and pushes the full current state as a single SSE event
- No websockets, no build step, no bundler — SSE + vanilla fetch is sufficient

### Frontend (`index.html`)

Single self-contained file. Uses React via CDN, ReactFlow via CDN for the node graph. No build step.

**Node graph layout:**

Each agent is a node. Nodes are arranged in pipeline order left-to-right with the Critic→Fixer loop shown as a back-edge. Parallel agents (Security Auditor + Performance Agent) are displayed on the same horizontal level.

**Node states and visual treatment:**

| State | Visual |
|---|---|
| `pending` | Grey, dimmed |
| `running` | Blue with a pulsing ring and spinner, label shows current activity string |
| `passed` | Green with checkmark |
| `failed` | Red with ✕ — hover shows failure reason |
| `skipped` | Grey with dash (e.g. Fixer when Critic passed first time) |
| `waiting_user` | Amber with pause icon — deploy choice or escalation |

**Active agent detail panel:**

When an agent is `running`, a side panel shows:
- Agent name and phase number
- Current activity string (populated from the most recent `agent_actions.jsonl` entry's `decision` field)
- Token counter: input / output tokens so far this phase
- Elapsed time for this phase

**Pipeline summary bar (bottom of screen):**

- Total tokens consumed (in + out)
- Elapsed wall time
- Phases complete / total
- Current gate statuses as coloured dots

**Token warning indicator:**

If any single agent invocation logged a token warning (input > 8,000), the corresponding node gets a small amber `⚠` badge. Clicking it shows the warning detail.

### State fields consumed by the UI

The UI reads these fields from `state.json`:

```json
{
  "agents": {
    "research":             { "status": "passed",  "activity": null,                         "tokens_in": 420,  "tokens_out": 980  },
    "analyst":              { "status": "passed",  "activity": null,                         "tokens_in": 1840, "tokens_out": 620  },
    "architect":            { "status": "running", "activity": "Defining service boundaries", "tokens_in": 610,  "tokens_out": 0    },
    "security_planner":     { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "ux_designer":          { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "implementer":          { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "test_writer":          { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "critic":               { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "fixer":                { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "security_auditor":     { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "performance_agent":    { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "completeness_judge":   { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "documenter":           { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    },
    "deployer":             { "status": "pending", "activity": null,                         "tokens_in": 0,    "tokens_out": 0    }
  }
}
```

The orchestrator is responsible for writing these fields to `state.json` before and after each agent invocation. The `activity` string is taken from the most recent `agent_actions.jsonl` entry's `decision` field for that agent.

### Orchestrator responsibilities for UI

Before invoking any agent, the orchestrator writes to `state.json`:
```json
{ "agents": { "<agent_name>": { "status": "running", "activity": "<brief description of what this agent is about to do>" } } }
```

After an agent completes, the orchestrator writes:
```json
{ "agents": { "<agent_name>": { "status": "passed|failed|skipped", "activity": null, "tokens_in": N, "tokens_out": N } } }
```

This is the only coupling between the orchestrator and the UI — a shared JSON file. The UI never calls the orchestrator and the orchestrator never calls the UI.

### Dependencies

The UI server requires Node.js (already required by Claude Code). The orchestrator scaffolds `.vibe/ui/package.json` during init and runs `npm install` once:

```json
{
  "name": "vibe-ui",
  "private": true,
  "dependencies": {
    "chokidar": "^3.6.0",
    "express": "^4.18.0"
  }
}
```

React and ReactFlow are loaded from CDN in `index.html`. No local bundling.

---

## Pipeline Flow Summary

```
/vibe "<goal>"                          /vibe continue
    │                                       │
    ├─ 0.  Bootstrap + boot UI monitor ─────┤ (skip to Critic if continuing)
    ├─ 1.  Research           → research.md │
    ├─ 2.  Analyst            → prd.md      │ (synthesised from existing code if no .vibe/)
    ├─ 3.  Architect          → architecture.md
    ├─ 4.  Security Planner   → threat_model.md
    ├─ 5.  UX Designer        → ux_spec.md
    ├─ 6.  Implementer        → code + smoke test (must boot before proceeding)
    ├─ 7.  Test Writer        → test suite
    ├─ 8.  Critic ────────────────────────────────┐ ◄── /vibe continue enters here
    ├─ 9.  Fixer (if needed)  → patches ──────────┘ (max 3 loops)
    ├─ 10. Security Auditor   ─┐ (parallel)
    ├─ 10b.Performance Agent  ─┘ → both must clear before Judge
    ├─ 11. Completeness Judge → done_report.md
    │       │
    │       ├─ done: false + retries exhausted → escalate to user (halt)
    │       └─ done: true → continue
    │
    ├─ 12. Documenter         → README.md, API.md, DEPLOYMENT.md
    └─ 13. Deployer           → deploy_options.md → user choice
                                   │
                                   ├─ MCP + authed + auto_deploy → execute
                                   ├─ MCP + not authed           → auth steps + retry
                                   └─ no MCP                     → walkthrough
```

Each step commits. All steps log. User is only required at the deploy choice.

---

## Technical Notes (Orchestrator Implementation)

### Agent Invocation

Agents are spawned as isolated `claude` CLI processes:

```bash
claude -p \
  --system-prompt "$(cat .vibe/prompts/03_architect.md)" \
  --output-format json \
  --model sonnet \
  --dangerously-skip-permissions \
  < .vibe/context/architect_input.md
```

- `--system-prompt` takes prompt content as a **string** — use `$(cat file)` to load from file
- `--output-format json` returns `{"result":"...","input_tokens":N,"output_tokens":N}`
- `--dangerously-skip-permissions` allows agents to write files autonomously
- `--model sonnet` uses claude-sonnet-4-6 for all agents (cost/speed optimised)
- `CLAUDE_CODE_ENTRYPOINT` env var must be unset for spawned processes

### Orchestrator Entry Point

```bash
node vibe.mjs "build a modern CRM"    # new project
node vibe.mjs continue                 # resume/improve
```

The orchestrator (`.vibe/orchestrator.mjs`) is the pipeline engine invoked by the CLI entry point (`vibe.mjs`).
