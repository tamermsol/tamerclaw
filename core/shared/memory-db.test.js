#!/usr/bin/env node
/**
 * memory-db.test.js — Tests for the SQLite memory module.
 *
 * Usage: node shared/memory-db.test.js
 */

import { MemoryDB } from './memory-db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'memory-test-'));
}

function teardown() {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function testCreateAndClose() {
  console.log('\n--- Create & Close ---');
  const mem = new MemoryDB('test-agent', { basePath: tmpDir });
  assert(mem.db.open, 'database opens successfully');
  assertEq(mem.count(), 0, 'new database has 0 entries');
  mem.close();
  assert(!mem.db.open, 'database closes cleanly');
}

function testAddEntry() {
  console.log('\n--- Add Entry ---');
  const mem = new MemoryDB('test-add', { basePath: tmpDir });

  const { id } = mem.addEntry({
    role: 'user',
    content: 'Hello, can you help me deploy the Flutter APK?',
    metadata: { source: 'telegram', chatId: 12345 },
  });

  assert(id > 0, `entry inserted with id ${id}`);
  assertEq(mem.count(), 1, 'count is 1 after insert');

  const entry = mem.getById(id);
  assertEq(entry.role, 'user', 'role matches');
  assert(entry.content.includes('Flutter APK'), 'content matches');
  assertEq(entry.metadata.source, 'telegram', 'metadata parsed correctly');
  assert(entry.tokensEst > 0, 'token estimate is positive');

  mem.close();
}

function testAddEntries() {
  console.log('\n--- Batch Add Entries ---');
  const mem = new MemoryDB('test-batch', { basePath: tmpDir });

  const entries = [
    { role: 'user', content: 'First message about backend API' },
    { role: 'assistant', content: 'I will help with the backend API setup' },
    { role: 'user', content: 'Second message about database schema' },
    { role: 'assistant', content: 'Here is the database schema design' },
  ];

  const count = mem.addEntries(entries);
  assertEq(count, 4, 'batch inserted 4 entries');
  assertEq(mem.count(), 4, 'count matches');

  mem.close();
}

function testGetRecent() {
  console.log('\n--- Get Recent ---');
  const mem = new MemoryDB('test-recent', { basePath: tmpDir });

  for (let i = 1; i <= 10; i++) {
    mem.addEntry({ role: 'user', content: `Message number ${i}` });
  }

  const recent5 = mem.getRecent(5);
  assertEq(recent5.length, 5, 'getRecent(5) returns 5');
  // Results should be chronological (oldest first after reverse)
  assert(recent5[0].content.includes('6'), 'oldest of recent 5 is message 6');
  assert(recent5[4].content.includes('10'), 'newest of recent 5 is message 10');

  mem.close();
}

function testSearch() {
  console.log('\n--- FTS5 Search ---');
  const mem = new MemoryDB('test-search', { basePath: tmpDir });

  mem.addEntries([
    { role: 'user', content: 'How do I configure the Nginx reverse proxy for the backend?' },
    { role: 'assistant', content: 'Here is the Nginx configuration for reverse proxy setup.' },
    { role: 'user', content: 'The Flutter app crashes on the login screen.' },
    { role: 'assistant', content: 'Let me debug the Flutter login screen crash.' },
    { role: 'user', content: 'Can you set up PostgreSQL replication?' },
    { role: 'summary', content: 'Session summary: discussed Nginx proxy config and Flutter login bug.' },
  ]);

  const nginxResults = mem.search('Nginx proxy', 10);
  assert(nginxResults.length >= 2, `search "Nginx proxy" found ${nginxResults.length} results`);

  const flutterResults = mem.search('Flutter login', 10);
  assert(flutterResults.length >= 2, `search "Flutter login" found ${flutterResults.length} results`);

  const pgResults = mem.search('PostgreSQL replication', 10);
  assertEq(pgResults.length, 1, 'search "PostgreSQL replication" found 1 result');

  // Search with role filter
  const userOnly = mem.search('Nginx', 10, { role: 'user' });
  assert(userOnly.length >= 1, `role-filtered search found ${userOnly.length} results`);
  assert(userOnly.every(r => r.role === 'user'), 'all role-filtered results are "user"');

  // Empty search returns empty
  const empty = mem.search('', 10);
  assertEq(empty.length, 0, 'empty query returns empty');

  // Search with special characters (should not throw)
  const special = mem.search('configure (proxy)', 10);
  assert(Array.isArray(special), 'special char search does not throw');

  mem.close();
}

function testDateQueries() {
  console.log('\n--- Date Queries ---');
  const mem = new MemoryDB('test-dates', { basePath: tmpDir });

  mem.addEntry({ role: 'user', content: 'Day one work', date: '2026-03-01', timestamp: '2026-03-01T10:00:00Z' });
  mem.addEntry({ role: 'user', content: 'Day two work', date: '2026-03-02', timestamp: '2026-03-02T10:00:00Z' });
  mem.addEntry({ role: 'user', content: 'Day three work', date: '2026-03-03', timestamp: '2026-03-03T10:00:00Z' });

  const day2 = mem.getByDate('2026-03-02');
  assertEq(day2.length, 1, 'getByDate returns 1 entry for March 2');
  assert(day2[0].content.includes('Day two'), 'correct entry for March 2');

  const range = mem.getDateRange('2026-03-01', '2026-03-02');
  assertEq(range.length, 2, 'getDateRange returns 2 entries');

  mem.close();
}

function testDelete() {
  console.log('\n--- Delete ---');
  const mem = new MemoryDB('test-delete', { basePath: tmpDir });

  const { id } = mem.addEntry({ role: 'user', content: 'To be deleted' });
  assertEq(mem.count(), 1, 'count is 1 before delete');

  const deleted = mem.deleteEntry(id);
  assert(deleted, 'deleteEntry returns true');
  assertEq(mem.count(), 0, 'count is 0 after delete');

  // Deleted entries should not appear in FTS
  const results = mem.search('deleted', 10);
  assertEq(results.length, 0, 'deleted entry not in FTS');

  mem.close();
}

function testStats() {
  console.log('\n--- Stats ---');
  const mem = new MemoryDB('test-stats', { basePath: tmpDir });

  mem.addEntries([
    { role: 'user', content: 'Hello', date: '2026-03-10', timestamp: '2026-03-10T10:00:00Z' },
    { role: 'assistant', content: 'Hi', date: '2026-03-10', timestamp: '2026-03-10T10:01:00Z' },
    { role: 'user', content: 'Bye', date: '2026-03-11', timestamp: '2026-03-11T10:00:00Z' },
  ]);

  const s = mem.stats();
  assertEq(s.agentId, 'test-stats', 'stats has correct agentId');
  assertEq(s.totalEntries, 3, 'stats totalEntries');
  assertEq(s.uniqueDays, 2, 'stats uniqueDays');
  assertEq(s.earliest, '2026-03-10', 'stats earliest date');
  assertEq(s.latest, '2026-03-11', 'stats latest date');
  assertEq(s.byRole.user, 2, 'stats byRole.user');
  assertEq(s.byRole.assistant, 1, 'stats byRole.assistant');
  assert(s.sizeBytes > 0, 'stats sizeBytes > 0');

  mem.close();
}

function testReopenPersistence() {
  console.log('\n--- Reopen Persistence ---');
  const dbPath = join(tmpDir, 'persist-agent', 'memory.db');

  const mem1 = new MemoryDB('persist-agent', { basePath: tmpDir });
  mem1.addEntry({ role: 'user', content: 'Persisted message about kubernetes deployment' });
  mem1.close();

  const mem2 = new MemoryDB('persist-agent', { basePath: tmpDir });
  assertEq(mem2.count(), 1, 'entry persists after reopen');

  const results = mem2.search('kubernetes', 5);
  assert(results.length >= 1, 'FTS works after reopen');

  mem2.close();
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

console.log('=== MemoryDB Test Suite ===');
setup();

try {
  testCreateAndClose();
  testAddEntry();
  testAddEntries();
  testGetRecent();
  testSearch();
  testDateQueries();
  testDelete();
  testStats();
  testReopenPersistence();
} finally {
  teardown();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
