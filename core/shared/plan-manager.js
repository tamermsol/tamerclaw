import { readFile, writeFile, readdir, mkdir, stat } from 'fs/promises';
import { join } from 'path';

const PLANS_DIR_NAME = 'plans';

/**
 * Get the plans directory for an agent
 */
function getPlansDir(agentDir) {
  return join(agentDir, PLANS_DIR_NAME);
}

/**
 * Ensure plans directory exists
 */
async function ensurePlansDir(agentDir) {
  const dir = getPlansDir(agentDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Generate a plan ID from title
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Create a new plan
 * @param {string} agentDir - Path to the agent's directory
 * @param {object} plan - Plan object with title, description, steps, files, etc.
 * @returns {string} - Path to the created plan file
 */
export async function createPlan(agentDir, plan) {
  const dir = await ensurePlansDir(agentDir);
  const slug = slugify(plan.title);
  const filename = `${slug}.md`;
  const filepath = join(dir, filename);

  const frontmatter = [
    '---',
    `title: "${plan.title}"`,
    `status: ${plan.status || 'draft'}`,
    `created: "${new Date().toISOString()}"`,
    `updated: "${new Date().toISOString()}"`,
    plan.priority ? `priority: ${plan.priority}` : null,
    plan.estimatedSteps ? `estimated_steps: ${plan.estimatedSteps}` : null,
    plan.tags ? `tags: [${plan.tags.map(t => `"${t}"`).join(', ')}]` : null,
    '---',
  ].filter(Boolean).join('\n');

  const sections = [`# ${plan.title}`, ''];

  if (plan.context) {
    sections.push('## Context', '', plan.context, '');
  }

  if (plan.architecture) {
    sections.push('## Architecture Decisions', '', plan.architecture, '');
  }

  if (plan.steps && plan.steps.length > 0) {
    sections.push('## Implementation Steps', '');
    plan.steps.forEach((step, i) => {
      sections.push(`### Step ${i + 1}: ${step.title}`);
      if (step.description) sections.push('', step.description);
      if (step.files) {
        sections.push('', '**Files:**');
        step.files.forEach(f => sections.push(`- \`${f.path}\` — ${f.action || 'modify'}: ${f.description || ''}`));
      }
      if (step.commands) {
        sections.push('', '**Commands:**');
        sections.push('```bash');
        step.commands.forEach(c => sections.push(c));
        sections.push('```');
      }
      if (step.tests) {
        sections.push('', '**Verification:**');
        step.tests.forEach(t => sections.push(`- [ ] ${t}`));
      }
      sections.push('');
    });
  }

  if (plan.risks) {
    sections.push('## Risks & Mitigations', '');
    plan.risks.forEach(r => sections.push(`- **${r.risk}** → ${r.mitigation}`));
    sections.push('');
  }

  if (plan.testPlan) {
    sections.push('## Test Plan', '', plan.testPlan, '');
  }

  const content = frontmatter + '\n\n' + sections.join('\n');
  await writeFile(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Update plan status
 */
export async function updatePlanStatus(planPath, newStatus) {
  let content = await readFile(planPath, 'utf-8');
  content = content.replace(/^status: .+$/m, `status: ${newStatus}`);
  content = content.replace(/^updated: .+$/m, `updated: "${new Date().toISOString()}"`);
  await writeFile(planPath, content, 'utf-8');
}

/**
 * Append execution notes to a plan
 */
export async function appendToPlan(planPath, section, text) {
  let content = await readFile(planPath, 'utf-8');
  const sectionHeader = `## ${section}`;
  if (content.includes(sectionHeader)) {
    content = content.replace(sectionHeader, `${sectionHeader}\n\n${text}`);
  } else {
    content += `\n\n${sectionHeader}\n\n${text}`;
  }
  content = content.replace(/^updated: .+$/m, `updated: "${new Date().toISOString()}"`);
  await writeFile(planPath, content, 'utf-8');
}

/**
 * List all plans for an agent
 */
export async function listPlans(agentDir) {
  const dir = getPlansDir(agentDir);
  try {
    const files = await readdir(dir);
    const plans = [];
    for (const f of files.filter(f => f.endsWith('.md'))) {
      const content = await readFile(join(dir, f), 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const meta = {};
        frontmatterMatch[1].split('\n').forEach(line => {
          const [key, ...rest] = line.split(':');
          if (key && rest.length) meta[key.trim()] = rest.join(':').trim().replace(/^"|"$/g, '');
        });
        plans.push({ file: f, path: join(dir, f), ...meta });
      }
    }
    return plans;
  } catch {
    return [];
  }
}

/**
 * Read a plan file
 */
export async function readPlan(planPath) {
  return readFile(planPath, 'utf-8');
}

export default { createPlan, updatePlanStatus, appendToPlan, listPlans, readPlan };
