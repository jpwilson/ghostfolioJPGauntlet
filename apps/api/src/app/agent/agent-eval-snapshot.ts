/**
 * Agent Eval - Snapshot Generator
 *
 * Runs test cases against the LIVE agent API and saves responses as snapshots.
 * These snapshots are then validated deterministically by agent-eval-check.ts
 * (which runs as a pre-commit hook, no LLM needed).
 *
 * Usage:
 *   AGENT_EVAL_TOKEN=<jwt> npx ts-node apps/api/src/app/agent/agent-eval-snapshot.ts
 *
 * Run this when:
 *   - You change the system prompt
 *   - You add/modify tools
 *   - You change agent.service.ts logic
 *   - You want to refresh the baseline
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const API_URL =
  process.env.AGENT_EVAL_URL || 'http://localhost:3333/api/v1/agent/chat';
const TOKEN = process.env.AGENT_EVAL_TOKEN || '';
const GOLDEN_PATH = path.join(__dirname, 'golden_data.yaml');
const SNAPSHOT_PATH = path.join(__dirname, 'eval-snapshots.json');

interface GoldenCase {
  id: string;
  query: string;
  category: string;
  expected_tools?: string[];
  must_contain?: string[];
  must_not_contain?: string[];
  expect_verified?: boolean;
}

interface Snapshot {
  id: string;
  query: string;
  category: string;
  response: string;
  toolCalls: string[];
  verified: boolean | null;
  timestamp: string;
  durationMs: number;
}

interface SnapshotFile {
  generatedAt: string;
  apiUrl: string;
  snapshots: Snapshot[];
}

async function generateSnapshot(
  goldenCase: GoldenCase
): Promise<Snapshot | null> {
  const start = Date.now();
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: goldenCase.query }]
      })
    });

    if (!res.ok) {
      console.error(
        `  FAILED [${goldenCase.id}]: HTTP ${res.status} - ${await res.text()}`
      );
      return null;
    }

    const data = await res.json();
    return {
      id: goldenCase.id,
      query: goldenCase.query,
      category: goldenCase.category,
      response: data.message || '',
      toolCalls: (data.toolCalls || []).map((tc: any) => tc.tool),
      verified:
        data.verification?.verified !== undefined
          ? data.verification.verified
          : null,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start
    };
  } catch (error: any) {
    console.error(`  ERROR [${goldenCase.id}]: ${error.message}`);
    return null;
  }
}

async function main() {
  if (!TOKEN) {
    console.error(
      'Set AGENT_EVAL_TOKEN environment variable with a valid JWT token'
    );
    process.exit(1);
  }

  // Load golden data
  const goldenYaml = fs.readFileSync(GOLDEN_PATH, 'utf8');
  const goldenCases = yaml.load(goldenYaml) as GoldenCase[];

  console.log(`\n${'='.repeat(60)}`);
  console.log('  Ghostfolio Agent - Snapshot Generator');
  console.log(`  Golden cases: ${goldenCases.length}`);
  console.log(`  API: ${API_URL}`);
  console.log(`${'='.repeat(60)}\n`);

  const snapshots: Snapshot[] = [];

  for (const gc of goldenCases) {
    process.stdout.write(`  [${gc.id}] ${gc.query.slice(0, 50)}...`);
    const snap = await generateSnapshot(gc);
    if (snap) {
      snapshots.push(snap);
      console.log(
        ` OK (${snap.durationMs}ms) [tools: ${snap.toolCalls.join(', ') || 'none'}]`
      );
    } else {
      console.log(' SKIPPED');
    }
  }

  const snapshotFile: SnapshotFile = {
    generatedAt: new Date().toISOString(),
    apiUrl: API_URL,
    snapshots
  };

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshotFile, null, 2));
  console.log(`\n  Snapshots saved to ${SNAPSHOT_PATH}`);
  console.log(
    `  ${snapshots.length}/${goldenCases.length} cases captured\n`
  );
}

main();
