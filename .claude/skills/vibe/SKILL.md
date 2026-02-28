---
name: vibe
description: Autonomous project builder — takes a goal and produces a fully implemented, tested, documented project through a 13-agent pipeline.
disable-model-invocation: true
argument-hint: "\"<goal>\" or continue"
---

# VIBE — Autonomous Project Builder

Run the VIBE orchestrator pipeline. This spawns isolated `claude -p` agent processes — do NOT use the Task tool or subagents.

## Invocation

The user has run `/vibe $ARGUMENTS`.

**If `$ARGUMENTS` is empty**, show the usage help and ask for a goal:

```
VIBE — Autonomous Project Builder

Usage:
  /vibe "<goal>"     Build a project from a goal description
  /vibe continue     Resume or improve an existing project

Examples:
  /vibe "build a modern CRM that rivals HubSpot"
  /vibe "create a real-time chat app with WebSocket support"
  /vibe continue
```

**If `$ARGUMENTS` is "continue"**, run:

```bash
node vibe.mjs continue
```

**Otherwise**, treat `$ARGUMENTS` as the project goal and run:

```bash
node vibe.mjs $ARGUMENTS
```

## Execution Rules

1. Run the command using the Bash tool with a long timeout (600000ms / 10 minutes)
2. The orchestrator handles everything autonomously — do not intervene, add commentary, or modify files while it runs
3. The orchestrator boots a live UI monitor at http://localhost:4242 — mention this to the user
4. When the pipeline completes or escalates, relay the final output to the user
5. If the pipeline fails with an error, show the error and suggest `node vibe.mjs continue` to resume
6. Do NOT use the Task tool to spawn subagents — the orchestrator manages its own agent processes via `claude -p`

## What to Tell the User

Before running, say:

```
Starting VIBE pipeline for: [goal]
Monitor progress at http://localhost:4242
```

Then execute the command silently and report the result when done.
