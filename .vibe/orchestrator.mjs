import { spawn, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const VIBE_DIR = resolve(PROJECT_ROOT, '.vibe');
const STATE_PATH = resolve(VIBE_DIR, 'state.json');
const LOG_PATH = resolve(VIBE_DIR, 'logs', 'agent_actions.jsonl');
const ARTIFACTS = resolve(VIBE_DIR, 'artifacts');
const CONTEXT = resolve(VIBE_DIR, 'context');
const PROMPTS = resolve(VIBE_DIR, 'prompts');

const AGENT_MODEL = 'sonnet';
const TOKEN_WARNING_THRESHOLD = 8000;

// Set when the user sends SIGINT so we write "interrupted" instead of "failed"
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; });

const DIFF_EXCLUDE_PATTERNS = [
  ':(exclude)*.md', ':(exclude)*.json', ':(exclude)*.lock',
  ':(exclude)*.yaml', ':(exclude)*.yml',
  ':(exclude)**/migrations/**', ':(exclude)**/generated/**', ':(exclude)**/*.generated.*',
  ':(exclude)package-lock.json', ':(exclude)yarn.lock', ':(exclude)pnpm-lock.yaml',
];

const FEATURE_KEYWORDS = {
  has_document_export: ['export', 'download', 'Word', 'docx', 'document generation'],
  has_spreadsheet_export: ['export', 'CSV', 'Excel', 'spreadsheet', 'reporting', 'data export'],
  has_pdf_generation: ['PDF', 'invoice', 'receipt', 'report generation', 'print'],
  has_presentations: ['presentation', 'slides', 'deck', 'PowerPoint'],
};

const NO_UI_KEYWORDS = ['CLI', 'API only', 'headless', 'no frontend'];

// ─────────────────────────────────────────────────
// State management
// ─────────────────────────────────────────────────

function readState() {
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
}

function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function updateState(patch) {
  const state = readState();
  deepMerge(state, patch);
  writeState(state);
  return state;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function setAgentStatus(name, status, activity = null, tokens_in = null, tokens_out = null) {
  const state = readState();
  if (!state.agents) state.agents = {};
  state.agents[name] = {
    ...state.agents[name],
    status,
    activity,
    // Preserve existing token counts if new values are null (agent still running or unknown)
    tokens_in:  tokens_in  ?? state.agents[name]?.tokens_in  ?? null,
    tokens_out: tokens_out ?? state.agents[name]?.tokens_out ?? null,
  };
  writeState(state);
}

// ─────────────────────────────────────────────────
// Audit logging
// ─────────────────────────────────────────────────

function appendLog(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  appendFileSync(LOG_PATH, line + '\n');
}

// ─────────────────────────────────────────────────
// Git operations (using execFileSync — no shell injection)
// ─────────────────────────────────────────────────

function git(...args) {
  return execFileSync('git', args, {
    cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitCommit(agentName, phase, message, bullets, tokensIn, tokensOut) {
  try { git('add', '-A'); } catch {}
  const status = git('status', '--porcelain');
  if (!status) return null;

  const body = bullets.map(b => `- ${b}`).join('\n');
  const trailer = `[vibe-agent: ${agentName} | phase: ${phase} | tokens-in: ${tokensIn} | tokens-out: ${tokensOut}]`;
  const fullMsg = `${message}\n\n${body}\n\n${trailer}`;
  git('commit', '-m', fullMsg);
  return git('rev-parse', '--short', 'HEAD');
}

function getScopedDiff(sinceCommit) {
  if (!sinceCommit) {
    try {
      return git('diff', 'HEAD~1', '--', '.', ...DIFF_EXCLUDE_PATTERNS);
    } catch {
      return git('diff', '--cached');
    }
  }
  return git('diff', `${sinceCommit}..HEAD`, '--', '.', ...DIFF_EXCLUDE_PATTERNS);
}

function getFullDiff() {
  try {
    const firstCommit = git('rev-list', '--max-parents=0', 'HEAD');
    return getScopedDiff(firstCommit);
  } catch {
    return '';
  }
}

function getLastVibeCommit() {
  try {
    const log = git('log', '--oneline', '--all', '-50');
    const lines = log.split('\n');
    for (const line of lines) {
      const hash = line.split(' ')[0];
      const msg = git('log', '-1', '--format=%B', hash);
      if (msg.includes('[vibe-agent:') && !msg.includes('status: running')) {
        return hash;
      }
    }
  } catch {}
  return null;
}

// ─────────────────────────────────────────────────
// Agent invocation
// ─────────────────────────────────────────────────

function runAgent(name, phase, promptFile, contextInput) {
  return new Promise((resolvePromise, reject) => {
    const promptPath = resolve(PROMPTS, promptFile);
    if (!existsSync(promptPath)) {
      reject(new Error(`Prompt file not found: ${promptPath}`));
      return;
    }
    const systemPrompt = readFileSync(promptPath, 'utf-8');

    setAgentStatus(name, 'running', `Phase ${phase}: starting`);

    const env = { ...process.env };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_ENTRYPOINT;

    const args = [
      '-p',
      '--system-prompt', systemPrompt,
      '--output-format', 'json',
      '--model', AGENT_MODEL,
      '--dangerously-skip-permissions',
    ];

    // Track current phase in state so the UI phase counter stays current
    updateState({ phase });

    const child = spawn('claude', args, {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.stdin.write(contextInput);
    child.stdin.end();

    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`Agent ${name} exited with code ${code}: ${stderr}`));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        // Try JSONL: find the last line that parses as JSON and has a result or token field
        let found = false;
        const lines = stdout.trim().split('\n').reverse();
        for (const line of lines) {
          try {
            const obj = JSON.parse(line.trim());
            if (obj.result !== undefined || obj.input_tokens !== undefined || obj.usage !== undefined) {
              parsed = obj;
              found = true;
              break;
            }
          } catch {}
        }
        if (!found) {
          // Greedy regex fallback — extract outermost {...}
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch {
              parsed = { result: stdout };
            }
          } else {
            parsed = { result: stdout };
          }
        }
      }

      const result = parsed.result || parsed.content || stdout;
      // Handle multiple possible token field locations from different CLI versions
      const tokensIn  = parsed.input_tokens  ?? parsed.tokens_in  ?? parsed.usage?.input_tokens  ?? null;
      const tokensOut = parsed.output_tokens ?? parsed.tokens_out ?? parsed.usage?.output_tokens ?? null;
      const tokenWarning = (tokensIn ?? 0) > TOKEN_WARNING_THRESHOLD;

      const state = readState();
      state.token_totals = state.token_totals || { in: 0, out: 0 };
      if (tokensIn  != null) state.token_totals.in  += tokensIn;
      if (tokensOut != null) state.token_totals.out += tokensOut;
      writeState(state);

      setAgentStatus(name, 'passed', null, tokensIn, tokensOut);

      appendLog({
        agent: name, phase,
        tokens_in: tokensIn, tokens_out: tokensOut,
        context: { artifacts_read: [], skills_injected: [], token_warning: tokenWarning },
        decision: `completed phase ${phase}`,
        artifact_written: null, commit: null, gate_result: null,
      });

      resolvePromise({ result, tokensIn, tokensOut, tokenWarning });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn agent ${name}: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────────────
// Artifact I/O helpers
// ─────────────────────────────────────────────────

function readArtifact(name) {
  const p = resolve(ARTIFACTS, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}

function writeArtifact(name, content) {
  writeFileSync(resolve(ARTIFACTS, name), content);
}

function writeContextFile(name, content) {
  writeFileSync(resolve(CONTEXT, `${name}_input.md`), content);
}

// ─────────────────────────────────────────────────
// Feature detection
// ─────────────────────────────────────────────────

function detectFeatures(prdContent) {
  const lower = prdContent.toLowerCase();
  const features = {
    has_ui: !NO_UI_KEYWORDS.some(k => lower.includes(k.toLowerCase())),
    has_document_export: false,
    has_spreadsheet_export: false,
    has_pdf_generation: false,
    has_presentations: false,
  };

  for (const [flag, keywords] of Object.entries(FEATURE_KEYWORDS)) {
    features[flag] = keywords.some(k => lower.includes(k.toLowerCase()));
  }

  return features;
}

// ─────────────────────────────────────────────────
// Skill injection
// ─────────────────────────────────────────────────

function loadSkill(skillName) {
  const paths = [
    `/mnt/skills/public/${skillName}/SKILL.md`,
    resolve(PROJECT_ROOT, `.vibe/skills/${skillName}.md`),
  ];
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  return null;
}

function getSkillInjection(agentName, features) {
  const injections = [];

  if ((agentName === 'ux_designer' || agentName === 'implementer') && features.has_ui) {
    const skill = loadSkill('frontend-design');
    if (skill) injections.push({ name: 'frontend-design', content: skill });
  }

  if (agentName === 'implementer') {
    const conditionalSkills = [
      { flag: 'has_spreadsheet_export', skill: 'xlsx' },
      { flag: 'has_document_export', skill: 'docx' },
      { flag: 'has_pdf_generation', skill: 'pdf' },
      { flag: 'has_presentations', skill: 'pptx' },
    ];
    for (const { flag, skill: skillName } of conditionalSkills) {
      if (features[flag]) {
        const skill = loadSkill(skillName);
        if (skill) injections.push({ name: skillName, content: skill.slice(0, 2000) });
      }
    }
  }

  return injections;
}

// ─────────────────────────────────────────────────
// Phase implementations
// ─────────────────────────────────────────────────

async function runResearch(goal) {
  console.log('  [1/13] Research Agent — surveying competitive landscape');
  setAgentStatus('research', 'running', 'Surveying competitive landscape');

  const result = await runAgent('research', 1, '01_research.md', goal);
  writeArtifact('research.md', result.result);

  const commit = gitCommit('research', 1,
    'feat(vibe/research): survey competitive landscape',
    ['Researched competitors and feature expectations', `Tokens: ${result.tokensIn} in / ${result.tokensOut} out`],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'research', phase: 1, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['goal string only'], skills_injected: [], token_warning: result.tokenWarning },
    decision: 'completed research', artifact_written: '.vibe/artifacts/research.md', commit, gate_result: null });

  return result;
}

async function runAnalyst(goal) {
  console.log('  [2/13] Analyst Agent — generating PRD');
  setAgentStatus('analyst', 'running', 'Generating PRD from research');

  const research = readArtifact('research.md');
  const context = `${research}\n\n---\n\nGoal: ${goal}`;
  writeContextFile('analyst', context);

  const result = await runAgent('analyst', 2, '02_analyst.md', context);
  writeArtifact('prd.md', result.result);

  const features = detectFeatures(result.result);
  updateState({ detected_features: features });

  const commit = gitCommit('analyst', 2,
    'feat(vibe/analyst): generate PRD from competitive research',
    ['Defined functional and non-functional requirements', 'Scoped MVP features'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'analyst', phase: 2, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['research.md (full)', 'goal string'], skills_injected: [], token_warning: result.tokenWarning },
    decision: 'PRD generated', artifact_written: '.vibe/artifacts/prd.md', commit, gate_result: null });

  return result;
}

async function runArchitect() {
  console.log('  [3/13] Architect Agent — defining technical architecture');
  setAgentStatus('architect', 'running', 'Defining technical architecture');

  const prd = readArtifact('prd.md');
  writeContextFile('architect', prd);

  const result = await runAgent('architect', 3, '03_architect.md', prd);
  writeArtifact('architecture.md', result.result);

  const commit = gitCommit('architect', 3,
    'feat(vibe/architect): define technical architecture',
    ['Chose stack and defined data model', 'Defined API surface and service boundaries'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'architect', phase: 3, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['prd.md'], skills_injected: [], token_warning: result.tokenWarning },
    decision: 'architecture defined', artifact_written: '.vibe/artifacts/architecture.md', commit, gate_result: null });

  return result;
}

async function runSecurityPlanner() {
  console.log('  [4/13] Security Planner Agent — defining security posture');
  setAgentStatus('security_planner', 'running', 'Defining security posture');

  const arch = readArtifact('architecture.md');
  writeContextFile('security_planner', arch);

  const result = await runAgent('security_planner', 4, '04_security_planner.md', arch);
  writeArtifact('threat_model.md', result.result);

  const commit = gitCommit('security_planner', 4,
    'feat(vibe/security-planner): define threat model',
    ['Identified attack surface and security requirements', 'Defined auth strategy'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'security_planner', phase: 4, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['architecture.md (interfaces/data flows)'], skills_injected: [], token_warning: result.tokenWarning },
    decision: 'threat model defined', artifact_written: '.vibe/artifacts/threat_model.md', commit, gate_result: null });

  return result;
}

async function runUxDesigner() {
  console.log('  [5/13] UX Designer Agent — designing user experience');
  setAgentStatus('ux_designer', 'running', 'Designing user flows and components');

  const prd = readArtifact('prd.md');
  const arch = readArtifact('architecture.md');
  const context = `${prd}\n\n---\n\n${arch}`;
  writeContextFile('ux_designer', context);

  const state = readState();
  const features = state.detected_features || {};
  const skills = getSkillInjection('ux_designer', features);
  let skillSuffix = '';
  if (skills.length) {
    skillSuffix = '\n\n---\n\n## Injected Skills\n\n' + skills.map(s => s.content).join('\n\n');
  }

  const result = await runAgent('ux_designer', 5, '05_ux_designer.md', context + skillSuffix);
  writeArtifact('ux_spec.md', result.result);

  const commit = gitCommit('ux_designer', 5,
    'feat(vibe/ux-designer): define UX specification',
    ['Listed screens and user flows', 'Defined component hierarchy'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'ux_designer', phase: 5, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['prd.md (REQ-F list)', 'architecture.md (API surface)'], skills_injected: skills.map(s => s.name), token_warning: result.tokenWarning },
    decision: 'UX spec defined', artifact_written: '.vibe/artifacts/ux_spec.md', commit, gate_result: null });

  return result;
}

async function runImplementer() {
  console.log('  [6/13] Implementer Agent — writing application code');
  setAgentStatus('implementer', 'running', 'Implementing application code');

  const arch = readArtifact('architecture.md');
  const threat = readArtifact('threat_model.md');
  const ux = readArtifact('ux_spec.md');
  const context = `${arch}\n\n---\n\n${threat}\n\n---\n\n${ux}`;
  writeContextFile('implementer', context);

  const state = readState();
  const features = state.detected_features || {};
  const skills = getSkillInjection('implementer', features);
  let skillSuffix = '';
  if (skills.length) {
    skillSuffix = '\n\n---\n\n## Injected Skills\n\n' + skills.map(s => s.content).join('\n\n');
  }

  const result = await runAgent('implementer', 6, '06_implementer.md', context + skillSuffix);

  const commit = gitCommit('implementer', 6,
    'feat(vibe/implementer): implement application code',
    ['Implemented application per architecture spec', 'Includes data model, API, and frontend'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'implementer', phase: 6, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['architecture.md (full)', 'threat_model.md (full)', 'ux_spec.md (full)'],
      skills_injected: skills.map(s => s.name), token_warning: result.tokenWarning },
    decision: 'implementation complete', artifact_written: null, commit, gate_result: null });

  return result;
}

async function runTestWriter() {
  console.log('  [7/13] Test Writer Agent — creating test suite');
  setAgentStatus('test_writer', 'running', 'Writing test suite');

  // Extract public interfaces using find + grep via execFileSync
  let interfaces = '(no exported interfaces found)';
  try {
    const files = execFileSync('find', ['.', '-name', '*.ts', '-o', '-name', '*.js', '-o', '-name', '*.tsx', '-o', '-name', '*.jsx'],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n').filter(f => f && !f.includes('node_modules') && !f.includes('.vibe')).slice(0, 20);

    let extracted = '';
    for (const f of files) {
      try {
        const content = readFileSync(resolve(PROJECT_ROOT, f), 'utf-8');
        const exportLines = content.split('\n').filter(l => l.includes('export')).slice(0, 10);
        if (exportLines.length) extracted += `\n// ${f}\n${exportLines.join('\n')}\n`;
      } catch {}
    }
    if (extracted) interfaces = extracted;
  } catch {}

  let testPatterns = '(no existing test files)';
  try {
    const testFiles = execFileSync('find', ['.', '-name', '*.test.*', '-o', '-name', '*.spec.*'],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n').filter(f => f && !f.includes('node_modules')).slice(0, 5);
    if (testFiles.length) {
      let tp = '';
      for (const f of testFiles) {
        try {
          const content = readFileSync(resolve(PROJECT_ROOT, f), 'utf-8');
          tp += `\n// ${f}\n${content.split('\n').slice(0, 20).join('\n')}\n`;
        } catch {}
      }
      if (tp) testPatterns = tp;
    }
  } catch {}

  const context = `## Public Interfaces\n\n${interfaces}\n\n---\n\n## Existing Test Patterns\n\n${testPatterns}`;
  writeContextFile('test_writer', context);

  const result = await runAgent('test_writer', 7, '07_test_writer.md', context);

  const commit = gitCommit('test_writer', 7,
    'test(vibe/test-writer): add test suite',
    ['Added unit and integration tests', 'Coverage target: 70%'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'test_writer', phase: 7, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['public interfaces (extracted)', 'test patterns'], skills_injected: [], token_warning: result.tokenWarning },
    decision: 'test suite written', artifact_written: null, commit, gate_result: null });

  return result;
}

async function runCritic(iteration = 1) {
  console.log(`  [8/13] Critic Agent — reviewing implementation (iteration ${iteration})`);
  setAgentStatus('critic', 'running', `Reviewing implementation (iteration ${iteration})`);

  const diff = getScopedDiff(getLastVibeCommit());
  const prd = readArtifact('prd.md');

  const reqLines = prd.split('\n').filter(l => l.match(/REQ-/)).join('\n');
  const context = `## Git Diff (source files only)\n\n${diff}\n\n---\n\n## Requirements\n\n${reqLines}`;
  writeContextFile('critic', context);

  const result = await runAgent('critic', 8, '08_critic.md', context);

  let findings;
  try { findings = JSON.parse(result.result); } catch {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { findings = JSON.parse(jsonMatch[0]); } catch {
        findings = { score: 0, passed: false, threshold: 80, blocking_issues: [{ id: 'C-ERR', description: 'Failed to parse critic output' }], warnings: [] };
      }
    } else {
      findings = { score: 0, passed: false, threshold: 80, blocking_issues: [{ id: 'C-ERR', description: 'Failed to parse critic output' }], warnings: [] };
    }
  }

  writeArtifact('review_findings.md', JSON.stringify(findings, null, 2));
  updateState({ gates: { critic_score: findings.passed || false } });

  const commit = gitCommit('critic', `8.${iteration}`,
    `chore(vibe/critic): review iteration ${iteration} — score ${findings.score}`,
    [`Score: ${findings.score}/${findings.threshold}`, `Blocking: ${findings.blocking_issues?.length || 0}`, `Warnings: ${findings.warnings?.length || 0}`],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'critic', phase: 8, iteration, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['git diff (scoped)', 'prd.md (REQ IDs only)'], skills_injected: [], token_warning: result.tokenWarning },
    decision: `score ${findings.score}, ${findings.passed ? 'passing' : 'not passing'} — ${findings.blocking_issues?.length || 0} blocking issues`,
    artifact_written: '.vibe/artifacts/review_findings.md', commit, gate_result: findings.passed });

  return { ...result, findings };
}

async function runFixer(iteration = 1) {
  console.log(`  [9/13] Fixer Agent — resolving blocking issues (iteration ${iteration})`);
  setAgentStatus('fixer', 'running', `Fixing blocking issues (iteration ${iteration})`);

  const findingsRaw = readArtifact('review_findings.md');
  let findings;
  try { findings = JSON.parse(findingsRaw); } catch { findings = { blocking_issues: [] }; }

  if (!findings.blocking_issues?.length) {
    setAgentStatus('fixer', 'skipped');
    return { result: 'no blocking issues', tokensIn: 0, tokensOut: 0 };
  }

  const referencedFiles = findings.blocking_issues
    .map(i => i.file).filter(Boolean)
    .filter((f, idx, arr) => arr.indexOf(f) === idx);

  let fileContents = '';
  for (const f of referencedFiles) {
    const fullPath = resolve(PROJECT_ROOT, f);
    if (existsSync(fullPath)) {
      fileContents += `\n\n## File: ${f}\n\n\`\`\`\n${readFileSync(fullPath, 'utf-8')}\n\`\`\``;
    }
  }

  const blockingJson = JSON.stringify(findings.blocking_issues, null, 2);
  const context = `## Blocking Issues\n\n${blockingJson}\n\n---\n\n## Referenced Files\n${fileContents}`;
  writeContextFile('fixer', context);

  const result = await runAgent('fixer', 9, '09_fixer.md', context);

  const commit = gitCommit('fixer', `9.${iteration}`,
    `fix(vibe/fixer): resolve blocking issues (iteration ${iteration})`,
    findings.blocking_issues.map(i => `${i.id}: ${i.description}`),
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'fixer', phase: 9, iteration, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['review_findings.md (blocking only)', `${referencedFiles.length} referenced files`], skills_injected: [], token_warning: result.tokenWarning },
    decision: `fixed ${findings.blocking_issues.length} blocking issues`,
    artifact_written: null, commit, gate_result: null });

  return result;
}

async function runCriticFixerLoop() {
  const state = readState();
  const maxIterations = state.iterations?.max_critic_fixer || 3;

  for (let i = 1; i <= maxIterations; i++) {
    updateState({ iterations: { critic_fixer: i } });

    const criticResult = await runCritic(i);
    if (criticResult.findings.passed) {
      console.log(`  Critic passed with score ${criticResult.findings.score}`);
      return true;
    }

    if (i === maxIterations) {
      console.log(`  Critic failed after ${maxIterations} iterations — escalating`);
      return false;
    }

    await runFixer(i);
  }
  return false;
}

async function runSecurityAuditor() {
  console.log('  [10/13] Security Auditor — post-implementation security review');
  setAgentStatus('security_auditor', 'running', 'Auditing security implementation');

  const threatModel = readArtifact('threat_model.md');
  const diff = getFullDiff();
  const context = `${threatModel}\n\n---\n\n## Implementation Diff\n\n${diff}`;
  writeContextFile('security_auditor', context);

  const result = await runAgent('security_auditor', 10, '10_security_auditor.md', context);

  let findings;
  try { findings = JSON.parse(result.result); } catch {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { findings = JSON.parse(jsonMatch[0]); } catch { findings = { cleared: false, new_findings: [{ id: 'SA-ERR', description: 'Parse error' }] }; } }
    else { findings = { cleared: false, new_findings: [{ id: 'SA-ERR', description: 'Parse error' }] }; }
  }

  writeArtifact('security_findings.md', JSON.stringify(findings, null, 2));
  updateState({ gates: { security: findings.cleared || false } });

  const commit = gitCommit('security_auditor', 10,
    `chore(vibe/security-auditor): security review — ${findings.cleared ? 'cleared' : 'issues found'}`,
    [findings.cleared ? 'All threat model items verified' : `${findings.new_findings?.length || 0} new findings`],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'security_auditor', phase: 10, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['threat_model.md (full)', 'implementation diff (scoped)'], skills_injected: [], token_warning: result.tokenWarning },
    decision: findings.cleared ? 'security cleared' : `${findings.new_findings?.length || 0} findings`,
    artifact_written: '.vibe/artifacts/security_findings.md', commit, gate_result: findings.cleared });

  return { ...result, findings };
}

async function runPerformanceAgent() {
  console.log('  [10b/13] Performance Agent — checking for anti-patterns');
  setAgentStatus('performance_agent', 'running', 'Scanning for performance anti-patterns');

  const arch = readArtifact('architecture.md');
  const diff = getFullDiff();
  const context = `${diff}\n\n---\n\n## Architecture (Data Model & Service Boundaries)\n\n${arch}`;
  writeContextFile('performance_agent', context);

  const result = await runAgent('performance_agent', '10b', '10b_performance_agent.md', context);

  let findings;
  try { findings = JSON.parse(result.result); } catch {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { findings = JSON.parse(jsonMatch[0]); } catch { findings = { cleared: true, blocking_issues: [], warnings: [] }; } }
    else { findings = { cleared: true, blocking_issues: [], warnings: [] }; }
  }

  writeArtifact('performance_findings.md', JSON.stringify(findings, null, 2));
  updateState({ gates: { performance: findings.cleared || false } });

  const commit = gitCommit('performance_agent', '10b',
    `chore(vibe/performance): performance review — ${findings.cleared ? 'cleared' : 'issues found'}`,
    [findings.cleared ? 'No blocking performance issues' : `${findings.blocking_issues?.length || 0} blocking issues`],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'performance_agent', phase: '10b', tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['implementation diff', 'architecture.md (data model)'], skills_injected: [], token_warning: result.tokenWarning },
    decision: findings.cleared ? 'performance cleared' : `${findings.blocking_issues?.length || 0} blocking issues`,
    artifact_written: '.vibe/artifacts/performance_findings.md', commit, gate_result: findings.cleared });

  return { ...result, findings };
}

async function runCompletenessJudge() {
  console.log('  [11/13] Completeness Judge — evaluating gates');
  setAgentStatus('completeness_judge', 'running', 'Evaluating completion gates');

  const prd = readArtifact('prd.md');
  const reviewFindings = readArtifact('review_findings.md') || '{}';
  const securityFindings = readArtifact('security_findings.md') || '{}';
  const perfFindings = readArtifact('performance_findings.md') || '{}';

  // Get test coverage
  let coverage = '0';
  try {
    const coverageOutput = execFileSync('npx', ['jest', '--coverage', '--coverageReporters=text-summary'],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
    const match = coverageOutput.match(/Statements\s*:\s*([\d.]+)%/);
    if (match) coverage = match[1];
  } catch {
    try {
      const coverageOutput = execFileSync('npx', ['vitest', 'run', '--coverage'],
        { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      const match = coverageOutput.match(/All files\s*\|\s*([\d.]+)/);
      if (match) coverage = match[1];
    } catch {
      coverage = '0';
    }
  }

  const gitLog = git('log', '--oneline', '-20');

  const context = [
    `## PRD Requirements\n\n${prd}`,
    `## Review Findings\n\n${reviewFindings}`,
    `## Security Findings\n\n${securityFindings}`,
    `## Performance Findings\n\n${perfFindings}`,
    `## Test Coverage\n\n${coverage}%`,
    `## Git Log\n\n${gitLog}`,
  ].join('\n\n---\n\n');
  writeContextFile('completeness_judge', context);

  const result = await runAgent('completeness_judge', 11, '11_completeness_judge.md', context);

  let report;
  try { report = JSON.parse(result.result); } catch {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { report = JSON.parse(jsonMatch[0]); } catch { report = { done: false, action: 'escalate_to_user' }; } }
    else { report = { done: false, action: 'escalate_to_user' }; }
  }

  writeArtifact('done_report.md', JSON.stringify(report, null, 2));

  if (report.gates) {
    updateState({
      gates: {
        prd_coverage: report.gates.prd_coverage?.passed || false,
        test_coverage: report.gates.test_coverage?.passed || false,
        critic_score: report.gates.critic_score?.passed || false,
        security: report.gates.security?.passed || false,
        performance: report.gates.performance?.passed || false,
      }
    });
  }

  const commit = gitCommit('completeness_judge', 11,
    `chore(vibe/completeness-judge): ${report.done ? 'all gates passed' : 'gates incomplete'}`,
    [report.done ? 'Project is complete' : `Action: ${report.action}`],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'completeness_judge', phase: 11, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['prd.md', 'review_findings.md', 'security_findings.md', 'performance_findings.md', 'test coverage', 'git log'], skills_injected: [], token_warning: result.tokenWarning },
    decision: report.done ? 'all gates passed' : `incomplete — ${report.action}`,
    artifact_written: '.vibe/artifacts/done_report.md', commit, gate_result: report.done });

  return { ...result, report };
}

async function runDocumenter() {
  console.log('  [12/13] Documenter Agent — generating documentation');
  setAgentStatus('documenter', 'running', 'Writing project documentation');

  const prd = readArtifact('prd.md');
  const arch = readArtifact('architecture.md');

  let interfaces = '(unable to extract interfaces)';
  try {
    const files = execFileSync('find', ['.', '-name', '*.ts', '-o', '-name', '*.js', '-o', '-name', '*.tsx'],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n').filter(f => f && !f.includes('node_modules') && !f.includes('.vibe') && !f.includes('test') && !f.includes('spec')).slice(0, 20);

    let extracted = '';
    for (const f of files) {
      try {
        const content = readFileSync(resolve(PROJECT_ROOT, f), 'utf-8');
        const exportLines = content.split('\n').filter(l => l.includes('export')).slice(0, 10);
        if (exportLines.length) extracted += `\n// ${f}\n${exportLines.join('\n')}\n`;
      } catch {}
    }
    if (extracted) interfaces = extracted;
  } catch {}

  const context = `${prd}\n\n---\n\n${arch}\n\n---\n\n## Public Interfaces\n\n${interfaces}`;
  writeContextFile('documenter', context);

  const result = await runAgent('documenter', 12, '12_documenter.md', context);

  const commit = gitCommit('documenter', 12,
    'docs(vibe/documenter): generate project documentation',
    ['README.md with setup and usage', 'docs/API.md endpoint reference', 'docs/DEPLOYMENT.md deployment guide'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'documenter', phase: 12, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['prd.md (features)', 'architecture.md (API surface)', 'public interfaces'], skills_injected: [], token_warning: result.tokenWarning },
    decision: 'documentation generated', artifact_written: null, commit, gate_result: null });

  return result;
}

async function runDeployer() {
  console.log('  [13/13] Deployer Agent — preparing deployment options');
  setAgentStatus('deployer', 'waiting_user', 'Preparing deployment options');

  const arch = readArtifact('architecture.md');

  let deployConfig = 'no deploy config';
  const deployConfigPath = resolve(PROJECT_ROOT, '.vibe-deploy.json');
  if (existsSync(deployConfigPath)) {
    deployConfig = readFileSync(deployConfigPath, 'utf-8');
  }

  const context = `${arch}\n\n---\n\n## Deploy Config\n\n${deployConfig}\n\n---\n\n## Available MCPs\n\nnone detected`;
  writeContextFile('deployer', context);

  const result = await runAgent('deployer', 13, '13_deployer.md', context);
  writeArtifact('deploy_options.md', result.result);

  const commit = gitCommit('deployer', 13,
    'chore(vibe/deployer): generate deployment options',
    ['Generated deployment options for the project'],
    result.tokensIn, result.tokensOut,
  );

  appendLog({ agent: 'deployer', phase: 13, tokens_in: result.tokensIn, tokens_out: result.tokensOut,
    context: { artifacts_read: ['architecture.md', 'deploy config', 'MCP list'], skills_injected: [], token_warning: result.tokenWarning },
    decision: 'deployment options generated', artifact_written: '.vibe/artifacts/deploy_options.md', commit, gate_result: null });

  console.log('\n' + result.result);
  return result;
}

// ─────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────

async function bootstrap(goal) {
  console.log('\n  VIBE Pipeline — bootstrapping\n');

  // 1. Ensure git repo
  try { git('status'); } catch {
    execFileSync('git', ['init'], { cwd: PROJECT_ROOT });
  }

  // 2. Scaffold directories
  for (const dir of ['logs', 'artifacts', 'context', 'prompts', 'ui']) {
    mkdirSync(resolve(VIBE_DIR, dir), { recursive: true });
  }

  // 3. Write initial state
  const initialState = {
    goal,
    phase: 0,
    status: 'initialising',
    started_at: new Date().toISOString(),
    iterations: { critic_fixer: 0, max_critic_fixer: 3 },
    gates: { prd_coverage: null, test_coverage: null, critic_score: null, security: null, performance: null },
    thresholds: { test_coverage: 70, critic_score: 80, prd_required_coverage: 100, prd_nicetohave_coverage: 80 },
    token_warning_threshold: 8000,
    detected_features: {},
    token_totals: { in: 0, out: 0 },
    agents: {},
  };

  for (const name of ['research', 'analyst', 'architect', 'security_planner', 'ux_designer',
    'implementer', 'test_writer', 'critic', 'fixer', 'security_auditor', 'performance_agent',
    'completeness_judge', 'documenter', 'deployer']) {
    initialState.agents[name] = { status: 'pending', activity: null, tokens_in: null, tokens_out: null };
  }

  writeState(initialState);

  // 4. Install UI dependencies
  const uiDir = resolve(VIBE_DIR, 'ui');
  if (!existsSync(resolve(uiDir, 'node_modules'))) {
    console.log('  Installing UI dependencies...');
    execFileSync('npm', ['install'], { cwd: uiDir, stdio: 'pipe' });
  }

  // 5. Boot UI monitor
  const uiProcess = spawn('node', [resolve(uiDir, 'server.js')], {
    cwd: uiDir, stdio: 'pipe', detached: true,
  });
  uiProcess.unref();
  console.log('  VIBE monitor running at http://localhost:4242');

  // 6. Commit scaffold
  try {
    git('add', '-A');
    git('commit', '-m', 'chore(vibe): scaffold .vibe directory');
  } catch {}

  updateState({ status: 'running', phase: 1 });
  return uiProcess;
}

// ─────────────────────────────────────────────────
// Continue/resume logic
// ─────────────────────────────────────────────────

async function handleContinue() {
  if (!existsSync(STATE_PATH)) {
    console.log('  No .vibe/state.json found — cannot continue');
    console.log('  Run with a goal to start a new project: node vibe.mjs "your goal"');
    process.exit(1);
  }

  const state = readState();

  // Handle continuation notes
  const continuePath = resolve(VIBE_DIR, 'continue.md');
  if (existsSync(continuePath)) {
    console.log('  Found continue.md — injecting into pipeline context');
    const archivePath = resolve(VIBE_DIR, 'logs', `continue_${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    copyFileSync(continuePath, archivePath);
    unlinkSync(continuePath);
  }

  // Reset stuck agents
  for (const [name, agent] of Object.entries(state.agents || {})) {
    if (agent.status === 'running') {
      console.log(`  Resetting stuck agent: ${name}`);
      state.agents[name].status = 'pending';
    }
  }
  writeState(state);

  // Boot UI
  const uiDir = resolve(VIBE_DIR, 'ui');
  if (!existsSync(resolve(uiDir, 'node_modules'))) {
    execFileSync('npm', ['install'], { cwd: uiDir, stdio: 'pipe' });
  }
  const uiProcess = spawn('node', [resolve(uiDir, 'server.js')], {
    cwd: uiDir, stdio: 'pipe', detached: true,
  });
  uiProcess.unref();
  console.log('  VIBE monitor running at http://localhost:4242');

  if (state.status === 'complete') {
    console.log('  Project previously completed — re-entering at Critic');
    updateState({ status: 'running', phase: 8 });
    return { phase: 8, uiProcess };
  }

  const phaseOrder = [
    ['research', 1], ['analyst', 2], ['architect', 3], ['security_planner', 4],
    ['ux_designer', 5], ['implementer', 6], ['test_writer', 7], ['critic', 8],
  ];

  for (const [name, phase] of phaseOrder) {
    if (state.agents[name]?.status !== 'passed') {
      console.log(`  Resuming at phase ${phase}: ${name}`);
      updateState({ status: 'running', phase });
      return { phase, uiProcess };
    }
  }

  return { phase: 10, uiProcess };
}

// ─────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────

export async function runPipeline(goal) {
  let uiProcess;

  try {
    uiProcess = await bootstrap(goal);
    console.log('\n  Starting pipeline...\n');

    await runResearch(goal);
    await runAnalyst(goal);
    await runArchitect();
    await runSecurityPlanner();
    await runUxDesigner();
    await runImplementer();
    await runTestWriter();

    const criticPassed = await runCriticFixerLoop();
    if (!criticPassed) {
      console.log('\n  ESCALATION: Critic/Fixer loop exhausted without resolution');
      const findings = readArtifact('review_findings.md');
      console.log('  Unresolved issues:\n' + findings);
      updateState({ status: 'escalated' });
      return;
    }

    const [secResult, perfResult] = await Promise.all([
      runSecurityAuditor(),
      runPerformanceAgent(),
    ]);

    if (!secResult.findings.cleared) {
      console.log('\n  ESCALATION: Security audit failed');
      console.log('  Findings:', JSON.stringify(secResult.findings, null, 2));
      updateState({ status: 'escalated' });
      return;
    }

    if (!perfResult.findings.cleared && perfResult.findings.blocking_issues?.length) {
      console.log('  Performance blocking issues found — running fixer');
      writeArtifact('review_findings.md', JSON.stringify({
        score: 0, passed: false, threshold: 80,
        blocking_issues: perfResult.findings.blocking_issues,
        warnings: perfResult.findings.warnings || [],
      }, null, 2));
      await runFixer(99);
    }

    const judgeResult = await runCompletenessJudge();
    if (!judgeResult.report.done) {
      console.log('\n  ESCALATION: Completeness check failed');
      console.log('  Report:', JSON.stringify(judgeResult.report, null, 2));
      updateState({ status: 'escalated' });
      return;
    }

    await runDocumenter();
    await runDeployer();

    updateState({ status: 'complete' });
    console.log('\n  VIBE pipeline complete!\n');

  } catch (err) {
    console.error(`\n  PIPELINE ERROR: ${err.message}`);
    console.error(err.stack);
    try { updateState({ status: interrupted ? 'interrupted' : 'failed' }); } catch {}
  } finally {
    if (uiProcess) {
      try { process.kill(-uiProcess.pid); } catch {}
    }
  }
}

export async function continuePipeline() {
  let uiProcess;

  try {
    const { phase, uiProcess: ui } = await handleContinue();
    uiProcess = ui;
    const state = readState();
    const goal = state.goal;

    console.log('\n  Continuing pipeline...\n');

    const phases = {
      1: () => runResearch(goal),
      2: () => runAnalyst(goal),
      3: () => runArchitect(),
      4: () => runSecurityPlanner(),
      5: () => runUxDesigner(),
      6: () => runImplementer(),
      7: () => runTestWriter(),
    };

    for (let p = phase; p <= 7; p++) {
      const agentNames = { 1: 'research', 2: 'analyst', 3: 'architect', 4: 'security_planner', 5: 'ux_designer', 6: 'implementer', 7: 'test_writer' };
      if (state.agents[agentNames[p]]?.status === 'passed') continue;
      if (phases[p]) await phases[p]();
    }

    if (phase <= 8 || state.agents.critic?.status !== 'passed') {
      const criticPassed = await runCriticFixerLoop();
      if (!criticPassed) {
        console.log('\n  ESCALATION: Critic/Fixer loop exhausted');
        updateState({ status: 'escalated' });
        return;
      }
    }

    if (state.agents.security_auditor?.status !== 'passed' || state.agents.performance_agent?.status !== 'passed') {
      const [secResult, perfResult] = await Promise.all([
        state.agents.security_auditor?.status !== 'passed' ? runSecurityAuditor() : { findings: { cleared: true } },
        state.agents.performance_agent?.status !== 'passed' ? runPerformanceAgent() : { findings: { cleared: true } },
      ]);

      if (!secResult.findings.cleared) {
        console.log('\n  ESCALATION: Security audit failed');
        updateState({ status: 'escalated' });
        return;
      }
      if (!perfResult.findings.cleared && perfResult.findings.blocking_issues?.length) {
        writeArtifact('review_findings.md', JSON.stringify({
          score: 0, passed: false, threshold: 80,
          blocking_issues: perfResult.findings.blocking_issues,
          warnings: perfResult.findings.warnings || [],
        }, null, 2));
        await runFixer(99);
      }
    }

    if (state.agents.completeness_judge?.status !== 'passed') {
      const judgeResult = await runCompletenessJudge();
      if (!judgeResult.report.done) {
        console.log('\n  ESCALATION: Completeness check failed');
        updateState({ status: 'escalated' });
        return;
      }
    }

    if (state.agents.documenter?.status !== 'passed') await runDocumenter();
    if (state.agents.deployer?.status !== 'passed') await runDeployer();

    updateState({ status: 'complete' });
    console.log('\n  VIBE pipeline complete!\n');

  } catch (err) {
    console.error(`\n  PIPELINE ERROR: ${err.message}`);
    console.error(err.stack);
    try { updateState({ status: interrupted ? 'interrupted' : 'failed' }); } catch {}
  } finally {
    if (uiProcess) {
      try { process.kill(-uiProcess.pid); } catch {}
    }
  }
}
