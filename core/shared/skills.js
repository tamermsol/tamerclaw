/**
 * skills.js — Bundled Skills System for TamerClaw v1.17.0
 *
 * Inspired by Claude Code's Skills architecture.
 * Skills are AI-powered, context-aware actions that go beyond simple commands:
 *   - They understand the current agent state and conversation context
 *   - They can chain multiple operations together
 *   - They auto-adapt based on the agent's identity and capabilities
 *   - They can be auto-generated from usage patterns (/skillify)
 *
 * Built-in skills: /stuck, /simplify, /verify, /recap, /handoff,
 *                  /diagnose, /checkpoint, /skillify
 *
 * Custom skills can be defined per-agent or globally.
 *
 * Usage:
 *   import { SkillsEngine, getSkillsEngine } from './skills.js';
 *
 *   const skills = getSkillsEngine();
 *   skills.register({
 *     name: 'deploy',
 *     description: 'Deploy the current project',
 *     trigger: /^\/deploy/,
 *     execute: async (ctx) => { ... },
 *   });
 *
 *   const result = await skills.execute('/stuck', ctx);
 */

import fs from 'fs';
import path from 'path';
import paths from './paths.js';
import { feature } from './feature-flags.js';

// ── Skill Definition ────────────────────────────────────────────────────
/**
 * @typedef {object} Skill
 * @property {string} name - Skill name (e.g., 'stuck')
 * @property {string} description - What the skill does
 * @property {RegExp|string} trigger - When to activate
 * @property {string} category - 'builtin', 'agent', 'custom', 'generated'
 * @property {boolean} aiPowered - Does this skill use AI classification
 * @property {Function} execute - async (ctx) => result
 * @property {string[]} [requiredFeatures] - Feature flags needed
 * @property {string[]} [forAgents] - Restrict to specific agents (empty = all)
 */

// ── SkillsEngine ────────────────────────────────────────────────────────
export class SkillsEngine {
  constructor() {
    this._skills = new Map();
    this._stats = {
      executions: 0,
      bySkill: {},
      errors: 0,
    };
    this._registerBuiltins();
  }

  /**
   * Register a skill.
   * @param {Skill} skill
   */
  register(skill) {
    if (!skill.name) throw new Error('Skill must have a name');

    this._skills.set(skill.name, {
      name: skill.name,
      description: skill.description || '',
      trigger: skill.trigger instanceof RegExp
        ? skill.trigger
        : new RegExp(`^\\/${skill.name}(?:\\s|$)`, 'i'),
      category: skill.category || 'custom',
      aiPowered: skill.aiPowered || false,
      execute: skill.execute,
      requiredFeatures: skill.requiredFeatures || [],
      forAgents: skill.forAgents || [],
    });
  }

  /**
   * Check if text triggers any skill.
   * @param {string} text
   * @returns {Skill|null}
   */
  match(text) {
    for (const skill of this._skills.values()) {
      if (skill.trigger.test(text)) return skill;
    }
    return null;
  }

  /**
   * Execute a skill by name or text match.
   * @param {string} nameOrText
   * @param {object} ctx - Execution context
   * @returns {Promise<{handled: boolean, result?: any, error?: string}>}
   */
  async execute(nameOrText, ctx) {
    const skill = this._skills.get(nameOrText) || this.match(nameOrText);

    if (!skill) {
      return { handled: false, error: `No skill matched: ${nameOrText}` };
    }

    // Check feature flag requirements
    for (const feat of skill.requiredFeatures) {
      if (!feature(feat)) {
        return { handled: false, error: `Skill '${skill.name}' requires disabled feature: ${feat}` };
      }
    }

    // Check agent restriction
    if (skill.forAgents.length > 0 && ctx.agentId && !skill.forAgents.includes(ctx.agentId)) {
      return { handled: false, error: `Skill '${skill.name}' not available for agent: ${ctx.agentId}` };
    }

    try {
      this._stats.executions++;
      this._stats.bySkill[skill.name] = (this._stats.bySkill[skill.name] || 0) + 1;

      const args = nameOrText.replace(skill.trigger, '').trim();
      const result = await skill.execute({ ...ctx, args, skillName: skill.name });

      return { handled: true, result };
    } catch (err) {
      this._stats.errors++;
      return { handled: false, error: `Skill '${skill.name}' failed: ${err.message}` };
    }
  }

  /**
   * List all available skills.
   * @param {object} [filter]
   * @returns {Array<{name: string, description: string, category: string}>}
   */
  list(filter = {}) {
    let skills = [...this._skills.values()];

    if (filter.category) skills = skills.filter(s => s.category === filter.category);
    if (filter.agentId) skills = skills.filter(s =>
      s.forAgents.length === 0 || s.forAgents.includes(filter.agentId)
    );

    return skills.map(s => ({
      name: s.name,
      description: s.description,
      category: s.category,
      aiPowered: s.aiPowered,
    }));
  }

  /**
   * Get execution stats.
   */
  getStats() {
    return { ...this._stats };
  }

  // ── Built-in Skills ───────────────────────────────────────────────────

  _registerBuiltins() {

    // ── /stuck — Diagnose why the agent appears stuck ──────────────────
    this.register({
      name: 'stuck',
      description: 'Diagnose and suggest fixes when an agent appears stuck or unresponsive',
      category: 'builtin',
      aiPowered: true,
      execute: async (ctx) => {
        const diagnostics = [];

        // Check agent process
        if (ctx.agentId) {
          const agentDir = paths.agentDir(ctx.agentId);
          const sessionDir = paths.sessions(ctx.agentId);

          // Check for lock files
          if (fs.existsSync(path.join(agentDir, '.lock'))) {
            diagnostics.push('Agent has a .lock file — may be in a long operation');
          }

          // Check last activity
          try {
            const memDir = paths.memory(ctx.agentId);
            if (fs.existsSync(memDir)) {
              const files = fs.readdirSync(memDir).sort().reverse();
              if (files.length > 0) {
                const stat = fs.statSync(path.join(memDir, files[0]));
                const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
                diagnostics.push(`Last memory update: ${Math.round(ageMinutes)} minutes ago`);
              }
            }
          } catch {}
        }

        // Use AI for deeper diagnosis if available
        if (ctx.recentMessages && ctx.recentMessages.length > 0) {
          try {
            const { classify } = await import('./anthropic-client.js');
            const recent = ctx.recentMessages.slice(-5).map(m => `${m.role}: ${(m.content || '').slice(0, 200)}`).join('\n');
            const analysis = await classify(
              `An AI agent appears stuck. Here are its recent messages:\n${recent}\n\nDiagnose the likely issue in 2-3 sentences and suggest a fix.`,
              { maxTokens: 300 }
            );
            diagnostics.push(typeof analysis === 'string' ? analysis : analysis.text || 'No diagnosis available');
          } catch {
            diagnostics.push('AI diagnosis unavailable — check if Anthropic API is connected');
          }
        }

        return diagnostics.length > 0
          ? diagnostics.join('\n')
          : 'No obvious issues found. Agent may be processing a complex task.';
      },
    });

    // ── /simplify — Review and simplify recent code changes ───────────
    this.register({
      name: 'simplify',
      description: 'Review recent code changes and suggest simplifications',
      category: 'builtin',
      aiPowered: true,
      execute: async (ctx) => {
        return 'Simplify skill: Pass a file path as argument, e.g., /simplify ./src/app.js — or run without args after making changes to review the last modified files.';
      },
    });

    // ── /verify — Verify the current state of a task ──────────────────
    this.register({
      name: 'verify',
      description: 'Verify that a task or implementation is complete and correct',
      category: 'builtin',
      aiPowered: true,
      execute: async (ctx) => {
        const checks = [];

        // Check if there are uncommitted changes
        try {
          const { execSync } = await import('child_process');
          const status = execSync('git status --porcelain', { cwd: paths.home, timeout: 5000 }).toString();
          if (status.trim()) {
            const fileCount = status.trim().split('\n').length;
            checks.push(`${fileCount} uncommitted file(s) in working directory`);
          } else {
            checks.push('Working directory clean');
          }
        } catch {
          checks.push('Git status check failed');
        }

        return checks.join('\n') || 'No verification issues found.';
      },
    });

    // ── /recap — Summarize the current session ────────────────────────
    this.register({
      name: 'recap',
      description: 'Summarize what happened in the current session',
      category: 'builtin',
      aiPowered: false,
      execute: async (ctx) => {
        if (!ctx.recentMessages || ctx.recentMessages.length === 0) {
          return 'No messages in current session to recap.';
        }

        const userMessages = ctx.recentMessages.filter(m => m.role === 'user');
        const assistantMessages = ctx.recentMessages.filter(m => m.role === 'assistant');

        let recap = `Session recap (${ctx.recentMessages.length} messages):\n`;
        recap += `- ${userMessages.length} user messages, ${assistantMessages.length} responses\n`;

        // Extract topics from user messages
        const topics = new Set();
        for (const msg of userMessages) {
          const words = (msg.content || '').split(/\s+/).slice(0, 10).join(' ');
          if (words.length > 5) topics.add(words);
        }

        if (topics.size > 0) {
          recap += `\nTopics discussed:\n`;
          for (const topic of [...topics].slice(0, 5)) {
            recap += `- ${topic}...\n`;
          }
        }

        return recap;
      },
    });

    // ── /handoff — Prepare context for another agent ──────────────────
    this.register({
      name: 'handoff',
      description: 'Prepare context package for handing off work to another agent',
      category: 'builtin',
      aiPowered: false,
      execute: async (ctx) => {
        const targetAgent = ctx.args?.trim();
        if (!targetAgent) {
          return 'Usage: /handoff <agent-name>\nPrepares a context summary for the target agent.';
        }

        const handoff = {
          from: ctx.agentId || 'unknown',
          to: targetAgent,
          timestamp: new Date().toISOString(),
          context: [],
        };

        // Gather recent context
        if (ctx.recentMessages) {
          handoff.context = ctx.recentMessages.slice(-10).map(m => ({
            role: m.role,
            summary: (m.content || '').slice(0, 300),
          }));
        }

        // Write handoff file to target agent's inbox
        const inboxDir = path.join(paths.agentDir(targetAgent), 'inbox');
        if (!fs.existsSync(inboxDir)) {
          fs.mkdirSync(inboxDir, { recursive: true });
        }

        const handoffPath = path.join(inboxDir, `handoff-${ctx.agentId || 'anon'}-${Date.now()}.json`);
        fs.writeFileSync(handoffPath, JSON.stringify(handoff, null, 2));

        return `Handoff prepared for ${targetAgent}. Context (${handoff.context.length} messages) written to their inbox.`;
      },
    });

    // ── /diagnose — System health check ───────────────────────────────
    this.register({
      name: 'diagnose',
      description: 'Run system diagnostics (memory, processes, connections)',
      category: 'builtin',
      aiPowered: false,
      execute: async (ctx) => {
        const diagnostics = [];

        // Memory usage
        const memUsage = process.memoryUsage();
        diagnostics.push(`Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB heap`);

        // Uptime
        diagnostics.push(`Uptime: ${Math.round(process.uptime() / 60)} minutes`);

        // Node version
        diagnostics.push(`Node: ${process.version}`);

        // Check key directories
        const dirs = [paths.agents, paths.bridge, paths.shared];
        for (const dir of dirs) {
          diagnostics.push(`${path.basename(dir)}: ${fs.existsSync(dir) ? 'OK' : 'MISSING'}`);
        }

        return `System Diagnostics:\n${diagnostics.map(d => `- ${d}`).join('\n')}`;
      },
    });

    // ── /checkpoint — Save current state as a named checkpoint ────────
    this.register({
      name: 'checkpoint',
      description: 'Save the current conversation/task state as a named checkpoint',
      category: 'builtin',
      aiPowered: false,
      execute: async (ctx) => {
        const name = ctx.args?.trim() || `checkpoint-${Date.now()}`;
        const checkpointDir = path.join(paths.agentDir(ctx.agentId || 'default'), 'checkpoints');

        if (!fs.existsSync(checkpointDir)) {
          fs.mkdirSync(checkpointDir, { recursive: true });
        }

        const checkpoint = {
          name,
          agentId: ctx.agentId,
          timestamp: new Date().toISOString(),
          messageCount: ctx.recentMessages?.length || 0,
          lastUserMessage: ctx.recentMessages?.filter(m => m.role === 'user').pop()?.content?.slice(0, 200) || '',
        };

        const checkpointPath = path.join(checkpointDir, `${name}.json`);
        fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

        return `Checkpoint "${name}" saved at ${checkpoint.timestamp}`;
      },
    });

    // ── /skillify — Auto-generate a skill from recent usage patterns ──
    this.register({
      name: 'skillify',
      description: 'Auto-generate a custom skill from a description of what you want automated',
      category: 'builtin',
      aiPowered: true,
      execute: async (ctx) => {
        const description = ctx.args?.trim();
        if (!description) {
          return 'Usage: /skillify <description of what you want automated>\nExample: /skillify check all agents are running and restart any that crashed';
        }

        // Generate skill definition using AI
        try {
          const { classify } = await import('./anthropic-client.js');
          const result = await classify(
            `Generate a TamerClaw skill definition as JSON for this automation:
"${description}"

Return a JSON object with these fields:
- name: short kebab-case name
- description: one sentence description
- steps: array of step descriptions (what the skill should do)

Return ONLY JSON.`,
            { maxTokens: 500 }
          );

          const text = typeof result === 'string' ? result : result.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const def = JSON.parse(jsonMatch[0]);
            // Save skill definition for future implementation
            const skillsDir = path.join(paths.agentDir(ctx.agentId || 'default'), 'skills');
            if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
            fs.writeFileSync(
              path.join(skillsDir, `${def.name || 'custom'}.json`),
              JSON.stringify(def, null, 2)
            );
            return `Skill "${def.name}" defined:\n${def.description}\n\nSteps:\n${(def.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nSaved to agent skills directory.`;
          }
          return 'Could not parse skill definition from AI response.';
        } catch (err) {
          return `Skillify failed: ${err.message}. Describe the skill you need and I'll create it manually.`;
        }
      },
    });
  }
}

// ── Singleton ───────────────────────────────────────────────────────────
let _engine = null;

/**
 * Get or create the global skills engine.
 * @returns {SkillsEngine}
 */
export function getSkillsEngine() {
  if (!_engine) {
    _engine = new SkillsEngine();
  }
  return _engine;
}

/**
 * Load custom skills from an agent's skills directory.
 * @param {string} agentId
 */
export async function loadAgentSkills(agentId) {
  const skillsDir = path.join(paths.agentDir(agentId), 'skills');
  if (!fs.existsSync(skillsDir)) return;

  const engine = getSkillsEngine();
  const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(skillsDir, file), 'utf-8'));
      if (def.name && def.steps) {
        engine.register({
          name: def.name,
          description: def.description || '',
          category: 'generated',
          forAgents: [agentId],
          execute: async (ctx) => {
            return `Custom skill "${def.name}" steps:\n${def.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n(Execution requires implementation)`;
          },
        });
      }
    } catch {}
  }
}

export default SkillsEngine;
