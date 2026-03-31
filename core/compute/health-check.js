#!/usr/bin/env node
/**
 * Compute Extension Health Check
 * Run: node core/compute/health-check.js
 *
 * Checks all configured compute nodes and reports status.
 */

import { getNodes, healthCheck, getNodeStatus } from '../shared/compute.js';

async function main() {
  console.log('=== Compute Extension Health Check ===\n');

  const nodes = await getNodes();

  if (nodes.length === 0) {
    console.log('No compute nodes configured.');
    process.exit(0);
  }

  for (const node of nodes) {
    console.log(`Node: ${node.name} (${node.id})`);
    console.log(`  Host: ${node.user}@${node.host}:${node.port}`);
    console.log(`  Capabilities: ${node.capabilities.join(', ')}`);

    const health = await healthCheck(node.id);
    if (health.available) {
      console.log(`  Status: ONLINE (${health.latency_ms}ms latency)`);
      const status = await getNodeStatus(node.id);
      if (status.stdout) {
        status.stdout.split('\n').forEach(line => {
          console.log(`    ${line}`);
        });
      }
    } else {
      console.log(`  Status: OFFLINE — tunnel not active`);
      console.log(`  Fix: Run setup-mac-tunnel.sh on the Mac Mini`);
    }
    console.log('');
  }
}

main().catch(err => {
  console.error('Health check failed:', err.message);
  process.exit(1);
});
