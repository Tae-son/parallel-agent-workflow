import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const runner = path.join(root, 'scripts/codex-smoke.sh');
const baseEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-test-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function shQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: baseEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function executable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function fixture(name) {
  const isolation = path.join(tmp, name);
  const repo = path.join(isolation, 'repo');
  const home = path.join(isolation, 'home');
  const codexHome = path.join(isolation, 'codex-home');
  const stubBin = path.join(isolation, 'stub-bin');
  const record = path.join(isolation, 'record');
  fs.mkdirSync(isolation);
  fs.writeFileSync(path.join(isolation, '.codex-smoke-disposable'), 'disposable Codex smoke root\n');
  fs.mkdirSync(home);
  fs.mkdirSync(codexHome);
  fs.mkdirSync(stubBin);
  git(isolation, 'init', '-q', '--template=', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  executable(path.join(stubBin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "harmless gh stub" >&2\nexit 97\n');
  executable(path.join(stubBin, 'codex'), `#!/bin/sh\n{
    printf 'cwd=%s\\n' "$PWD"
    printf 'home=%s\\n' "$HOME"
    printf 'codex_home=%s\\n' "$CODEX_HOME"
    printf 'gh=%s\\n' "$(command -v gh)"
    printf 'args=%s\\n' "$*"
    if [ "\${OPENAI_API_KEY+x}" = x ]; then printf 'credential=LEAKED\\n'; else printf 'credential=absent\\n'; fi
  } > ${shQuote(record)}\n`);
  const args = [
    '--owner-approved',
    '--isolation-root', isolation,
    '--repo', repo,
    '--home', home,
    '--codex-home', codexHome,
    '--stub-bin', stubBin,
    '--codex-bin', path.join(stubBin, 'codex'),
    '--', 'fixture-command', '--flag',
  ];
  return { isolation, repo, home, codexHome, stubBin, record, args };
}

function run(fx, args = fx.args, env = {}) {
  return spawnSync(runner, args, {
    cwd: root,
    env: { ...baseEnv, OPENAI_API_KEY: 'must-not-leak', ...env },
    encoding: 'utf8',
  });
}

function output(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('fixture mode executes only the isolated Codex stub with a scrubbed environment', () => {
  const fx = fixture('valid');
  const r = run(fx);
  assert.equal(r.status, 0, output(r));
  const observed = fs.readFileSync(fx.record, 'utf8');
  assert.match(observed, new RegExp(`^cwd=${fx.repo.replaceAll('\\', '\\\\')}$`, 'm'));
  assert.match(observed, new RegExp(`^home=${fx.home.replaceAll('\\', '\\\\')}$`, 'm'));
  assert.match(observed, new RegExp(`^codex_home=${fx.codexHome.replaceAll('\\', '\\\\')}$`, 'm'));
  assert.match(observed, new RegExp(`^gh=${path.join(fx.stubBin, 'gh').replaceAll('\\', '\\\\')}$`, 'm'));
  assert.match(observed, /^args=fixture-command --flag$/m);
  assert.match(observed, /^credential=absent$/m);
});

test('runner refuses a smoke test without the explicit owner-approved declaration', () => {
  const fx = fixture('no-approval');
  const r = run(fx, fx.args.filter((arg) => arg !== '--owner-approved'));
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /owner approval/i);
  assert.equal(fs.existsSync(fx.record), false);
});

test('runner refuses isolation paths outside the marked disposable root', () => {
  const fx = fixture('outside-home');
  const outside = path.join(tmp, 'outside-home-global');
  fs.mkdirSync(outside);
  const args = [...fx.args];
  args[args.indexOf(fx.home)] = outside;
  const r = run(fx, args);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /home.*inside.*isolation root/i);
  assert.equal(fs.existsSync(fx.record), false);
});

test('runner refuses a repository with a configured remote', () => {
  const fx = fixture('remote');
  git(fx.repo, 'remote', 'add', 'origin', path.join(tmp, 'not-used'));
  const r = run(fx);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /must not have Git remotes/i);
  assert.equal(fs.existsSync(fx.record), false);
});

test('runner refuses a dirty disposable repository', () => {
  const fx = fixture('dirty');
  fs.writeFileSync(path.join(fx.repo, 'untracked'), 'x\n');
  const r = run(fx);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /must be clean/i);
  assert.equal(fs.existsSync(fx.record), false);
});

test('runner requires an executable harmless gh stub', () => {
  const fx = fixture('missing-gh-stub');
  fs.rmSync(path.join(fx.stubBin, 'gh'));
  const r = run(fx);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /gh stub/i);
  assert.equal(fs.existsSync(fx.record), false);
});

test('fixture mode refuses a Codex binary outside the disposable root', () => {
  const fx = fixture('outside-codex');
  const outside = path.join(tmp, 'outside-codex-stub');
  fs.copyFileSync(path.join(fx.stubBin, 'codex'), outside);
  fs.chmodSync(outside, 0o755);
  const args = [...fx.args];
  args[args.indexOf(path.join(fx.stubBin, 'codex'))] = outside;
  const r = run(fx, args);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /native.*approval/i);
  assert.equal(fs.existsSync(fx.record), false);
});

test('native mode requires separate declarations for activation and a possible model call', () => {
  const fx = fixture('native-declarations');
  const outside = path.join(tmp, 'native-codex-stub');
  fs.copyFileSync(path.join(fx.stubBin, 'codex'), outside);
  fs.chmodSync(outside, 0o755);
  const args = [...fx.args];
  args[args.indexOf(path.join(fx.stubBin, 'codex'))] = outside;
  args.splice(args.indexOf('--'), 0, '--native', '--model-call-approved');
  for (const env of [
    {},
    { CODEX_SMOKE_NATIVE_APPROVED: '1' },
  ]) {
    const r = run(fx, args, env);
    assert.equal(r.status, 2, output(r));
    assert.match(output(r), /separate owner approval/i);
  }
  const r = run(fx, args, {
    CODEX_SMOKE_NATIVE_APPROVED: '1',
    CODEX_SMOKE_MODEL_CALL_APPROVED: '1',
  });
  assert.equal(r.status, 0, output(r));
});

test('runner refuses Codex sandbox-bypass flags in every mode', () => {
  const fx = fixture('sandbox-bypass');
  const args = [...fx.args, '--dangerously-bypass-approvals-and-sandbox'];
  const r = run(fx, args);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /sandbox bypass/i);
  assert.equal(fs.existsSync(fx.record), false);
});

test('runner is valid shell syntax', () => {
  const r = spawnSync('bash', ['-n', runner], { encoding: 'utf8' });
  assert.equal(r.status, 0, output(r));
});

test('agent policy requires owner-approved boundaries and preserves unrelated prohibitions', () => {
  const policyFiles = [
    'AGENTS.md',
    'CONTRIBUTING.md',
    '.claude/skills/parallel-agent-workflow/SKILL.md',
    '.agents/skills/parallel-agent-workflow/SKILL.md',
  ];
  for (const file of policyFiles) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(content, /Codex smoke tests only when the\s+owner explicitly approves/i, file);
    assert.match(content, /scripts\/codex-smoke\.sh/, file);
    assert.match(content, /Never merge|never merge/i, file);
    assert.match(content, /push(?:ing)? to `?main`?/i, file);
  }
  const docs = fs.readFileSync(path.join(root, 'docs/agent-support.md'), 'utf8');
  assert.match(docs, /fixture tests.*do\s+not prove.*native activation/is);
  assert.match(docs, /does\s+not\s+authenticate owner approval/i);
  assert.match(docs, /normal profiles|live profiles/i);
});
