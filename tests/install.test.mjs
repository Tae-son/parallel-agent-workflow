import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = path.join(root, 'install.sh');
const env = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

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
  '.hermes/plugins/parallel-agent-guard/plugin.yaml',
  '.hermes/plugins/parallel-agent-guard/__init__.py', 'tests/hermes-agent-guard.test.mjs',
  'docs/agent-support.md',
  '.codex/hooks.json', 'tests/codex-hook.test.mjs',
  'scripts/land.sh', 'scripts/codex-review.sh', 'scripts/agents-status.sh', 'scripts/gate-files.txt',
  'scripts/ui-paths.txt', 'scripts/risky-paths.txt', 'scripts/codex-exclude.txt', 'scripts/codex-review-contract.md',
  '.githooks/pre-push', '.github/pull_request_template.md', '.github/workflows/ci.yml', '.github/CODEOWNERS',
  '.claude/hooks/agent-guard.mjs', '.claude/settings.json', 'CONTRIBUTING.md', 'AGENTS.md',
  '.claude/skills/parallel-agent-workflow/SKILL.md', '.agents/skills/parallel-agent-workflow/SKILL.md',
  'tests/agent-guard.test.mjs', 'tests/agent-skill.test.mjs', 'tests/agents-status.test.mjs', 'tests/codex-review.test.mjs',
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
  for (const f of EXPECTED.filter((f) => f === 'AGENTS.md' || f.endsWith('/SKILL.md'))) {
    assert.ok(fs.lstatSync(path.join(target, f)).isFile(), `${f} must be a regular file, not a symlink`);
    assert.equal(fs.statSync(path.join(target, f)).mode & 0o777, 0o644, `${f} must not be executable`);
  }
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @someone\n');
  assert.equal(git(target, 'config', 'core.hooksPath'), '.githooks');
  assert.ok(!fs.existsSync(path.join(target, 'install.sh')), 'the installer must not copy itself');
  assert.ok(!fs.existsSync(path.join(target, 'README.md.kit')));
  assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'target\n', 'target README untouched');
  assert.match(r.stdout, /Bootstrap rule/);
  assert.match(r.stdout, /independent QA/);
  assert.match(fs.readFileSync(path.join(target, 'CONTRIBUTING.md'), 'utf8'), /## Independent QA/);
  assert.match(fs.readFileSync(path.join(target, '.github/pull_request_template.md'), 'utf8'), /```independent-qa/);
});

test('a preserved customised command guard is explicitly reported as unverified', () => {
  const target = freshRepo('custom-command-guard');
  fs.mkdirSync(path.join(target, '.claude/hooks'), { recursive: true });
  const guard = path.join(target, '.claude/hooks/agent-guard.mjs');
  fs.writeFileSync(guard, '// custom checker\n');
  const r = install([target]);
  assert.equal(r.status, 0, text(r));
  assert.equal(fs.readFileSync(guard, 'utf8'), '// custom checker\n');
  assert.match(r.stdout, /shared command checker differs.*unverified/);
});

test('Hermes plugin is staged without changing project configuration or profile state', () => {
  const target = freshRepo('hermes-staged');
  fs.mkdirSync(path.join(target, '.hermes'));
  const projectConfig = '# existing owner configuration\nplugins:\n  enabled: []\n';
  fs.writeFileSync(path.join(target, '.hermes/config.yaml'), projectConfig);
  const profile = path.join(tmp, 'hermes-profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'config.yaml'), projectConfig);
  const r = spawnSync(installer, [target], { cwd: root, env: { ...env, HERMES_HOME: profile }, encoding: 'utf8' });
  assert.equal(r.status, 0, text(r));
  assert.ok(fs.existsSync(path.join(target, '.hermes/plugins/parallel-agent-guard/__init__.py')));
  assert.equal(fs.readFileSync(path.join(target, '.hermes/config.yaml'), 'utf8'), projectConfig);
  assert.equal(fs.readFileSync(path.join(profile, 'config.yaml'), 'utf8'), projectConfig);
  assert.deepEqual(fs.readdirSync(profile), ['config.yaml']);
  assert.match(r.stdout, /Hermes.*not activated/);
  assert.match(r.stdout, /project-only/);
});

test('a kept, customised skill copy that differs from the other copy is reported', () => {
  const target = freshRepo('skill-drift');
  const skill = path.join(target, '.claude/skills/parallel-agent-workflow/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# Customised workflow\n');
  const r = install(['--owner', 'someone', '--no-tests', target]);
  assert.equal(r.status, 0, text(r));
  assert.equal(fs.readFileSync(skill, 'utf8'), '# Customised workflow\n');
  assert.match(r.stdout, /Notes:[^\n]*\n(\s+.*\n)*\s+\.claude\/skills\/parallel-agent-workflow\/SKILL\.md and \.agents\/skills\/parallel-agent-workflow\/SKILL\.md differ/);
  const clean = freshRepo('skill-same');
  assert.doesNotMatch(install(['--owner', 'someone', '--no-tests', clean]).stdout, /differ \(an existing copy was kept\)/);
});

test('existing files are left alone without --force and overwritten with it', () => {
  const target = freshRepo('existing');
  assert.equal(install(['--owner', 'someone', target]).status, 0);
  const gate = path.join(target, 'scripts/gate-files.txt');
  fs.writeFileSync(gate, '# customised\nsrc/build/*\n');
  const skill = path.join(target, '.claude/skills/parallel-agent-workflow/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# Customised workflow\nKeep my project rules.\n');
  const again = install(['--owner', 'other', target]);
  assert.equal(again.status, 0, text(again));
  assert.equal(fs.readFileSync(gate, 'utf8'), '# customised\nsrc/build/*\n');
  assert.equal(fs.readFileSync(skill, 'utf8'), '# Customised workflow\nKeep my project rules.\n');
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @someone\n');
  assert.match(again.stdout, /Left unchanged[^\n]*\n(\s+.*\n)*\s+scripts\/gate-files\.txt/);
  assert.match(again.stdout, /Left unchanged[^\n]*\n(\s+.*\n)*\s+\.claude\/skills\/parallel-agent-workflow\/SKILL\.md/);
  assert.match(again.stdout, /Left unchanged[^\n]*\n(\s+.*\n)*\s+\.github\/CODEOWNERS/);
  const forced = install(['--owner', 'other', '--force', target]);
  assert.equal(forced.status, 0, text(forced));
  assert.ok(fs.readFileSync(gate).equals(fs.readFileSync(path.join(root, 'scripts/gate-files.txt'))));
  assert.ok(fs.readFileSync(skill).equals(fs.readFileSync(path.join(root, '.claude/skills/parallel-agent-workflow/SKILL.md'))));
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @other\n');
});

test('an existing AGENTS.md is kept and reported without --force and replaced with it', () => {
  const target = freshRepo('existing-agents');
  const agents = path.join(target, 'AGENTS.md');
  const existing = Buffer.from('# Project rules\r\nKeep these instructions.\r\n');
  fs.writeFileSync(agents, existing);
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.ok(fs.readFileSync(agents).equals(existing), 'existing AGENTS.md must stay byte-identical');
  assert.match(r.stdout, /Left unchanged[^\n]*\n(?:[ \t]+[^\n]*\n)*?[ \t]+AGENTS\.md/);
  assert.match(r.stdout, /Notes:\n(?:[ \t]+[^\n]*\n)*?[ \t]+[^\n]*AGENTS\.md already exists/);
  assert.match(r.stdout, /rules[^\n]*not added/i);
  assert.match(r.stdout, /merge[^\n]*(by hand|manually)/i);
  assert.ok(r.stdout.includes(path.join(root, 'AGENTS.md')) || /kit[^\n]*AGENTS\.md/i.test(r.stdout), 'note must point to the kit AGENTS.md');
  const forced = install(['--owner', 'someone', '--force', target]);
  assert.equal(forced.status, 0, text(forced));
  assert.ok(fs.readFileSync(agents).equals(fs.readFileSync(path.join(root, 'AGENTS.md'))));
  assert.doesNotMatch(forced.stdout, /AGENTS\.md already exists/);
});

for (const file of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) {
  test(`an existing ${file} without an import gets a note and stays byte-identical even with --force`, () => {
    const target = freshRepo(`claude-no-import-${file.replace(/\W+/g, '-')}`);
    const claude = path.join(target, file);
    const existing = Buffer.from('# Local instructions\r\nKeep my project rules.\r\n');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, existing);
    for (const flags of [[], ['--force']]) {
      const r = install(['--owner', 'someone', ...flags, target]);
      assert.equal(r.status, 0, text(r));
      assert.ok(fs.readFileSync(claude).equals(existing), `${file} must stay byte-identical`);
      const want = file.startsWith('.claude/') ? '@../AGENTS.md' : '@AGENTS.md';
      assert.match(r.stdout, /Notes:\n(?:[ \t]+[^\n]*\n)*?[ \t]+[^\n]*add a line @/);
      assert.ok(r.stdout.includes(`add a line ${want} to ${file}`), `note must ask for ${want} in ${file}`);
      assert.match(r.stdout, /Claude Code reads/);
      assert.match(r.stdout, /instead of AGENTS\.md/);
      assert.ok(r.stdout.includes(file), 'note must name the Claude instructions file');
    }
  });
}

for (const [label, line] of [
  ['plain', '@AGENTS.md'],
  ['whitespace', ' \t@AGENTS.md\t '],
  ['relative', ' \t@./AGENTS.md\t '],
]) {
  test(`a ${label} standalone AGENTS.md import in CLAUDE.md suppresses the import note`, () => {
    const target = freshRepo(`claude-import-${label}`);
    const claude = path.join(target, 'CLAUDE.md');
    const existing = Buffer.from(`# Project instructions\n${line}\nMore instructions.\n`);
    fs.writeFileSync(claude, existing);
    const r = install(['--owner', 'someone', target]);
    assert.equal(r.status, 0, text(r));
    assert.doesNotMatch(r.stdout, /add a line @/);
    assert.ok(fs.readFileSync(claude).equals(existing));
  });
}

test('an import in one Claude instructions file suppresses the note for the others', () => {
  const target = freshRepo('claude-import-one-of-many');
  const files = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
  const contents = ['# Root instructions\n', '# Nested instructions\n', '@./AGENTS.md\n'];
  for (const [i, file] of files.entries()) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.writeFileSync(path.join(target, file), contents[i]);
  }
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.doesNotMatch(r.stdout, /add a line @/);
  for (const [i, file] of files.entries()) assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), contents[i]);
});

test('no Claude instructions files means no import note', () => {
  const target = freshRepo('claude-absent');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.doesNotMatch(r.stdout, /add a line @/);
  for (const file of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) {
    assert.ok(!fs.existsSync(path.join(target, file)), `${file} must not be created`);
  }
});

// Claude Code imports "@path" resolved from the importing file's directory
// (https://code.claude.com/docs/en/memory#import-additional-files). The installer only accepts an
// import on a line of its own outside fenced blocks, so anything else gets the (harmless) note.
for (const [label, file, body, noted] of [
  ['a ../ import from .claude/CLAUDE.md', '.claude/CLAUDE.md', '@../AGENTS.md\n', false],
  ['a CRLF import line', 'CLAUDE.md', '# Rules\r\n@AGENTS.md\r\n', false],
  ['an import after a closed fence', 'CLAUDE.md', '```sh\nls\n```\n@AGENTS.md\n', false],
  ['an import inside a sentence (conservative)', 'CLAUDE.md', 'see @AGENTS.md for rules\n', true],
  ['a mention inside a code span', 'CLAUDE.md', 'example `use @AGENTS.md here`\n', true],
  ['a mention inside a fenced block', 'CLAUDE.md', '```\n@AGENTS.md\n```\n', true],
  ['a ~~~ line inside a backtick fence', 'CLAUDE.md', '```\n~~~\n@AGENTS.md\n```\n', true],
  ['a shorter fence inside a four-backtick fence', 'CLAUDE.md', '````\n```\n@AGENTS.md\n````\n', true],
  ['@AGENTS.md in .claude/CLAUDE.md, which resolves to .claude/AGENTS.md', '.claude/CLAUDE.md', '@AGENTS.md\n', true],
  ['a lookalike name', 'CLAUDE.md', '@AGENTSXmd\n', true],
]) {
  test(`Claude import detection: ${label} ${noted ? 'still gets' : 'suppresses'} the note`, () => {
    const target = freshRepo(`claude-detect-${label.replace(/\W+/g, '-')}`);
    const claude = path.join(target, file);
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, body);
    const r = install(['--owner', 'someone', target]);
    assert.equal(r.status, 0, text(r));
    (noted ? assert.match : assert.doesNotMatch)(r.stdout, /add a line @/);
    assert.equal(fs.readFileSync(claude, 'utf8'), body);
  });
}

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

test('Codex hooks merge once, preserve other hooks and leave trust/config files untouched', () => {
  const target = freshRepo('codex-settings');
  fs.mkdirSync(path.join(target, '.codex'));
  const config = '# Owner configuration\n[hooks]\n# Inline hooks need separate review\n';
  fs.writeFileSync(path.join(target, '.codex/config.toml'), config);
  const existing = { description: 'keep', hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'keep-me' }] }] } };
  const hooks = path.join(target, '.codex/hooks.json');
  fs.writeFileSync(hooks, JSON.stringify(existing), { mode: 0o600 });
  for (let n = 0; n < 2; n++) {
    const r = install(['--owner', 'someone', target]);
    assert.equal(r.status, 0, text(r));
    const merged = JSON.parse(fs.readFileSync(hooks, 'utf8'));
    assert.equal(merged.description, 'keep');
    assert.deepEqual(merged.hooks.PreToolUse[0], existing.hooks.PreToolUse[0]);
    assert.equal(merged.hooks.PreToolUse.length, 2);
    assert.deepEqual(merged.hooks.PreToolUse[1], JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0]);
    assert.equal(fs.statSync(hooks).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(target, '.codex/config.toml'), 'utf8'), config);
    assert.match(r.stdout, /Codex.*not activated/);
    assert.match(r.stdout, /\/hooks/);
    assert.match(r.stdout, /inline/);
  }
});

for (const [label, content] of [
  ['malformed', '{broken'], ['wrong-event-shape', '{"hooks":{"PreToolUse":{}}}'],
  ['null-root', 'null'], ['array-root', '[]'],
  ['invalid-matcher', '{"hooks":{"PreToolUse":[{"matcher":false,"hooks":[]}]}}'],
  ['missing-command', '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command"}]}]}}'],
  ['unknown-handler', '{"hooks":{"PreToolUse":[{"hooks":[{"type":"future-handler"}]}]}}'],
  ['duplicate-windows-alias', JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'printf harmless', commandWindows: null, command_windows: null }] }] } })],
  ['async-guard', JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node agent-guard.mjs', async: true }] }] } })],
  ['wrong-matcher', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node agent-guard.mjs' }] }] } })],
  ['post-only', JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node agent-guard.mjs' }] }] } })],
]) {
  test(`Codex ${label} configuration is refused unchanged even with force`, () => {
    const target = freshRepo(`codex-${label}`);
    fs.mkdirSync(path.join(target, '.codex'));
    const hooks = path.join(target, '.codex/hooks.json');
    fs.writeFileSync(hooks, content);
    for (const flags of [[], ['--force']]) {
      const r = install([...flags, target]);
      assert.equal(r.status, 2, text(r));
      assert.equal(fs.readFileSync(hooks, 'utf8'), content);
      assert.match(r.stdout, /Refused \(never touched\):[\s\S]*\.codex\/hooks\.json/);
    }
  });
}

for (const [field, value] of [
  ['async', 'false'], ['async', null], ['timeout', 'ten'], ['timeout', -1], ['timeout', 1.5],
  ['timeout', Number.MAX_SAFE_INTEGER + 1], ['commandWindows', 3], ['command_windows', false],
  ['statusMessage', []], ['additionalContextLimit', 'many'], ['additionalContextLimit', -1],
]) {
  test(`Codex native field ${field}=${JSON.stringify(value)} is refused without rewriting`, () => {
    const target = freshRepo(`codex-field-${field}-${JSON.stringify(value).replace(/\W/g, '_')}`);
    fs.mkdirSync(path.join(target, '.codex'));
    const hooks = path.join(target, '.codex/hooks.json');
    const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [
      { type: 'command', command: 'printf harmless', [field]: value },
    ] }] } });
    fs.writeFileSync(hooks, original);
    for (const flags of [[], ['--force']]) {
      const r = install([...flags, '--no-hooks-path', target]);
      assert.equal(r.status, 2, text(r));
      assert.equal(fs.readFileSync(hooks, 'utf8'), original);
      assert.match(r.stdout, /Refused \(never touched\):[\s\S]*\.codex\/hooks\.json/);
    }
  });
}

test('Codex native optional fields and nulls survive a valid registration merge', () => {
  const target = freshRepo('codex-valid-optionals');
  fs.mkdirSync(path.join(target, '.codex'));
  const hooks = path.join(target, '.codex/hooks.json');
  const original = { hooks: { PreToolUse: [{ hooks: [
    { type: 'command', command: 'printf harmless', async: false, timeout: 0,
      command_windows: 'echo harmless', statusMessage: null, additionalContextLimit: 0 },
    { type: 'command', command: 'printf other', timeout: null, commandWindows: null,
      statusMessage: 'checking', additionalContextLimit: null },
  ] }] } };
  fs.writeFileSync(hooks, JSON.stringify(original));
  const r = install([target]);
  assert.equal(r.status, 0, text(r));
  assert.deepEqual(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
});

test('Codex symlink destinations are refused without touching their target', () => {
  const target = freshRepo('codex-symlink');
  fs.mkdirSync(path.join(target, '.codex'));
  const outside = path.join(tmp, 'codex-outside.json');
  fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, path.join(target, '.codex/hooks.json'));
  const r = install(['--force', target]);
  assert.equal(r.status, 2, text(r));
  assert.equal(fs.readFileSync(outside, 'utf8'), '{}');
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
  assert.match(r.stdout, /core\.hooksPath is '\.husky' \(repository-level config\) and was left unchanged/);
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

test('a read-only .github directory makes CODEOWNERS a refusal; later steps still run and the exit is 2', () => {
  const target = freshRepo('readonly-github');
  fs.mkdirSync(path.join(target, '.github'));
  fs.chmodSync(path.join(target, '.github'), 0o555);
  try {
    const r = install(['--owner', 'someone', '--no-tests', target]);
    assert.equal(r.status, 2, text(r));
    assert.match(r.stdout, /\.github\/CODEOWNERS \(directory not writable\)/);
    assert.ok(fs.existsSync(path.join(target, '.claude/settings.json')), 'settings step still ran');
    assert.equal(git(target, 'config', '--local', 'core.hooksPath'), '.githooks');
    assert.match(r.stdout, /Next steps/);
  } finally { fs.chmodSync(path.join(target, '.github'), 0o755); }
});

test('a stale .git/config.lock makes the hooksPath step a note, not an abort', () => {
  const target = freshRepo('config-lock');
  fs.writeFileSync(path.join(target, '.git/config.lock'), '');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /could not set core\.hooksPath: .*lock/);
  assert.match(r.stdout, /4\. Hooks: core\.hooksPath was left as it is/);
});

test('a hooksPath coming through an include or worktree config counts as repository-level and is left alone', () => {
  const inc = freshRepo('include-hooks');
  fs.writeFileSync(path.join(inc, '.git/shared.cfg'), '[core]\n\thooksPath = .husky/_\n');
  fs.appendFileSync(path.join(inc, '.git/config'), '[include]\n\tpath = shared.cfg\n');
  const r1 = install(['--owner', 'someone', inc]);
  assert.equal(r1.status, 0, text(r1));
  assert.match(r1.stdout, /core\.hooksPath is '\.husky\/_' \(repository-level config\) and was left unchanged/);
  assert.equal(git(inc, 'config', 'core.hooksPath'), '.husky/_');

  const wt = freshRepo('worktree-hooks');
  git(wt, 'config', 'extensions.worktreeConfig', 'true');
  git(wt, 'config', '--worktree', 'core.hooksPath', '.husky');
  const r2 = install(['--owner', 'someone', wt]);
  assert.equal(r2.status, 0, text(r2));
  assert.match(r2.stdout, /core\.hooksPath is '\.husky' \(repository-level config\) and was left unchanged/);
  assert.equal(git(wt, 'config', 'core.hooksPath'), '.husky');
});

test('an uninitialised submodule directory is refused as a destination', () => {
  const upstream = freshRepo('sub-upstream');
  git(upstream, 'add', '-A'); git(upstream, 'commit', '-qm', 'init');
  const parent = freshRepo('sub-parent');
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, '.github');
  git(parent, 'add', '-A'); git(parent, 'commit', '-qm', 'add submodule');
  const clone = path.join(tmp, 'sub-clone');
  git(tmp, 'clone', '-q', parent, clone);
  assert.deepEqual(fs.readdirSync(path.join(clone, '.github')), [], 'submodule is uninitialised');
  const r = install(['--owner', 'someone', clone]);
  assert.equal(r.status, 2, text(r));
  assert.deepEqual(fs.readdirSync(path.join(clone, '.github')), [], 'nothing written into the submodule path');
  assert.match(r.stdout, /\.github\/pull_request_template\.md \(a submodule is in its path\)/);
  assert.match(r.stdout, /\.github\/CODEOWNERS \(a submodule is in its path\)/);
});

test('owner logins are limited to 39 ASCII characters even with hyphens and under a UTF-8 locale', () => {
  const target = freshRepo('owner-rules');
  assert.notEqual(install(['--owner', 'a-'.repeat(38) + 'a', target]).status, 0, '77 characters');
  const r = spawnSync(installer, ['--owner', 'josé', target], { cwd: root, env: { ...env, LC_ALL: 'C.UTF-8' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'non-ASCII letter');
  assert.deepEqual(fs.readdirSync(target).filter((n) => n !== '.git'), ['README.md']);
});

test('hooksPath is not set when .githooks/pre-push could not be installed', () => {
  const target = freshRepo('githooks-is-file');
  fs.writeFileSync(path.join(target, '.githooks'), 'not a dir\n');
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 2, text(r));
  const cfg = spawnSync('git', ['config', '--local', 'core.hooksPath'], { cwd: target, env, encoding: 'utf8' });
  assert.notEqual(cfg.status, 0, 'hooksPath must stay unset');
  assert.match(r.stdout, /core\.hooksPath was not set because \.githooks\/pre-push is not in place/);
});

test('symlinked hooks in .git/hooks are pointed out too', () => {
  const target = freshRepo('symlinked-hook');
  fs.mkdirSync(path.join(target, 'tools'));
  fs.writeFileSync(path.join(target, 'tools/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('../../tools/pre-commit', path.join(target, '.git/hooks/pre-commit'));
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /existing hooks in .*\.git\/hooks are no longer run .*pre-commit/);
});

test('written files get 755 or 644 regardless of umask, and a merged settings file keeps its mode', () => {
  const target = freshRepo('modes');
  fs.mkdirSync(path.join(target, '.claude'));
  fs.writeFileSync(path.join(target, '.claude/settings.json'), '{"env":{"SECRET":"x"}}', { mode: 0o600 });
  const r = spawnSync('bash', ['-c', `umask 077 && ${JSON.stringify(installer)} --owner someone ${JSON.stringify(target)}`], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, text(r));
  const mode = (p) => fs.statSync(path.join(target, p)).mode & 0o777;
  assert.equal(mode('scripts/land.sh'), 0o755);
  assert.equal(mode('CONTRIBUTING.md'), 0o644);
  assert.equal(mode('AGENTS.md'), 0o644);
  assert.equal(mode('.claude/skills/parallel-agent-workflow/SKILL.md'), 0o644);
  assert.equal(mode('.agents/skills/parallel-agent-workflow/SKILL.md'), 0o644);
  assert.equal(mode('.github/CODEOWNERS'), 0o644);
  assert.equal(mode('.claude/settings.json'), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')).env, { SECRET: 'x' });
});

test('a placeholder line among other CODEOWNERS rules is still warned about', () => {
  const target = freshRepo('placeholder-plus');
  fs.mkdirSync(path.join(target, '.github'));
  fs.writeFileSync(path.join(target, '.github/CODEOWNERS'), '* @OWNER\n/docs/ @docs-team\n');
  assert.match(install([target]).stdout, /still holds the placeholder @OWNER/);
  const r = install(['--owner', 'real', target]);
  assert.equal(fs.readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), '* @OWNER\n/docs/ @docs-team\n', 'mixed file is not rewritten');
  assert.match(r.stdout, /still contains the placeholder line/);
});

test('a whitespace-only or BOM-prefixed settings file is handled', () => {
  const ws = freshRepo('ws-settings');
  fs.mkdirSync(path.join(ws, '.claude'));
  fs.writeFileSync(path.join(ws, '.claude/settings.json'), '\n  \n');
  const r1 = install(['--owner', 'someone', ws]);
  assert.equal(r1.status, 0, text(r1));
  assert.ok(fs.readFileSync(path.join(ws, '.claude/settings.json')).equals(fs.readFileSync(path.join(root, '.claude/settings.json'))));
  const bom = freshRepo('bom-settings');
  fs.mkdirSync(path.join(bom, '.claude'));
  fs.writeFileSync(path.join(bom, '.claude/settings.json'), '﻿{"permissions":{"allow":[]}}');
  const r2 = install(['--owner', 'someone', bom]);
  assert.equal(r2.status, 0, text(r2));
  const merged = JSON.parse(fs.readFileSync(path.join(bom, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(merged.permissions, { allow: [] });
  assert.match(merged.hooks.PreToolUse[0].hooks[0].command, /agent-guard/);
});

test('a refused ci.yml is reflected in the next steps', () => {
  const target = freshRepo('ci-refused');
  fs.mkdirSync(path.join(target, '.github/workflows'), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'nowhere.yml'), path.join(target, '.github/workflows/ci.yml'));
  const r = install(['--owner', 'someone', target]);
  assert.equal(r.status, 2, text(r));
  assert.match(r.stdout, /2\. The CI workflow could not be installed/);
  assert.doesNotMatch(r.stdout, /The installed CI workflow runs/);
});

test('GIT_TRACE variables cannot make git write trace files outside the target', () => {
  const target = freshRepo('git-trace');
  const trace = path.join(tmp, 'trace.log');
  const r = spawnSync(installer, ['--owner', 'someone', target], { cwd: root, env: { ...env, GIT_TRACE: trace, GIT_TRACE2_EVENT: `${trace}.2` }, encoding: 'utf8' });
  assert.equal(r.status, 0, text(r));
  assert.ok(!fs.existsSync(trace) && !fs.existsSync(`${trace}.2`), 'no trace files written');
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
  const r = spawnSync('node', ['--test', 'tests/agent-guard.test.mjs', 'tests/pre-push-hook.test.mjs', 'tests/agents-status.test.mjs', 'tests/codex-review.test.mjs', 'tests/codex-hook.test.mjs', 'tests/hermes-agent-guard.test.mjs'],
    { cwd: target, env: nestedEnv, encoding: 'utf8', timeout: 180_000 });
  assert.equal(r.status, 0, text(r));
  assert.match(r.stdout, /fail 0\b/);
  assert.match(r.stdout, /pass [1-9]\d*\b/);
});
