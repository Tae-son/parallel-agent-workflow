import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

let tmp, mainWt, wtA, wtB, stubEnv;

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
