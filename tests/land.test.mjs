import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const landSource = `${root}scripts/land.sh`;
const ghStub = `${root}tests/helpers/land-gh-stub.mjs`;
const gateList = `${root}scripts/gate-files.txt`;
const uiList = `${root}scripts/ui-paths.txt`;
const REPO = 'example-org/example-repo';
const N = 7;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[key];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

const defaultBody = [
  'Scope: tidy the docs notes.',
  '',
  'Allowed paths:',
  '- docs/',
  '',
  'Other text that must not reach the Codex contract.',
].join('\n');

// Hermetic fixture: bare origin, primary clone with land.sh on main, PR head at refs/pull/N/head,
// and a stub `gh` first on PATH answering from fixture.json.
function makeFixture({
  files = { 'docs/notes.md': 'updated notes\n' },
  symlinks = {},
  pr = {},
  rollup = [{ __typename: 'CheckRun', workflowName: 'CI', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  recheck = {},
  mainMoves = false,
  behindBy = 0,
  landOnMain = true,
  deployments = [],
  statuses = {},
  gateListOnMain = true,
  gateListText,
  uiListOnMain = true,
  uiListText,
  originUrl,
  codexExit,
  codexOutcome,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-test-'));
  const origin = path.join(dir, 'origin.git');
  const primary = path.join(dir, 'primary');
  const agent = path.join(dir, 'agent');
  const bin = path.join(dir, 'bin');
  const stub = path.join(dir, 'stub');
  fs.mkdirSync(bin);
  fs.mkdirSync(stub);

  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'init', '--quiet', '-b', 'main', primary);
  writeFiles(primary, { 'README.md': 'fixture\n', 'src/app.js': 'export {};\n', 'docs/notes.md': 'notes\n' });
  fs.mkdirSync(path.join(primary, 'scripts'));
  fs.copyFileSync(landSource, path.join(primary, 'scripts/land.sh'));
  fs.chmodSync(path.join(primary, 'scripts/land.sh'), 0o755);
  if (gateListText !== undefined) writeFiles(primary, { 'scripts/gate-files.txt': gateListText });
  else if (gateListOnMain) fs.copyFileSync(gateList, path.join(primary, 'scripts/gate-files.txt'));
  if (uiListText !== undefined) writeFiles(primary, { 'scripts/ui-paths.txt': uiListText });
  else if (uiListOnMain) fs.copyFileSync(uiList, path.join(primary, 'scripts/ui-paths.txt'));
  if (codexExit !== undefined) {
    writeFiles(primary, { 'scripts/codex-exclude.txt': 'x\n', 'scripts/codex-review-contract.md': 'x\n' });
    fs.writeFileSync(path.join(primary, 'scripts/codex-review.sh'), codexStub('MAIN', codexExit, codexOutcome), { mode: 0o755 });
  }
  git(primary, 'add', '-A');
  git(primary, 'commit', '--quiet', '-m', 'base');
  // originUrl: configure a GitHub-looking origin URL (for repo detection) that git rewrites to the
  // local bare repository for every fetch, so the test stays offline.
  git(primary, 'remote', 'add', 'origin', originUrl ?? origin);
  if (originUrl) git(primary, 'config', `url.${origin}.insteadOf`, originUrl);
  git(primary, 'push', '--quiet', 'origin', 'main');

  git(dir, 'clone', '--quiet', origin, agent);
  writeFiles(agent, files);
  for (const [name, target] of Object.entries(symlinks)) fs.symlinkSync(target, path.join(agent, name));
  git(agent, 'add', '-A');
  git(agent, 'commit', '--quiet', '-m', 'pr change');
  git(agent, 'push', '--quiet', 'origin', `HEAD:refs/pull/${N}/head`);

  const headSha = git(agent, 'rev-parse', 'HEAD');
  const mainSha = git(primary, 'rev-parse', 'HEAD');
  const view = {
    number: N, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: headSha,
    body: defaultBody, title: 'Tidy docs notes', url: `https://github.com/${REPO}/pull/${N}`,
    statusCheckRollup: rollup, ...pr,
  };
  fs.writeFileSync(path.join(stub, 'fixture.json'), JSON.stringify({
    prViews: [view, { ...view, ...recheck }],
    mainShas: mainMoves ? [mainSha, 'e'.repeat(40)] : [mainSha],
    landSha: landOnMain ? git(primary, 'hash-object', 'scripts/land.sh') : null,
    behindBy, deployments, statuses,
  }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${ghStub}' "$@"\n`, { mode: 0o755 });

  return { dir, primary, stub, bin, headSha, mainSha };
}

// Stub codex-review.sh: records which copy ran and which sibling files it could see.
function codexStub(marker, exitCode, outcome) {
  return [
    '#!/bin/sh',
    'd=$(dirname "$0")',
    `{ echo ${marker}; for f in codex-exclude.txt codex-review-contract.md gate-files.txt; do`,
    '  [ -f "$d/$f" ] && echo "sibling $f"; done; } >"$LAND_GH_STUB_DIR/codex-marker"',
    'out=',
    'while [ $# -gt 0 ]; do case $1 in',
    '  --contract) cp "$2" "$LAND_GH_STUB_DIR/contract.md" ;; --out) out=$2 ;; esac; shift; done',
    outcome ? `printf '%s\n' '${outcome}' >"$out/outcome"` : ':',
    `exit ${exitCode}`, '',
  ].join('\n');
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// tty: drive /dev/tty via util-linux `script` (answers typed on its stdin); otherwise run in a new
// session with no controlling terminal.
function land(fx, args = [String(N)], { answers = '', tty = true, landPath, repoEnv = REPO } = {}) {
  const script = landPath ?? path.join(fx.primary, 'scripts/land.sh');
  const env = { ...gitEnv, PATH: `${fx.bin}:${process.env.PATH}`, SHELL: '/bin/bash', LAND_GH_STUB_DIR: fx.stub };
  if (repoEnv !== null) env.LAND_REPO = repoEnv; else delete env.LAND_REPO;
  const opts = { cwd: fx.primary, env, input: answers, encoding: 'utf8', timeout: 30000 };
  const r = tty
    ? spawnSync('script', ['-qec', [script, ...args].map(quote).join(' '), '/dev/null'], opts)
    : spawnSync('setsid', ['-w', script, ...args], opts);
  const merges = fs.existsSync(path.join(fx.stub, 'merge.log'))
    ? fs.readFileSync(path.join(fx.stub, 'merge.log'), 'utf8').trim().split('\n') : [];
  const output = `${r.stdout}${r.stderr}`;
  // The pty translates \n to \r\n; undo that so assertions read the same in both modes.
  return { status: r.status, output: tty ? output.replace(/\r\n/g, '\n') : output, merges };
}

function assertMerged(r, fx, repo = REPO) {
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.merges, [`pr merge ${N} -R ${repo} --squash --match-head-commit ${fx.headSha}`]);
}

function assertRefused(r, pattern) {
  assert.notEqual(r.status, 0, r.output);
  assert.deepEqual(r.merges, [], 'no merge may be attempted');
  assert.match(r.output, pattern);
  assert.match(r.output, /Not merged/);
}

const typed = `${N}\n`;

test('merges a clean in-scope PR after the PR number is typed', () => {
  const fx = makeFixture();
  const r = land(fx, undefined, { answers: typed });
  assertMerged(r, fx);
  assert.match(r.output, /In declared scope:\s+M\s+docs\/notes\.md/);
  assert.match(r.output, /CI \/ verify COMPLETED SUCCESS/);
  assert.doesNotMatch(r.output, /Not merged/);
});

test('--help prints usage without merging', () => {
  const r = land(makeFixture(), ['--help'], { tty: false });
  assert.equal(r.status, 0);
  assert.match(r.output, /Usage: scripts\/land\.sh/);
});

const ciCases = {
  missing: [{ __typename: 'CheckRun', workflowName: 'Other', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  pending: [{ __typename: 'CheckRun', workflowName: 'CI', name: 'verify', status: 'IN_PROGRESS', conclusion: '' }],
  skipped: [{ __typename: 'CheckRun', workflowName: 'CI', name: 'verify', status: 'COMPLETED', conclusion: 'SKIPPED' }],
  failure: [{ __typename: 'CheckRun', workflowName: 'CI', name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }],
};
for (const [name, rollup] of Object.entries(ciCases)) {
  test(`refuses when CI verify is ${name}`, () => {
    assertRefused(land(makeFixture({ rollup }), undefined, { answers: typed }), /CI \/ verify is not green/);
  });
}

test('refuses a branch behind main and suggests update-branch', () => {
  const r = land(makeFixture({ behindBy: 2 }), undefined, { answers: typed });
  assertRefused(r, /not up to date/);
  assert.match(r.output, new RegExp(`gh pr update-branch ${N} -R ${REPO}`));
});

for (const [name, pr, pattern] of [
  ['a base other than main', { baseRefName: 'develop' }, /targets 'develop', not main/],
  ['a draft', { isDraft: true }, /is a draft/],
  ['a closed PR', { state: 'CLOSED' }, /is CLOSED, not OPEN/],
]) {
  test(`refuses ${name}`, () => {
    assertRefused(land(makeFixture({ pr }), undefined, { answers: typed }), pattern);
  });
}

test('refuses when the PR head changes before the final re-check', () => {
  const r = land(makeFixture({ recheck: { headRefOid: 'f'.repeat(40) } }), undefined, { answers: typed });
  assertRefused(r, /PR head changed since review/);
});

test('refuses when main moves before the final re-check', () => {
  const r = land(makeFixture({ mainMoves: true }), undefined, { answers: typed });
  assertRefused(r, /main moved since review/);
});

test('refuses a symlink in the diff', () => {
  const r = land(makeFixture({ symlinks: { 'docs/link': '../README.md' } }), undefined, { answers: typed });
  assertRefused(r, /symlink or submodule/);
});

test('refuses when the local land.sh differs from main on GitHub', () => {
  const fx = makeFixture();
  fs.appendFileSync(path.join(fx.primary, 'scripts/land.sh'), '# local edit\n');
  assertRefused(land(fx, undefined, { answers: typed }), new RegExp(`differs from ${REPO} main`));
});

test('refuses with the bootstrap rule when land.sh is not on main', () => {
  const r = land(makeFixture({ landOnMain: false }), undefined, { answers: typed });
  assertRefused(r, /Bootstrap rule: .*merged by the owner in GitHub's web UI/);
});

test('refuses to run from a linked worktree', () => {
  const fx = makeFixture();
  const wt = path.join(fx.dir, 'linked');
  git(fx.primary, 'worktree', 'add', '--quiet', '--detach', wt);
  const r = land(fx, undefined, { answers: typed, landPath: path.join(wt, 'scripts/land.sh') });
  assertRefused(r, /primary worktree/);
});

test('refuses without a terminal even when the answer is piped', () => {
  const r = land(makeFixture(), undefined, { answers: typed, tty: false });
  assertRefused(r, /no terminal: land\.sh needs an interactive owner/);
});

test('refuses a wrong typed answer', () => {
  assertRefused(land(makeFixture(), undefined, { answers: '8\n' }), /confirmation did not match/);
});

test('refuses on EOF at the prompt', () => {
  assertRefused(land(makeFixture(), undefined, { answers: '' }), /no confirmation \(EOF\)/);
});

test('highlights out-of-scope paths but merges after normal confirmation', () => {
  const fx = makeFixture({ files: { 'docs/notes.md': 'x\n', 'misc/extra.txt': 'x\n' } });
  const r = land(fx, undefined, { answers: typed });
  assertMerged(r, fx);
  assert.match(r.output, /OUTSIDE declared scope \(owner decides\):(\x1b\[0m)?\s+A\s+misc\/extra\.txt/);
});

test('gate-file changes print the full diff and need a typed "gate"', () => {
  const files = { 'docs/notes.md': 'x\n', 'tests/new.test.mjs': '// GATE-DIFF-MARKER\n' };
  const refused = land(makeFixture({ files }), undefined, { answers: typed });
  assertRefused(refused, /no confirmation \(EOF\)/);
  assert.match(refused.output, /\+\/\/ GATE-DIFF-MARKER/);
  assert.match(refused.output, /re-run with --codex/);

  const fx = makeFixture({ files });
  assertMerged(land(fx, undefined, { answers: `${N}\ngate\n` }), fx);
});

const uiBody = 'Approved brief: owner brief 2026-10-20\n\nAllowed paths:\n- src/\n';

test('UI changes show the exact-commit preview and need "preview checked"', () => {
  const opts = {
    files: { 'src/app.js': 'export const changed = 1;\n' },
    pr: { body: uiBody },
    deployments: [{ id: 11 }],
    statuses: { 11: [{ state: 'success', environment: 'preview', environment_url: 'https://preview.example.invalid' }] },
  };
  const refused = land(makeFixture(opts), undefined, { answers: typed });
  assertRefused(refused, /no confirmation \(EOF\)/);
  assert.match(refused.output, /Preview \(preview\): https:\/\/preview\.example\.invalid/);

  const fx = makeFixture(opts);
  assertMerged(land(fx, undefined, { answers: `${N}\npreview checked\n` }), fx);
});

test('UI changes without a preview say so', () => {
  const fx = makeFixture({ files: { 'src/app.js': 'x\n' }, pr: { body: uiBody } });
  const r = land(fx, undefined, { answers: `${N}\npreview checked\n` });
  assertMerged(r, fx);
  assert.match(r.output, /No preview built from this exact commit/);
});

test('UI changes without an Approved brief are refused', () => {
  const r = land(makeFixture({ files: { 'src/app.js': 'x\n' } }), undefined, { answers: `${N}\npreview checked\n` });
  assertRefused(r, /no 'Approved brief:' line with real content/);
});

const template = [
  '## Scope',
  '',
  'Approved brief: <!-- link or quote of the owner-approved brief; required for UI changes -->',
  '',
  'Allowed paths:',
  '<!-- one glob per line, copied from the brief, e.g. src/components/calculator/ -->',
].join('\r\n');

test('unfilled PR template: no Allowed paths declared', () => {
  const fx = makeFixture({ pr: { body: template } });
  const r = land(fx, undefined, { answers: typed });
  assertMerged(r, fx);
  assert.match(r.output, /No Allowed paths declared/);
  assert.match(r.output, /OUTSIDE declared scope[^\n]*\n\s+M\s+docs\/notes\.md/);
});

test('unfilled PR template: placeholder brief counts as missing for UI changes', () => {
  const r = land(makeFixture({ files: { 'src/app.js': 'x\n' }, pr: { body: template } }), undefined,
    { answers: `${N}\npreview checked\n` });
  assertRefused(r, /no 'Approved brief:' line with real content/);
});

test('filled PR template with CRLF line endings is parsed', () => {
  const body = template
    .replace('Approved brief: <!--', 'Approved brief: https://example.invalid/brief <!--')
    .concat('\r\n- `src/components/calculator/`\r\nsrc/app.js\r\n\r\nsrc/not-a-glob.js\r\n');
  const fx = makeFixture({
    files: { 'src/app.js': 'x\n', 'src/components/calculator/Step.jsx': 'x\n', 'src/not-a-glob.js': 'x\n' },
    pr: { body },
  });
  const r = land(fx, undefined, { answers: `${N}\npreview checked\n` });
  assertMerged(r, fx);
  assert.match(r.output, /Allowed paths: src\/components\/calculator\/ src\/app\.js \n/);
  assert.match(r.output, /In declared scope:\s+M\s+src\/app\.js\s+A\s+src\/components\/calculator\/Step\.jsx\n/);
  assert.match(r.output, /OUTSIDE declared scope[^\n]*\n\s+A\s+src\/not-a-glob\.js/);
});

test('PR-controlled text is printed without raw control characters', () => {
  const r = land(makeFixture({ pr: { title: 'Evil\x1b[2J title\rspoof\u009b end' } }), undefined, { tty: false });
  assert.match(r.output, /Title: +Evil\?\[2J title\?spoof\? end/);
  assert.doesNotMatch(r.output, /[\x1b\r\u009b]/);
  assertRefused(r, /no terminal/);
});

for (const [kind, url] of [
  ['https', 'https://github.com/detected-org/detected-repo.git'],
  ['https without .git', 'https://github.com/detected-org/detected-repo'],
  ['ssh scp-style', 'git@github.com:detected-org/detected-repo.git'],
  ['ssh url', 'ssh://git@github.com/detected-org/detected-repo.git'],
]) {
  test(`without LAND_REPO the repository is detected from the ${kind} origin URL`, () => {
    const fx = makeFixture({ originUrl: url });
    const r = land(fx, undefined, { answers: typed, repoEnv: null });
    assertMerged(r, fx, 'detected-org/detected-repo');
    assert.doesNotMatch(r.output, /NON-DEFAULT REPOSITORY/);
  });
}

test('refuses when the repository cannot be determined and no --repo is given', () => {
  const r = land(makeFixture(), undefined, { answers: typed, repoEnv: null });
  assertRefused(r, /cannot determine the GitHub repository.*LAND_REPO=OWNER\/NAME or pass --repo/);
});

test('--repo alone is accepted when origin is not a GitHub URL, without the non-default warning', () => {
  const fx = makeFixture();
  const r = land(fx, ['--repo', 'cli-org/cli-repo', String(N)], { answers: typed, repoEnv: null });
  assertMerged(r, fx, 'cli-org/cli-repo');
  assert.doesNotMatch(r.output, /NON-DEFAULT REPOSITORY/);
});

test('LAND_REPO is the default when origin is not a GitHub URL', () => {
  const fx = makeFixture();
  const r = land(fx, undefined, { answers: typed, repoEnv: 'env-org/env-repo' });
  assertMerged(r, fx, 'env-org/env-repo');
  assert.doesNotMatch(r.output, /NON-DEFAULT REPOSITORY|fetching PR objects/);
});

test('when origin is a different GitHub repository, PR objects are fetched from the target repository, not origin', () => {
  const fx = makeFixture({ originUrl: 'https://github.com/detected-org/detected-repo.git' });
  const r = land(fx, undefined, { answers: typed, repoEnv: 'env-org/env-repo' });
  assertRefused(r, /git fetch https:\/\/github\.com\/env-org\/env-repo\.git main failed/);
  assert.match(r.output, /origin is detected-org\/detected-repo; fetching PR objects from https:\/\/github\.com\/env-org\/env-repo\.git/);
});

for (const [kind, url] of [
  ['https with userinfo', 'https://someone@github.com/detected-org/detected-repo.git'],
  ['ssh with port', 'ssh://git@github.com:22/detected-org/detected-repo.git'],
  ['scp-style without user', 'github.com:detected-org/detected-repo'],
]) {
  test(`origin URL form "${kind}" is recognised`, () => {
    const fx = makeFixture({ originUrl: url });
    const r = land(fx, undefined, { answers: typed, repoEnv: null });
    assertMerged(r, fx, 'detected-org/detected-repo');
  });
}

test('malformed --repo values are refused before any network call', () => {
  for (const bad of ['../..', 'a/.', 'a/..', '-x/y', 'a/b/c', 'a']) {
    const r = land(makeFixture(), ['--repo', bad, String(N)], { answers: typed });
    assertRefused(r, /invalid --repo/);
  }
});

test('a base branch changed after review is caught by the pre-merge re-check', () => {
  const r = land(makeFixture({ recheck: { baseRefName: 'release' } }), undefined, { answers: typed });
  assertRefused(r, /targets 'release', not main \(changed since review; re-run\)/);
});

test('a CI result that turned red after review is caught by the pre-merge re-check', () => {
  const red = [{ __typename: 'CheckRun', workflowName: 'CI', name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const r = land(makeFixture({ recheck: { statusCheckRollup: red } }), undefined, { answers: typed });
  assertRefused(r, /CI \/ verify is not green \(COMPLETED\/FAILURE\) \(changed since review; re-run\)/);
});

test('a draft conversion after review is caught by the pre-merge re-check', () => {
  const r = land(makeFixture({ recheck: { isDraft: true } }), undefined, { answers: typed });
  assertRefused(r, /is a draft \(changed since review; re-run\)/);
});

test('the Approved brief is printed in the packet and a decoration-only brief is refused', () => {
  const fx = makeFixture({ files: { 'src/app.js': 'x\n' }, pr: { body: uiBody } });
  const r = land(fx, undefined, { answers: `${N}\npreview checked\n` });
  assertMerged(r, fx);
  assert.match(r.output, /Approved brief: owner brief 2026-10-20/);
  for (const brief of ['Approved brief: **', 'Approved brief: -', '**Approved brief:** `` ']) {
    const refused = land(makeFixture({ files: { 'src/app.js': 'x\n' }, pr: { body: `${brief}\n\nAllowed paths:\n- src/\n` } }), undefined, { answers: `${N}\npreview checked\n` });
    assertRefused(refused, /no 'Approved brief:' line with real content/);
  }
});

test('an executable-bit change is shown in the packet', () => {
  const fx = makeFixture({ files: { 'docs/notes.md': 'now a script\n' } });
  const agent = path.join(fx.dir, 'agent');
  fs.chmodSync(path.join(agent, 'docs/notes.md'), 0o755);
  git(agent, 'add', '-A');
  git(agent, 'commit', '--quiet', '--amend', '--no-edit');
  git(agent, 'push', '--quiet', '--force', 'origin', `HEAD:refs/pull/${N}/head`);
  const headSha = git(agent, 'rev-parse', 'HEAD');
  const fixture = JSON.parse(fs.readFileSync(path.join(fx.stub, 'fixture.json'), 'utf8'));
  for (const v of fixture.prViews) v.headRefOid = headSha;
  fs.writeFileSync(path.join(fx.stub, 'fixture.json'), JSON.stringify(fixture));
  fx.headSha = headSha;
  const r = land(fx, undefined, { answers: `${N}\n` });
  assertMerged(r, fx);
  assert.match(r.output, /M\s+docs\/notes\.md\s+\(mode 100644 -> 100755\)/);
});

test('word joiner, soft hyphen, variation selectors and line separators are printed as "?"', () => {
  const cp = (...codes) => String.fromCodePoint(...codes);
  const name = `src/auth${cp(0x2060, 0x00ad, 0xfe0f, 0x2028)}.js`;
  const fx = makeFixture({ files: { [name]: 'x\n' }, pr: { body: uiBody, title: `A${cp(0x2060)}B` } });
  const r = land(fx, undefined, { answers: `${N}\npreview checked\n` });
  assertMerged(r, fx);
  assert.match(r.output, /A\s+src\/auth\?\?\?\?\.js/);
  assert.match(r.output, /Title:\s+A\?B/);
  for (const code of [0x00ad, 0x180e, 0x2028, 0x2029, 0x2060, 0x2064, 0xfe00, 0xfe0f]) {
    assert.ok(!r.output.includes(cp(code)), `U+${code.toString(16)} leaked`);
  }
});

test('a newline inside a PR title cannot forge packet lines', () => {
  const r = land(makeFixture({ pr: { title: 'Fine\nGate files:\n  (none)' } }), undefined, { answers: typed });
  assert.match(r.output, /Title:\s+Fine\?Gate files:\?  \(none\)/);
});

test('refuses when scripts/ui-paths.txt is missing on main', () => {
  const r = land(makeFixture({ uiListOnMain: false }), undefined, { answers: typed });
  assertRefused(r, /ui-paths\.txt is missing on main/);
});

test('an empty ui-paths.txt disables the UI gate', () => {
  const fx = makeFixture({ files: { 'src/app.js': 'x\n' }, uiListText: '# no UI paths in this project\n\n' });
  const r = land(fx, undefined, { answers: typed });
  assertMerged(r, fx);
  assert.match(r.output, /UI:\s+\(none\)/);
  assert.match(r.output, /No UI change/);
});

test('ui-paths.txt patterns from main decide what counts as UI', () => {
  const fx = makeFixture({ files: { 'docs/notes.md': 'x\n' }, uiListText: 'docs/*\n', pr: { body: uiBody } });
  const r = land(fx, undefined, { answers: `${N}\npreview checked\n` });
  assertMerged(r, fx);
  assert.match(r.output, /UI:\s+M\s+docs\/notes\.md/);
});

test('--repo other/repo is shown prominently and needs OWNER/NAME#N', () => {
  const refused = land(makeFixture(), ['--repo', 'other/repo', String(N)], { answers: typed });
  assertRefused(refused, /confirmation did not match 'other\/repo#7'/);
  assert.match(refused.output, /NON-DEFAULT REPOSITORY: other\/repo/);

  const fx = makeFixture();
  assertMerged(land(fx, ['--repo', 'other/repo', String(N)], { answers: `other/repo#${N}\n` }), fx, 'other/repo');
});

test('--codex exit 0 merges and receives only the Scope and Allowed paths sections', () => {
  const fx = makeFixture({ codexExit: 0 });
  assertMerged(land(fx, ['--codex', String(N)], { answers: typed }), fx);
  const contract = fs.readFileSync(path.join(fx.stub, 'contract.md'), 'utf8');
  assert.match(contract, /tidy the docs notes/);
  assert.match(contract, /- docs\//);
  assert.doesNotMatch(contract, /must not reach/);
});

test('--codex exit 1 refuses', () => {
  const r = land(makeFixture({ codexExit: 1 }), ['--codex', String(N)], { answers: typed });
  assertRefused(r, /blocked by unresolved Codex findings/);
});

test('--codex with an unexpected exit code refuses instead of continuing', () => {
  const r = land(makeFixture({ codexExit: 3 }), ['--codex', String(N)], { answers: typed });
  assertRefused(r, /codex-review\.sh failed unexpectedly \(exit 3\)/);
});

test('--codex exit 2 continues without the review after confirmation', () => {
  const fx = makeFixture({ codexExit: 2 });
  const r = land(fx, ['--codex', String(N)], { answers: typed });
  assertMerged(r, fx);
  assert.match(r.output, /Codex review did not run/);
});

test('--codex runs main\'s codex-review.sh, not a different working-tree copy', () => {
  const fx = makeFixture({ codexExit: 0, codexOutcome: 'clear' });
  fs.writeFileSync(path.join(fx.primary, 'scripts/codex-review.sh'), codexStub('WORKTREE', 1), { mode: 0o755 });
  assertMerged(land(fx, ['--codex', String(N)], { answers: typed }), fx);
  const marker = fs.readFileSync(path.join(fx.stub, 'codex-marker'), 'utf8');
  assert.match(marker, /^MAIN\n/);
  assert.match(marker, /sibling codex-exclude\.txt\nsibling codex-review-contract\.md\nsibling gate-files\.txt/);
});

test('--codex prints the recorded outcome and never says "passed"', () => {
  const fx = makeFixture({ codexExit: 0, codexOutcome: 'overridden: 2 actionable finding(s)' });
  const r = land(fx, ['--codex', String(N)], { answers: typed });
  assertMerged(r, fx);
  assert.match(r.output, /Codex review: overridden: 2 actionable finding\(s\) \(details in \S+\)/);
  assert.doesNotMatch(r.output, /passed/i);

  const fx2 = makeFixture({ codexExit: 0 });
  const r2 = land(fx2, ['--codex', String(N)], { answers: typed });
  assertMerged(r2, fx2);
  assert.match(r2.output, /Codex review: finished \(no outcome recorded; see \S+\)/);
  assert.doesNotMatch(r2.output, /passed/i);
});

test('--codex with no codex-review.sh on main reports that it did not run', () => {
  const fx = makeFixture();
  fs.writeFileSync(path.join(fx.primary, 'scripts/codex-review.sh'), codexStub('WORKTREE', 0), { mode: 0o755 });
  const r = land(fx, ['--codex', String(N)], { answers: typed });
  assertMerged(r, fx);
  assert.match(r.output, /Codex review did not run \(scripts\/codex-review\.sh is not on main\)/);
  assert.equal(fs.existsSync(path.join(fx.stub, 'codex-marker')), false);
});

test('a postcss.config.js change is a gate file and needs "gate"', () => {
  const files = { 'docs/notes.md': 'x\n', 'postcss.config.js': 'export default {};\n' };
  const refused = land(makeFixture({ files }), undefined, { answers: typed });
  assertRefused(refused, /no confirmation \(EOF\)/);
  assert.match(refused.output, /Gate files:\s+A\s+postcss\.config\.js/);
  assert.match(refused.output, /\+export default \{\};/);

  const fx = makeFixture({ files });
  assertMerged(land(fx, undefined, { answers: `${N}\ngate\n` }), fx);
});

test('refuses when scripts/gate-files.txt is missing on main', () => {
  const fx = makeFixture({ gateListOnMain: false });
  fs.copyFileSync(gateList, path.join(fx.primary, 'scripts/gate-files.txt'));   // a working-tree copy does not count
  assertRefused(land(fx, undefined, { answers: typed }), /scripts\/gate-files\.txt is missing on main/);
});

test('bidi and zero-width characters in paths are printed as "?"', () => {
  const fx = makeFixture({ files: { 'src/\u202Esj.kcatta/ok.js': 'x\n' }, pr: { body: uiBody } });
  const r = land(fx, undefined, { answers: `${N}\npreview checked\n` });
  assertMerged(r, fx);
  assert.match(r.output, /A\s+src\/\?sj\.kcatta\/ok\.js/);
  assert.doesNotMatch(r.output, /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
});

test('gate-files.txt patterns are trimmed and comments skipped', () => {
  const gateListText = '# comment\n   # indented comment\n\n  vercel.json  \r\n\tscripts/*\n';
  const files = { 'docs/notes.md': 'x\n', 'vercel.json': '{}\n' };
  const refused = land(makeFixture({ gateListText, files }), undefined, { answers: typed });
  assertRefused(refused, /no confirmation \(EOF\)/);
  assert.match(refused.output, /Gate files:\s+A\s+vercel\.json/);

  const fx = makeFixture({ gateListText, files });
  assertMerged(land(fx, undefined, { answers: `${N}\ngate\n` }), fx);
});

test('a vite.calculator.config.js change is a gate file', () => {
  const files = { 'docs/notes.md': 'x\n', 'vite.calculator.config.js': 'export default {};\n' };
  const refused = land(makeFixture({ files }), undefined, { answers: typed });
  assertRefused(refused, /no confirmation \(EOF\)/);
  assert.match(refused.output, /Gate files:\s+A\s+vite\.calculator\.config\.js/);

  const gateListText = 'vite.config.*\nvite.*.config.*\n';
  const split = land(makeFixture({ gateListText, files }), undefined, { answers: typed });
  assertRefused(split, /no confirmation \(EOF\)/);
  assert.match(split.output, /Gate files:\s+A\s+vite\.calculator\.config\.js/);
});
