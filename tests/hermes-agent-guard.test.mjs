import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = '.hermes/plugins/parallel-agent-guard';
let tmp, repo, feature, outside, env;
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hermes-agent-guard-'));
  const templates = path.join(tmp, 'empty-git-templates');
  mkdirSync(templates);
  env = {
    PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: tmp, TMPDIR: tmp,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: templates,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  repo = path.join(tmp, 'kit');
  feature = path.join(tmp, 'feature');
  outside = path.join(tmp, 'unrelated');
  git(tmp, 'init', '-q', '-b', 'main', repo);
  writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'worktree', 'add', '-qb', 'feat/test', feature);
  git(tmp, 'init', '-q', '-b', 'main', outside);
  mkdirSync(path.join(repo, '.claude/hooks'), { recursive: true });
  copyFileSync(path.join(root, '.claude/hooks/agent-guard.mjs'), path.join(repo, '.claude/hooks/agent-guard.mjs'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

// Synthetic Hermes runtime state, real adapter and real Node policy. No Hermes
// startup, profile/config reads, package dependencies, or payload execution.
const harness = String.raw`
import contextlib, importlib.util, json, pathlib, shutil, subprocess, sys, types
from unittest.mock import patch
p = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location('guard_fixture', p['plugin'])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
terminal = types.ModuleType('tools.terminal_tool')
terminal._get_env_config = lambda: p['config']
terminal.get_session_cwd = lambda key: p.get('sessions', {}).get(key or '')
terminal.resolve_task_overrides = lambda key: p.get('overrides', {}).get(key or '', {})
approval = types.ModuleType('tools.approval')
approval.get_current_session_key = lambda default='': p.get('contextKey', default)
sys.modules['tools'] = types.ModuleType('tools')
sys.modules['tools.terminal_tool'] = terminal
sys.modules['tools.approval'] = approval
hooks = []
ctx = types.SimpleNamespace(manifest=types.SimpleNamespace(source=p.get('source', 'project')),
                            register_hook=lambda name, cb: hooks.append((name, cb)))
guard.register(ctx)
dispatch = None
executions = []
cwd_checks = 0
if p.get('runtimeSource'):
    # Execute actual installed dispatch functions, not app module top-level code.
    # Synthetic lifecycle/runtime/handler boundaries make this a version-bound
    # dispatch check, NOT full discovery, worker-context or live activation proof.
    import ast, logging, threading, time
    from dataclasses import dataclass, asdict
    from typing import Any, Optional
    from contextlib import suppress
    def selected(relative, names, ns):
        source = pathlib.Path(p['runtimeSource']) / relative
        tree = ast.parse(source.read_text())
        nodes = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names]
        assert {n.name for n in nodes} == set(names)
        code = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
        exec(compile(ast.fix_missing_locations(code), str(source), 'exec'), ns)
    plugins = types.ModuleType('hermes_cli.plugins')
    lifecycle = types.ModuleType('hermes_cli.lifecycle')
    lifecycle.invoke_hook = lambda event, **kw: [cb(**kw) for name, cb in hooks if name == event]
    sys.modules['hermes_cli'] = types.ModuleType('hermes_cli')
    sys.modules['hermes_cli.lifecycle'] = lifecycle
    sys.modules['hermes_cli.plugins'] = plugins
    ns = dict(globals(), _thread_tool_whitelist=threading.local())
    selected('hermes_cli/plugins.py', ['_PreToolCallDirective', '_get_pre_tool_call_directive_details',
             '_resolve_block_from_details', '_dispatch_pre_tool_call_hooks'], ns)
    plugins._dispatch_pre_tool_call_hooks = ns['_dispatch_pre_tool_call_hooks']
    connectors = types.ModuleType('tools.connectors')
    connectors.is_connector_name = lambda name: False
    names = types.ModuleType('tools.connectors.gateway.names')
    names.parse_connector_name = lambda name: None
    sys.modules['tools.connectors'] = connectors
    sys.modules['tools.connectors.gateway.names'] = names
    def execute(name, args, *a, **kw):
        executions.append({'name': name, 'args': args})
        return json.dumps({'synthetic_handler': True})
    ns.update(
        logger=logging.getLogger('synthetic-dispatch'), _LEGACY_TOOL_ALIASES={}, _AGENT_LOOP_TOOLS=set(),
        _READ_SEARCH_TOOLS=set(), coerce_tool_args=lambda name, args: args,
        _dispatch_bridge_tool=lambda *a: None,
        _apply_request_middleware=lambda name, args, ids, trace: (args, dict(args), trace),
        _emit_post_tool_call_hook=lambda **kw: None, _execute_tool=execute,
        _apply_transform_tool_result_hook=lambda name, args, result, *a: result,
        tool_error=lambda msg: json.dumps({'error': msg}), _sanitize_tool_error=lambda msg: msg,
    )
    selected('model_tools.py', ['_CallIds', '_elapsed_ms', '_pre_dispatch_guards', 'handle_function_call'], ns)
    dispatch = ns['handle_function_call']
    scope = types.ModuleType('tools.terminal_scope')
    scope.enforce_no_refusal = lambda: None
    sys.modules['tools.terminal_scope'] = scope
    # Real local planning/resolution functions with synthetic state accessors.
    # No environment acquisition or shell execution occurs.
    ns.update(
        _get_env_config=terminal._get_env_config, get_session_cwd=terminal.get_session_cwd,
        resolve_task_overrides=terminal.resolve_task_overrides,
        _resolve_container_task_id=lambda task: task, _select_image=lambda *a: '',
        coerce_ssh_remote_cwd=lambda cwd, backend: cwd, _resolve_task_host_cwd=lambda *a: None,
        _is_container_backend=lambda backend: False, FOREGROUND_MAX_TIMEOUT=600,
        trailing_amp_background_command=lambda command: None, _foreground_background_guidance=lambda command: None,
    )
    selected('tools/terminal_tool.py', ['_ExecPlan', '_plan_execution', '_resolve_command_cwd',
             '_container_visible_cwd', '_container_visible_default'], ns)
    for call in p.get('calls', []):
        args = call['args']
        if not isinstance(args.get('command'), str):
            continue
        plan = ns['_plan_execution'](args['command'], task_id=call.get('task_id'), timeout=None,
                                    background=args.get('background', False), _host_local=False)
        key = approval.get_current_session_key(default='') or (call.get('task_id') or '')
        cwd = ns['_resolve_command_cwd'](workdir=args.get('workdir'), default_cwd=plan.cwd,
                                         session_key=key, env_type=plan.env_type)
        assert guard._terminal_location(args, call.get('task_id')) == (plan.env_type, cwd)
        cwd_checks += 1
with contextlib.ExitStack() as stack:
    if p.get('missingDependency'):
        which = shutil.which
        stack.enter_context(patch('shutil.which', side_effect=lambda name: None if name == p['missingDependency'] else which(name)))
    if p.get('runtimeFailure'):
        terminal._get_env_config = lambda: (_ for _ in ()).throw(RuntimeError('fixture runtime failure'))
    if p.get('brokenGit'):
        run = subprocess.run
        stack.enter_context(patch('subprocess.run', side_effect=lambda argv, **kw:
            types.SimpleNamespace(returncode=128, stderr='fixture Git failure', stdout='')
            if pathlib.Path(argv[0]).name == 'git' else run(argv, **kw)))
    failure = p.get('launchFailure')
    if failure:
        run = subprocess.run
        def failed_launch(argv, **kw):
            if pathlib.Path(argv[0]).name != 'node':
                return run(argv, **kw)
            if failure == 'timeout':
                raise subprocess.TimeoutExpired('node', 5)
            if failure == 'missing':
                raise FileNotFoundError('fixture missing node')
            return types.SimpleNamespace(returncode=1, stderr='', stdout='')
        stack.enter_context(patch('subprocess.run', side_effect=failed_launch))
    if dispatch:
        results = [json.loads(dispatch(call['tool_name'], call['args'], task_id=call.get('task_id'),
                   session_id=call.get('session_id'))) for call in p.get('calls', [])]
    else:
        results = [cb(**call) for call in p.get('calls', []) for name, cb in hooks]
output = {'hooks': [name for name, cb in hooks], 'results': results}
if dispatch:
    output['executions'] = executions
    output['cwdChecks'] = cwd_checks
print(json.dumps(output))
`;
function probe(options = {}) {
  const destination = path.join(repo, pluginDir);
  mkdirSync(destination, { recursive: true });
  for (const file of ['__init__.py', 'plugin.yaml']) {
    assert.ok(existsSync(path.join(root, pluginDir, file)), `${file} must be implemented`);
    copyFileSync(path.join(root, pluginDir, file), path.join(destination, file));
  }
  const result = spawnSync('python3', ['-B', '-c', harness], {
    cwd: outside, env, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ plugin: path.join(destination, '__init__.py'), config: { env_type: 'local', cwd: repo, timeout: 180 }, ...options }),
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
const call = (command, args = {}, extra = {}) => ({ tool_name: 'terminal', args: { command, ...args }, task_id: 'task', session_id: 'different-session', ...extra });
function blocked(value, pattern = /./) {
  assert.equal(value?.action, 'block');
  assert.match(value.message, pattern);
}

test('registers native pre_tool_call and maps terminal to the real Bash guard', () => {
  const result = probe({ calls: [call('git status --short'), call('git push origin main')] });
  assert.deepEqual(result.hooks, ['pre_tool_call']);
  assert.equal(result.results[0], null);
  blocked(result.results[1], /pushing to main/);
});

for (const background of [false, true]) {
  test(`effective cwd precedence for ${background ? 'background' : 'foreground'} calls`, () => {
    const commands = [
      call('git commit -m example', { background }),
      call('git commit -m example', { background, workdir: repo }),
      call('git commit -m example', { background, workdir: feature }),
    ];
    // Process cwd is unrelated; task state, not session_id or process cwd, wins.
    const featureState = probe({ sessions: { task: feature, 'different-session': repo }, calls: commands });
    assert.equal(featureState.results[0], null);
    blocked(featureState.results[1], /on main/);
    assert.equal(featureState.results[2], null);
    const mainState = probe({ config: { env_type: 'local', cwd: feature }, sessions: { task: repo }, calls: commands });
    blocked(mainState.results[0], /on main/);
    blocked(mainState.results[1], /on main/);
    assert.equal(mainState.results[2], null);
  });
}

test('approval context session key takes priority, then raw task, then task override/backend default', () => {
  const commands = [call('git commit -m example')];
  blocked(probe({ contextKey: 'ctx', sessions: { ctx: repo, task: feature }, calls: commands }).results[0], /on main/);
  assert.equal(probe({ contextKey: 'ctx', sessions: { ctx: feature, task: repo }, calls: commands }).results[0], null);
  assert.equal(probe({ overrides: { task: { cwd: feature } }, calls: commands }).results[0], null);
  blocked(probe({ calls: commands }).results[0], /on main/);
  // The final session record beats a task workspace override, as in _resolve_command_cwd.
  blocked(probe({ overrides: { task: { cwd: feature } }, sessions: { task: repo }, calls: commands }).results[0], /on main/);
});

test('only the plugin repository and its linked worktrees receive policy', () => {
  const plain = path.join(tmp, 'plain');
  mkdirSync(plain);
  const subdir = path.join(repo, 'nested');
  mkdirSync(subdir);
  const result = probe({ calls: [
    call('gh pr merge 7', { workdir: outside }),
    call('gh pr merge 7', { workdir: plain }),
    call('gh pr merge 7', { workdir: feature }),
    call('gh pr merge 7', { workdir: subdir }),
    call('gh pr merge 7'),
  ] });
  assert.deepEqual(result.results.slice(0, 2), [null, null]);
  result.results.slice(2).forEach(value => blocked(value, /owner-only/));
  // A nested unrelated repository is not owned merely by path containment.
  git(repo, 'init', '-q', '-b', 'main', subdir);
  assert.equal(probe({ calls: [call('gh pr merge 7', { workdir: subdir })] }).results[0], null);
});

test('profile/bundled copies do not register project policy', () => {
  for (const source of ['user', 'bundled', 'pip', 'unknown']) {
    assert.deepEqual(probe({ source, calls: [call('gh pr merge 7')] }), { hooks: [], results: [] });
  }
});

test('malformed terminal payloads fail closed in scope but unrelated tools are untouched', () => {
  const malformed = [null, [], {}, { command: null }, { command: 42 }, { command: '' }, { command: '  ' },
    { command: 'git status', workdir: 42 }, { command: 'git status', workdir: {} }, { command: 'git status\0' }];
  const result = probe({ calls: malformed.map(args => ({ tool_name: 'terminal', args })) });
  result.results.forEach(value => blocked(value));
  for (const tool_name of ['execute_code', 'process', 'process_manage', 'mcp__shell', 'Bash', 'terminal_extra']) {
    assert.equal(probe({ calls: [{ tool_name, args: null }], runtimeFailure: true }).results[0], null);
  }
  assert.equal(probe({ config: { env_type: 'local', cwd: outside }, calls: [{ tool_name: 'terminal', args: null }] }).results[0], null);
});

test('unknown, relative, missing cwd and unsupported backends are explicit blocks', () => {
  for (const cwd of [null, '', '.', 'relative', '~/repo', path.join(tmp, 'missing')]) {
    blocked(probe({ config: { env_type: 'local', cwd }, calls: [call('git status')] }).results[0], /cwd|directory/i);
  }
  for (const env_type of [null, '', 'ssh', 'docker', 'modal', 'daytona', 'unknown']) {
    blocked(probe({ config: { env_type, cwd: repo }, calls: [call('git status')] }).results[0], /backend/i);
  }
  blocked(probe({ runtimeFailure: true, calls: [call('git status')] }).results[0], /runtime/i);
  blocked(probe({ calls: [call('git status', { workdir: '../kit' })] }).results[0], /cwd|directory/i);
});

test('missing dependencies and guard launch failures never permit scoped terminal calls', () => {
  for (const missingDependency of ['node', 'git']) {
    blocked(probe({ missingDependency, calls: [call('git status')] }).results[0], new RegExp(missingDependency));
    assert.equal(probe({ missingDependency, calls: [call('gh pr merge 7', { workdir: outside })] }).results[0], null);
  }
  for (const launchFailure of ['timeout', 'missing', 'exit']) {
    blocked(probe({ launchFailure, calls: [call('git status')] }).results[0]);
  }
  const hook = path.join(repo, '.claude/hooks/agent-guard.mjs');
  rmSync(hook);
  try {
    blocked(probe({ calls: [call('git status')] }).results[0], /guard/);
  } finally {
    copyFileSync(path.join(root, '.claude/hooks/agent-guard.mjs'), hook);
  }
});

test('foreground/background launches retain the existing allowed and denied policy', () => {
  const denied = [
    'git push origin main', 'git push origin HEAD:refs/heads/main', 'git push -f origin feat/test',
    'git push --mirror', 'gh pr merge 7', 'gh api -X PATCH repos/o/r/git/refs/heads/main',
    'scripts/land.sh 7', 'codex exec -', 'bash scripts/codex-review.sh --pr 7',
    'git commit -m example', 'git reset --hard', 'git push origin main &',
    'bash -lc "git push origin main"',
  ];
  const allowed = [
    'git status', 'git diff', 'git pull --ff-only', 'gh pr view 7', 'gh api repos/o/r',
    'git push -u origin feat/test', 'git push --force-with-lease origin feat/test',
  ];
  for (const background of [false, true]) {
    const result = probe({ calls: [...denied, ...allowed].map(command => call(command, { background })) });
    result.results.slice(0, denied.length).forEach(value => blocked(value));
    assert.deepEqual(result.results.slice(denied.length), allowed.map(() => null));
  }
});

test('guard never executes the supplied command or shell substitutions', () => {
  const marker = path.join(tmp, 'payload-ran');
  const result = probe({ calls: [
    call(`touch '${marker}'`),
    call(`echo $(touch '${marker}'); git push origin main`, { background: true }),
  ] });
  assert.equal(result.results[0], null);
  blocked(result.results[1]);
  assert.equal(existsSync(marker), false);
});

test('manifest declares a native pre_tool_call plugin without Python dependencies', () => {
  const manifest = readFileSync(path.join(root, pluginDir, 'plugin.yaml'), 'utf8');
  assert.match(manifest, /^name: parallel-agent-guard$/m);
  assert.match(manifest, /^provides_hooks:\n  - pre_tool_call$/m);
  assert.doesNotMatch(manifest, /python_dependencies|pip/);
});

test('Git present but unable to inspect the scoped repository fails closed', () => {
  blocked(probe({ brokenGit: true, calls: [call('git status')] }).results[0], /git/i);
  assert.equal(probe({ brokenGit: true, calls: [call('gh pr merge 7', { workdir: outside })] }).results[0], null);
});

test('version-bound installed Hermes dispatch vetoes before a synthetic handler', {
  skip: !process.env.HERMES_GUARD_RUNTIME_SOURCE && 'set HERMES_GUARD_RUNTIME_SOURCE for installed-source validation',
}, () => {
  const runtimeSource = process.env.HERMES_GUARD_RUNTIME_SOURCE;
  assert.equal(git(runtimeSource, 'rev-parse', 'HEAD'), '82d5c0ae8106c5eff3ae22fd7ae33ca4ff71d784');
  assert.equal(git(runtimeSource, 'diff', 'HEAD', '--', 'model_tools.py', 'hermes_cli/plugins.py', 'tools/terminal_tool.py'), '');
  const result = probe({ runtimeSource, sessions: { task: feature }, calls: [
    call('git status'), call('git push origin main', { background: true }),
    call('git commit -m example'), call('git commit -m example', { workdir: repo }),
    call('gh pr merge 7', { workdir: outside }), call(null),
  ] });
  assert.deepEqual(result.results[0], { synthetic_handler: true });
  assert.match(result.results[1].error, /pushing to main/);
  assert.deepEqual(result.results[2], { synthetic_handler: true });
  assert.match(result.results[3].error, /on main/);
  assert.deepEqual(result.results[4], { synthetic_handler: true });
  assert.match(result.results[5].error, /malformed/);
  assert.deepEqual(result.executions.map(value => value.args.command), ['git status', 'git commit -m example', 'gh pr merge 7']);
  assert.equal(result.cwdChecks, 5);
  for (const state of [
    {}, { contextKey: 'ctx', sessions: { ctx: repo, task: feature } },
    { contextKey: 'ctx', sessions: { ctx: feature, task: repo } },
    { overrides: { task: { cwd: feature } } },
    { overrides: { task: { cwd: feature } }, sessions: { task: repo } },
  ]) {
    assert.equal(probe({ runtimeSource, ...state, calls: [call('git status')] }).cwdChecks, 1);
  }
});
