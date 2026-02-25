/**
 * Agent Eval - Deterministic Checker (Pre-commit hook)
 *
 * Validates saved snapshots against golden_data.yaml rules.
 * NO LLM calls. NO network calls. Pure string matching.
 * Runs in milliseconds. Safe to run on every commit.
 *
 * Usage:
 *   npx ts-node apps/api/src/app/agent/agent-eval-check.ts
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = one or more checks failed
 *   2 = missing snapshot file (run agent-eval-snapshot.ts first)
 *
 * Four check types (deterministic, binary, no LLM needed):
 *   1. Tool Selection   - Did the agent call the right tool(s)?
 *   2. Content Validation - Does the response contain required facts?
 *   3. Negative Validation - Did the agent hallucinate or include forbidden content?
 *   4. Verification      - Did data integrity checks pass?
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

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

interface CheckResult {
  id: string;
  query: string;
  category: string;
  passed: boolean;
  checks: {
    type: 'tool_selection' | 'content_validation' | 'negative_validation' | 'verification';
    passed: boolean;
    detail: string;
  }[];
}

function runChecks(golden: GoldenCase, snapshot: Snapshot): CheckResult {
  const checks: CheckResult['checks'] = [];

  // 1. Tool Selection - Did the agent use the right tool(s)?
  if (golden.expected_tools && golden.expected_tools.length > 0) {
    for (const expectedTool of golden.expected_tools) {
      const found = snapshot.toolCalls.includes(expectedTool);
      checks.push({
        type: 'tool_selection',
        passed: found,
        detail: found
          ? `Tool '${expectedTool}' was correctly called`
          : `Expected tool '${expectedTool}' not called. Got: [${snapshot.toolCalls.join(', ')}]`
      });
    }
  }

  // 2. Content Validation - Does the response contain required content?
  if (golden.must_contain && golden.must_contain.length > 0) {
    const responseLower = snapshot.response.toLowerCase();
    for (const required of golden.must_contain) {
      const found = responseLower.includes(required.toLowerCase());
      checks.push({
        type: 'content_validation',
        passed: found,
        detail: found
          ? `Response contains '${required}'`
          : `Response missing required content '${required}'`
      });
    }
  }

  // 3. Negative Validation - Did the agent hallucinate or include forbidden content?
  if (golden.must_not_contain && golden.must_not_contain.length > 0) {
    const responseLower = snapshot.response.toLowerCase();
    for (const forbidden of golden.must_not_contain) {
      const found = responseLower.includes(forbidden.toLowerCase());
      checks.push({
        type: 'negative_validation',
        passed: !found,
        detail: !found
          ? `Response correctly excludes '${forbidden}'`
          : `Response contains forbidden content '${forbidden}'`
      });
    }
  }

  // 4. Verification - Did data integrity checks pass?
  if (golden.expect_verified !== undefined) {
    const match = snapshot.verified === golden.expect_verified;
    checks.push({
      type: 'verification',
      passed: match,
      detail: match
        ? `Verification status matches (${golden.expect_verified})`
        : `Expected verified=${golden.expect_verified}, got ${snapshot.verified}`
    });
  }

  return {
    id: golden.id,
    query: golden.query,
    category: golden.category,
    passed: checks.every((c) => c.passed),
    checks
  };
}

function main() {
  // Check snapshot file exists
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error(
      '\n  ERROR: No snapshot file found at ' + SNAPSHOT_PATH
    );
    console.error(
      '  Run the snapshot generator first:'
    );
    console.error(
      '    AGENT_EVAL_TOKEN=<jwt> npx ts-node apps/api/src/app/agent/agent-eval-snapshot.ts\n'
    );
    process.exit(2);
  }

  // Load files
  const goldenYaml = fs.readFileSync(GOLDEN_PATH, 'utf8');
  const goldenCases = yaml.load(goldenYaml) as GoldenCase[];
  const snapshotFile: SnapshotFile = JSON.parse(
    fs.readFileSync(SNAPSHOT_PATH, 'utf8')
  );
  const snapshotMap = new Map<string, Snapshot>();
  for (const snap of snapshotFile.snapshots) {
    snapshotMap.set(snap.id, snap);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  Ghostfolio Agent - Deterministic Eval Check');
  console.log(`  Golden cases: ${goldenCases.length}`);
  console.log(`  Snapshots from: ${snapshotFile.generatedAt}`);
  console.log(`${'='.repeat(60)}\n`);

  const results: CheckResult[] = [];
  let totalChecks = 0;
  let passedChecks = 0;

  for (const golden of goldenCases) {
    const snapshot = snapshotMap.get(golden.id);
    if (!snapshot) {
      console.log(`  [${golden.id}] SKIP - no snapshot found`);
      continue;
    }

    const result = runChecks(golden, snapshot);
    results.push(result);

    const icon = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  [${golden.id}] ${icon} - ${golden.query.slice(0, 50)}`);

    for (const check of result.checks) {
      totalChecks++;
      if (check.passed) passedChecks++;
      const checkIcon = check.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      if (!check.passed) {
        console.log(`    ${checkIcon} [${check.type}] ${check.detail}`);
      }
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.passed) byCategory[r.category].passed++;
  }

  const byCheckType: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    for (const c of r.checks) {
      if (!byCheckType[c.type]) byCheckType[c.type] = { passed: 0, total: 0 };
      byCheckType[c.type].total++;
      if (c.passed) byCheckType[c.type].passed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  RESULTS');
  console.log(`${'='.repeat(60)}`);
  console.log(
    `  Cases: ${passed}/${results.length} passed (${results.length > 0 ? ((passed / results.length) * 100).toFixed(0) : 0}%)`
  );
  console.log(`  Checks: ${passedChecks}/${totalChecks} passed`);
  console.log('');
  console.log('  By category:');
  for (const [cat, stats] of Object.entries(byCategory)) {
    console.log(`    ${cat}: ${stats.passed}/${stats.total}`);
  }
  console.log('');
  console.log('  By check type:');
  for (const [type, stats] of Object.entries(byCheckType)) {
    const icon = stats.passed === stats.total ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`    ${icon} ${type}: ${stats.passed}/${stats.total}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
