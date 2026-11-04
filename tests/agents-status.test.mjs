import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = `${root}scripts/agents-status.sh`;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

let tmp, mainWt, wtA, wtB, stubEnv, recEnv;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agents-status-'));
  mainWt = path.join(tmp, 'repo');
  wtA = path.join(tmp, 'wt-a');
  wtB = path.join(tmp, 'wt-b');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(tmp, 'clone', '-q', path.join(tmp, 'origin.git'), mainWt);
  git(mainWt, 'switch', '-qc', 'main');
  write(path.join(mainWt, 'CLAUDE.md'), 'rules\n');
  write(path.join(mainWt, 'src/a.js'), 'export const a = 1;\n');
  git(mainWt, 'add', '.');
  git(mainWt, 'commit', '-qm', 'init');
  git(mainWt, 'push', '-q', 'origin', 'main');

  git(mainWt, 'worktree', 'add', '-q', '-b', 'feat/a', wtA);
  write(path.join(wtA, 'CLAUDE.md'), 'rules\nmore from a\n');
  write(path.join(wtA, 'src/a.js'), 'export const a = 2;\n');
  git(wtA, 'commit', '-qam', 'a changes');

  git(mainWt, 'worktree', 'add', '-q', '-b', 'feat/b', wtB);
  write(path.join(wtB, 'CLAUDE.md'), 'rules\nmore from b\n');
  write(path.join(wtB, 'notes/new.txt'), 'untracked\n');

  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "gh: simulated failure" >&2\nexit 1\n');
  chmodSync(path.join(bin, 'gh'), 0o755);
  stubEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };

  // Recording stub: logs every invocation (one line of arguments) to $GH_STUB_LOG, answers
  // `pr list` from the JSON file $GH_STUB_LIST, or from $GH_STUB_HEAD_JSON when --head is
  // given, and applies the --jq filter with the system jq like real gh would.
  const recBin = path.join(tmp, 'bin-rec');
  mkdirSync(recBin);
  writeFileSync(path.join(recBin, 'gh'), `#!/bin/sh
printf '%s\n' "$*" >>"$GH_STUB_LOG"
head='' filter=''
while [ $# -gt 0 ]; do
  case "$1" in --head) head=$2; shift ;; --jq) filter=$2; shift ;; esac
  shift
done
if [ -n "$head" ]; then printf '%s' "\${GH_STUB_HEAD_JSON:-[]}" | jq -r "$filter"; else jq -r "$filter" "$GH_STUB_LIST"; fi
`);
  chmodSync(path.join(recBin, 'gh'), 0o755);
  recEnv = { ...env, PATH: `${recBin}:${process.env.PATH}` };
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const statuses = () => [mainWt, wtA, wtB].map((wt) => git(wt, 'status', '--porcelain', '--untracked-files=all'));
const runStatus = (cwd = mainWt) => spawnSync('bash', [script], { cwd, env: stubEnv, encoding: 'utf8' });

test('reports the CLAUDE.md overlap but not the a-only src/a.js', () => {
  const r = runStatus();
  assert.equal(r.status, 0, r.stderr);
  const overlap = r.stdout.split('\n').find((l) => l.includes('feat/a <-> feat/b'));
  assert.ok(overlap, r.stdout);
  assert.match(overlap, /CLAUDE\.md/);
  assert.doesNotMatch(overlap, /src\/a\.js/);
  assert.match(r.stdout, /committed \(2\):\n {4}CLAUDE\.md\n {4}src\/a\.js/);
  assert.match(r.stdout, /dirty \(1\):\n {4}CLAUDE\.md/);
  assert.match(r.stdout, /untracked \(1\):\n {4}notes\/new\.txt/);
  assert.match(r.stdout, /1 ahead, 0 behind/);
  assert.match(r.stdout, /WIP: 2 active non-main worktrees \(limit 3\)/);
});

test('leaves every worktree status byte-identical', () => {
  const before = statuses();
  assert.equal(runStatus(wtB).status, 0);
  assert.deepEqual(statuses(), before);
});

test('exits 0 with "PR: unknown" when gh fails', () => {
  const r = runStatus(wtA);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PR: unknown/);
  assert.doesNotMatch(r.stdout, /simulated failure/);
});

const hasJq = spawnSync('jq', ['--version']).status === 0;
const pr = (number, headRefName, state = 'OPEN', isDraft = false) => ({ number, state, isDraft, headRefName });
const prLine = (out, branch) => out.split('\n== ').find((sec) => sec.startsWith(`${branch} `))?.split('\n').find((l) => l.startsWith('  PR: '));
function runRecording(name, list, extra = {}) {
  const log = path.join(tmp, `${name}.log`);
  const listFile = path.join(tmp, `${name}.json`);
  writeFileSync(log, '');
  writeFileSync(listFile, JSON.stringify(list));
  const r = spawnSync('bash', [script], { cwd: mainWt, encoding: 'utf8', env: { ...recEnv, GH_STUB_LOG: log, GH_STUB_LIST: listFile, ...extra } });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { out: r.stdout, calls };
}

test('fetches the PR list with one gh call and maps it onto every branch', { skip: !hasJq && 'jq not installed' }, () => {
  const { out, calls } = runRecording('one', [pr(12, 'feat/a'), pr(9, 'feat/a', 'MERGED', true), pr(1, 'main', 'MERGED')]);
  assert.equal(calls.length, 1, `gh calls:\n${calls.join('\n')}`);
  assert.doesNotMatch(calls[0], /--head/);
  assert.match(calls[0], /headRefName/);
  assert.equal(prLine(out, 'feat/a'), '  PR: #12 OPEN, #9 MERGED (draft)');
  assert.equal(prLine(out, 'feat/b'), '  PR: none');
  assert.equal(prLine(out, 'main'), '  PR: #1 MERGED');
});

test('falls back to a per-branch query only for branches missing from a full page', { skip: !hasJq && 'jq not installed' }, () => {
  const L = 200; // must match PR_LIMIT in scripts/agents-status.sh
  const list = Array.from({ length: L }, (_, i) => pr(1000 + i, ['feat/b', 'main'][i] ?? `other/${i}`));
  const { out, calls } = runRecording('full', list, { GH_STUB_HEAD_JSON: JSON.stringify([pr(77, 'feat/a')]) });
  const heads = calls.filter((c) => c.includes('--head')).map((c) => c.match(/--head (\S+)/)[1]).sort();
  assert.deepEqual(heads, ['feat/a'], `gh calls:\n${calls.join('\n')}`);
  assert.equal(calls.length, 2);
  assert.equal(prLine(out, 'feat/a'), '  PR: #77 OPEN');
  assert.equal(prLine(out, 'feat/b'), '  PR: #1000 OPEN');
});
