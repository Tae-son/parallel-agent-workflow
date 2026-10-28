import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
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
  assert.match(again.stdout, /Left unchanged[^\n]*\n(\s+.*\n)*\s+\.github\/CODEOWNERS/);
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
  assert.doesNotMatch(r.stdout, /Overwritten/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 2);
});

test('a hook registered under a different literal is recognised and not duplicated', () => {
  const target = freshRepo('settings-variant');
  fs.mkdirSync(path.join(target, '.claude'));
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ./.claude/hooks/agent-guard.mjs' }] }] } };
  fs.writeFileSync(path.join(target, '.claude/settings.json'), JSON.stringify(existing));
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /already registered/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 1);
});

for (const [label, content] of [
  ['hooks is a string', '{"hooks":"x"}'],
  ['hooks is an array', '{"hooks":[]}'],
  ['PreToolUse is an object', '{"hooks":{"PreToolUse":{}}}'],
  ['top level is an array', '[1,2]'],
  ['not JSON', '{nope'],
]) {
  test(`unsupported .claude/settings.json (${label}) is left unchanged, reported, and the run still completes with exit 2`, () => {
    const target = freshRepo(`settings-${label.replace(/\W+/g, '-')}`);
    fs.mkdirSync(path.join(target, '.claude'));
    fs.writeFileSync(path.join(target, '.claude/settings.json'), content);
    const r = install(['--owner', 'someone', target]);
    assert.equal(r.status, 2, text(r));
    assert.equal(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'), content);
    assert.match(r.stdout, /Refused[^\n]*\n(\s+.*\n)*\s+\.claude\/settings\.json \(.*register the hook by hand/);
    assert.doesNotMatch(r.stdout, /^Updated:|hook added/m);
    assert.equal(git(target, 'config', 'core.hooksPath'), '.githooks', 'later steps still ran');
    assert.ok(fs.existsSync(path.join(target, 'scripts/land.sh')));
  });
}

test('odd entries inside hooks.PreToolUse are preserved and the hook is still appended', () => {
  const target = freshRepo('settings-odd-entries');
  fs.mkdirSync(path.join(target, '.claude'));
  fs.writeFileSync(path.join(target, '.claude/settings.json'), '{"hooks":{"PreToolUse":[null,{"hooks":"x"}]}}');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  const merged = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(merged.hooks.PreToolUse.slice(0, 2), [null, { hooks: 'x' }]);
  assert.match(merged.hooks.PreToolUse[2].hooks[0].command, /agent-guard\.mjs/);
});

test('without --owner a placeholder CODEOWNERS is written, flagged on every run, and replaced by a later --owner', () => {
  const target = freshRepo('placeholder');
  const r = install([target]);
  assert.equal(r.status, 0, text(r));
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @OWNER\n');
  assert.match(r.stdout, /replace @OWNER/);
  const again = install([target]);
  assert.match(again.stdout, /still holds the placeholder @OWNER/);
  const owned = install(['--owner', 'real-owner', target]);
  assert.equal(owned.status, 0, text(owned));
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @real-owner\n');
  assert.match(owned.stdout, /placeholder replaced with @real-owner/);
});

test('symlinks anywhere in a destination path are refused and nothing is written through them', () => {
  const target = freshRepo('symlinks');
  const outside = path.join(tmp, 'outside-dir'); fs.mkdirSync(outside);
  const outsideFile = path.join(tmp, 'outside-file.txt'); fs.writeFileSync(outsideFile, 'keep me\n');
  fs.symlinkSync(outside, path.join(target, 'scripts'));                       // directory symlink
  fs.mkdirSync(path.join(target, '.github'));
  fs.symlinkSync(outsideFile, path.join(target, '.github/pull_request_template.md')); // file symlink
  fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(target, '.github/CODEOWNERS')); // dangling
  const r = install(['--owner', 'someone', '--force', target]);
  assert.equal(r.status, 2, text(r));
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the directory symlink');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep me\n', 'file symlink target untouched');
  assert.ok(!fs.existsSync(path.join(tmp, 'does-not-exist')), 'dangling symlink not materialised');
  assert.match(r.stdout, /Refused[^\n]*\n(\s+.*\n)*\s+scripts\/land\.sh \(a symlink is in its path\)/);
  assert.match(r.stdout, /\.github\/CODEOWNERS \(a symlink is in its path\)/);
  assert.ok(fs.existsSync(path.join(target, 'CONTRIBUTING.md')), 'unaffected files still installed');
});

test('a directory where a file belongs is refused even with --force', () => {
  const target = freshRepo('dir-at-file');
  fs.mkdirSync(path.join(target, 'CONTRIBUTING.md'));
  const r = install(['--owner', 'someone', '--force', target]);
  assert.equal(r.status, 2, text(r));
  assert.ok(fs.statSync(path.join(target, 'CONTRIBUTING.md')).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(target, 'CONTRIBUTING.md')), []);
  assert.match(r.stdout, /CONTRIBUTING\.md \(exists and is not a regular file\)/);
});

test('an existing core.hooksPath other than .githooks is left alone and reported', () => {
  const target = freshRepo('husky');
  git(target, 'config', 'core.hooksPath', '.husky');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.equal(git(target, 'config', 'core.hooksPath'), '.husky');
  assert.match(r.stdout, /core\.hooksPath is '\.husky' and was left unchanged/);
});

test('an inherited GIT_DIR cannot redirect the config write to another repository', () => {
  const other = freshRepo('other-repo');
  const target = freshRepo('git-dir-victim');
  const r = spawnSync(installer, ['--owner', 'someone', target], { cwd: root, env: { ...env, GIT_DIR: path.join(other, '.git') }, encoding: 'utf8' });
  assert.equal(r.status, 0, text(r));
  assert.equal(git(target, 'config', 'core.hooksPath'), '.githooks');
  const cfg = spawnSync('git', ['config', 'core.hooksPath'], { cwd: other, env, encoding: 'utf8' });
  assert.notEqual(cfg.status, 0, 'the other repository must be untouched');
});

test('a target path containing spaces works, including running the installed tests there', () => {
  const target = freshRepo('with space in name');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.ok(fs.existsSync(path.join(target, 'scripts/land.sh')));
  assert.equal(git(target, 'config', 'core.hooksPath'), '.githooks');
  const nestedEnv = { ...env };
  for (const k of Object.keys(nestedEnv)) if (k.startsWith('NODE_TEST_')) delete nestedEnv[k];
  const t = spawnSync('node', ['--test', 'tests/pre-push-hook.test.mjs'], { cwd: target, env: nestedEnv, encoding: 'utf8', timeout: 60_000 });
  assert.equal(t.status, 0, text(t));
  assert.match(t.stdout, /fail 0\b/);
});

test('a relative TARGET_DIR works even with CDPATH exported', () => {
  const target = freshRepo('cdpath-target');
  const elsewhere = path.join(tmp, 'elsewhere'); fs.mkdirSync(path.join(elsewhere, 'cdpath-target'), { recursive: true });
  const r = spawnSync(installer, ['--owner', 'someone', 'cdpath-target'], { cwd: tmp, env: { ...env, CDPATH: elsewhere }, encoding: 'utf8' });
  assert.equal(r.status, 0, text(r));
  assert.ok(fs.existsSync(path.join(target, 'scripts/land.sh')));
  assert.deepEqual(fs.readdirSync(path.join(elsewhere, 'cdpath-target')), []);
});

test('an inherited GIT_CONFIG cannot redirect the config write', () => {
  const target = freshRepo('git-config-env');
  const decoy = path.join(tmp, 'decoy-config'); fs.writeFileSync(decoy, '');
  const r = spawnSync(installer, ['--owner', 'someone', target], { cwd: root, env: { ...env, GIT_CONFIG: decoy }, encoding: 'utf8' });
  assert.equal(r.status, 0, text(r));
  assert.equal(git(target, 'config', '--local', 'core.hooksPath'), '.githooks');
  assert.equal(fs.readFileSync(decoy, 'utf8'), '');
});

test('a global core.hooksPath does not stop the local one from being set, and is mentioned', () => {
  const target = freshRepo('global-hooks');
  const globalCfg = path.join(tmp, 'global-gitconfig');
  fs.writeFileSync(globalCfg, '[core]\n\thooksPath = /somewhere/global-hooks\n');
  const r = spawnSync(installer, ['--owner', 'someone', target], { cwd: root, env: { ...env, GIT_CONFIG_GLOBAL: globalCfg }, encoding: 'utf8' });
  assert.equal(r.status, 0, text(r));
  assert.equal(git(target, 'config', '--local', 'core.hooksPath'), '.githooks');
  assert.match(r.stdout, /non-local core\.hooksPath \(\/somewhere\/global-hooks\) exists; the local value takes precedence/);
});

test('existing executable hooks in .git/hooks are pointed out when hooksPath is set', () => {
  const target = freshRepo('live-hooks');
  fs.writeFileSync(path.join(target, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /existing hooks in .*\.git\/hooks are no longer run now that core\.hooksPath is set: .*pre-commit/);
});

test('a CODEOWNERS at the root or in docs/ is not shadowed by a new .github/CODEOWNERS', () => {
  const target = freshRepo('root-codeowners');
  fs.writeFileSync(path.join(target, 'CODEOWNERS'), '* @existing-team\n');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.ok(!fs.existsSync(path.join(target, '.github/CODEOWNERS')));
  assert.match(r.stdout, /\.github\/CODEOWNERS not created: CODEOWNERS already exists/);
});

test('a hard link to another file is refused so the other file is never rewritten', () => {
  const target = freshRepo('hard-link');
  const precious = path.join(tmp, 'precious.md'); fs.writeFileSync(precious, 'mine\n');
  fs.linkSync(precious, path.join(target, 'CONTRIBUTING.md'));
  fs.mkdirSync(path.join(target, '.claude'));
  const preciousSettings = path.join(tmp, 'precious-settings.json'); fs.writeFileSync(preciousSettings, '{}');
  fs.linkSync(preciousSettings, path.join(target, '.claude/settings.json'));
  const r = install(['--owner', 'someone', '--force', target]);
  assert.equal(r.status, 2, text(r));
  assert.equal(fs.readFileSync(precious, 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(preciousSettings, 'utf8'), '{}');
  assert.match(r.stdout, /CONTRIBUTING\.md \(is a hard link to another file\)/);
  assert.match(r.stdout, /\.claude\/settings\.json \(is a hard link to another file\)/);
});

test('a CRLF or commented placeholder CODEOWNERS is still recognised', () => {
  const target = freshRepo('crlf-placeholder');
  fs.mkdirSync(path.join(target, '.github'));
  fs.writeFileSync(path.join(target, '.github/CODEOWNERS'), '# owners\r\n* @OWNER\r\n');
  const r = install([target]);
  assert.match(r.stdout, /still holds the placeholder @OWNER/);
  const owned = install(['--owner=real-owner', target]);
  assert.equal(owned.status, 0, text(owned));
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @real-owner\n');
});

test('a regular file at an intermediate path component is refused and the rest still installs', () => {
  const target = freshRepo('file-at-dir');
  fs.writeFileSync(path.join(target, 'scripts'), 'not a directory\n');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 2, text(r));
  assert.equal(fs.readFileSync(path.join(target, 'scripts'), 'utf8'), 'not a directory\n');
  assert.match(r.stdout, /scripts\/land\.sh \(a non-directory is in its path\)/);
  assert.ok(fs.existsSync(path.join(target, 'CONTRIBUTING.md')));
  assert.equal(git(target, 'config', '--local', 'core.hooksPath'), '.githooks');
});

test('a nested repository at a destination directory is refused', () => {
  const target = freshRepo('nested');
  git(target, 'init', '-q', 'scripts');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 2, text(r));
  assert.ok(!fs.existsSync(path.join(target, 'scripts/land.sh')));
  assert.match(r.stdout, /scripts\/land\.sh \(a nested repository is in its path\)/);
});

test('a write that fails is reported as refused, not as added or overwritten', () => {
  const target = freshRepo('unwritable');
  fs.mkdirSync(path.join(target, 'scripts'));
  fs.writeFileSync(path.join(target, 'scripts/land.sh'), 'mine\n');
  fs.chmodSync(path.join(target, 'scripts'), 0o555);
  try {
    const r = install(['--owner', 'someone', '--force', target]);
    assert.equal(r.status, 2, text(r));
    assert.equal(fs.readFileSync(path.join(target, 'scripts/land.sh'), 'utf8'), 'mine\n');
    assert.match(r.stdout, /scripts\/land\.sh \((directory not writable|cannot replace it)\)/);
    assert.doesNotMatch(r.stdout, /Overwritten[^\n]*\n(\s+.*\n)*\s+scripts\/land\.sh\n/);
  } finally { fs.chmodSync(path.join(target, 'scripts'), 0o755); }
});

test('an empty .claude/settings.json is treated as absent', () => {
  const target = freshRepo('empty-settings');
  fs.mkdirSync(path.join(target, '.claude'));
  fs.writeFileSync(path.join(target, '.claude/settings.json'), '');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.ok(fs.readFileSync(path.join(target, '.claude/settings.json')).equals(fs.readFileSync(path.join(root, '.claude/settings.json'))));
});

test('"--" ends option parsing and a target after it is accepted', () => {
  const target = freshRepo('dashdash');
  const r = install(['--owner', 'someone', '--', target]);
  assert.equal(r.status, 0, text(r));
  assert.ok(fs.existsSync(path.join(target, 'scripts/land.sh')));
});

test('next steps reflect a kept ci.yml and an untouched hooksPath', () => {
  const target = freshRepo('next-steps');
  fs.mkdirSync(path.join(target, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(target, '.github/workflows/ci.yml'), 'name: Build\n');
  git(target, 'config', 'core.hooksPath', '.husky');
  const r = install(['--owner', 'someone', '--no-tests', target]);
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /Your existing \.github\/workflows\/ci\.yml was kept/);
  assert.match(r.stdout, /4\. Hooks: core\.hooksPath was left as it is/);
  assert.doesNotMatch(r.stdout, /node --test tests/);
  assert.match(r.stdout, /copy the kit's \.github\/workflows\/ci\.yml by hand/);
  assert.doesNotMatch(r.stdout, /with --force/);
});

test('a pre-existing CI workflow is left alone and the required check name is pointed out', () => {
  const target = freshRepo('own-ci');
  fs.mkdirSync(path.join(target, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(target, '.github/workflows/ci.yml'), 'name: Build\n');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.equal(fs.readFileSync(path.join(target, '.github/workflows/ci.yml'), 'utf8'), 'name: Build\n');
  assert.match(r.stdout, /ci\.yml already existed: the gate needs a check named "verify" in a workflow named "CI"/);
});

test('an incomplete kit checkout is refused before anything is written', () => {
  const kitCopy = path.join(tmp, 'kit-copy');
  fs.cpSync(root, kitCopy, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git${path.sep}`) && !p.endsWith(`${path.sep}.git`) });
  fs.rmSync(path.join(kitCopy, 'tests/land.test.mjs'));
  const target = freshRepo('incomplete');
  const r = spawnSync(path.join(kitCopy, 'install.sh'), ['--owner', 'someone', target], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(text(r), /kit file missing: tests\/land\.test\.mjs/);
  assert.deepEqual(fs.readdirSync(target).filter((n) => n !== '.git'), ['README.md'], 'nothing written');
});

test('--help prints usage without leaking code', () => {
  const r = install(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: install\.sh/);
  assert.doesNotMatch(r.stdout, /set -e|pipefail/);
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
  assert.notEqual(install(['--owner', '', target]).status, 0, 'empty --owner must be refused');
  assert.notEqual(install(['--owner=', target]).status, 0);
  assert.notEqual(install(['--owner', 'a'.repeat(40), target]).status, 0, 'logins are at most 39 characters');
  assert.notEqual(install(['--bogus', target]).status, 0);
  assert.notEqual(install([root]).status, 0);
  assert.deepEqual(fs.readdirSync(target).filter((n) => n !== '.git').sort(), ['README.md', 'sub'], 'refusals write nothing');
});

test('the installed guard tests pass inside the target repository', () => {
  const target = freshRepo('selftest');
  assert.equal(install(['--owner', 'someone', target]).status, 0);
  // A nested runner must not inherit the parent runner's child-process context variables.
  const nestedEnv = { ...env };
  for (const k of Object.keys(nestedEnv)) if (k.startsWith('NODE_TEST_')) delete nestedEnv[k];
  const r = spawnSync('node', ['--test', 'tests/agent-guard.test.mjs', 'tests/pre-push-hook.test.mjs', 'tests/agents-status.test.mjs', 'tests/codex-review.test.mjs'],
    { cwd: target, env: nestedEnv, encoding: 'utf8', timeout: 180_000 });
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /fail 0\b/);
  assert.match(r.stdout, /pass [1-9]\d*\b/);
});
