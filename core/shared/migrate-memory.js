#!/usr/bin/env node
/**
 * migrate-memory.js — Import existing markdown memory files into SQLite.
 *
 * Scans user/agents/{name}/memory/*.md and imports each into user/agents/{name}/memory.db.
 * Safe to re-run: skips files already imported (tracked by source_file column).
 *
 * Usage:
 *   node core/shared/migrate-memory.js                # migrate all agents
 *   node core/shared/migrate-memory.js flutter mark    # migrate specific agents
 *   node core/shared/migrate-memory.js --dry-run       # preview without writing
 *   node core/shared/migrate-memory.js --stats         # show stats for all agent DBs
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryDB } from './memory-db.js';
import { paths } from './paths.js';

const AGENTS_DIR = paths.agents;

// ---------------------------------------------------------------------------
// Markdown parser: split a daily memory file into individual entries
// ---------------------------------------------------------------------------

/**
 * Parse a markdown memory file into discrete entries.
 * Handles two common formats:
 *   1. Timestamped sections: "## 2026-02-24 16:57 UTC" or "## HH:MM UTC - Title"
 *   2. Heading-based sections: "## Title" without timestamps
 *
 * @param {string} text     — raw markdown content
 * @param {string} filename — original filename (e.g. "2026-03-08.md")
 * @returns {Array<{role: string, content: string, timestamp: string, date: string}>}
 */
function parseMemoryFile(text, filename) {
  const entries = [];
  // Extract date from filename (YYYY-MM-DD.md)
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
  const fileDate = dateMatch ? dateMatch[1] : null;

  // Split on ## headings
  const sections = text.split(/^(?=## )/m).filter(s => s.trim());

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Skip if it's just a top-level heading with no content
    const lines = trimmed.split('\n');
    const heading = lines[0];
    const body = lines.slice(1).join('\n').trim();

    // Try to extract timestamp from heading
    let timestamp = null;
    let date = fileDate;

    // Pattern: "## 2026-02-24 16:57 UTC"
    const fullTsMatch = heading.match(/##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*(?:UTC)?/);
    if (fullTsMatch) {
      date = fullTsMatch[1];
      timestamp = `${fullTsMatch[1]}T${fullTsMatch[2]}:00.000Z`;
    }

    // Pattern: "## HH:MM UTC - Title"
    const timeTsMatch = heading.match(/##\s+(\d{2}:\d{2})\s*(?:UTC)?/);
    if (!timestamp && timeTsMatch && date) {
      timestamp = `${date}T${timeTsMatch[1]}:00.000Z`;
    }

    // Default: use noon of the file date
    if (!timestamp && date) {
      timestamp = `${date}T12:00:00.000Z`;
    } else if (!timestamp) {
      timestamp = new Date().toISOString();
    }

    // Build the full content including the heading for context
    const content = trimmed;

    if (content.length < 10) continue; // Skip trivially empty sections

    entries.push({
      role: 'summary',      // migrated entries are summaries
      content,
      timestamp,
      date: date || timestamp.slice(0, 10),
    });
  }

  // If no sections were found, treat the whole file as one entry
  if (entries.length === 0 && text.trim().length >= 10) {
    const ts = fileDate ? `${fileDate}T12:00:00.000Z` : new Date().toISOString();
    entries.push({
      role: 'summary',
      content: text.trim(),
      timestamp: ts,
      date: fileDate || ts.slice(0, 10),
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Migration logic
// ---------------------------------------------------------------------------

function discoverAgents() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const memDir = join(AGENTS_DIR, name, 'memory');
      return existsSync(memDir) && statSync(memDir).isDirectory();
    });
}

function getMemoryFiles(agentId) {
  const memDir = join(AGENTS_DIR, agentId, 'memory');
  if (!existsSync(memDir)) return [];
  return readdirSync(memDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({
      name: f,
      path: join(memDir, f),
    }));
}

function migrateAgent(agentId, dryRun = false) {
  const files = getMemoryFiles(agentId);
  if (files.length === 0) {
    console.log(`  [${agentId}] No memory .md files found, skipping.`);
    return { agent: agentId, files: 0, entries: 0, skipped: 0 };
  }

  const mem = dryRun ? null : new MemoryDB(agentId);

  // Check which files are already imported
  let alreadyImported = new Set();
  if (!dryRun) {
    const existing = mem.db.prepare(
      'SELECT DISTINCT source_file FROM entries WHERE source_file IS NOT NULL'
    ).all();
    alreadyImported = new Set(existing.map(r => r.source_file));
  }

  let totalEntries = 0;
  let skippedFiles = 0;

  for (const file of files) {
    const relPath = `memory/${file.name}`;

    if (alreadyImported.has(relPath)) {
      console.log(`  [${agentId}] ${file.name} — already imported, skipping.`);
      skippedFiles++;
      continue;
    }

    const raw = readFileSync(file.path, 'utf-8');
    const entries = parseMemoryFile(raw, file.name);

    if (dryRun) {
      console.log(`  [${agentId}] ${file.name} — would import ${entries.length} entries`);
      totalEntries += entries.length;
      continue;
    }

    const enriched = entries.map(e => ({
      ...e,
      sourceFile: relPath,
      metadata: JSON.stringify({ migratedFrom: 'markdown', originalFile: file.name }),
    }));

    const count = mem.addEntries(enriched);
    totalEntries += count;
    console.log(`  [${agentId}] ${file.name} — imported ${count} entries`);
  }

  if (!dryRun && mem) {
    mem.optimize();
    const s = mem.stats();
    console.log(`  [${agentId}] Total: ${s.totalEntries} entries, ${s.uniqueDays} days, ` +
      `${(s.sizeBytes / 1024).toFixed(0)} KB`);
    mem.close();
  }

  return { agent: agentId, files: files.length, entries: totalEntries, skipped: skippedFiles };
}

function showStats() {
  const agents = discoverAgents();
  // Also check agents that may have a .db but no markdown dir
  const allAgentDirs = existsSync(AGENTS_DIR)
    ? readdirSync(AGENTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    : [];

  const agentsWithDb = allAgentDirs.filter(a =>
    existsSync(join(AGENTS_DIR, a, 'memory.db'))
  );

  if (agentsWithDb.length === 0) {
    console.log('No agent memory databases found. Run migration first.');
    return;
  }

  console.log('\n=== Agent Memory Database Stats ===\n');
  for (const agentId of agentsWithDb.sort()) {
    try {
      const mem = new MemoryDB(agentId, { readonly: true });
      const s = mem.stats();
      console.log(`  ${agentId.padEnd(15)} | ${String(s.totalEntries).padStart(5)} entries | ` +
        `${String(s.uniqueDays).padStart(3)} days | ${s.earliest || 'n/a'} → ${s.latest || 'n/a'} | ` +
        `${(s.sizeBytes / 1024).toFixed(0)} KB`);
      mem.close();
    } catch (err) {
      console.log(`  ${agentId.padEnd(15)} | ERROR: ${err.message}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const showStatsFlag = args.includes('--stats');
  const agentArgs = args.filter(a => !a.startsWith('--'));

  if (showStatsFlag) {
    showStats();
    return;
  }

  const agents = agentArgs.length > 0
    ? agentArgs
    : discoverAgents();

  if (agents.length === 0) {
    console.log('No agents with memory/ directories found.');
    return;
  }

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Migrating memory for ${agents.length} agents...\n`);

  const results = [];
  for (const agentId of agents) {
    console.log(`\n--- ${agentId} ---`);
    try {
      results.push(migrateAgent(agentId, dryRun));
    } catch (err) {
      console.error(`  ERROR migrating ${agentId}: ${err.message}`);
      results.push({ agent: agentId, files: 0, entries: 0, error: err.message });
    }
  }

  // Summary
  console.log('\n=== Migration Summary ===');
  const totalEntries = results.reduce((s, r) => s + r.entries, 0);
  const totalFiles = results.reduce((s, r) => s + r.files, 0);
  const totalSkipped = results.reduce((s, r) => s + (r.skipped || 0), 0);
  console.log(`  Agents: ${results.length}`);
  console.log(`  Files processed: ${totalFiles}`);
  console.log(`  Files skipped (already imported): ${totalSkipped}`);
  console.log(`  Entries ${dryRun ? 'to import' : 'imported'}: ${totalEntries}`);

  if (!dryRun) {
    console.log('\nRun with --stats to see database details.');
  }
  console.log('');
}

// Allow import for testing
export { parseMemoryFile, migrateAgent, discoverAgents, showStats };

main();
