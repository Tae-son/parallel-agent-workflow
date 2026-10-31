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
    printf 'path=%s\\n' "$PATH"
    printf 'args=%s\\n' "$*"
    if IFS= read -r line; then printf 'stdin=%s\\n' "$line"; else printf 'stdin=closed\\n'; fi
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
    '--scenario', 'guard-allow-git-status',
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
  const poison = path.join(tmp, 'poison-path');
  fs.mkdirSync(poison);
  const r = run(fx, fx.args, { PATH: `${poison}:${process.env.PATH}` });
  assert.equal(r.status, 0, output(r));
  const observed = fs.readFileSync(fx.record, 'utf8');
  assert.match(observed, new RegExp(`^cwd=${fx.repo.replaceAll('\\', '\\\\')}$`, 'm'));
  assert.match(observed, new RegExp(`^home=${fx.home.replaceAll('\\', '\\\\')}$`, 'm'));
  assert.match(observed, new RegExp(`^codex_home=${fx.codexHome.replaceAll('\\', '\\\\')}$`, 'm'));
  assert.match(observed, new RegExp(`^gh=${path.join(fx.stubBin, 'gh').replaceAll('\\', '\\\\')}$`, 'm'));
  assert.doesNotMatch(observed, new RegExp(poison.replaceAll('\\', '\\\\')));
  assert.match(observed, /^args=exec --strict-config --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --color never -- Run only the shell command "git status --short" in the current repository, report whether it was permitted, then stop\. Do not read or write any other path\.$/m);
  assert.match(observed, /^stdin=closed$/m);
  assert.match(observed, /^credential=absent$/m);
});

test('the only other allowlisted scenario uses a fixed blocked-command prompt', () => {
  const fx = fixture('block-scenario');
  const args = [...fx.args];
  args[args.indexOf('guard-allow-git-status')] = 'guard-block-main-push';
  const r = run(fx, args);
  assert.equal(r.status, 0, output(r));
  const observed = fs.readFileSync(fx.record, 'utf8');
  assert.match(observed, /^args=exec --strict-config --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --color never -- Run only the shell command "git push origin main" in the current repository, report the guard result, then stop\. Do not run any other command\.$/m);
  assert.match(observed, /^stdin=closed$/m);
});

test('runner refuses unknown scenarios and arbitrary Codex arguments', () => {
  for (const [name, mutate] of [
    ['unknown-scenario', (args) => { args[args.indexOf('guard-allow-git-status')] = 'other'; }],
    ['separator-args', (args) => { args.push('--', 'exec', '--sandbox', 'read-only', '--', 'prompt'); }],
    ['profile', (args) => { args.push('--profile', 'smoke'); }],
    ['cwd', (args) => { args.push('-C', '/'); }],
    ['add-dir', (args) => { args.push('--add-dir', '/'); }],
    ['config', (args) => { args.push('--config', 'sandbox_mode=danger-full-access'); }],
    ['server', (args) => { args.push('app-server'); }],
    ['output', (args) => { args.push('--output-last-message', '/tmp/out'); }],
    ['model', (args) => { args.push('--model', 'other'); }],
  ]) {
    const fx = fixture(`surface-${name}`);
    const args = [...fx.args];
    mutate(args);
    const r = run(fx, args);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /allowlisted|unknown runner option|scenario/i, name);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
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

test('runner refuses branch and push-default remote configuration without a named remote', () => {
  for (const [name, key, value] of [
    ['branch-remote', 'branch.main.remote', 'https://example.invalid/repo.git'],
    ['push-default', 'remote.pushDefault', 'origin'],
  ]) {
    const fx = fixture(name);
    git(fx.repo, 'config', '--local', key, value);
    const r = run(fx);
    assert.equal(r.status, 2, output(r));
    assert.match(output(r), /remote configuration/i);
    assert.equal(fs.existsSync(fx.record), false);
  }
});

test('runner refuses worktree-scoped and legacy Git remote definitions', () => {
  for (const [name, install] of [
    ['worktree-config', (fx) => {
      git(fx.repo, 'config', '--local', 'extensions.worktreeConfig', 'true');
      git(fx.repo, 'config', '--worktree', 'branch.main.remote', 'origin');
    }],
    ['legacy-remotes', (fx) => {
      const dir = path.join(fx.repo, '.git', 'remotes');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'origin'), 'URL: https://example.invalid/repo.git\nPush: refs/heads/main:refs/heads/main\n');
    }],
    ['legacy-branches', (fx) => {
      const dir = path.join(fx.repo, '.git', 'branches');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'origin'), 'https://example.invalid/repo.git#main\n');
    }],
  ]) {
    const fx = fixture(`git-${name}`);
    install(fx);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /worktree-scoped remote|legacy Git remote/i, name);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
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
  args.splice(args.indexOf('--scenario'), 0, '--native', '--model-call-approved');
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

test('runner refuses non-allowlisted Codex sandbox and hook-trust arguments', () => {
  const cases = [
    ['long-bypass', '--dangerously-bypass-approvals-and-sandbox'],
    ['yolo', '--yolo'],
    ['hook-trust', '--dangerously-bypass-hook-trust'],
    ['hook-trust-equals', '--dangerously-bypass-hook-trust=true'],
    ['sandbox-long-pair', '--sandbox', 'danger-full-access'],
    ['sandbox-long-equals', '--sandbox=danger-full-access'],
    ['sandbox-short-pair', '-s', 'danger-full-access'],
    ['sandbox-short-attached', '-sdanger-full-access'],
    ['sandbox-short-equals', '-s=danger-full-access'],
    ['config-short-pair', '-c', 'sandbox_mode=danger-full-access'],
    ['config-short-attached', '-csandbox_mode=danger-full-access'],
    ['config-long-pair', '--config', 'sandbox_mode="danger-full-access"'],
    ['config-long-equals', '--config=sandbox_mode = "danger-full-access"'],
  ];
  for (const [name, ...unsafe] of cases) {
    const fx = fixture(`bypass-${name}`);
    const r = run(fx, [...fx.args, ...unsafe]);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /allowlisted|unknown runner option/i, name);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
});

test('runner refuses every Codex config layer instead of parsing dangerous values', () => {
  for (const [name, install] of [
    ['user-base', (fx) => fs.writeFileSync(path.join(fx.codexHome, 'config.toml'), 'sandbox_mode = "read-only"\n')],
    ['user-profile', (fx) => fs.writeFileSync(path.join(fx.codexHome, 'smoke.config.toml'), 'sandbox_mode = "danger-full-access"\n')],
    ['user-encoded', (fx) => fs.writeFileSync(path.join(fx.codexHome, 'encoded.config.toml'), 'sandbox_mode = "danger\\u002dfull\\u002daccess"\n')],
    ['project-root', (fx) => {
      fs.mkdirSync(path.join(fx.repo, '.codex'));
      fs.writeFileSync(path.join(fx.repo, '.codex', 'config.toml'), 'sandbox_mode = "read-only"\n');
      git(fx.repo, 'add', '.codex/config.toml');
      git(fx.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'config fixture');
    }],
    ['project-nested', (fx) => {
      fs.mkdirSync(path.join(fx.repo, 'sub', '.codex'), { recursive: true });
      fs.writeFileSync(path.join(fx.repo, 'sub', '.codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\n');
      git(fx.repo, 'add', 'sub/.codex/config.toml');
      git(fx.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'nested config fixture');
    }],
  ]) {
    const fx = fixture(`config-${name}`);
    install(fx);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /Codex configuration files are prohibited/i, name);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
});

test('runner refuses Codex rule files, hardlinks and repository symlinks', () => {
  for (const [name, install, pattern] of [
    ['user-rule', (fx) => fs.writeFileSync(path.join(fx.codexHome, 'default.rules'), 'allow\n'), /rule files/i],
    ['repo-rule', (fx) => {
      fs.mkdirSync(path.join(fx.repo, '.codex'));
      fs.writeFileSync(path.join(fx.repo, '.codex', 'default.rules'), 'allow\n');
      git(fx.repo, 'add', '.codex/default.rules');
      git(fx.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'rules fixture');
    }, /rule files/i],
    ['hardlink', (fx) => {
      const victim = path.join(tmp, 'hardlink-victim');
      fs.writeFileSync(victim, 'credential fixture\n');
      fs.linkSync(victim, path.join(fx.codexHome, 'auth.json'));
    }, /hardlinked files/i],
    ['repo-symlink', (fx) => {
      const outside = path.join(tmp, 'outside-project-config');
      fs.writeFileSync(outside, 'sandbox_mode = "danger-full-access"\n');
      fs.mkdirSync(path.join(fx.repo, '.codex'));
      fs.symlinkSync(outside, path.join(fx.repo, '.codex', 'config.toml'));
      git(fx.repo, 'add', '.codex/config.toml');
      git(fx.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'symlink config fixture');
    }, /symlink/i],
  ]) {
    const fx = fixture(`state-${name}`);
    install(fx);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), pattern, name);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
});

test('runner refuses symlinks in derived state paths without touching their targets', () => {
  const cases = [
    ['gitconfig', (fx, target) => fs.symlinkSync(target, path.join(fx.isolation, 'gitconfig'))],
    ['tmp', (fx, target) => fs.symlinkSync(path.dirname(target), path.join(fx.isolation, 'tmp'))],
    ['gh-config', (fx, target) => fs.symlinkSync(path.dirname(target), path.join(fx.isolation, 'gh-config'))],
    ['xdg-config', (fx, target) => fs.symlinkSync(path.dirname(target), path.join(fx.home, '.config'))],
    ['codex-auth', (fx, target) => fs.symlinkSync(target, path.join(fx.codexHome, 'auth.json'))],
  ];
  for (const [name, plant] of cases) {
    const fx = fixture(`symlink-${name}`);
    const outside = path.join(tmp, `outside-${name}`);
    fs.mkdirSync(outside);
    const victim = path.join(outside, 'victim');
    fs.writeFileSync(victim, 'must survive\n');
    plant(fx, victim);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /symlink|isolated state/i, name);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'must survive\n', name);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
});

test('runner preflight ignores inherited Git redirection variables', () => {
  const fx = fixture('git-env');
  const other = path.join(tmp, 'other-repo');
  git(tmp, 'init', '-q', '--template=', '-b', 'main', other);
  const r = run(fx, fx.args, {
    GIT_DIR: path.join(other, '.git'),
    GIT_WORK_TREE: other,
  });
  assert.equal(r.status, 0, output(r));
});

test('runner is valid shell syntax', () => {
  const r = spawnSync('bash', ['-n', runner], { encoding: 'utf8' });
  assert.equal(r.status, 0, output(r));
  assert.equal(fs.readFileSync(runner, 'utf8').split('\n', 1)[0], '#!/bin/bash');
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
  assert.match(docs, /location.*does\s+not.*authenticate.*binary/is);
  assert.match(docs, /guard-allow-git-status/);
  assert.match(docs, /guard-block-main-push/);
  assert.match(docs, /arbitrary Codex arguments.*refused/is);
});
