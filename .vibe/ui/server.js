import express from 'express';
import { watch } from 'chokidar';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VIBE_DIR = resolve(__dirname, '..');
const STATE_PATH = resolve(VIBE_DIR, 'state.json');
const LOG_PATH = resolve(VIBE_DIR, 'logs', 'agent_actions.jsonl');
const PORT = process.env.VIBE_PORT || 4242;

const app = express();
const clients = new Set();

function readState() {
  try {
    if (!existsSync(STATE_PATH)) return null;
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
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
  const payload = JSON.stringify({ state: readState(), log: readLog() });
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
  res.write(`data: ${JSON.stringify({ state: readState(), log: readLog() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/', (_req, res) => {
  res.sendFile(resolve(__dirname, 'index.html'));
});

const watcher = watch([STATE_PATH, LOG_PATH], {
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
