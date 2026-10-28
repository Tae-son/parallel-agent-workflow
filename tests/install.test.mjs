import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const installer = path.join(root, 'install.sh');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const install = (args, cwd = root) => spawnSync(installer, args, { cwd, env, encoding: 'utf8' });
const text = (r) => `${r.stdout}${r.stderr}`;

let tmp;
function freshRepo(name) {
  const dir = path.join(tmp, name);
  git(tmp, 'init', '-q', '-b', 'main', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'target\n');
  return dir;
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-test-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const EXPECTED = [
  'scripts/land.sh', 'scripts/codex-review.sh', 'scripts/agents-status.sh', 'scripts/gate-files.txt',
  'scripts/ui-paths.txt', 'scripts/risky-paths.txt', 'scripts/codex-exclude.txt', 'scripts/codex-review-contract.md',
  '.githooks/pre-push', '.github/pull_request_template.md', '.github/workflows/ci.yml', '.github/CODEOWNERS',
  '.claude/hooks/agent-guard.mjs', '.claude/settings.json', 'CONTRIBUTING.md',
  'tests/agent-guard.test.mjs', 'tests/agents-status.test.mjs', 'tests/codex-review.test.mjs',
  'tests/land.test.mjs', 'tests/pre-push-hook.test.mjs', 'tests/helpers/land-gh-stub.mjs',
];

test('installs every kit file into a fresh repository, byte-identical, executable, with CODEOWNERS and hooksPath', () => {
  const target = freshRepo('fresh');
  const r = install(['--owner', '@someone', target]);
  assert.equal(r.status, 0, text(r));
  for (const f of EXPECTED) assert.ok(fs.existsSync(path.join(target, f)), `missing ${f}`);
  for (const f of EXPECTED.filter((f) => !['.github/CODEOWNERS'].includes(f))) {
    assert.ok(fs.readFileSync(path.join(target, f)).equals(fs.readFileSync(path.join(root, f))), `${f} differs from the kit`);
  }
  for (const f of ['scripts/land.sh', 'scripts/codex-review.sh', 'scripts/agents-status.sh', '.githooks/pre-push', '.claude/hooks/agent-guard.mjs']) {
    assert.ok(fs.statSync(path.join(target, f)).mode & 0o100, `${f} not executable`);
  }
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @someone\n');
  assert.equal(git(target, 'config', 'core.hooksPath'), '.githooks');
  assert.ok(!fs.existsSync(path.join(target, 'install.sh')), 'the installer must not copy itself');
  assert.ok(!fs.existsSync(path.join(target, 'README.md.kit')));
  assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'target\n', 'target README untouched');
  assert.match(r.stdout, /Bootstrap rule/);
});

test('existing files are left alone without --force and overwritten with it', () => {
  const target = freshRepo('existing');
  assert.equal(install(['--owner', 'someone', target]).status, 0);
  const gate = path.join(target, 'scripts/gate-files.txt');
  fs.writeFileSync(gate, '# customised\nsrc/build/*\n');
  const again = install(['--owner', 'other', target]);
  assert.equal(again.status, 0, text(again));
  assert.equal(fs.readFileSync(gate, 'utf8'), '# customised\nsrc/build/*\n');
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @someone\n');
  assert.match(again.stdout, /Left unchanged[^\n]*\n(\s+.*\n)*\s+scripts\/gate-files\.txt/);
  const forced = install(['--owner', 'other', '--force', target]);
  assert.equal(forced.status, 0, text(forced));
  assert.ok(fs.readFileSync(gate).equals(fs.readFileSync(path.join(root, 'scripts/gate-files.txt'))));
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @other\n');
});

test('an existing .claude/settings.json keeps its hooks and gains the agent-guard hook once', () => {
  const target = freshRepo('settings');
  fs.mkdirSync(path.join(target, '.claude'));
  const existing = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo keep' }] }] } };
  fs.writeFileSync(path.join(target, '.claude/settings.json'), JSON.stringify(existing));
  assert.equal(install(['--owner', 'someone', target]).status, 0);
  const merged = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(merged.permissions, existing.permissions);
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'echo keep');
  assert.equal(merged.hooks.PreToolUse[1].matcher, 'Bash');
  assert.match(merged.hooks.PreToolUse[1].hooks[0].command, /agent-guard\.mjs/);
  const r = install(['--owner', 'someone', target]);
  assert.match(r.stdout, /hook already registered/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 2);
});

test('without --owner a placeholder CODEOWNERS is written and flagged', () => {
  const target = freshRepo('placeholder');
  const r = install([target]);
  assert.equal(r.status, 0, text(r));
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @OWNER\n');
  assert.match(r.stdout, /replace @OWNER/);
});

test('--no-tests and --no-hooks-path are honoured', () => {
  const target = freshRepo('minimal');
  const r = install(['--owner', 'someone', '--no-tests', '--no-hooks-path', target]);
  assert.equal(r.status, 0, text(r));
  assert.ok(!fs.existsSync(path.join(target, 'tests')));
  const cfg = spawnSync('git', ['config', 'core.hooksPath'], { cwd: target, env, encoding: 'utf8' });
  assert.notEqual(cfg.status, 0, 'hooksPath must not be set');
});

test('refuses a non-repository, a subdirectory, an invalid owner and the kit itself', () => {
  const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain);
  assert.notEqual(install([plain]).status, 0);
  const target = freshRepo('sub'); fs.mkdirSync(path.join(target, 'sub'));
  const r = install([path.join(target, 'sub')]);
  assert.notEqual(r.status, 0); assert.match(text(r), /top level/);
  assert.notEqual(install(['--owner', 'bad login', target]).status, 0);
  assert.notEqual(install([root]).status, 0);
});

test('the installed guard tests pass inside the target repository', () => {
  const target = freshRepo('selftest');
  assert.equal(install(['--owner', 'someone', target]).status, 0);
  // A nested runner must not inherit the parent runner's child-process context variables.
  const nestedEnv = { ...env };
  for (const k of Object.keys(nestedEnv)) if (k.startsWith('NODE_TEST_')) delete nestedEnv[k];
  const r = spawnSync('node', ['--test', 'tests/agent-guard.test.mjs', 'tests/pre-push-hook.test.mjs', 'tests/agents-status.test.mjs'],
    { cwd: target, env: nestedEnv, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /fail 0\b/);
  assert.match(r.stdout, /pass [1-9]\d*\b/);
});
