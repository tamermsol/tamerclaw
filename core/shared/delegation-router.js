/**
 * delegation-router.js — Smart Capability-Based Agent Routing
 *
 * Decides which agent is best suited for a task, enforces the
 * "synthesize before delegating" rule, and manages delegation chains.
 *
 * Key concepts:
 *   - Capability registry maps agents to domains, skills, and teams
 *   - routeTask() scores agents by domain/skill match + online status + load
 *   - buildDelegationSpec() enforces synthesis (no vague delegation)
 *   - createDelegationChain() builds multi-phase workflows
 *   - advanceChain() moves through phases, synthesizing between them
 *
 * Storage:
 *   Delegation chains are persisted at {TAMERCLAW_HOME}/tasks/chains/
 *
 * @module delegation-router
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ── Dynamic path resolution ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.TAMERCLAW_HOME || path.resolve(__dirname, '..', '..');

// ── Constants ──────────────────────────────────────────────────────────────────

const TASKS_DIR = path.join(BASE_DIR, 'tasks');
const CHAINS_DIR = path.join(TASKS_DIR, 'chains');
const AGENTS_DIR = path.join(BASE_DIR, 'agents');
const REGISTRY_PATH = path.join(TASKS_DIR, 'registry.json');

// ── Scoring weights ────────────────────────────────────────────────────────────

const SCORE_DOMAIN_MATCH = 3;
const SCORE_SKILL_MATCH = 2;
const SCORE_PARTIAL_MATCH = 1;
const SCORE_ONLINE_BOOST = 5;
const SCORE_OVERLOADED_PENALTY = -4;

// ── Agent Capability Registry ──────────────────────────────────────────────────

const AGENT_REGISTRY = {
  // Tech Team (CTO)
  'trading': {
    service: 'trading-agent.service',
    team: 'tech-team',
    leader: 'cto',
    domains: ['trading', 'crypto', 'finance', 'polymarket', 'defi', 'blockchain', 'prediction-markets', 'quantitative'],
    skills: ['python', 'django', 'celery', 'api', 'data-analysis', 'websocket', 'redis'],
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent'],
    model: 'dynamic',
    writeAccess: [path.join(BASE_DIR, 'agents', 'trading') + '/'],
    maxConcurrentTasks: 2,
  },
  'hbot': {
    service: 'hbot-agent.service',
    team: 'tech-team',
    leader: 'cto',
    subteamLeader: true,
    subteam: ['smarty', 'hbot-website', 'hbot-ux'],
    domains: ['iot', 'smart-home', 'esp32', 'mqtt', 'hardware', 'flutter', 'mobile-app', 'home-automation', 'embedded'],
    skills: ['flutter', 'dart', 'c++', 'mqtt', 'esp-idf', 'platformio', 'firebase'],
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent'],
    model: 'dynamic',
  },
  'smarty': {
    service: 'smarty-agent.service',
    team: 'tech-team',
    leader: 'cto',
    domains: ['research', 'analysis', 'strategy', 'planning', 'evaluation', 'architecture', 'investigation'],
    skills: ['research', 'analysis', 'writing', 'planning', 'architecture-review'],
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent'],
    model: 'dynamic',
  },
  'david': {
    service: 'david-agent.service',
    team: 'tech-team',
    leader: 'cto',
    domains: ['chat-app', 'messaging', 'social', 'real-time', 'flutter'],
    skills: ['flutter', 'dart', 'firebase', 'websocket', 'mobile'],
    model: 'dynamic',
  },
  'tamerclaw': {
    service: 'tamerclaw-agent.service',
    team: 'tech-team',
    leader: 'cto',
    domains: ['agent-system', 'infrastructure', 'devops', 'ci-cd', 'system-architecture', 'multi-agent'],
    skills: ['node', 'systemd', 'linux', 'shell', 'architecture', 'git'],
    model: 'dynamic',
  },
  'hbot-website': {
    service: 'hbot-website-agent.service',
    team: 'tech-team',
    leader: 'hbot',
    domains: ['website', 'landing-page', 'seo', 'web-performance', 'hbot-brand'],
    skills: ['nextjs', 'react', 'css', 'animation', 'tailwind', 'vercel'],
    model: 'dynamic',
  },
  'msol': {
    service: 'msol-agent.service',
    team: 'tech-team',
    domains: ['msol-website', 'company-site', 'portfolio', 'cms', 'payload-cms'],
    skills: ['nextjs', 'react', 'typescript', 'cms', 'framer-motion'],
    model: 'dynamic',
  },
  'mos-v3-website': {
    service: 'mos-v3-website-agent.service',
    team: 'tech-team',
    domains: ['mos', 'marketing-platform', 'saas', 'nextjs-app'],
    skills: ['nextjs', 'react', 'django', 'python', 'celery'],
    model: 'dynamic',
  },

  // Creative Team (CDO)
  'hbot-ux': {
    service: 'hbot-ux-agent.service',
    team: 'creative-team',
    leader: 'cdo',
    domains: ['ux', 'ui-design', 'wireframe', 'user-flow', 'accessibility', 'design-system'],
    skills: ['figma', 'design-system', 'usability', 'prototyping', 'user-research'],
    model: 'dynamic',
  },
  'agent-designer': {
    team: 'creative-team',
    leader: 'cdo',
    domains: ['agent-design', 'prompt-engineering', 'agent-behavior', 'identity-design'],
    skills: ['prompt-design', 'identity', 'behavior-modeling', 'system-prompts'],
    model: 'dynamic',
  },

  // Marketing Team (CMO)
  'presentations': {
    service: 'presentations-agent.service',
    team: 'marketing-team',
    leader: 'cmo',
    domains: ['presentation', 'pitch', 'slides', 'deck', 'demo', 'storytelling'],
    skills: ['html', 'css', 'animation', 'storytelling', 'reveal.js'],
    model: 'dynamic',
  },
  'msol-social': {
    team: 'marketing-team',
    leader: 'cmo',
    domains: ['social-media', 'linkedin', 'content', 'marketing', 'brand-voice'],
    skills: ['copywriting', 'social-media', 'content-strategy'],
  },

  // QA
  'qa': {
    service: 'qa-agent.service',
    domains: ['testing', 'quality', 'bugs', 'validation', 'regression', 'verification'],
    skills: ['testing', 'automation', 'verification', 'code-review'],
    model: 'dynamic',
  },
};

// ── Anti-pattern phrases for delegation spec validation ─────────────────────

const DELEGATION_ERROR_PATTERNS = [
  { pattern: /based on your findings/i, message: 'Delegates understanding — spec must contain the synthesized findings, not tell the agent to rely on its own' },
  { pattern: /figure it out/i, message: 'Vague delegation — spec must be specific and self-contained' },
  { pattern: /figure out/i, message: 'Vague delegation — spec must specify exactly what to do' },
  { pattern: /use your judgment/i, message: 'Delegates decision-making — the coordinator must make the decision and encode it in the spec' },
  { pattern: /do whatever you think/i, message: 'Abdication of coordination — spec must prescribe the approach' },
  { pattern: /look into this/i, message: 'Vague research delegation — specify exactly what to look into and what output to produce' },
];

const DELEGATION_WARNING_PATTERNS = [
  { check: (spec) => !spec.files || spec.files.length === 0, message: 'No specific files mentioned — spec should reference concrete file paths when applicable' },
  { check: (spec) => !spec.successCriteria || spec.successCriteria.length === 0, message: 'No success criteria — spec should define how to verify the task is done' },
  { check: (spec) => !spec.expectedOutput, message: 'No expected output format — spec should describe what the deliverable looks like' },
  { check: (spec) => !spec.constraints || spec.constraints.length === 0, message: 'No constraints specified — consider adding boundaries (do not modify X, keep Y stable)' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Ensure a directory exists, creating it recursively if needed.
 * @param {string} dir - Directory path
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Atomic JSON write: write to .tmp, then rename.
 * @param {string} filePath - Target path
 * @param {*} data - Serializable data
 */
function atomicWriteJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Safe JSON read with fallback.
 * @param {string} filePath - File to read
 * @param {*} fallback - Return value on failure
 * @returns {*}
 */
function readJSONSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Generate a unique chain ID.
 * @returns {string}
 */
function generateChainId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `chain-${ts}-${rand}`;
}

/**
 * Tokenize a string into lowercase tokens, splitting on whitespace,
 * hyphens, underscores, slashes, and dots. Filters out stop words
 * and tokens shorter than 2 characters.
 * @param {string} text - Input text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
    'if', 'while', 'this', 'that', 'these', 'those', 'it', 'its',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
    'them', 'their', 'what', 'which', 'who', 'whom', 'need', 'needs',
    'want', 'wants', 'create', 'make', 'build', 'update', 'change',
  ]);

  return text
    .toLowerCase()
    .split(/[\s\-_\/\.,:;!?()[\]{}'"]+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Check if token A is a partial match for token B (or vice versa).
 * A partial match means one token starts with the other and the shorter
 * token is at least 3 characters.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isPartialMatch(a, b) {
  if (a === b) return false; // exact match handled separately
  if (a.length < 3 || b.length < 3) return false;
  return a.startsWith(b) || b.startsWith(a);
}

// ── Core Functions ─────────────────────────────────────────────────────────────

/**
 * Score and rank agents for a given task description.
 *
 * Scoring:
 *   - Domain keyword match: 3 points each
 *   - Skill keyword match: 2 points each
 *   - Partial match (prefix): 1 point each
 *   - Online boost: +5 if the agent's systemd service is active
 *   - Overloaded penalty: -4 if agent has too many active tasks
 *
 * @param {string} taskDescription - Natural language description of the task
 * @param {Object} [options]
 * @param {string} [options.requiredTeam] - Filter to agents on this team
 * @param {string[]} [options.excludeAgents] - Agent IDs to exclude
 * @param {boolean} [options.checkOnline=true] - Whether to check systemd status
 * @param {number} [options.maxResults=10] - Maximum results to return
 * @returns {Array<{agentId: string, score: number, confidence: string, matchedDomains: string[], matchedSkills: string[], isOnline: boolean}>}
 */
export function routeTask(taskDescription, options = {}) {
  const {
    requiredTeam = null,
    excludeAgents = [],
    checkOnline = true,
    maxResults = 10,
  } = options;

  const tokens = tokenize(taskDescription);
  if (tokens.length === 0) {
    return [];
  }

  const results = [];
  const excludeSet = new Set(excludeAgents);

  for (const [agentId, agent] of Object.entries(AGENT_REGISTRY)) {
    // Apply filters
    if (excludeSet.has(agentId)) continue;
    if (requiredTeam && agent.team !== requiredTeam) continue;

    let score = 0;
    const matchedDomains = [];
    const matchedSkills = [];
    const partialMatches = [];

    // Score domain matches
    for (const domain of agent.domains || []) {
      const domainTokens = tokenize(domain);
      for (const dt of domainTokens) {
        for (const token of tokens) {
          if (token === dt) {
            score += SCORE_DOMAIN_MATCH;
            if (!matchedDomains.includes(domain)) matchedDomains.push(domain);
          } else if (isPartialMatch(token, dt)) {
            score += SCORE_PARTIAL_MATCH;
            if (!partialMatches.includes(domain)) partialMatches.push(domain);
          }
        }
      }
      // Also check the full domain string as a single token
      const domainLower = domain.toLowerCase();
      for (const token of tokens) {
        if (domainLower === token && !matchedDomains.includes(domain)) {
          score += SCORE_DOMAIN_MATCH;
          matchedDomains.push(domain);
        }
      }
    }

    // Score skill matches
    for (const skill of agent.skills || []) {
      const skillTokens = tokenize(skill);
      for (const st of skillTokens) {
        for (const token of tokens) {
          if (token === st) {
            score += SCORE_SKILL_MATCH;
            if (!matchedSkills.includes(skill)) matchedSkills.push(skill);
          } else if (isPartialMatch(token, st)) {
            score += SCORE_PARTIAL_MATCH;
            if (!partialMatches.includes(skill)) partialMatches.push(skill);
          }
        }
      }
      // Check full skill string
      const skillLower = skill.toLowerCase();
      for (const token of tokens) {
        if (skillLower === token && !matchedSkills.includes(skill)) {
          score += SCORE_SKILL_MATCH;
          matchedSkills.push(skill);
        }
      }
    }

    // Skip agents with no matches at all
    if (score === 0) continue;

    // Online check
    let isOnline = false;
    if (checkOnline && agent.service) {
      isOnline = isAgentOnline(agentId);
      if (isOnline) {
        score += SCORE_ONLINE_BOOST;
      }
    }

    // Load check
    const load = getAgentLoad(agentId);
    if (load.isOverloaded) {
      score += SCORE_OVERLOADED_PENALTY;
    }

    // Determine confidence level
    const maxPossible = (agent.domains?.length || 0) * SCORE_DOMAIN_MATCH
      + (agent.skills?.length || 0) * SCORE_SKILL_MATCH
      + SCORE_ONLINE_BOOST;
    const ratio = maxPossible > 0 ? score / maxPossible : 0;
    let confidence;
    if (ratio >= 0.4) confidence = 'high';
    else if (ratio >= 0.2) confidence = 'medium';
    else confidence = 'low';

    results.push({
      agentId,
      score,
      confidence,
      matchedDomains,
      matchedSkills,
      partialMatches,
      isOnline,
      team: agent.team || null,
      leader: agent.leader || null,
      load: {
        activeTasks: load.activeTasks,
        isOverloaded: load.isOverloaded,
      },
    });
  }

  // Sort by score descending, then by agentId for stable ordering
  results.sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));

  return results.slice(0, maxResults);
}

/**
 * Build a self-contained delegation specification for a target agent.
 *
 * Implements the "synthesize before delegating" rule: the spec must contain
 * all context the agent needs. It must NOT tell the agent to "figure out"
 * anything or rely on "its own findings."
 *
 * @param {string} taskDescription - The original task description
 * @param {Object} researchFindings - Synthesized research context
 * @param {string} researchFindings.summary - Human-readable summary of findings
 * @param {string[]} [researchFindings.files] - Relevant file paths discovered
 * @param {Object} [researchFindings.data] - Structured data from research
 * @param {string} targetAgent - The agent ID that will receive the spec
 * @returns {{spec: Object, validation: {valid: boolean, warnings: string[], errors: string[]}}}
 * @throws {Error} If targetAgent is not in the registry
 */
export function buildDelegationSpec(taskDescription, researchFindings, targetAgent) {
  if (!AGENT_REGISTRY[targetAgent]) {
    throw new Error(`Unknown agent "${targetAgent}" — not found in AGENT_REGISTRY`);
  }

  const agent = AGENT_REGISTRY[targetAgent];
  const findings = researchFindings || {};

  // Build the self-contained spec
  const spec = {
    targetAgent,
    team: agent.team || null,
    leader: agent.leader || null,
    timestamp: new Date().toISOString(),

    // What to do — synthesized from task + research
    task: taskDescription,
    context: findings.summary || '',

    // Which files — concrete paths from research
    files: findings.files || [],

    // Structured data the agent needs
    data: findings.data || null,

    // Expected outcome — what "done" looks like
    expectedOutput: findings.expectedOutput || '',

    // Success criteria — how to verify
    successCriteria: findings.successCriteria || [],

    // Constraints — what NOT to do
    constraints: findings.constraints || [],

    // The synthesized prompt that will be sent to the agent
    prompt: _buildSynthesizedPrompt(taskDescription, findings, targetAgent, agent),
  };

  // Validate the spec before returning
  const validation = validateDelegationSpec(spec);

  return { spec, validation };
}

/**
 * Build the actual prompt text from synthesized inputs.
 * @private
 */
function _buildSynthesizedPrompt(taskDescription, findings, targetAgent, agent) {
  const lines = [];

  lines.push(`## Task for ${targetAgent}`);
  lines.push('');
  lines.push(taskDescription);

  if (findings.summary) {
    lines.push('');
    lines.push('## Context (from prior research)');
    lines.push('');
    lines.push(findings.summary);
  }

  if (findings.files && findings.files.length > 0) {
    lines.push('');
    lines.push('## Relevant Files');
    lines.push('');
    for (const f of findings.files) {
      lines.push(`- \`${f}\``);
    }
  }

  if (findings.data) {
    lines.push('');
    lines.push('## Data');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(findings.data, null, 2));
    lines.push('```');
  }

  if (findings.expectedOutput) {
    lines.push('');
    lines.push('## Expected Output');
    lines.push('');
    lines.push(findings.expectedOutput);
  }

  if (findings.successCriteria && findings.successCriteria.length > 0) {
    lines.push('');
    lines.push('## Success Criteria');
    lines.push('');
    for (const c of findings.successCriteria) {
      lines.push(`- ${c}`);
    }
  }

  if (findings.constraints && findings.constraints.length > 0) {
    lines.push('');
    lines.push('## Constraints');
    lines.push('');
    for (const c of findings.constraints) {
      lines.push(`- ${c}`);
    }
  }

  return lines.join('\n');
}

/**
 * Create a multi-phase delegation chain for complex tasks.
 *
 * Each phase can run one or more agents in parallel or sequentially.
 * The chain advances phase-by-phase, synthesizing results between phases.
 *
 * @param {string} taskDescription - Overall task description
 * @param {Array<{phase: string, agents: string[], parallel?: boolean}>} phases - Ordered list of phases
 * @returns {Object} The chain object, also persisted to disk
 * @throws {Error} If phases array is empty or contains unknown agents
 */
export function createDelegationChain(taskDescription, phases) {
  if (!phases || phases.length === 0) {
    throw new Error('Delegation chain requires at least one phase');
  }

  // Validate all agents exist
  for (const phase of phases) {
    if (!phase.phase || typeof phase.phase !== 'string') {
      throw new Error('Each phase must have a "phase" name string');
    }
    if (!phase.agents || phase.agents.length === 0) {
      throw new Error(`Phase "${phase.phase}" must have at least one agent`);
    }
    for (const agentId of phase.agents) {
      if (!AGENT_REGISTRY[agentId]) {
        throw new Error(`Unknown agent "${agentId}" in phase "${phase.phase}" — not in AGENT_REGISTRY`);
      }
    }
  }

  const chainId = generateChainId();
  const now = new Date().toISOString();

  const chain = {
    id: chainId,
    description: taskDescription,
    phases: phases.map((p, idx) => ({
      phase: p.phase,
      index: idx,
      agents: p.agents,
      parallel: p.parallel !== undefined ? p.parallel : (p.agents.length > 1),
      status: 'pending',
      startedAt: null,
      completedAt: null,
      results: {},
      specs: {},
    })),
    currentPhase: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    results: {},
    history: [
      { action: 'created', at: now, details: `Chain created with ${phases.length} phases` },
    ],
  };

  // Persist to disk
  ensureDir(CHAINS_DIR);
  atomicWriteJSON(path.join(CHAINS_DIR, `${chainId}.json`), chain);

  return chain;
}

/**
 * Advance a delegation chain to the next phase.
 *
 * Checks that all agents in the current phase have reported results,
 * synthesizes those results into specs for the next phase, and dispatches.
 *
 * @param {string} chainId - The chain ID to advance
 * @param {Object} [phaseResults] - Results from the current phase, keyed by agentId
 * @returns {{chain: Object, nextPhase: Object|null, specs: Object}}
 * @throws {Error} If chain not found, current phase incomplete, or chain already finished
 */
export function advanceChain(chainId, phaseResults = {}) {
  const chainPath = path.join(CHAINS_DIR, `${chainId}.json`);
  const chain = readJSONSafe(chainPath);

  if (!chain) {
    throw new Error(`Chain "${chainId}" not found at ${chainPath}`);
  }

  if (chain.status === 'completed' || chain.status === 'failed') {
    throw new Error(`Chain "${chainId}" is already ${chain.status}`);
  }

  const currentIdx = chain.currentPhase;
  const currentPhase = chain.phases[currentIdx];

  if (!currentPhase) {
    throw new Error(`Chain "${chainId}" has no phase at index ${currentIdx}`);
  }

  const now = new Date().toISOString();

  // Merge provided results into the current phase
  for (const [agentId, result] of Object.entries(phaseResults)) {
    currentPhase.results[agentId] = result;
  }

  // Check if all agents in current phase have results
  const missingResults = currentPhase.agents.filter(
    agentId => !currentPhase.results[agentId]
  );

  if (missingResults.length > 0) {
    // Save partial progress
    chain.updatedAt = now;
    atomicWriteJSON(chainPath, chain);
    return {
      chain,
      nextPhase: null,
      specs: {},
      waiting: missingResults,
      message: `Waiting for results from: ${missingResults.join(', ')}`,
    };
  }

  // Mark current phase as completed
  currentPhase.status = 'completed';
  currentPhase.completedAt = now;

  // Collect all results from current phase into the chain's aggregate
  chain.results[currentPhase.phase] = { ...currentPhase.results };

  chain.history.push({
    action: 'phase_completed',
    at: now,
    phase: currentPhase.phase,
    agents: currentPhase.agents,
  });

  // Check if this was the last phase
  const nextIdx = currentIdx + 1;
  if (nextIdx >= chain.phases.length) {
    chain.status = 'completed';
    chain.updatedAt = now;
    chain.history.push({ action: 'chain_completed', at: now });
    atomicWriteJSON(chainPath, chain);
    return {
      chain,
      nextPhase: null,
      specs: {},
      message: 'Chain completed — all phases finished',
    };
  }

  // Advance to next phase
  chain.currentPhase = nextIdx;
  const nextPhase = chain.phases[nextIdx];
  nextPhase.status = 'in_progress';
  nextPhase.startedAt = now;
  chain.status = 'in_progress';

  // Synthesize results from current phase into specs for next phase agents.
  // This is the critical "synthesize before delegating" step.
  const synthesizedSummary = _synthesizePhaseResults(currentPhase);
  const specs = {};

  for (const agentId of nextPhase.agents) {
    const { spec, validation } = buildDelegationSpec(
      chain.description,
      {
        summary: synthesizedSummary,
        files: _extractFilesFromResults(currentPhase.results),
        data: currentPhase.results,
        expectedOutput: `Output for ${nextPhase.phase} phase`,
        successCriteria: [`Complete the ${nextPhase.phase} phase of: ${chain.description}`],
        constraints: [],
      },
      agentId
    );

    specs[agentId] = spec;
    nextPhase.specs[agentId] = spec;

    // If there are validation errors, log them but don't block
    if (!validation.valid) {
      chain.history.push({
        action: 'spec_validation_warning',
        at: now,
        agent: agentId,
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }
  }

  chain.updatedAt = now;
  chain.history.push({
    action: 'phase_started',
    at: now,
    phase: nextPhase.phase,
    agents: nextPhase.agents,
  });

  atomicWriteJSON(chainPath, chain);

  return {
    chain,
    nextPhase,
    specs,
    message: `Advanced to phase "${nextPhase.phase}" with agents: ${nextPhase.agents.join(', ')}`,
  };
}

/**
 * Synthesize results from a completed phase into a coherent summary.
 * @private
 * @param {Object} phase - The completed phase object
 * @returns {string} Human-readable synthesis
 */
function _synthesizePhaseResults(phase) {
  const lines = [];
  lines.push(`Results from "${phase.phase}" phase:`);
  lines.push('');

  for (const [agentId, result] of Object.entries(phase.results)) {
    lines.push(`### ${agentId}`);

    if (typeof result === 'string') {
      lines.push(result);
    } else if (result && typeof result === 'object') {
      if (result.summary) {
        lines.push(result.summary);
      }
      if (result.findings) {
        lines.push('');
        lines.push('Key findings:');
        if (Array.isArray(result.findings)) {
          for (const f of result.findings) {
            lines.push(`- ${typeof f === 'string' ? f : JSON.stringify(f)}`);
          }
        } else {
          lines.push(JSON.stringify(result.findings, null, 2));
        }
      }
      if (result.output) {
        lines.push('');
        lines.push('Output:');
        lines.push(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2));
      }
      if (result.files) {
        lines.push('');
        lines.push('Files:');
        const files = Array.isArray(result.files) ? result.files : [result.files];
        for (const f of files) {
          lines.push(`- ${f}`);
        }
      }
    } else {
      lines.push(String(result));
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Extract file paths from phase results.
 * @private
 * @param {Object} results - Phase results keyed by agentId
 * @returns {string[]} Unique file paths
 */
function _extractFilesFromResults(results) {
  const files = new Set();

  for (const result of Object.values(results)) {
    if (!result || typeof result !== 'object') continue;

    if (result.files) {
      const fileList = Array.isArray(result.files) ? result.files : [result.files];
      for (const f of fileList) {
        if (typeof f === 'string') files.add(f);
      }
    }
  }

  return [...files];
}

/**
 * Validate a delegation spec for anti-patterns.
 *
 * Checks the prompt and spec fields against known bad patterns from the
 * "synthesize before delegating" rule. Errors indicate the spec MUST be
 * rewritten. Warnings suggest improvements but are not blocking.
 *
 * @param {Object} spec - The delegation spec to validate
 * @param {string} spec.prompt - The synthesized prompt text
 * @param {string} spec.task - The task description
 * @param {string[]} [spec.files] - Referenced file paths
 * @param {string[]} [spec.successCriteria] - Success criteria
 * @param {string} [spec.expectedOutput] - Expected output description
 * @param {string[]} [spec.constraints] - Constraints
 * @returns {{valid: boolean, warnings: string[], errors: string[]}}
 */
export function validateDelegationSpec(spec) {
  const errors = [];
  const warnings = [];

  if (!spec) {
    return { valid: false, warnings: [], errors: ['Spec is null or undefined'] };
  }

  // Check the prompt text for error-level anti-patterns
  const textToCheck = [spec.prompt || '', spec.task || '', spec.context || ''].join(' ');

  for (const { pattern, message } of DELEGATION_ERROR_PATTERNS) {
    if (pattern.test(textToCheck)) {
      errors.push(message);
    }
  }

  // Check structural warning patterns
  for (const { check, message } of DELEGATION_WARNING_PATTERNS) {
    if (check(spec)) {
      warnings.push(message);
    }
  }

  // Additional structural checks
  if (!spec.prompt && !spec.task) {
    errors.push('Spec has neither a prompt nor a task description — it is empty');
  }

  if (spec.prompt && spec.prompt.length < 20) {
    warnings.push('Prompt is very short — consider adding more detail for the target agent');
  }

  if (!spec.targetAgent) {
    errors.push('No target agent specified');
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Check an agent's current task load.
 *
 * Reads from the task registry, checks the agent's inbox for pending tasks,
 * and checks if a processing.json file exists.
 *
 * @param {string} agentId - The agent to check
 * @returns {{activeTasks: number, lastActivity: string|null, isOverloaded: boolean, tasks: string[]}}
 */
export function getAgentLoad(agentId) {
  const maxConcurrent = AGENT_REGISTRY[agentId]?.maxConcurrentTasks || 3;
  let activeTasks = 0;
  let lastActivity = null;
  const taskIds = [];

  // Check the task registry for active tasks assigned to this agent
  const registry = readJSONSafe(REGISTRY_PATH);
  if (registry && registry.tasks) {
    for (const [taskId, task] of Object.entries(registry.tasks)) {
      const isAssigned = task.assignedTo === agentId
        || (task.delegatedTo && task.delegatedTo.includes(agentId));

      if (isAssigned && !['delivered', 'cancelled', 'completed'].includes(task.status)) {
        activeTasks++;
        taskIds.push(taskId);

        // Track most recent activity
        if (task.updatedAt) {
          if (!lastActivity || task.updatedAt > lastActivity) {
            lastActivity = task.updatedAt;
          }
        }
      }
    }
  }

  // Check agent's inbox for pending task files
  const inboxDir = path.join(AGENTS_DIR, agentId, 'inbox');
  try {
    const inboxFiles = fs.readdirSync(inboxDir)
      .filter(f => f.endsWith('.json') || f.endsWith('.md'));
    activeTasks += inboxFiles.length;
  } catch {
    // No inbox directory or read error — not a problem
  }

  // Check for processing.json (indicates agent is mid-task)
  const processingPath = path.join(AGENTS_DIR, agentId, 'processing.json');
  try {
    const processing = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
    if (processing && processing.taskId) {
      // Don't double-count if already in the registry count
      if (!taskIds.includes(processing.taskId)) {
        activeTasks++;
      }
      if (processing.startedAt) {
        if (!lastActivity || processing.startedAt > lastActivity) {
          lastActivity = processing.startedAt;
        }
      }
    }
  } catch {
    // No processing.json — agent is idle
  }

  return {
    activeTasks,
    lastActivity,
    isOverloaded: activeTasks >= maxConcurrent,
    maxConcurrentTasks: maxConcurrent,
    tasks: taskIds,
  };
}

/**
 * Check if an agent's systemd service is currently running.
 *
 * @param {string} agentId - The agent ID to check
 * @returns {boolean} True if the agent's service is active
 */
export function isAgentOnline(agentId) {
  const agent = AGENT_REGISTRY[agentId];
  if (!agent || !agent.service) return false;

  try {
    const result = execSync(`systemctl is-active ${agent.service} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return result === 'active';
  } catch {
    return false;
  }
}

// ── Chain Query Functions ──────────────────────────────────────────────────────

/**
 * Load a chain by its ID.
 *
 * @param {string} chainId - The chain ID
 * @returns {Object|null} The chain object or null if not found
 */
export function getChain(chainId) {
  return readJSONSafe(path.join(CHAINS_DIR, `${chainId}.json`));
}

/**
 * List all chains, optionally filtered by status.
 *
 * @param {Object} [options]
 * @param {string} [options.status] - Filter by chain status
 * @param {number} [options.limit=20] - Maximum chains to return
 * @returns {Object[]} Array of chain objects
 */
export function listChains(options = {}) {
  const { status = null, limit = 20 } = options;

  ensureDir(CHAINS_DIR);

  let files;
  try {
    files = fs.readdirSync(CHAINS_DIR)
      .filter(f => f.startsWith('chain-') && f.endsWith('.json'))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }

  const chains = [];
  for (const file of files) {
    if (chains.length >= limit) break;

    const chain = readJSONSafe(path.join(CHAINS_DIR, file));
    if (!chain) continue;

    if (status && chain.status !== status) continue;
    chains.push(chain);
  }

  return chains;
}

/**
 * Update the status of a specific phase's agent result within a chain.
 *
 * @param {string} chainId - The chain ID
 * @param {string} agentId - The agent reporting results
 * @param {*} result - The result data
 * @returns {Object} Updated chain
 * @throws {Error} If chain not found or agent not in current phase
 */
export function reportPhaseResult(chainId, agentId, result) {
  const chainPath = path.join(CHAINS_DIR, `${chainId}.json`);
  const chain = readJSONSafe(chainPath);

  if (!chain) {
    throw new Error(`Chain "${chainId}" not found`);
  }

  const currentPhase = chain.phases[chain.currentPhase];
  if (!currentPhase) {
    throw new Error(`Chain "${chainId}" has no active phase`);
  }

  if (!currentPhase.agents.includes(agentId)) {
    throw new Error(`Agent "${agentId}" is not part of phase "${currentPhase.phase}" in chain "${chainId}"`);
  }

  currentPhase.results[agentId] = result;
  chain.updatedAt = new Date().toISOString();
  chain.history.push({
    action: 'result_reported',
    at: chain.updatedAt,
    agent: agentId,
    phase: currentPhase.phase,
  });

  atomicWriteJSON(chainPath, chain);
  return chain;
}

// ── Registry Access ────────────────────────────────────────────────────────────

/**
 * Get the full agent registry.
 *
 * @returns {Object} Copy of the AGENT_REGISTRY
 */
export function getAgentRegistry() {
  return { ...AGENT_REGISTRY };
}

/**
 * Get a single agent's registry entry.
 *
 * @param {string} agentId - The agent ID
 * @returns {Object|null} The agent's registry entry or null
 */
export function getAgentInfo(agentId) {
  return AGENT_REGISTRY[agentId] ? { agentId, ...AGENT_REGISTRY[agentId] } : null;
}

/**
 * Get all agents belonging to a specific team.
 *
 * @param {string} teamName - Team name (e.g., 'tech-team', 'creative-team')
 * @returns {Array<{agentId: string, [key: string]: *}>}
 */
export function getTeamAgents(teamName) {
  return Object.entries(AGENT_REGISTRY)
    .filter(([, agent]) => agent.team === teamName)
    .map(([agentId, agent]) => ({ agentId, ...agent }));
}

// ── Default Export ──────────────────────────────────────────────────────────────

export default {
  routeTask,
  buildDelegationSpec,
  createDelegationChain,
  advanceChain,
  validateDelegationSpec,
  getAgentLoad,
  isAgentOnline,
  getChain,
  listChains,
  reportPhaseResult,
  getAgentRegistry,
  getAgentInfo,
  getTeamAgents,
  AGENT_REGISTRY,
};
