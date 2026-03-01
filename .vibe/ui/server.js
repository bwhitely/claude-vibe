import express from 'express';
import { watch } from 'chokidar';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, basename } from 'path';

const AGENT_ORDER = [
  'research', 'analyst', 'architect', 'security_planner', 'ux_designer',
  'implementer', 'test_writer', 'critic', 'fixer', 'security_auditor',
  'performance_agent', 'completeness_judge', 'builder', 'documenter', 'deployer',
];

// Gates whose null-reset is triggered when a given agent is reset
const AGENT_GATE_RESETS = {
  critic:             ['critic_score'],
  test_writer:        ['test_coverage'],
  security_auditor:   ['security'],
  performance_agent:  ['performance'],
  completeness_judge: ['prd_coverage', 'test_coverage', 'critic_score', 'security', 'performance'],
  builder:            [],
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// When invoked by the orchestrator, VIBE_PROJECT_DIR points to the target
// project's .vibe/ directory. Fall back to the tool repo's .vibe/ for
// local dev / running the server standalone.
const VIBE_DIR       = process.env.VIBE_PROJECT_DIR ?? resolve(__dirname, '..');
const PROJECT_ROOT   = dirname(VIBE_DIR);
const STATE_PATH     = resolve(VIBE_DIR, 'state.json');
const LOG_PATH       = resolve(VIBE_DIR, 'logs', 'agent_actions.jsonl');
const USAGE_PATH     = resolve(VIBE_DIR, 'usage_totals.json');
const ARTIFACTS_PATH = resolve(VIBE_DIR, 'artifacts');
const CONTEXT_PATH   = resolve(VIBE_DIR, 'context');
const PORT = process.env.VIBE_PORT || 4242;

const app = express();
app.use(express.json());
const clients = new Set();

function readState() {
  try {
    if (!existsSync(STATE_PATH)) return null;
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch { return null; }
}

function readUsage() {
  try {
    if (!existsSync(USAGE_PATH)) return null;
    return JSON.parse(readFileSync(USAGE_PATH, 'utf-8'));
  } catch { return null; }
}

function readLog() {
  try {
    if (!existsSync(LOG_PATH)) return [];
    const raw = readFileSync(LOG_PATH, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function broadcast() {
  const payload = JSON.stringify({ state: readState(), log: readLog(), usage: readUsage() });
  for (const res of clients) {
    res.write(`data: ${payload}\n\n`);
  }
}

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({ state: readState(), log: readLog(), usage: readUsage() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/', (_req, res) => {
  res.sendFile(resolve(__dirname, 'index.html'));
});

// ── Read-only content endpoints ───────────────────────────────────────────────

// Serve a .vibe/artifacts/<name> file
app.get('/artifact/:name', (req, res) => {
  const name = basename(req.params.name);  // prevent path traversal
  const filePath = resolve(ARTIFACTS_PATH, name);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found' });
  res.type('text/plain').send(readFileSync(filePath, 'utf-8'));
});

// Serve a .vibe/context/<agent>_input.md file
app.get('/context/:agent', (req, res) => {
  const agent = basename(req.params.agent);
  const filePath = resolve(CONTEXT_PATH, `${agent}_input.md`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Context input not found' });
  res.type('text/plain').send(readFileSync(filePath, 'utf-8'));
});

// Serve the output of git show <hash> for a vibe commit
app.get('/commit-diff/:hash', (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/gi, '');  // hex-only sanitisation
  if (!hash || hash.length < 6) return res.status(400).json({ error: 'Invalid hash' });
  try {
    const output = execFileSync('git', ['show', '--stat', '-p', hash], {
      cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 8000,
    });
    res.type('text/plain').send(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Mutation endpoints ─────────────────────────────────────────────────────────

// Reset state from agentId onwards (inclusive). Trims JSONL of reset agents.
app.post('/reset/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    const idx = AGENT_ORDER.indexOf(agentId);
    if (idx === -1) return res.status(400).json({ error: `Unknown agent: ${agentId}` });

    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    const agentsToReset = AGENT_ORDER.slice(idx);

    for (const name of agentsToReset) {
      if (state.agents && state.agents[name]) {
        state.agents[name] = { status: 'pending', activity: null, tokens_in: null, tokens_out: null };
      }
    }

    // Null-out gates owned by reset agents
    const gatesToReset = new Set();
    for (const name of agentsToReset) {
      for (const gate of (AGENT_GATE_RESETS[name] || [])) gatesToReset.add(gate);
    }
    for (const gate of gatesToReset) {
      if (state.gates) state.gates[gate] = null;
    }

    // Reset iteration counter if critic is included
    if (agentsToReset.includes('critic') && state.iterations) {
      state.iterations.critic_fixer = 0;
    }

    // Pipeline is no longer complete/failed — mark interrupted so /vibe continue picks it up
    if (['complete', 'escalated', 'failed'].includes(state.status)) {
      state.status = 'interrupted';
    }

    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

    // Trim JSONL: remove all entries belonging to the reset agents
    if (existsSync(LOG_PATH)) {
      const raw = readFileSync(LOG_PATH, 'utf-8').trim();
      if (raw) {
        const kept = raw.split('\n').filter(line => {
          try { return !agentsToReset.includes(JSON.parse(line).agent); } catch { return true; }
        });
        writeFileSync(LOG_PATH, kept.length ? kept.join('\n') + '\n' : '');
      }
    }

    broadcast();
    res.json({ ok: true, reset: agentsToReset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark an agent as skipped (will be bypassed on next /vibe continue)
app.post('/skip/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    if (!AGENT_ORDER.includes(agentId)) return res.status(400).json({ error: `Unknown agent: ${agentId}` });
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    if (!state.agents?.[agentId]) return res.status(400).json({ error: 'Agent not in state' });
    state.agents[agentId] = { ...state.agents[agentId], status: 'skipped', activity: null };
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    broadcast();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a skipped agent back to pending
app.post('/unskip/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    if (!AGENT_ORDER.includes(agentId)) return res.status(400).json({ error: `Unknown agent: ${agentId}` });
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    if (!state.agents?.[agentId]) return res.status(400).json({ error: 'Agent not in state' });
    state.agents[agentId] = { ...state.agents[agentId], status: 'pending', activity: null };
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    broadcast();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const watcher = watch([STATE_PATH, LOG_PATH, USAGE_PATH], {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
});
watcher.on('change', broadcast);
watcher.on('add', broadcast);

const server = app.listen(PORT, () => {
  console.log(`VIBE monitor running at http://localhost:${PORT}`);
});

function shutdown() {
  watcher.close();
  for (const res of clients) res.end();
  clients.clear();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
