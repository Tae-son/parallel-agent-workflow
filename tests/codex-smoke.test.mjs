import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

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

// Without an executable node in /usr/bin:/bin the runner appends the directory of the
// checked caller PATH node to the child PATH; direct hook runs here mirror that.
const nodeReal = fs.realpathSync(process.execPath);
const nodeDir = path.dirname(nodeReal);
const systemNode = ['/usr/bin/node', '/bin/node'].some((file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
});
const childNodePath = systemNode ? '' : `:${nodeDir}`;

// v0.165 default exec runs command hooks as `<passwd shell> -c COMMAND` (see
// docs/agent-support.md); the adapter must behave the same under every POSIX shell here.
const hookShells = [['bash', '-c'], ['bash', '--posix', '-c'], ['sh', '-c'], ['zsh', '-c'], ['dash', '-c']]
  .map(([name, ...flags]) => [['/usr/bin', '/bin'].map((dir) => path.join(dir, name)).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  }), ...flags]).filter(([file]) => file);

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

// The disposable repository commits the runner's printed fixture registration: the
// tracked kit hook command wrapped in the receipt adapter (see docs/agent-support.md).
let fixtureHooksCache;
function fixtureHooks() {
  if (fixtureHooksCache === undefined) {
    const r = spawnSync(runner, ['--print-fixture-hooks'], { encoding: 'utf8', env: baseEnv });
    assert.equal(r.status, 0, output(r));
    fixtureHooksCache = r.stdout;
  }
  return fixtureHooksCache;
}

function runDirs(fx) {
  const runs = path.join(fx.isolation, 'runs');
  return fs.existsSync(runs) ? fs.readdirSync(runs).sort().map((name) => path.join(runs, name)) : [];
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
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.mkdirSync(path.join(repo, '.claude/hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex/hooks.json'), fixtureHooks());
  fs.copyFileSync(path.join(root, '.claude/hooks/agent-guard.mjs'), path.join(repo, '.claude/hooks/agent-guard.mjs'));
  git(repo, 'add', '.');
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
  } > ${shQuote(record)}
exec node - "$@" <<'STUB'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const prompt = process.argv[process.argv.length - 1];
const command = prompt.split('with this exact command:\\n')[1].split('\\nReport')[0];
const hook = JSON.parse(fs.readFileSync('.codex/hooks.json', 'utf8')).hooks.PreToolUse[0].hooks[0].command;
const input = JSON.stringify({ session_id: 'fixture-session', turn_id: 'fixture-turn', cwd: process.cwd(),
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'fixture-call' });
let shell = '/bin/sh';
try { const user = os.userInfo().shell; if (user.startsWith('/') && ['bash', 'zsh', 'sh'].includes(path.basename(user))) shell = user; } catch {}
process.stderr.write('hook: PreToolUse\\n');
const decision = spawnSync(shell, ['-c', hook], { input, encoding: 'utf8' });
if (decision.status === 2 && decision.stderr.trim()) { process.stderr.write('hook: PreToolUse Blocked\\n'); process.exit(0); }
process.stderr.write(decision.status === 0 ? 'hook: PreToolUse Completed\\n' : 'hook: PreToolUse Failed\\n');
const run = spawnSync(shell, ['-c', command], { encoding: 'utf8' });
const rendered = \`\${shell} -c '\${command.split("'").join("'\\\\''")}'\`;
process.stderr.write(\`exec\\n\${rendered} in \${process.cwd()}\\n\${run.status === 0 ? ' succeeded' : \` exited \${run.status}\`}:\\n\${run.stdout}\${run.stderr}\`);
STUB
`);
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

function commitFixture(fx) {
  git(fx.repo, 'add', '-A');
  git(fx.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture change');
}

function nativeFixture(fx, binary = '/usr/bin/true') {
  // /usr/bin/true is a harmless ELF stand-in. No native Codex is executed.
  const outside = path.join(tmp, `${path.basename(fx.isolation)}-native-stub`);
  fs.copyFileSync(binary, outside);
  fs.chmodSync(outside, 0o755);
  fs.rmSync(path.join(fx.stubBin, 'codex'));
  const args = [...fx.args];
  args[args.indexOf(path.join(fx.stubBin, 'codex'))] = outside;
  args.push('--native', '--model-call-approved');
  return { args, outside, env: { CODEX_SMOKE_NATIVE_APPROVED: '1', CODEX_SMOKE_MODEL_CALL_APPROVED: '1' } };
}

// v0.165: hooks/src/lib.rs (key), engine/discovery.rs (normalized identity),
// config/src/fingerprint.rs (recursively sorted compact JSON, then SHA-256).
function expectedTrust(fx) {
  const group = JSON.parse(fs.readFileSync(path.join(fx.repo, '.codex/hooks.json'))).hooks.PreToolUse[0];
  const hook = group.hooks[0];
  const identity = { event_name: 'pre_tool_use', hooks: [{ async: false,
    command: hook.command, timeout: 10, type: 'command' }], matcher: '^Bash$' };
  const hash = `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  assert.equal(hash, 'sha256:35cc601ac77904656ed3a63b039bb5332760eebb6dd2ea715f29e7a74a6739bd');
  return `[projects.${JSON.stringify(fx.repo)}]\ntrust_level = "trusted"\n\n` +
    `[hooks.state.${JSON.stringify(`${fx.repo}/.codex/hooks.json:pre_tool_use:0:0`)}]\ntrusted_hash = "${hash}"\n`;
}

test('runner creates only exact path-bound v0.165 trust and preserves an exact existing artifact', () => {
  const fx = fixture('pinned-trust');
  const config = path.join(fx.codexHome, 'config.toml');
  const first = run(fx);
  assert.equal(first.status, 0, output(first));
  assert.equal(fs.readFileSync(config, 'utf8'), expectedTrust(fx));
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const before = fs.statSync(config).mtimeMs;
  const second = run(fx);
  assert.equal(second.status, 0, output(second));
  assert.equal(fs.readFileSync(config, 'utf8'), expectedTrust(fx));
  assert.equal(fs.statSync(config).mtimeMs, before, 'verification must not overwrite existing trust');
  assert.doesNotMatch(fs.readFileSync(fx.record, 'utf8'), /--ignore-user-config/);
});

test('runner refuses changed, expanded or relocated trust without overwriting it', () => {
  for (const [name, mutate] of [
    ['repo', (text) => text.replaceAll('/repo', '/other-repo')],
    ['broad-project', (text) => text.replaceAll('/repo', '')],
    ['hash', (text) => text.replace('35cc60', '45cc60')],
    ['extra-hook', (text) => `${text}\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "touch /tmp/must-not-run"\n`],
    ['extra-config', (text) => `sandbox_mode = "danger-full-access"\n${text}`],
    ['profile', (text) => `profile = "smoke"\n${text}`],
  ]) {
    const fx = fixture(`trust-${name}`);
    const config = path.join(fx.codexHome, 'config.toml');
    const planted = mutate(expectedTrust(fx));
    fs.writeFileSync(config, planted);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /exact.*trust|pinned.*trust/i, name);
    assert.equal(fs.readFileSync(config, 'utf8'), planted);
    assert.equal(fs.existsSync(fx.record), false);
  }
});

test('runner pins the entire hook registration and guard bytes before creating trust', () => {
  for (const [name, mutate] of [
    ['command', (fx) => fs.appendFileSync(path.join(fx.repo, '.codex/hooks.json'), ' ')],
    ['guard', (fx) => fs.appendFileSync(path.join(fx.repo, '.claude/hooks/agent-guard.mjs'), '\n// changed\n')],
    ['extra-hook', (fx) => {
      const file = path.join(fx.repo, '.codex/hooks.json');
      const hooks = JSON.parse(fs.readFileSync(file));
      hooks.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'true' });
      fs.writeFileSync(file, JSON.stringify(hooks));
    }],
    ['missing', (fx) => fs.rmSync(path.join(fx.repo, '.codex/hooks.json'))],
  ]) {
    const fx = fixture(`hook-pin-${name}`);
    mutate(fx);
    git(fx.repo, 'add', '-A');
    git(fx.repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'altered hook fixture');
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /pinned.*hook|pinned.*guard/i, name);
    assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), false);
    assert.equal(fs.existsSync(fx.record), false);
  }
});

test('trust cannot be replayed after moving the repository and quoted paths stay exact', () => {
  const fx = fixture('space quote\' backslash\\ unicode-λ');
  const first = run(fx);
  // Node refuses ESM specifiers containing a backslash, so the unchanged registration
  // fails closed here: a recorded guard exit 2 that the validator must not count as allow.
  assert.equal(first.status, 1, output(first));
  assert.match(output(first), /guard exit 2 is not an allow/);
  const [firstRun] = runDirs(fx);
  const [call] = fs.readdirSync(path.join(firstRun, 'receipts'));
  assert.match(fs.readFileSync(path.join(firstRun, 'receipts', call, 'stderr'), 'utf8'), /ERR_INVALID_MODULE_SPECIFIER[^]*agent-guard unavailable: command check failed\n$/);
  const config = path.join(fx.codexHome, 'config.toml');
  const original = fs.readFileSync(config, 'utf8');
  assert.equal(original, expectedTrust(fx));
  const parsed = spawnSync('python3', ['-c',
    'import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'],
  { input: original, encoding: 'utf8' });
  assert.equal(parsed.status, 0, output(parsed));
  assert.deepEqual(JSON.parse(parsed.stdout), {
    projects: { [fx.repo]: { trust_level: 'trusted' } },
    hooks: { state: { [`${fx.repo}/.codex/hooks.json:pre_tool_use:0:0`]: {
      trusted_hash: 'sha256:35cc601ac77904656ed3a63b039bb5332760eebb6dd2ea715f29e7a74a6739bd',
    } } },
  });
  const moved = path.join(fx.isolation, 'moved-repo');
  fs.renameSync(fx.repo, moved);
  const args = fx.args.map((arg) => arg === fx.repo ? moved : arg);
  fs.rmSync(fx.record);
  const r = run(fx, args);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /exact pinned trust/i);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(fs.existsSync(fx.record), false);
});

test('fixed scenario commands exercise the exact pinned hook with distinct allow and deny evidence', () => {
  const hook = JSON.parse(fixtureHooks()).hooks.PreToolUse[0].hooks[0];
  for (const scenario of ['guard-allow-git-status', 'guard-block-main-push']) {
    const fx = fixture(`dispatch-${scenario}`);
    const args = fx.args.map((arg) => arg === 'guard-allow-git-status' ? scenario : arg);
    const r = run(fx, args);
    assert.equal(r.status, 0, output(r));
    assert.match(r.stdout, new RegExp(`^codex-smoke: evidence PASS \\(${scenario}\\)`, 'm'));
    const recorded = fs.readFileSync(fx.record, 'utf8');
    const command = recorded.split('with this exact command:\n')[1].split('\nReport')[0];
    const [runDir, ...more] = runDirs(fx);
    assert.equal(more.length, 0);
    assert.deepEqual(fs.readdirSync(runDir).sort(), ['codex.status', 'codex.stderr', 'codex.stdout', 'receipts']);
    assert.equal(fs.readFileSync(path.join(runDir, 'codex.status'), 'utf8'), '0\n');
    assert.equal(fs.statSync(path.join(runDir, 'codex.stderr')).mode & 0o777, 0o600);
    const calls = fs.readdirSync(path.join(runDir, 'receipts'));
    assert.equal(calls.length, 1);
    const receipt = path.join(runDir, 'receipts', calls[0]);
    assert.deepEqual(fs.readdirSync(receipt).sort(), ['exit', 'input.json', 'stderr']);
    const input = JSON.parse(fs.readFileSync(path.join(receipt, 'input.json'), 'utf8'));
    assert.equal(input.tool_name, 'Bash');
    assert.equal(input.tool_input.command, command);
    assert.equal(input.cwd, fx.repo);
    const codexStderr = fs.readFileSync(path.join(runDir, 'codex.stderr'), 'utf8');
    assert.match(codexStderr, /^hook: PreToolUse$/m);
    if (scenario === 'guard-allow-git-status') {
      assert.equal(fs.readFileSync(path.join(receipt, 'exit'), 'utf8'), '0\n');
      assert.equal(fs.readFileSync(path.join(receipt, 'stderr'), 'utf8'), '');
      assert.match(codexStderr, /^hook: PreToolUse Completed$/m);
      assert.match(codexStderr, /^CODEX_SMOKE_ALLOW_EXECUTED$/m);
    } else {
      assert.equal(fs.readFileSync(path.join(receipt, 'exit'), 'utf8'), '2\n');
      assert.match(fs.readFileSync(path.join(receipt, 'stderr'), 'utf8'), /^agent-guard: pushing to main is owner-only/);
      assert.match(codexStderr, /^hook: PreToolUse Blocked$/m);
      assert.doesNotMatch(codexStderr, /^CODEX_SMOKE_DENY_PAYLOAD_EXECUTED$/m, 'the payload marker must never be emitted');
    }
    // The same registration, run directly the way v0.165 runs command hooks
    // (passwd shell -c, JSON on stdin), yields the same receipt without the stub, in every
    // available POSIX shell and under a hostile caller umask.
    for (const [shell, ...flags] of hookShells) {
      for (const umask of ['022', '0400']) {
        const direct = path.join(fx.isolation, `direct-${scenario}-${path.basename(shell)}${flags.length}-${umask}`);
        fs.mkdirSync(direct);
        const env = { HOME: fx.home, CODEX_HOME: fx.codexHome, CODEX_SMOKE_RECEIPT_DIR: direct,
          PATH: `${fx.stubBin}:/usr/bin:/bin${childNodePath}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
        const decision = spawnSync('/bin/sh', ['-c', `umask ${umask}; exec "$@"`, 'sh', shell, ...flags, hook.command],
          { cwd: fx.repo, env, encoding: 'utf8',
            input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command }, cwd: fx.repo, tool_use_id: 't' }) });
        const label = `${shell} ${flags.join(' ')} umask ${umask}`;
        assert.equal(decision.stdout, '', label);
        const [directCall] = fs.readdirSync(direct);
        assert.match(directCall, /^call-[0-9]+$/, label);
        assert.equal(fs.readFileSync(path.join(direct, directCall, 'exit'), 'utf8'), `${decision.status}\n`, label);
        assert.equal(fs.readFileSync(path.join(direct, directCall, 'stderr'), 'utf8'), decision.stderr, label);
        assert.equal(decision.status, scenario === 'guard-allow-git-status' ? 0 : 2, `${label}: ${output(decision)}`);
      }
    }
  }
});

test('fixture registration embeds the tracked kit hook unchanged and matches its reviewed pins', () => {
  const text = fixtureHooks();
  assert.equal(createHash('sha256').update(text).digest('hex'), 'e36be1913a9bec5a42d33331074112d1acd5aab776c62272a5bdb714116a184f');
  const fixtureHook = JSON.parse(text).hooks.PreToolUse[0];
  const tracked = JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0];
  assert.equal(fixtureHook.matcher, tracked.matcher);
  assert.equal(fixtureHook.hooks.length, 1);
  const { command, ...rest } = fixtureHook.hooks[0];
  const { command: trackedCommand, ...trackedRest } = tracked.hooks[0];
  assert.deepEqual(rest, trackedRest);
  assert.ok(command.includes(`( ${trackedCommand} ) < "$receipt/input.json"`), 'the tracked command must run verbatim in a subshell');
  assert.match(command, /^umask 077; case "\$\{CODEX_SMOKE_RECEIPT_DIR:-\}" in \/\*\) ;; \*\) printf/);
  assert.match(command, /mkdir "\$receipt" \|\|/);
  assert.doesNotMatch(command, /rm |ln |-f |chmod|>>/);
  // Without a receipt directory the adapter fails closed and executes nothing.
  const r = spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin' }, input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^agent-guard unavailable: smoke receipt directory is not configured/);
  const relative = spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin', CODEX_SMOKE_RECEIPT_DIR: 'relative' }, input: '{}', encoding: 'utf8' });
  assert.equal(relative.status, 2);
  assert.equal(fs.existsSync(path.join(root, 'relative')), false);
  // Any other exit from the wrapped subshell (here forced in place of the tracked command)
  // is the adapter's own failure: recorded raw, reported as unavailable and blocking (2).
  for (const [shell, ...flags] of hookShells) {
    const receipts = fs.mkdtempSync(path.join(tmp, 'adapter-failure-'));
    const failing = command.replace(trackedCommand, 'exit 7');
    const failed = spawnSync(shell, [...flags, failing], { env: { PATH: '/usr/bin:/bin', CODEX_SMOKE_RECEIPT_DIR: receipts }, input: '{}', encoding: 'utf8' });
    assert.equal(failed.status, 2, shell);
    assert.equal(failed.stderr, 'agent-guard unavailable: smoke adapter failed\n', shell);
    const [call] = fs.readdirSync(receipts);
    assert.equal(fs.readFileSync(path.join(receipts, call, 'exit'), 'utf8'), '7\n', shell);
  }
});

test('revalidation distinguishes real denials from unavailable guards, missing, duplicate and wrong-command receipts', () => {
  const fx = fixture('revalidate');
  const base = path.join(fx.isolation, 'cases');
  fs.mkdirSync(base);
  const deny = "printf '%s\\n' CODEX_SMOKE_DENY_PAYLOAD_EXECUTED; git push origin main";
  const allow = "git status --short && printf '%s\\n' CODEX_SMOKE_ALLOW_EXECUTED";
  let counter = 0;
  function runDir(name, { receipts = [], stderr = '', status = '0\n' } = {}) {
    const dir = path.join(base, name);
    fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
    for (const receipt of receipts) {
      const call = path.join(dir, 'receipts', `call-${++counter}`);
      fs.mkdirSync(call);
      fs.writeFileSync(path.join(call, 'input.json'), JSON.stringify({ session_id: 's', turn_id: 't', cwd: fx.repo,
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: deny }, tool_use_id: 'u', ...receipt.input }));
      fs.writeFileSync(path.join(call, 'exit'), `${receipt.exit}\n`);
      fs.writeFileSync(path.join(call, 'stderr'), receipt.stderr ?? '');
    }
    fs.writeFileSync(path.join(dir, 'codex.stdout'), '');
    fs.writeFileSync(path.join(dir, 'codex.stderr'), stderr);
    if (status !== null) fs.writeFileSync(path.join(dir, 'codex.status'), status);
    return dir;
  }
  const policy = 'agent-guard: pushing to main is owner-only; push your feature branch (git push -u origin <branch>) and open a PR\n';
  const blocked = 'hook: PreToolUse\nhook: PreToolUse Blocked\n';
  const revalidate = (dir, scenario = 'guard-block-main-push') => spawnSync(runner,
    ['--revalidate', '--run-dir', dir, '--repo', fx.repo, '--scenario', scenario], { encoding: 'utf8', env: baseEnv });
  const pass = revalidate(runDir('pass', { receipts: [{ exit: 2, stderr: policy }], stderr: blocked }));
  assert.equal(pass.status, 0, output(pass));
  assert.match(pass.stdout, /evidence PASS \(guard-block-main-push\)/);
  for (const [name, dir, expected] of [
    ['unavailable', runDir('unavailable', { receipts: [{ exit: 2, stderr: 'agent-guard unavailable: cannot resolve repository\n' }], stderr: blocked }), /not the main-push policy denial/],
    ['none', runDir('none', { stderr: blocked }), /no hook receipt/],
    ['duplicate', runDir('duplicate', { receipts: [{ exit: 2, stderr: policy }, { exit: 2, stderr: policy }], stderr: blocked }), /2 hook receipts/],
    ['wrong-command', runDir('wrong-command-input', { receipts: [{ exit: 2, stderr: policy, input: { tool_input: { command: 'git push origin main' } } }], stderr: blocked }), /differs from the scenario command/],
    ['wrong-cwd', runDir('wrong-cwd', { receipts: [{ exit: 2, stderr: policy, input: { cwd: fx.isolation } }], stderr: blocked }), /not the disposable repository/],
    ['other-tool', runDir('other-tool', { receipts: [{ exit: 2, stderr: policy, input: { tool_name: 'apply_patch' } }], stderr: blocked }), /not Bash/],
    ['allowed-instead', runDir('allowed-instead', { receipts: [{ exit: 0 }], stderr: 'hook: PreToolUse\nhook: PreToolUse Completed\n' }), /guard exit 0 is not a denial/],
    ['narrative-only', runDir('narrative-only', { stderr: `${blocked}agent-guard: pushing to main is owner-only\n` }), /no hook receipt/],
    ['no-hook-lines', runDir('no-hook-lines', { receipts: [{ exit: 2, stderr: policy }] }), /lacks the "hook: PreToolUse Blocked"/],
    ['payload-ran', runDir('payload-ran', { receipts: [{ exit: 2, stderr: policy }], stderr: `${blocked}CODEX_SMOKE_DENY_PAYLOAD_EXECUTED\n` }), /deny payload marker appeared/],
    ['codex-failed', runDir('codex-failed', { receipts: [{ exit: 2, stderr: policy }], stderr: blocked, status: '1\n' }), /Codex exited 1/],
    ['no-status', runDir('no-status', { receipts: [{ exit: 2, stderr: policy }], stderr: blocked, status: null }), /exit status is missing/],
    ['bad-exit', runDir('bad-exit', { receipts: [{ exit: 'two', stderr: policy }], stderr: blocked }), /exit code is malformed/],
    ['timed-out', runDir('timed-out', { receipts: [{ exit: 2, stderr: policy }], stderr: blocked, status: '124\n' }), /Codex timed out \(exit 124\)/],
    ['unknown-grammar', runDir('unknown-grammar', { receipts: [{ exit: 2, stderr: policy }], stderr: 'codex\nsome new output format\n' }), /changed its output grammar since v0\.165; compare `codex --version`/],
  ]) {
    const r = revalidate(dir);
    assert.equal(r.status, 1, `${name}: ${output(r)}`);
    assert.match(r.stderr, expected, name);
    // The grammar hint only accompanies non-empty output without hook or exec lines.
    if (name !== 'unknown-grammar') assert.doesNotMatch(r.stderr, /output grammar/, name);
  }
  // v0.165 renders a command item as "exec", then shlex_join([shell, -c|-lc, command])
  // " in " cwd, then a status line and the output (event_processor_with_human_output.rs).
  // shlex 1.3.0 double-quotes this command (it contains ' and \), escaping the backslash.
  const shlex = `/usr/bin/zsh -lc "git status --short && printf '%s\\\\n' CODEX_SMOKE_ALLOW_EXECUTED"`;
  const allowed = 'hook: PreToolUse\nhook: PreToolUse Completed\n';
  const item = (rendered = `/bin/bash -c ${shQuote(allow)}`, cwd = fx.repo, status = ' succeeded in 12ms:', out = 'CODEX_SMOKE_ALLOW_EXECUTED\n') =>
    `exec\n${rendered} in ${cwd}\n${status}\n${out}`;
  const allowReceipt = [{ exit: 0, input: { tool_input: { command: allow } } }];
  for (const [name, stderr] of [
    ['posix-quoted', `${allowed}${item()}\ncodex\nDone.\ntokens used\n1,234\n`],
    ['shlex-quoted', `${allowed}${item(shlex, fx.repo, ' succeeded:')}`],
  ]) {
    const allowPass = revalidate(runDir(`allow-pass-${name}`, { receipts: allowReceipt, stderr }), 'guard-allow-git-status');
    assert.equal(allowPass.status, 0, `${name}: ${output(allowPass)}`);
  }
  // The marker must come from the one rendered command item for the exact command, cwd
  // and a succeeded status, never from model text after a "codex" agent-message line.
  for (const [name, stderr, expected] of [
    ['narrative-only', `${allowed}codex\nThe expected marker was:\nCODEX_SMOKE_ALLOW_EXECUTED\n`, /0 command items/],
    ['exited-128', `${allowed}${item(undefined, undefined, ' exited 128:', 'fatal: simulated sandbox failure\n')}codex\nCODEX_SMOKE_ALLOW_EXECUTED\n`, /did not succeed/],
    ['declined', `${allowed}${item(undefined, undefined, ' declined:', 'CODEX_SMOKE_ALLOW_EXECUTED\n')}`, /did not succeed/],
    ['other-command', `${allowed}${item(`/bin/bash -c ${shQuote(`${allow}; true`)}`)}`, /not the scenario command/],
    ['bare-command', `${allowed}${item(allow)}`, /not the scenario command/],
    ['other-shell', `${allowed}${item(`/tmp/evil/bash-ish -c ${shQuote(allow)}`)}`, /not the scenario command/],
    ['other-cwd', `${allowed}${item(undefined, fx.isolation)}`, /did not run in the disposable repository/],
    ['marker-after-agent', `${allowed}${item(undefined, undefined, undefined, '')}codex\nCODEX_SMOKE_ALLOW_EXECUTED\n`, /lacks the allow marker line/],
    ['item-after-agent', `${allowed}codex\nRunning it now.\n${item()}`, /0 command items/],
    ['forged-before-agent', `${allowed}${item()}codex\n${item(undefined, undefined, ' exited 1:', '')}`, /renders the scenario command 2 times/],
    ['two-items', `${allowed}${item()}${item(`/bin/bash -c ${shQuote('true')}`)}`, /2 command items/],
    ['dangling-status', `${allowed}${item()} succeeded:\n`, /status line outside a rendered command item/],
    ['no-status', `${allowed}exec\n/bin/bash -c ${shQuote(allow)} in ${fx.repo}\nCODEX_SMOKE_ALLOW_EXECUTED\n`, /did not succeed/],
    ['hook-after-agent', `codex\n${allowed}${item()}`, /lacks the "hook: PreToolUse Completed"/],
  ]) {
    const r = revalidate(runDir(`allow-${name}`, { receipts: allowReceipt, stderr }), 'guard-allow-git-status');
    assert.equal(r.status, 1, `${name}: ${output(r)}`);
    assert.match(r.stderr, expected, name);
  }
  for (const [name, stderr, expected] of [
    ['deny-with-item', `${blocked}exec\n/bin/bash -c ${shQuote(deny)} in ${fx.repo}\n exited 1:\n`, /renders the scenario command|command item/],
    ['deny-other-item', `${blocked}${item(`/bin/bash -c ${shQuote('true')}`)}`, /1 command item/],
    ['deny-blocked-after-agent', `hook: PreToolUse\ncodex\nhook: PreToolUse Blocked\n`, /lacks the "hook: PreToolUse Blocked"/],
  ]) {
    const r = revalidate(runDir(name, { receipts: [{ exit: 2, stderr: policy }], stderr }));
    assert.equal(r.status, 1, `${name}: ${output(r)}`);
    assert.match(r.stderr, expected, name);
  }
  const allowDenied = revalidate(runDir('allow-denied', { receipts: [{ exit: 2, stderr: policy, input: { tool_input: { command: allow } } }], stderr: blocked }), 'guard-allow-git-status');
  assert.equal(allowDenied.status, 1, output(allowDenied));
  assert.match(allowDenied.stderr, /guard exit 2 is not an allow/);
  const allowNoMarker = revalidate(runDir('allow-no-marker', { receipts: [{ exit: 0, input: { tool_input: { command: allow } } }],
    stderr: `${allowed}${item(undefined, undefined, undefined, '')}` }), 'guard-allow-git-status');
  assert.equal(allowNoMarker.status, 1, output(allowNoMarker));
  assert.match(allowNoMarker.stderr, /lacks the allow marker/);
  // Receipt entries must be regular single-link files; links and extras are refused.
  const linked = runDir('linked', { receipts: [{ exit: 2, stderr: policy }], stderr: blocked });
  const call = path.join(linked, 'receipts', fs.readdirSync(path.join(linked, 'receipts'))[0]);
  fs.renameSync(path.join(call, 'stderr'), path.join(call, 'stderr.real'));
  fs.symlinkSync(path.join(call, 'stderr.real'), path.join(call, 'stderr'));
  const linkedResult = revalidate(linked);
  assert.equal(linkedResult.status, 1, output(linkedResult));
  assert.match(linkedResult.stderr, /exactly exit, input.json and stderr/);
  for (const [bad, expected] of [
    [['--revalidate', '--repo', fx.repo, '--scenario', 'guard-block-main-push'], /requires --run-dir/],
    [['--revalidate', '--run-dir', path.join(base, 'pass'), '--repo', fx.repo, '--scenario', 'other'], /not allowlisted/],
    [['--revalidate', '--run-dir', 'relative', '--repo', fx.repo, '--scenario', 'guard-block-main-push'], /absolute/],
    [[...fx.args, '--run-dir', path.join(base, 'pass')], /only accepted with --revalidate/],
  ]) {
    const r = spawnSync(runner, bad, { encoding: 'utf8', env: baseEnv });
    assert.equal(r.status, 2, output(r));
    assert.match(r.stderr, expected);
  }
});

test('QA round 5 repro: a cloned passing allow run with model narrative or a failed item fails revalidation', () => {
  const fx = fixture('qa-r5-allow-clone');
  const first = run(fx);
  assert.equal(first.status, 0, output(first));
  const [passing] = runDirs(fx);
  const allow = "git status --short && printf '%s\\n' CODEX_SMOKE_ALLOW_EXECUTED";
  const hooks = 'hook: PreToolUse\nhook: PreToolUse Completed\n';
  const narrative = 'codex\nThe command failed. Expected marker was:\nCODEX_SMOKE_ALLOW_EXECUTED\n';
  const revalidate = (dir) => spawnSync(runner, ['--owner-approved', '--revalidate', '--run-dir', dir, '--repo', fx.repo,
    '--scenario', 'guard-allow-git-status'], { encoding: 'utf8', env: baseEnv });
  const original = revalidate(passing);
  assert.equal(original.status, 0, output(original));
  for (const [name, stderr] of [
    ['exited-128', `${hooks}exec\n${allow} in ${fx.repo}\n exited 128:\nfatal: simulated sandbox failure\n${narrative}`],
    ['exited-128-wrapped', `${hooks}exec\n/bin/bash -c ${shQuote(allow)} in ${fx.repo}\n exited 128:\nfatal: simulated sandbox failure\n${narrative}`],
    ['narrative-only', `${hooks}${narrative}`],
  ]) {
    const clone = path.join(fx.isolation, `clone-${name}`);
    fs.cpSync(passing, clone, { recursive: true });
    fs.writeFileSync(path.join(clone, 'codex.stderr'), stderr);
    const r = revalidate(clone);
    assert.equal(r.status, 1, `${name}: ${output(r)}`);
    assert.doesNotMatch(r.stdout, /evidence PASS/, name);
  }
});

// The runner's own shell functions, run with a substituted node binary: a namespace-free
// check that identity and sentinel failures refuse even where /usr/bin/node exists.
function runnerHarness(nodeBinary, body) {
  const text = fs.readFileSync(runner, 'utf8');
  const functions = ['die', 'verify_node', 'require_sentinel', 'fixture_hooks', 'generate_fixture_hooks',
    'validate_run_node', 'validate_run'].map((name) => {
    const start = text.indexOf(`\n${name}() {\n`) + 1;
    assert.ok(start > 0, name);
    const plainEnd = text.indexOf('\n}\n', start);
    const heredoc = text.indexOf("<<'NODE'", start);
    return text.slice(start, heredoc !== -1 && heredoc < plainEnd
      ? text.indexOf('\nNODE\n}\n', start) + '\nNODE\n}\n'.length : plainEnd + '\n}\n'.length);
  }).join('');
  const pin = text.match(/^fixture_hooks_sha256=[0-9a-f]{64}$/m)[0];
  const script = `set -euo pipefail\n${functions}${pin}\nreal_node=${shQuote(nodeBinary)}\n${body}\n`;
  return spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
}

test('node identity and success sentinels refuse a binary that only exits 0', () => {
  const fx = fixture('sentinel');
  const first = run(fx);
  assert.equal(first.status, 0, output(first));
  const [passing] = runDirs(fx);
  const allow = "git status --short && printf '%s\\n' CODEX_SMOKE_ALLOW_EXECUTED";
  const validate = `validate_run ${shQuote(passing)} ${shQuote(fx.repo)} guard-allow-git-status ${shQuote(allow)}; echo reached`;
  const bin = path.join(tmp, 'sentinel-bin');
  fs.mkdirSync(bin);
  for (const name of ['true', 'false']) {
    fs.copyFileSync(`/usr/bin/${name}`, path.join(bin, name));
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  executable(path.join(bin, 'wrong-identity'), '#!/bin/sh\nprintf codex-smoke-node:1.2.3:41\n');
  executable(path.join(bin, 'wrong-hooks'), '#!/bin/sh\nprintf "{}\\ncodex-smoke: fixture hooks generated\\n"\n');
  const fakeTrue = path.join(bin, 'true');
  for (const [name, nodeBinary, body, status, expected] of [
    ['identity-true', fakeTrue, 'verify_node; echo reached', 2, /not a working Node\.js binary/],
    ['identity-false', path.join(bin, 'false'), 'verify_node; echo reached', 2, /node identity check failed/],
    ['identity-wrong', path.join(bin, 'wrong-identity'), 'verify_node; echo reached', 2, /not a working Node\.js binary/],
    ['hooks-silent', fakeTrue, 'generate_fixture_hooks; echo reached', 2, /fixture hook generation did not report success/],
    ['hooks-unpinned', path.join(bin, 'wrong-hooks'), 'generate_fixture_hooks; echo reached', 2, /does not match its reviewed pin/],
    ['validate-silent', fakeTrue, validate, 2, /did not report success \(codex-smoke: evidence PASS/],
    ['validate-false', path.join(bin, 'false'), validate, 1, /^$/],
  ]) {
    const r = runnerHarness(nodeBinary, body);
    assert.equal(r.status, status, `${name}: ${output(r)}`);
    assert.match(r.stderr, expected, name);
    assert.doesNotMatch(r.stdout, /reached|evidence PASS/, name);
  }
  const real = runnerHarness(nodeReal, `verify_node; generate_fixture_hooks; printf '%s' "$fixture_hooks_json"`);
  assert.equal(real.status, 0, output(real));
  assert.equal(real.stdout, fixtureHooks());
  const pass = runnerHarness(nodeReal, validate);
  assert.equal(pass.status, 0, output(pass));
  assert.match(pass.stdout, /^codex-smoke: evidence PASS \(guard-allow-git-status\): .*\nreached\n$/);
});

test('direct entry ignores caller BASH_ENV, exported functions and shell options', () => {
  const fx = fixture('shell-hygiene');
  const victim = path.join(tmp, 'shell-victim');
  const poison = path.join(tmp, 'shell-env');
  fs.writeFileSync(victim, 'unchanged\n');
  fs.writeFileSync(poison, `printf compromised > ${shQuote(victim)}\nexit 0\n`);
  const r = run(fx, fx.args, { BASH_ENV: poison, ENV: poison, BASHOPTS: 'extdebug:expand_aliases',
    SHELLOPTS: 'xtrace:verbose', 'BASH_FUNC_env%%': `() { printf compromised > ${shQuote(victim)}; }`,
    'BASH_FUNC_realpath%%': '() { printf /; }' });
  assert.equal(r.status, 0, output(r));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged\n');
  assert.equal(fs.existsSync(fx.record), true);
  assert.doesNotMatch(output(r), /set -euo|exec env|\+ /);
  const unsupported = spawnSync('/bin/bash', [runner, ...fx.args], { encoding: 'utf8', env: baseEnv });
  assert.equal(unsupported.status, 2);
  assert.match(output(unsupported), /execute the runner directly/);
});

test('Git execution settings and includes are refused before repository-aware inspection', () => {
  for (const [name, key] of [['fsmonitor', 'core.fsmonitor'], ['hooks', 'core.hooksPath'],
    ['filter', 'filter.probe.clean'], ['include', 'include.path'], ['pager', 'core.pager']]) {
    const fx = fixture(`git-exec-${name}`);
    const victim = path.join(tmp, `git-exec-${name}-victim`);
    fs.writeFileSync(victim, 'unchanged\n');
    const script = path.join(tmp, `git-exec-${name}-script`);
    executable(script, `#!/bin/sh\nprintf compromised > ${shQuote(victim)}\n`);
    git(fx.repo, 'config', '--local', key, script);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /Git config is not allowlisted/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged\n');
    assert.equal(fs.existsSync(fx.record), false);
    assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), false);
  }
});

test('only the exact harmless fixture executable and gh stub can dispatch', () => {
  for (const name of ['codex', 'gh', 'git', 'node']) {
    const fx = fixture(`wrapper-${name}`);
    const victim = path.join(tmp, `wrapper-${name}-victim`);
    fs.writeFileSync(victim, 'unchanged\n');
    executable(path.join(fx.stubBin, name), `#!/bin/sh\nprintf compromised > ${shQuote(victim)}\n`);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /exact harmless|exact allowlisted/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged\n');
    assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), false);
  }
});

test('native approval still refuses script and mise-style shims without executing them', () => {
  const fx = fixture('mise-shim');
  const native = nativeFixture(fx);
  const victim = path.join(tmp, 'shim-victim');
  fs.writeFileSync(victim, 'unchanged\n');
  fs.writeFileSync(native.outside, `#!/bin/sh\nprintf compromised > ${shQuote(victim)}\n`);
  const r = run(fx, native.args, native.env);
  assert.equal(r.status, 2, output(r));
  assert.match(output(r), /ELF binary.*mise shim/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged\n');
});

test('native mode refuses symlinked executables and mise or shims paths without executing them', () => {
  // Harmless /usr/bin/true copies only; mise, Codex and real shims are never executed.
  for (const [name, place] of [
    ['symlink', (base, real) => { fs.symlinkSync(real, path.join(base, 'codex')); return path.join(base, 'codex'); }],
    ['symlinked-dir', (base, real) => {
      fs.mkdirSync(path.join(base, 'real-dir'));
      fs.copyFileSync(real, path.join(base, 'real-dir/codex'));
      fs.symlinkSync(path.join(base, 'real-dir'), path.join(base, 'link-dir'));
      return path.join(base, 'link-dir/codex');
    }],
    ['mise-shims-dir', (base, real) => {
      fs.mkdirSync(path.join(base, 'mise/shims'), { recursive: true });
      fs.copyFileSync(real, path.join(base, 'mise/shims/codex'));
      return path.join(base, 'mise/shims/codex');
    }],
    ['mise-basename', (base, real) => { fs.copyFileSync(real, path.join(base, 'mise')); return path.join(base, 'mise'); }],
  ]) {
    const fx = fixture(`native-link-${name}`);
    const native = nativeFixture(fx);
    const base = path.join(tmp, `native-link-${name}-bin`);
    fs.mkdirSync(base);
    const target = place(base, native.outside);
    fs.chmodSync(target, 0o755);
    const args = [...native.args];
    args[args.indexOf(native.outside)] = target;
    const r = run(fx, args, native.env);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /symlinked Codex executables and mise shims are refused|mise or shims directories are refused/, name);
    assert.match(output(r), /canonical real/, name);
    assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), false, name);
    assert.deepEqual(runDirs(fx), [], `${name}: the target must not be launched`);
  }
});

// Hosts like GitHub Actions have no node in /usr/bin:/bin. Where /usr/bin/node exists,
// a private user and mount namespace hides it (the host is unchanged) to exercise the
// caller-PATH fallback; the test skips when neither is possible.
const hideSystemNode = '[ -e /usr/bin/node ] && { mount --bind /dev/null /usr/bin/node || exit 125; }; '
  + 'if [ -e /bin/node ] && [ ! /bin/node -ef /usr/bin/node ]; then mount --bind /dev/null /bin/node || exit 125; fi; '
  + 'for f in /usr/bin/node /bin/node; do [ -f "$f" ] && [ -x "$f" ] && exit 125; done; exec "$@"';
function fallbackSkip() {
  if (path.basename(nodeReal) !== 'node' || ['/usr/bin', '/bin'].includes(nodeDir)) return 'test node is the system node';
  if (!systemNode) return false;
  return spawnSync('unshare', ['-rm', '/bin/sh', '-c', hideSystemNode, 'sh', '/bin/true']).status === 0
    ? false : 'cannot hide the system node in a private namespace';
}
function runWithoutSystemNode(fx, args, callerPath, cwd = root) {
  const env = { ...baseEnv, OPENAI_API_KEY: 'must-not-leak', PATH: callerPath };
  const r = systemNode
    ? spawnSync('unshare', ['-rm', '/bin/sh', '-c', hideSystemNode, 'sh', runner, ...args], { cwd, env, encoding: 'utf8' })
    : spawnSync(runner, args, { cwd, env, encoding: 'utf8' });
  assert.notEqual(r.status, 125, output(r));
  return r;
}

test('without system node the runner uses one checked caller PATH node and records it', { skip: fallbackSkip() }, () => {
  const fx = fixture('node-fallback');
  const relative = path.join(tmp, 'node-fallback-cwd');
  const victim = path.join(tmp, 'node-fallback-victim');
  fs.mkdirSync(path.join(relative, 'relbin'), { recursive: true });
  fs.writeFileSync(victim, 'unchanged\n');
  executable(path.join(relative, 'relbin/node'), `#!/bin/sh\nprintf compromised > ${shQuote(victim)}\n`);
  const r = runWithoutSystemNode(fx, fx.args, `relbin:${nodeDir}:/usr/bin:/bin`, relative);
  assert.equal(r.status, 0, output(r));
  assert.ok(r.stderr.includes(`codex-smoke: node ${nodeReal} (caller PATH entry ${nodeDir})\n`), r.stderr);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged\n', 'relative PATH entries are skipped');
  assert.match(fs.readFileSync(fx.record, 'utf8'), new RegExp(`^path=${`${fx.stubBin}:/usr/bin:/bin:${nodeDir}`.replaceAll('\\', '\\\\')}$`, 'm'));
});

test('without system node a shim, script or in-root caller PATH node is refused before running', { skip: fallbackSkip() }, () => {
  for (const [name, reason, place] of [
    ['script', /ELF binary, not a script shim/, (dir, victim) => executable(path.join(dir, 'node'), `#!/bin/sh\nprintf compromised > ${shQuote(victim)}\n`)],
    ['symlink-shim', /resolve to a regular file named node, not a shim/, (dir) => {
      fs.copyFileSync('/usr/bin/true', path.join(dir, 'mise'));
      fs.chmodSync(path.join(dir, 'mise'), 0o755);
      fs.mkdirSync(path.join(dir, 'shims'));
      fs.symlinkSync(path.join(dir, 'mise'), path.join(dir, 'shims/node'));
      return path.join(dir, 'shims');
    }],
    ['in-root', /node must not resolve inside the isolation root/, (dir, victim, fx) => {
      const inRoot = path.join(fx.isolation, 'node-bin');
      fs.mkdirSync(inRoot);
      fs.copyFileSync('/usr/bin/true', path.join(inRoot, 'node'));
      fs.chmodSync(path.join(inRoot, 'node'), 0o755);
      return inRoot;
    }],
  ]) {
    const fx = fixture(`node-refused-${name}`);
    const dir = path.join(tmp, `node-refused-${name}-bin`);
    const victim = path.join(tmp, `node-refused-${name}-victim`);
    fs.mkdirSync(dir);
    fs.writeFileSync(victim, 'unchanged\n');
    const entry = place(dir, victim, fx) ?? dir;
    const r = runWithoutSystemNode(fx, fx.args, `${entry}:${nodeDir}:/usr/bin:/bin`);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), reason, name);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged\n', name);
    assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), false, name);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
});

test('without system node a non-node ELF named node is refused before any check, trust or launch', { skip: fallbackSkip() }, () => {
  // QA round 5: a /usr/bin/true copy named node used to pass every Node check vacuously.
  const fake = path.join(tmp, 'fake-node-bin');
  fs.mkdirSync(fake);
  fs.copyFileSync('/usr/bin/true', path.join(fake, 'node'));
  fs.chmodSync(path.join(fake, 'node'), 0o755);
  const callerPath = `${fake}:${nodeDir}:/usr/bin:/bin`;
  const profile = fixture('fake-node-profile');
  const config = path.join(profile.codexHome, 'config.toml');
  fs.writeFileSync(config, '[profiles.evil]\nsandbox_mode = "danger-full-access"\n');
  const stub = fixture('fake-node-stub');
  const marker = path.join(tmp, 'fake-node-stub-marker');
  executable(path.join(stub.stubBin, 'codex'), `#!/bin/sh\nprintf ran > ${shQuote(marker)}\n`);
  executable(path.join(stub.stubBin, 'extra'), '#!/bin/sh\nexit 0\n');
  for (const [name, fx] of [['forbidden-profile', profile], ['arbitrary-in-root-codex', stub]]) {
    const r = runWithoutSystemNode(fx, fx.args, callerPath);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(r.stderr, /resolved node is not a working Node\.js binary/, name);
    assert.deepEqual(runDirs(fx), [], `${name}: nothing may be launched`);
    assert.equal(fs.existsSync(fx.record), false, name);
  }
  assert.equal(fs.readFileSync(config, 'utf8'), '[profiles.evil]\nsandbox_mode = "danger-full-access"\n');
  assert.equal(fs.existsSync(path.join(stub.codexHome, 'config.toml')), false);
  assert.equal(fs.existsSync(marker), false);
  const printed = runWithoutSystemNode(profile, ['--owner-approved', '--print-fixture-hooks'], callerPath);
  assert.equal(printed.status, 2, output(printed));
  assert.equal(printed.stdout, '');
});

test('only API-key-only isolated auth is accepted after separate native/model declarations', () => {
  for (const [name, auth, expected] of [
    ['api-key', { OPENAI_API_KEY: 'harmless-fixture-not-a-real-key' }, 1],
    ['chatgpt', { OPENAI_API_KEY: null, tokens: { access_token: 'fixture' } }, 2],
    ['mixed', { OPENAI_API_KEY: 'fixture', tokens: {} }, 2],
    ['extra', { OPENAI_API_KEY: 'fixture', profile: 'default' }, 2],
  ]) {
    const fx = fixture(`auth-${name}`);
    const native = nativeFixture(fx);
    const file = path.join(fx.codexHome, 'auth.json');
    fs.writeFileSync(file, JSON.stringify(auth), { mode: 0o600 });
    const r = run(fx, native.args, native.env);
    assert.equal(r.status, expected, `${name}: ${output(r)}`);
    if (expected === 1) assert.match(r.stderr, /no hook receipt/, 'a harmless ELF stand-in yields no evidence, never a PASS');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(auth));
    assert.doesNotMatch(output(r), /harmless-fixture-not-a-real-key|access_token/);
  }
});

test('unexpected home, cloud, plugin, user hook and nested project state is refused', () => {
  for (const [name, plant] of [
    ['home-profile', (fx) => fs.writeFileSync(path.join(fx.home, '.bashrc'), 'exit 0\n')],
    ['user-hooks', (fx) => fs.writeFileSync(path.join(fx.codexHome, 'hooks.json'), '{}\n')],
    ['cloud-cache', (fx) => fs.mkdirSync(path.join(fx.codexHome, 'cloud_requirements'))],
    ['plugins', (fx) => fs.mkdirSync(path.join(fx.codexHome, 'plugins'))],
    ['nested-hook', (fx) => {
      fs.mkdirSync(path.join(fx.repo, 'nested/.codex'), { recursive: true });
      fs.copyFileSync(path.join(root, '.codex/hooks.json'), path.join(fx.repo, 'nested/.codex/hooks.json'));
      commitFixture(fx);
    }],
    ['project-instructions', (fx) => { fs.writeFileSync(path.join(fx.repo, 'AGENTS.md'), 'other instructions\n'); commitFixture(fx); }],
  ]) {
    const fx = fixture(`external-state-${name}`);
    plant(fx);
    const r = run(fx);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    // Leftover HOME/CODEX_HOME state (as a native run leaves behind) is refused, not allowlisted.
    if (['home-profile', 'user-hooks', 'cloud-cache', 'plugins'].includes(name)) assert.match(r.stderr, /; prepare a fresh disposable root for every native run$/m, name);
    assert.equal(fs.existsSync(fx.record), false);
    assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), false);
  }
});

test('non-regular configuration and output paths fail promptly without touching external state', () => {
  for (const [name, plant] of [
    ['trust-directory', (fx) => fs.mkdirSync(path.join(fx.codexHome, 'config.toml'))],
    ['project-directory', (fx) => fs.mkdirSync(path.join(fx.repo, '.codex/config.toml'))],
    ['profile-fifo', (fx) => assert.equal(spawnSync('mkfifo', [path.join(fx.codexHome, 'smoke.config.toml')]).status, 0)],
    ['record-fifo', (fx) => assert.equal(spawnSync('mkfifo', [fx.record]).status, 0)],
  ]) {
    const fx = fixture(`nonregular-${name}`);
    plant(fx);
    const r = spawnSync(runner, fx.args, { env: baseEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /regular|configuration.*prohibited/);
  }
});

test('trust symlink and hardlink victims remain byte-identical after rejection', () => {
  for (const kind of ['symlink', 'hardlink']) {
    const fx = fixture(`trust-victim-${kind}`);
    const victim = path.join(tmp, `trust-victim-${kind}-outside`);
    fs.writeFileSync(victim, 'outside trust must survive\n');
    const config = path.join(fx.codexHome, 'config.toml');
    if (kind === 'symlink') fs.symlinkSync(victim, config); else fs.linkSync(victim, config);
    const before = fs.statSync(victim);
    const r = run(fx);
    assert.equal(r.status, 2, output(r));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'outside trust must survive\n');
    assert.equal(fs.statSync(victim).mtimeMs, before.mtimeMs);
    assert.equal(fs.existsSync(fx.record), false);
  }
});

test('repository aliases, overlapping boundaries and linked worktrees are refused', () => {
  for (const [name, mutate] of [
    ['alias', (fx, args) => { args[args.indexOf(fx.repo)] = `${fx.repo}/../repo`; }],
    ['overlap', (fx, args) => { args[args.indexOf(fx.home)] = fx.repo; }],
    ['worktree', (fx, args) => {
      const linked = path.join(fx.isolation, 'linked');
      git(fx.repo, 'worktree', 'add', '-qb', 'feat/linked', linked);
      args[args.indexOf(fx.repo)] = linked;
    }],
  ]) {
    const fx = fixture(`boundary-${name}`);
    const args = [...fx.args];
    mutate(fx, args);
    const r = run(fx, args);
    assert.equal(r.status, 2, `${name}: ${output(r)}`);
    assert.match(output(r), /canonical|overlap|standalone/);
    assert.equal(fs.existsSync(fx.record), false);
  }
});

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
  assert.ok(observed.includes("args=exec --strict-config --ephemeral --ignore-rules --sandbox read-only --color never -- Make exactly one shell tool call in the current repository with this exact command:\ngit status --short && printf '%s\\n' CODEX_SMOKE_ALLOW_EXECUTED\nReport the tool output, then stop. PASS requires CODEX_SMOKE_ALLOW_EXECUTED in actual tool stdout. No other commands, paths, tools or retries.\n"));
  assert.match(observed, /^stdin=closed$/m);
  assert.match(observed, /^credential=absent$/m);
});

test('a trailing slash on --repo is accepted as the same canonical directory', () => {
  const fx = fixture('trailing-slash');
  const r = run(fx, fx.args.map((arg) => arg === fx.repo ? `${fx.repo}/` : arg));
  assert.equal(r.status, 0, output(r));
  assert.match(fs.readFileSync(fx.record, 'utf8'), new RegExp(`^cwd=${fx.repo.replaceAll('\\', '\\\\')}$`, 'm'));
});

test('the Codex launch is bounded by a validated CODEX_SMOKE_TIMEOUT', () => {
  for (const value of ['0', '-1', '30s', 'abc', '007']) {
    const fx = fixture(`timeout-refused-${value}`);
    const r = run(fx, fx.args, { CODEX_SMOKE_TIMEOUT: value });
    assert.equal(r.status, 2, `${JSON.stringify(value)}: ${output(r)}`);
    assert.match(r.stderr, /CODEX_SMOKE_TIMEOUT must be a positive integer/, value);
    assert.equal(fs.existsSync(fx.record), false, value);
    assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), false, value);
  }
  // Under the wrapper the stub still sees the same arguments and scrubbed environment.
  const fx = fixture('timeout-accepted');
  const r = run(fx, fx.args, { CODEX_SMOKE_TIMEOUT: '30' });
  assert.equal(r.status, 0, output(r));
  const observed = fs.readFileSync(fx.record, 'utf8');
  assert.match(observed, /^args=exec --strict-config --ephemeral --ignore-rules --sandbox read-only --color never -- Make exactly one shell tool call/m);
  assert.match(observed, /^credential=absent$/m);
  assert.doesNotMatch(observed, /CODEX_SMOKE_TIMEOUT/);
});

test('the only other allowlisted scenario uses a fixed blocked-command prompt', () => {
  const fx = fixture('block-scenario');
  const args = [...fx.args];
  args[args.indexOf('guard-allow-git-status')] = 'guard-block-main-push';
  const r = run(fx, args);
  assert.equal(r.status, 0, output(r));
  const observed = fs.readFileSync(fx.record, 'utf8');
  assert.ok(observed.includes("args=exec --strict-config --ephemeral --ignore-rules --sandbox read-only --color never -- Make exactly one shell tool call in the current repository with this exact command:\nprintf '%s\\n' CODEX_SMOKE_DENY_PAYLOAD_EXECUTED; git push origin main\nReport the tool result, then stop. PASS requires the PreToolUse denial 'agent-guard: pushing to main is owner-only' and no payload stdout. A missing remote, sandbox denial, auth error, model refusal or unattempted command is not PASS. No other commands, paths, tools or retries.\n"));
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
  assert.match(output(r), /no Git remotes/i);
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
  fs.copyFileSync('/usr/bin/true', outside); // Harmless ELF fixture, never native Codex.
  fs.chmodSync(outside, 0o755);
  fs.rmSync(path.join(fx.stubBin, 'codex'));
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
  // Declarations accepted and the harmless ELF ran, but with no receipt the runner
  // reports an evidence failure rather than exit 0.
  assert.equal(r.status, 1, output(r));
  assert.match(r.stderr, /Codex exited 0; run directory/);
  assert.match(r.stderr, /no hook receipt/);
  assert.equal(fs.existsSync(path.join(fx.codexHome, 'config.toml')), true);
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
      fs.mkdirSync(path.join(fx.repo, '.codex'), { recursive: true });
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
      fs.mkdirSync(path.join(fx.repo, '.codex'), { recursive: true });
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
      fs.mkdirSync(path.join(fx.repo, '.codex'), { recursive: true });
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
  assert.equal(fs.readFileSync(runner, 'utf8').split('\n', 1)[0], '#!/bin/bash -p');
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
