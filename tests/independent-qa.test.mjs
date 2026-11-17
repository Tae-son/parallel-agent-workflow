// The shared report rules (scripts/independent-qa.jq), the commit-status runner
// (scripts/independent-qa-status.sh) against a fake gh, and the privileged workflow's shape.
// No real GitHub call is made: gh is a stub that records what would have been posted.
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const rules = path.join(root, 'scripts/independent-qa.jq');
const runner = path.join(root, 'scripts/independent-qa-status.sh');
const workflowPath = path.join(root, '.github/workflows/independent-qa.yml');
const REPO = 'example-org/example-repo';
const PR = 7;
const HEAD = 'a1'.repeat(20);
const UNTRUSTED = 'UNTRUSTED-PR-TEXT-$(touch pwned)';
const TOKEN = 'ghp_FAKE-TOKEN-MUST-NOT-APPEAR';
const DESCRIPTIONS = {
  pending: 'Checking the independent QA report on this exact head',
  success: 'Structurally valid PASS report for this exact head (not authentication)',
  failure: 'No valid PASS report for this exact head; see CONTRIBUTING.md',
};

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

function report(head = HEAD) {
  return {
    version: 1, head, builder: 'builder-session', reviewer: 'qa-session', verdict: 'PASS',
    checks: [{ criterion: 'Requested output is correct', result: 'PASS', evidence: 'Ran the fixture; expected output observed.' }],
    blockers: [], limitations: 'Offline fixture only.',
  };
}
const fence = (text) => `\n\n## Independent QA\n\n\`\`\`independent-qa\n${text}\n\`\`\`\n`;
const bodyWith = (r) => `Approved brief: ${UNTRUSTED}\n\nAllowed paths:\n- docs/${fence(JSON.stringify(r, null, 2))}`;
const changed = (fn) => { const r = report(); fn(r); return bodyWith(r); };
const template = fs.readFileSync(path.join(root, '.github/pull_request_template.md'), 'utf8');

// [label, PR body, accepted?] shared by the rules and the runner.
const CASES = [
  ['valid PASS on the exact head', bodyWith(report()), true],
  ['valid PASS with CRLF line endings', bodyWith(report()).replaceAll('\n', '\r\n'), true],
  ['the shipped BLOCKED template', template, false],
  ['FAIL verdict', changed((r) => { r.verdict = 'FAIL'; }), false],
  ['BLOCKED verdict', changed((r) => { r.verdict = 'BLOCKED'; }), false],
  ['stale head', changed((r) => { r.head = 'b'.repeat(40); }), false],
  ['uppercase head', changed((r) => { r.head = HEAD.toUpperCase(); }), false],
  ['missing key', changed((r) => { delete r.reviewer; }), false],
  ['extra key', changed((r) => { r.approved = true; }), false],
  ['same sessions', changed((r) => { r.reviewer = r.builder; }), false],
  ['invalid session characters', changed((r) => { r.builder = 'builder session'; }), false],
  ['session starting with punctuation', changed((r) => { r.reviewer = '-qa'; }), false],
  ['session with trailing newline', changed((r) => { r.reviewer = 'qa-session\n'; }), false],
  ['empty limitations', changed((r) => { r.limitations = ' \t\n'; }), false],
  ['nonempty blockers', changed((r) => { r.blockers = ['Broken output']; }), false],
  ['blockers not an array', changed((r) => { r.blockers = ''; }), false],
  ['empty checks', changed((r) => { r.checks = []; }), false],
  ['a FAIL check', changed((r) => { r.checks[0].result = 'FAIL'; }), false],
  ['a check without evidence', changed((r) => { delete r.checks[0].evidence; }), false],
  ['a check with blank evidence', changed((r) => { r.checks[0].evidence = ' '; }), false],
  ['version 2', changed((r) => { r.version = 2; }), false],
  ['version as a string', changed((r) => { r.version = '1'; }), false],
  ['null body', null, false],
  ['empty body', '', false],
  ['no fence', 'Approved brief: x\n', false],
  ['two fences', bodyWith(report()) + fence(JSON.stringify(report())), false],
  ['unclosed fence', `x\n\n\`\`\`independent-qa\n${JSON.stringify(report())}\n`, false],
  ['invalid JSON', fence('{bad json}'), false],
  ['a JSON array, not an object', fence(JSON.stringify([report()])), false],
];

test('rules module: accepts exactly the valid PASS reports', () => {
  for (const [label, body, ok] of CASES) {
    const r = spawnSync('jq', ['-e', '-L', path.dirname(rules), '--arg', 'head', HEAD,
      'include "independent-qa"; [qa_report | qa_pass($head)] == [true]'], { input: JSON.stringify({ body }), encoding: 'utf8' });
    assert.equal(r.status === 0, ok, `${label}: jq exit ${r.status} ${r.stderr}`);
  }
});

// ---- Status runner against a fake gh. ----

const GH_STUB = String.raw`
const fs = require('node:fs');
const dir = process.env.QA_STUB_DIR;
const fx = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\n');
if (args[0] === 'api' && args[1] === 'repos/' + fx.repo + '/pulls/' + fx.pr && args.length === 2) {
  const file = dir + '/reads';
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  const r = fx.reads[Math.min(n, fx.reads.length - 1)];
  if (r.fail) { process.stderr.write('gh: Server Error (HTTP 502)\n'); process.exit(1); }
  process.stdout.write(r.raw !== undefined ? r.raw : JSON.stringify(r.json) + '\n');
} else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  const fields = {};
  for (let i = 4; i < args.length; i += 2) {
    if (args[i] !== '-f') { process.stderr.write('gh stub: unexpected flag\n'); process.exit(1); }
    const eq = args[i + 1].indexOf('=');
    fields[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
  }
  if ((fx.failPosts || []).includes(fields.state)) { process.stderr.write('gh: Forbidden (HTTP 403)\n'); process.exit(1); }
  fs.appendFileSync(dir + '/posts.log', JSON.stringify({ path: args[3], ...fields }) + '\n');
  process.stdout.write('{}\n');
} else {
  process.stderr.write('gh stub: unexpected call\n');
  process.exit(1);
}
`;

const pull = ({ body = bodyWith(report()), head = HEAD, state = 'open', base = 'main', number = PR } = {}) => ({
  json: { number, state, title: UNTRUSTED, body, base: { ref: base }, head: { sha: head, ref: UNTRUSTED } },
});

// reads: successive answers to GET pulls/N (the last repeats). Returns exit status, output, gh calls and posts.
function run({ reads = [pull()], failPosts = [], args = [REPO, String(PR)], script = runner, env = {}, jqWrapper } = {}) {
  const dir = tempDir('qa-status-test-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'gh-stub.cjs'), GH_STUB);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'gh-stub.cjs')}' "$@"\n`, { mode: 0o755 });
  if (jqWrapper) fs.writeFileSync(path.join(bin, 'jq'), jqWrapper, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ repo: REPO, pr: PR, reads, failPosts }));
  const childEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_STUB_DIR: dir, GH_TOKEN: TOKEN, ...env };
  for (const key of ['GITHUB_TOKEN', 'GITHUB_RUN_ID', 'GITHUB_SERVER_URL', 'GITHUB_EVENT_PATH']) if (!(key in env)) delete childEnv[key];
  const r = spawnSync(script, args, { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 20000 });
  const lines = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const output = `${r.stdout}${r.stderr}`;
  assert.ok(!output.includes(TOKEN), 'the token must never be printed');
  assert.ok(!output.includes('UNTRUSTED-PR-TEXT'), 'PR text must never be printed');
  const posts = lines('posts.log');
  for (const p of posts) {
    assert.equal(p.context, 'independent-qa');
    assert.equal(p.description, DESCRIPTIONS[p.state], `fixed description for ${p.state}`);
    assert.ok(!JSON.stringify(p).includes('UNTRUSTED-PR-TEXT'), 'PR text must never reach a status');
  }
  for (const call of lines('calls.log')) assert.ok(!JSON.stringify(call).includes('UNTRUSTED-PR-TEXT'), 'PR text must never reach gh argv');
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  return { status: r.status, output, calls: lines('calls.log'), posts, states: posts.map((p) => p.state), dir };
}

test('runner: posts pending then the verdict on the PR head for every report case', () => {
  for (const [label, body, ok] of CASES) {
    const r = run({ reads: [pull({ body })] });
    assert.equal(r.status, 0, `${label}: ${r.output}`);
    assert.deepEqual(r.states, ['pending', ok ? 'success' : 'failure'], label);
    for (const p of r.posts) assert.equal(p.path, `repos/${REPO}/statuses/${HEAD}`, label);
  }
});

test('runner: reads the PR twice and never uses the triggering event', () => {
  const dir = tempDir('qa-event-');
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: PR, body: bodyWith(report()), head: { sha: HEAD } } }));
  const r = run({ reads: [pull({ body: changed((x) => { x.verdict = 'BLOCKED'; }) })], env: { GITHUB_EVENT_PATH: event } });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.states, ['pending', 'failure']);
  assert.equal(r.calls.filter((c) => c[1] === `repos/${REPO}/pulls/${PR}`).length, 2);
});

test('runner: a closed PR or one not targeting main gets failure, not success', () => {
  assert.deepEqual(run({ reads: [pull({ state: 'closed' })] }).states, ['pending', 'failure']);
  assert.deepEqual(run({ reads: [pull({ base: 'develop' })] }).states, ['pending', 'failure']);
});

test('runner: links the status to the Actions run only when the environment is plausible', () => {
  const ok = run({ env: { GITHUB_RUN_ID: '12345', GITHUB_SERVER_URL: 'https://github.com' } });
  assert.equal(ok.posts[1].target_url, `https://github.com/${REPO}/actions/runs/12345`);
  const bad = run({ env: { GITHUB_RUN_ID: '1;x', GITHUB_SERVER_URL: 'https://github.com' } });
  assert.equal(bad.posts[1].target_url, undefined);
});

for (const [label, args] of [
  ['no arguments', []],
  ['an extra argument', [REPO, String(PR), 'x']],
  ['a repository without an owner', ['example-repo', String(PR)]],
  ['a repository with a path', [`${REPO}/x`, String(PR)]],
  ['a repository named ..', ['example-org/..', String(PR)]],
  ['an option as the repository', ['--method', String(PR)]],
  ['PR 0', [REPO, '0']],
  ['a negative PR', [REPO, '-7']],
  ['a non-numeric PR', [REPO, '7a']],
  ['a PR with a leading zero', [REPO, '07']],
]) {
  test(`runner: refuses ${label} before calling gh`, () => {
    const r = run({ args });
    assert.notEqual(r.status, 0, r.output);
    assert.deepEqual(r.calls, []);
  });
}

const wrongPull = (fn) => { const p = pull(); fn(p.json); return p; };
for (const [label, first] of [
  ['an API error', { fail: true }],
  ['an empty response', { raw: '' }],
  ['non-JSON data', { raw: '<html>error</html>' }],
  ['a JSON array', { raw: '[]' }],
  ['a different PR number', wrongPull((j) => { j.number = PR + 1; })],
  ['a PR number as a string', wrongPull((j) => { j.number = String(PR); })],
  ['an uppercase head SHA', wrongPull((j) => { j.head.sha = HEAD.toUpperCase(); })],
  ['an abbreviated head SHA', wrongPull((j) => { j.head.sha = HEAD.slice(0, 7); })],
  ['a head SHA with a newline', wrongPull((j) => { j.head.sha = `${HEAD}\n`; })],
  ['a missing head', wrongPull((j) => { delete j.head; })],
  ['a numeric body', wrongPull((j) => { j.body = 42; })],
  ['a missing state', wrongPull((j) => { delete j.state; })],
  ['a missing base', wrongPull((j) => { delete j.base; })],
]) {
  test(`runner: posts nothing for ${label} on the first read`, () => {
    const r = run({ reads: [first] });
    assert.notEqual(r.status, 0, r.output);
    assert.deepEqual(r.posts, []);
    assert.match(r.output, /REFUSED/);
  });
}

for (const [label, second, pattern] of [
  ['an API error', { fail: true }, /could not read PR/],
  ['non-JSON data', { raw: 'oops' }, /unexpected PR data/],
  ['a new head', pull({ head: 'c'.repeat(40) }), /head changed/],
  ['a body edit', pull({ body: `${bodyWith(report())}\nedited` }), /body, state or base changed/],
  ['the report withdrawn', pull({ body: 'no report' }), /body, state or base changed/],
  ['the PR closed', pull({ state: 'closed' }), /body, state or base changed/],
  ['the base changed', pull({ base: 'develop' }), /body, state or base changed/],
]) {
  test(`runner: leaves pending, never success, after ${label} on the re-read`, () => {
    const r = run({ reads: [pull(), second] });
    assert.notEqual(r.status, 0, r.output);
    assert.deepEqual(r.states, ['pending']);
    assert.match(r.output, pattern);
  });
}

test('runner: a failed pending post stops before any verdict', () => {
  const r = run({ failPosts: ['pending'] });
  assert.notEqual(r.status, 0, r.output);
  assert.deepEqual(r.states, []);
  assert.match(r.output, /could not post the pending/);
  assert.equal(r.calls.length, 2, 'one read and one failed post');
});

test('runner: a failed final post exits nonzero', () => {
  for (const state of ['success', 'failure']) {
    const body = state === 'success' ? bodyWith(report()) : 'no report';
    const r = run({ reads: [pull({ body })], failPosts: [state] });
    assert.notEqual(r.status, 0, r.output);
    assert.deepEqual(r.states, ['pending']);
    assert.match(r.output, new RegExp(`could not post the ${state}`));
  }
});

test('runner: a jq failure in the report check publishes nothing final', () => {
  const jq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = `#!/bin/sh\ncase "$*" in *qa_pass*) exit 3 ;; esac\nexec '${jq}' "$@"\n`;
  const r = run({ jqWrapper: wrapper });
  assert.notEqual(r.status, 0, r.output);
  assert.deepEqual(r.states, ['pending']);
  assert.match(r.output, /report check itself failed/);
});

test('runner: refuses without, or with uncompilable, rules beside it', () => {
  const dir = tempDir('qa-runner-copy-');
  const copy = path.join(dir, 'independent-qa-status.sh');
  fs.copyFileSync(runner, copy);
  fs.chmodSync(copy, 0o755);
  let r = run({ script: copy });
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /independent-qa\.jq is missing/);
  assert.deepEqual(r.calls, []);
  fs.writeFileSync(path.join(dir, 'independent-qa.jq'), 'def qa_report: ;\n');
  r = run({ script: copy });
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /does not compile/);
  assert.deepEqual(r.calls, []);
});

test('runner: passes bash -n', () => {
  const r = spawnSync('bash', ['-n', runner], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(runner).mode & 0o100, 'runner must be executable');
});

// ---- Workflow shape. Static checks only: they cannot prove GitHub's runtime behaviour. ----

const workflowText = fs.readFileSync(workflowPath, 'utf8');

function parsedWorkflow(t) {
  const r = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))', workflowPath], { encoding: 'utf8' });
  if (r.error) { t.skip('ruby is not available to parse YAML'); return null; }
  assert.equal(r.status, 0, r.stderr);
  const wf = JSON.parse(r.stdout);
  // YAML 1.1 reads a bare `on` key as true.
  if ('true' in wf) { wf.on = wf.true; delete wf.true; }
  return wf;
}

test('workflow: parses and has only the trusted trigger, least permissions and one bounded job', (t) => {
  const wf = parsedWorkflow(t);
  if (!wf) return;
  assert.deepEqual(Object.keys(wf.on), ['pull_request_target']);
  assert.deepEqual(wf.on.pull_request_target, {
    branches: ['main'], types: ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review'],
  });
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.concurrency, {
    group: '${{ github.workflow }}-pr-${{ github.event.pull_request.number }}', 'cancel-in-progress': false,
  });
  assert.deepEqual(Object.keys(wf.jobs), ['publish-status']);
  const job = wf.jobs['publish-status'];
  assert.notEqual(job.name, 'independent-qa', 'the job check must not look like the commit status');
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read', statuses: 'write' });
  assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] <= 10);
  assert.equal(job.steps.length, 2);
  const [checkout, publish] = job.steps;
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.deepEqual(checkout.with, { 'persist-credentials': false }, 'no ref override, no persisted token');
  assert.equal(publish.uses, undefined);
  assert.equal(publish.run, 'scripts/independent-qa-status.sh "$QA_REPO" "$QA_PR"');
  assert.deepEqual(publish.env, {
    GH_TOKEN: '${{ github.token }}', QA_REPO: '${{ github.repository }}', QA_PR: '${{ github.event.pull_request.number }}',
  });
});

test('workflow: never touches pull request code, secrets, caches or artifacts', () => {
  const code = workflowText.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const banned of [/secrets\./, /\bref:/, /pull_request\.head/, /head_ref/, /\.sha\b/, /merge_commit/,
    /\bnpm\b/, /setup-node/, /actions\/cache/, /download-artifact/, /workflow_run/, /\bpull_request:/,
    /pull_request\.(body|title)/, /allow-unsafe-pr-checkout/, /persist-credentials:\s*true/]) {
    assert.doesNotMatch(code, banned);
  }
  const runs = code.match(/^\s*run:.*$/gm);
  assert.deepEqual(runs.map((l) => l.trim()), ['run: scripts/independent-qa-status.sh "$QA_REPO" "$QA_PR"']);
  assert.doesNotMatch(runs.join('\n'), /\$\{\{/, 'no expression may be interpolated into a shell');
  assert.equal((code.match(/^\s*(- )?uses:/gm) ?? []).length, 1);
});
