#!/usr/bin/env node
/**
 * validate-workflows.js
 * Sanity-checks every workflows/<dir>/workflow.json in this repo:
 *   1. parses as JSON
 *   2. has the fields n8n's "Import from File" expects (name, nodes, connections)
 *   3. every node has id / name / type / typeVersion / position[x,y]
 *   4. node names and ids are unique
 *   5. every connection references an existing node name
 *   6. workflow has at least one trigger node
 *   7. no real-looking secrets (API keys/tokens) are embedded
 *   8. credential references are placeholders, not real credential ids
 *
 * Usage: node scripts/validate-workflows.js
 * Exit code 0 = all good, 1 = at least one problem.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'workflows');

const TRIGGER_TYPES = [
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.emailReadImap',
];

// Real-credential shapes. Placeholders like sk-REPLACE_ME are short/obvious and won't match.
const SECRET_PATTERNS = [
  { name: 'OpenAI key', re: /sk-[A-Za-z0-9_-]{32,}/ },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: 'Slack token', re: /xox[abprs]-[A-Za-z0-9-]{20,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Generic 40+ char hex secret assigned to key/token field', re: /"(api[_-]?key|token|secret|password)"\s*:\s*"[A-Fa-f0-9]{40,}"/i },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

let failures = 0;
let checked = 0;

function fail(file, msg) {
  failures++;
  console.error(`  ✗ ${msg}`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function validateWorkflow(file) {
  const rel = path.relative(REPO_ROOT, file);
  console.log(`\n${rel}`);
  checked++;

  // 1. Valid JSON
  let raw, wf;
  try {
    raw = fs.readFileSync(file, 'utf8');
    wf = JSON.parse(raw);
  } catch (e) {
    return fail(file, `invalid JSON: ${e.message}`);
  }
  ok('valid JSON');

  // 2. Top-level shape
  if (typeof wf.name !== 'string' || !wf.name.trim()) fail(file, 'missing "name"');
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) return fail(file, '"nodes" missing or empty');
  if (typeof wf.connections !== 'object' || wf.connections === null) return fail(file, '"connections" missing');
  ok(`name: "${wf.name}" — ${wf.nodes.length} nodes`);

  // 3+4. Node integrity & uniqueness
  const names = new Set();
  const ids = new Set();
  let nodeErrors = 0;
  for (const n of wf.nodes) {
    const label = n.name ?? n.id ?? '<unnamed>';
    if (!n.id) { fail(file, `node "${label}" has no id`); nodeErrors++; }
    if (!n.name) { fail(file, `node ${n.id} has no name`); nodeErrors++; }
    if (!n.type) { fail(file, `node "${label}" has no type`); nodeErrors++; }
    if (typeof n.typeVersion !== 'number') { fail(file, `node "${label}" has no numeric typeVersion`); nodeErrors++; }
    if (!Array.isArray(n.position) || n.position.length !== 2 || n.position.some(p => typeof p !== 'number')) {
      fail(file, `node "${label}" has invalid position`); nodeErrors++;
    }
    if (names.has(n.name)) { fail(file, `duplicate node name "${n.name}"`); nodeErrors++; }
    if (ids.has(n.id)) { fail(file, `duplicate node id "${n.id}"`); nodeErrors++; }
    names.add(n.name);
    ids.add(n.id);
  }
  if (nodeErrors === 0) ok('all nodes have id/name/type/typeVersion/position; names & ids unique');

  // 5. Connections reference real nodes
  let connErrors = 0;
  for (const [from, outputs] of Object.entries(wf.connections)) {
    if (!names.has(from)) { fail(file, `connections key "${from}" is not a node`); connErrors++; continue; }
    for (const branches of Object.values(outputs)) {
      for (const branch of branches ?? []) {
        for (const target of branch ?? []) {
          if (!names.has(target.node)) { fail(file, `"${from}" connects to unknown node "${target.node}"`); connErrors++; }
        }
      }
    }
  }
  if (connErrors === 0) ok('all connections reference existing nodes');

  // 6. Trigger present
  const triggers = wf.nodes.filter(n => TRIGGER_TYPES.includes(n.type) || /trigger/i.test(n.type));
  if (triggers.length === 0) fail(file, 'no trigger node found');
  else ok(`trigger: ${triggers.map(t => t.name).join(', ')}`);

  // 7. No real-looking secrets
  let secretHits = 0;
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(raw)) { fail(file, `possible real secret embedded (${name})`); secretHits++; }
  }
  if (secretHits === 0) ok('no embedded secrets detected');

  // 8. Credentials are placeholders
  let credErrors = 0;
  for (const n of wf.nodes) {
    for (const [credType, cred] of Object.entries(n.credentials ?? {})) {
      const label = `${n.name} → ${credType}`;
      if (cred.id && cred.id !== 'PLACEHOLDER') { fail(file, `${label}: credential id "${cred.id}" is not "PLACEHOLDER"`); credErrors++; }
      if (!/PLACEHOLDER/i.test(cred.name ?? '')) { fail(file, `${label}: credential name "${cred.name}" lacks PLACEHOLDER marker`); credErrors++; }
    }
  }
  if (credErrors === 0) ok('all credential references are placeholders');
}

// --- main ---
if (!fs.existsSync(WORKFLOWS_DIR)) {
  console.error(`workflows/ directory not found at ${WORKFLOWS_DIR}`);
  process.exit(1);
}

const dirs = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => path.join(WORKFLOWS_DIR, d.name, 'workflow.json'))
  .sort();

for (const file of dirs) {
  if (fs.existsSync(file)) validateWorkflow(file);
  else { failures++; console.error(`\n✗ missing: ${path.relative(REPO_ROOT, file)}`); }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`${checked} workflow file(s) checked — ${failures === 0 ? 'ALL PASSED ✅' : failures + ' problem(s) found ❌'}`);
process.exit(failures === 0 ? 0 : 1);
