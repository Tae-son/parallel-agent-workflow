import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
let tmp, repo, subdir, env;
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function handler() {
  const config = JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8'));
  const group = config.hooks.PreToolUse.find((entry) => new RegExp(entry.matcher).test('Bash'));
  assert.ok(group, 'Codex must register a Bash pre-tool hook');
  const hook = group.hooks[0];
  assert.equal(hook.type, 'command');
  assert.equal(hook.async, false, 'blocking requires a synchronous hook');
  assert.ok(hook.timeout > 0 && hook.timeout <= 30);
  assert.ok(!new RegExp(group.matcher).test('NotBash'));
  assert.ok(!hook.command.includes('CLAUDE_PROJECT_DIR'));
  return hook;
}
function run(command, cwd = subdir, extraEnv = {}) {
  return spawnSync('/bin/sh', ['-c', handler().command], {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command }, cwd, session_id: 'fixture', permission_mode: 'bypassPermissions' }),
  });
}
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-'));
  env = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  repo = path.join(tmp, 'repo with spaces');
  git(tmp, 'init', '-q', '--template=', '-b', 'main', repo);
  fs.mkdirSync(path.join(repo, '.claude/hooks'), { recursive: true });
  fs.copyFileSync(path.join(root, '.claude/hooks/agent-guard.mjs'), path.join(repo, '.claude/hooks/agent-guard.mjs'));
  git(repo, 'add', '.claude');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  subdir = path.join(repo, 'nested directory');
  fs.mkdirSync(subdir);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('Codex registration rejects a forbidden command without executing its payload', () => {
  const marker = path.join(tmp, 'must-not-exist');
  const r = run(`touch '${marker}'; gh pr merge 7`);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /owner-only/);
  assert.equal(fs.existsSync(marker), false);
});

test('Codex registration denies a missing guard instead of returning a fail-open exit code', () => {
  const guard = path.join(repo, '.claude/hooks/agent-guard.mjs');
  fs.renameSync(guard, `${guard}.saved`);
  try {
    const r = run('git status');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /agent-guard.*unavailable/);
  } finally { fs.renameSync(`${guard}.saved`, guard); }
});

test('Codex registration denies an undeclared smoke runner invocation', () => {
  const r = run('scripts/codex-smoke.sh --isolation-root /tmp/smoke');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /explicit owner approval/i);
});

test('Codex registration permits the explicitly declared smoke runner for its own boundary checks', () => {
  const r = run('scripts/codex-smoke.sh --owner-approved --isolation-root /tmp/smoke');
  assert.equal(r.status, 0, r.stderr);
});

for (const command of ['git status --short', 'gh pr view 7', 'git push -u origin feat/example', 'npm run verify']) {
  test(`Codex registration permits ${command}`, () => {
    const r = run(command);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
}

for (const command of ['git push origin HEAD:main', 'git push --force origin feat/x',
  'git commit -m unsafe', 'git status\ngh pr merge 7', 'bash -lc "git push origin main"',
  'scripts/land.sh 7', 'scripts/codex-review.sh --pr 7', 'gh api -X PATCH repos/o/r/git/refs/heads/main']) {
  test(`Codex registration denies ${command}`, () => {
    const r = run(command);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /agent-guard:/);
  });
}

test('Codex registration resolves a linked feature worktree from a nested directory', () => {
  const linked = path.join(tmp, 'linked worktree');
  git(repo, 'worktree', 'add', '-qb', 'feat/linked', linked);
  const nested = path.join(linked, 'nested');
  fs.mkdirSync(nested);
  assert.equal(run('git commit -m permitted', nested).status, 0);
  assert.equal(run(`git -C '${repo}' commit -m forbidden`, nested).status, 2);
  assert.equal(run('git push origin HEAD:main', nested).status, 2);
});

test('Codex registration converts unavailable Node and unexpected guard errors into a denial', () => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const gitPath = spawnSync('which', ['git'], { env, encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(gitPath, path.join(bin, 'git'));
  for (const content of [null, '#!/bin/sh\nexit 1\n']) {
    if (content) fs.writeFileSync(path.join(bin, 'node'), content, { mode: 0o755 });
    const r = run('git status', subdir, { PATH: bin });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /agent-guard unavailable/);
  }
});

test('Codex registration denies when repository discovery fails', () => {
  const r = run('git status', tmp);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot resolve repository/);
});

test('Codex registration denies failed Git branch inspection after successful discovery', () => {
  const broken = path.join(tmp, 'broken Git repository');
  git(tmp, 'init', '-q', '--template=', '-b', 'main', broken);
  fs.mkdirSync(path.join(broken, '.claude/hooks'), { recursive: true });
  fs.copyFileSync(path.join(root, '.claude/hooks/agent-guard.mjs'), path.join(broken, '.claude/hooks/agent-guard.mjs'));
  const packed = path.join(broken, '.git/packed-refs');
  fs.writeFileSync(packed, 'invalid packed refs fixture\n');
  try {
    assert.equal(git(broken, 'rev-parse', '--show-toplevel'), broken);
    const branch = spawnSync('git', ['branch', '--show-current'], { cwd: broken, env, encoding: 'utf8' });
    assert.equal(branch.status, 128);
    const r = run('git commit -m ordinary', broken);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /agent-guard unavailable.*branch/);
  } finally { fs.rmSync(packed); }
});
