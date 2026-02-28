#!/usr/bin/env node

import { runPipeline, continuePipeline } from './.vibe/orchestrator.mjs';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
  VIBE — Autonomous Project Builder

  Usage:
    node vibe.mjs "<goal>"     Build a project from a goal description
    node vibe.mjs continue     Resume or improve an existing project

  Examples:
    node vibe.mjs "build a modern CRM that rivals HubSpot"
    node vibe.mjs "create a real-time chat app with WebSocket support"
    node vibe.mjs continue
`);
  process.exit(0);
}

const mode = args[0].toLowerCase();

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log('\n  Shutting down gracefully...');
  // Give time for state to be written
  setTimeout(() => process.exit(0), 1000);
});

if (mode === 'continue') {
  continuePipeline().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
} else {
  const goal = args.join(' ');
  runPipeline(goal).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
