# VIBE — Autonomous Project Builder

VIBE takes a single natural language goal and produces a fully implemented, tested, documented, and optionally deployed project using a multi-agent Claude pipeline — with minimal human intervention.

---

## Requirements

- [Claude Code](https://claude.ai/code) installed and authenticated (`claude` on PATH)
- Node.js 18+
- Git

---

## Usage

### Build a new project

```bash
node vibe.mjs "<goal>"
```

**Examples:**
```bash
node vibe.mjs "build a modern CRM that rivals HubSpot"
node vibe.mjs "create a real-time collaborative whiteboard"
node vibe.mjs "build a Stripe billing dashboard with subscription management"
```

Run from any directory. VIBE initialises a git repo, scaffolds the pipeline, and starts building. A local monitor UI starts at **http://localhost:4242**.

### Resume or improve an existing project

```bash
node vibe.mjs continue
```

Run inside a project directory that was previously built with VIBE. Behaviour:

- If the pipeline was interrupted mid-run, it resumes at the last incomplete phase
- If the pipeline completed, it re-enters at the Critic phase and improves the codebase

**Optional:** drop a `.vibe/continue.md` file before running to give the pipeline focused direction:

```markdown
## What to improve
- Add rate limiting to the API
- The search is slow on large datasets

## Known issues
- Email notifications not sending in production
```

---

## Pipeline

VIBE runs 13 agents in sequence:

| Phase | Agent | Output |
|---|---|---|
| 1 | Research | Competitive landscape, must-have features |
| 2 | Analyst | PRD with scoped MVP requirements |
| 3 | Architect | Stack, data model, API surface |
| 4 | Security Planner | Threat model, auth strategy |
| 5 | UX Designer | Screen inventory, user flows, component hierarchy |
| 6 | Implementer | Full application code |
| 7 | Test Writer | Unit + integration test suite (≥70% coverage) |
| 8–9 | Critic → Fixer | Quality review loop (max 3 iterations) |
| 10 | Security Auditor | Post-implementation security verification |
| 10b | Performance Agent | N+1 queries, missing indexes, unbounded lists |
| 11 | Judge | All-gates completion check |
| 12 | Documenter | README, API docs, deployment guide |
| 13 | Deployer | Deployment options + execution |

Each agent commits its work. The pipeline can be interrupted at any phase and resumed with `node vibe.mjs continue`.

---

## Monitor UI

The pipeline boots a local web UI at **http://localhost:4242** showing:

- Live node graph with agent status (pending / running / passed / failed)
- Active agent detail panel — phase, activity, token counts
- Activity log — timestamped actions from the audit trail
- Summary bar — total tokens, elapsed time, gate statuses

---

## Directory Structure

```
.vibe/
  state.json              Pipeline state (phases, agent statuses, gates)
  artifacts/              Agent outputs (research.md, prd.md, architecture.md, ...)
  logs/
    agent_actions.jsonl   Append-only audit log
  prompts/                Agent system prompts
  ui/                     Local monitor server
  context/                Per-agent input files (ephemeral, gitignored)
```

---

## Optional Deploy Config

Create `.vibe-deploy.json` (gitignored) to configure deployment targets:

```json
{
  "targets": ["railway", "fly"],
  "preferred": "railway",
  "auto_deploy": true
}
```

If absent, the Deployer agent generates options based on your stack and prompts you to choose.

---

## Architecture

VIBE is a thin orchestrator (`vibe.mjs` → `.vibe/orchestrator.mjs`) that:

1. Spawns each agent as an isolated `claude -p` subprocess — no shared conversation context between agents
2. Constructs minimal per-agent context from artifacts (not full codebase)
3. Writes structured artifacts and git commits after each phase
4. Watches `.vibe/state.json` and streams updates to the monitor UI via SSE

Token efficiency is the core design constraint: each agent receives only what its task requires.
