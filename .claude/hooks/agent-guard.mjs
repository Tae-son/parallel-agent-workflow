#!/usr/bin/env node
// agent-guard.mjs: Claude Code PreToolUse hook for the Bash tool.
//
// GUARDRAIL, NOT A SECURITY BOUNDARY. It stops accidental and ordinary attempts by
// parallel agents to push to main, force-push, merge pull requests, write through
// `gh api`, run the owner-only scripts/land.sh, run the codex CLI or
// scripts/codex-review.sh, or commit/merge/rebase/cherry-pick/revert/am/pull
// (without --ff-only)/reset --hard while on main. Hooks still run in
// bypass-permissions mode, which is why this is a hook and not a deny rule.
// A determined process can evade it. Known gaps: command words built at run time
// (`$(echo gh) pr merge 5`, `$CMD push`), git/gh aliases, scripts written to disk
// and then run, commands piped into a bare `bash`, `find -exec`, other languages'
// subprocess APIs, raw curl to the GitHub API, and branch switches earlier in the
// same command (`git switch main && git commit`), and push destinations hidden by
// abbreviated value options (`--rep`) or remote push refspec config. The git pre-push hook
// (.githooks/pre-push) is a second layer for main pushes.
//
// Protocol: JSON on stdin {tool_name, tool_input: {command}, cwd}. To block, print
// one line to stderr and exit 2. Otherwise exit 0. Unparseable input or no
// command exits 0 so unrelated tools keep working.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const OWNER_MERGE = 'merging is owner-only; leave the PR open and ask the owner to run scripts/land.sh <PR#> in their own terminal';
const PUSH_MAIN = 'pushing to main is owner-only; push your feature branch (git push -u origin <branch>) and open a PR';
const FORCE = 'force-push blocked; push a new commit instead, or use --force-with-lease on your own feature branch';
const CODEX = 'the codex CLI / scripts/codex-review.sh is owner-run; ask the owner to run the review';

// ---- Tokenizer: splits a shell string into simple commands (arrays of words). ----
// Separators: ; & && | || newline ( ). Quotes are removed; $(...) and backticks are
// scanned recursively and their commands appended to `out`. Heredoc bodies,
// comments and redirection targets are dropped.
function scan(src, i, closer, out) {
  let words = [], word = '', inWord = false, skipNext = false, depth = 0;
  const heredocs = [];
  const endWord = () => {
    if (inWord) { if (skipNext) skipNext = false; else words.push(word); }
    word = ''; inWord = false;
  };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; skipNext = false; };
  const substitution = (start, open, close) => {
    const end = scan(src, start + open, close, out);
    word += src.slice(start, end + 1); inWord = true;
    return end;
  };
  const dquote = (j) => {
    for (; j < src.length; j++) {
      const d = src[j];
      if (d === '"') return j;
      if (d === '\\' && '"\\$`\n'.includes(src[j + 1] ?? 'x')) word += src[++j];
      else if (d === '$' && src[j + 1] === '(') j = substitution(j, 2, ')');
      else if (d === '`') j = substitution(j, 1, '`');
      else word += d;
    }
    return j;
  };
  const heredocStart = (j) => { // j points just after "<<"
    const strip = src[j] === '-'; if (strip) j++;
    while (src[j] === ' ' || src[j] === '\t') j++;
    let delim = '';
    for (; j < src.length && !/[\s;&|<>()]/.test(src[j]); j++) if (!`'"\\`.includes(src[j])) delim += src[j];
    heredocs.push({ delim, strip });
    return j - 1;
  };
  const skipHeredocs = (j) => { // j points at a newline; skip pending heredoc bodies
    for (const { delim, strip } of heredocs.splice(0)) {
      while (j < src.length) {
        const nl = src.indexOf('\n', j + 1), end = nl < 0 ? src.length : nl;
        let line = src.slice(j + 1, end); if (strip) line = line.replace(/^\t+/, '');
        j = end;
        if (line === delim) break;
      }
    }
    return j;
  };

  for (; i < src.length; i++) {
    const c = src[i];
    if (closer && c === closer && depth === 0) { endCmd(); return i; }
    if (c === '\\') { if (src[i + 1] !== '\n') { word += src[i + 1] ?? ''; inWord = true; } i++; }
    else if (c === "'") { const j = src.indexOf("'", i + 1), e = j < 0 ? src.length : j; word += src.slice(i + 1, e); i = e; inWord = true; }
    else if (c === '"') { inWord = true; i = dquote(i + 1); }
    else if (c === '$' && src[i + 1] === '(') i = substitution(i, 2, ')');
    else if (c === '`') i = substitution(i, 1, '`');
    else if (c === '#' && !inWord) { while (i + 1 < src.length && src[i + 1] !== '\n') i++; }
    else if (c === '\n') { endCmd(); i = skipHeredocs(i); }
    else if (c === ' ' || c === '\t') endWord();
    else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') { endWord(); i = heredocStart(i + 2); }
    else if (c === '<' || c === '>') {
      if (/^\d*$/.test(word)) { word = ''; inWord = false; } else endWord(); // drop fd numbers like 2>
      while ('<>&|'.includes(src[i + 1] ?? 'x')) i++;
      skipNext = true; // drop the redirection target
    }
    else if (c === '(') { endCmd(); depth++; }
    else if (c === ')') { endCmd(); if (depth) depth--; }
    else if (c === ';' || c === '&' || c === '|') endCmd();
    else { word += c; inWord = true; }
  }
  endCmd();
  return src.length;
}

// ---- Command analysis ----
const base = (w) => w.split('/').pop();
const resolveDir = (from, dir) => path.resolve(from, dir.replace(/^~(?=$|\/)/, homedir()));
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const WRAPPER_ARGS = { // wrappers we look through, with their options that take a value
  sudo: ['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D'], doas: ['-u', '-C'], env: ['-u', '-C', '-S', '--unset', '--chdir'],
  nice: ['-n'], timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a'],
  npx: ['-p', '--package'], command: [], exec: [], nohup: [], time: [], builtin: [],
  if: [], then: [], else: [], elif: [], do: [], while: [], until: [], '!': [], '{': [],
};

function unwrap(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i], b = base(w);
    if (/^[A-Za-z_]\w*=/.test(w)) { i++; continue; } // VAR=value prefix
    if (!Object.hasOwn(WRAPPER_ARGS, b)) break;
    for (i++; i < words.length && words[i].startsWith('-'); i++) if (WRAPPER_ARGS[b].includes(words[i])) i++;
    if (b === 'timeout' && i < words.length) i++; // duration
  }
  return words.slice(i);
}

function check(command, ctx) {
  const cmds = [];
  scan(command, 0, null, cmds);
  for (const words of cmds) {
    const reason = checkSimple(unwrap(words), ctx);
    if (reason) return reason;
  }
  return null;
}

function checkSimple(words, ctx) {
  if (!words.length) return null;
  const [cmd, ...args] = words, b = base(cmd);
  if (b === 'cd') { ctx.cwd = resolveDir(ctx.cwd, args.find((a) => !a.startsWith('-')) ?? homedir()); return null; }
  const script = scriptReason(cmd);
  if (script) return script;
  if (SHELLS.has(b)) return checkShell(args, ctx);
  if (b === 'source' || b === '.') return args[0] ? scriptReason(args[0]) : null;
  if (b === 'eval') return check(args.join(' '), ctx);
  if (b === 'git') return checkGit(args, ctx);
  if (b === 'gh') return checkGh(args);
  return null;
}

function scriptReason(p) {
  const b = base(p);
  if (b === 'land.sh') return `running land.sh blocked: ${OWNER_MERGE}`;
  if (b === 'codex' || b === 'codex-review.sh') return CODEX;
  return null;
}

function checkShell(args, ctx) {
  let commandMode = false, syntaxOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--rcfile' || a === '--init-file') { i++; continue; }
    if (/^[-+][A-Za-z]+$/.test(a)) { // flag group such as -euo pipefail, +O extglob, -lc
      if (a[0] === '-') { commandMode ||= a.includes('c'); syntaxOnly ||= a.includes('n'); }
      i += (a.match(/[oO]/g) ?? []).length; // each o/O consumes the next word as an option name
      continue;
    }
    if (a === '--noexec') { syntaxOnly = true; continue; }
    if (a !== '--' && /^[-+]/.test(a)) continue; // --norc, --login, ...
    if (a === '--') { if (++i >= args.length) return null; }
    if (syntaxOnly) return null;
    return commandMode ? check(args[i], ctx) : scriptReason(args[i]);
  }
  return null;
}

function currentBranch(dir) {
  const r = spawnSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkGit(args, ctx) {
  let dir = ctx.cwd, i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-C') dir = resolveDir(dir, args[++i] ?? '.');
    else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(a)) i++;
    else if (!a.startsWith('-')) break;
  }
  const sub = args[i], rest = args.slice(i + 1);
  if (sub === 'push') return checkPush(rest, dir);
  const onMainOnly = (['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(sub) && !rest.some((a) => a === '--abort' || a === '--quit'))
    || (sub === 'pull' && !pullIsFastForwardOfMain(rest))
    || (sub === 'reset' && rest.includes('--hard'));
  if (onMainOnly && currentBranch(dir) === 'main') {
    return `git ${sub}${sub === 'reset' ? ' --hard' : ''} on main blocked (${dir}); create or switch to a feature branch or worktree first`;
  }
  return null;
}

// On main, only `git pull --ff-only [<remote> [main]]` is allowed.
function pullIsFastForwardOfMain(rest) {
  const positional = rest.filter((a) => !a.startsWith('-'));
  return rest.includes('--ff-only') && (positional.length <= 1 || (positional.length === 2 && positional[1] === 'main'));
}

function checkPush(rest, dir) {
  const VALUE_OPTS = ['-o', '--push-option', '--repo', '--receive-pack', '--exec'];
  let del = false;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { positional.push(...rest.slice(i + 1)); break; }
    if (VALUE_OPTS.includes(a)) { i++; continue; }
    // git accepts unique long-option prefixes (--mirro, --al, --forc), so match prefixes.
    // --force-with-lease / --force-if-includes (and their prefixes) are not prefixes of "force".
    const long = a.startsWith('--') ? a.slice(2).split('=')[0] : '';
    const abbrev = (full) => long.length >= 2 && full.startsWith(long);
    if (abbrev('force')) return FORCE;
    if (['mirror', 'all', 'branches'].some(abbrev)) return `git push ${a} blocked; push only your own feature branch explicitly (git push -u origin <branch>)`;
    if (abbrev('delete')) { del = true; continue; }
    if (/^-[A-Za-z]+$/.test(a)) { if (a.includes('f')) return FORCE; if (a.includes('d')) del = true; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const refspecs = positional.slice(1); // first positional is the remote
  for (const r of refspecs) {
    if (r.startsWith('+')) return FORCE;
    if (r.includes('*')) return `glob refspec push blocked (${r}); push one named feature branch`;
    const dst = del ? r : r.slice(r.indexOf(':') + 1); // no colon: destination = source
    if (dst === 'main' || dst === 'heads/main' || dst.endsWith('/heads/main')) return PUSH_MAIN; // git DWIM
  }
  // Implicit destination (no refspec, HEAD or @) is the current branch.
  const implicit = refspecs.length === 0 || refspecs.some((r) => r === 'HEAD' || r === '@');
  if (!del && implicit && currentBranch(dir) === 'main') return PUSH_MAIN;
  return null;
}

function checkGh(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (['-R', '--repo', '--hostname', '-X', '--method'].includes(args[i])) i++;
    else if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  if (positional[0] === 'pr' && positional[1] === 'merge') return `gh pr merge blocked: ${OWNER_MERGE}`;
  if (positional[0] !== 'api') return null;
  if (args.some((a) => /mergePullRequest|enablePullRequestAutoMerge/.test(a))) return `gh api merge call blocked: ${OWNER_MERGE}`;
  // Endpoint = first positional after `api`, skipping the values of options that take one.
  const VALUE = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q', '--jq',
    '-t', '--template', '-p', '--preview', '--cache', '--hostname', '-R', '--repo'];
  let endpoint = null;
  for (let i = args.indexOf('api') + 1; i < args.length && endpoint === null; i++) {
    if (VALUE.includes(args[i])) i++;
    else if (!args[i].startsWith('-')) endpoint = args[i];
  }
  if (endpoint === 'graphql') { // queries are POST by nature; mutations and --input are not allowed
    const opaque = args.some((a) => /^--input(=|$)/.test(a) || /=@/.test(a)); // body or field read from a file
    if (opaque || args.some((a) => /\bmutation\b/i.test(a))) return 'GraphQL mutations are owner-only; use read-only queries or ask the owner';
    return null;
  }
  let method = null, hasFields = false;
  args.forEach((a, i) => {
    if (a === '-X' || a === '--method') method = args[i + 1];
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (a.startsWith('--method=')) method = a.slice(9);
    if (/^-[fF]/.test(a) || /^--(field|raw-field|input)(=|$)/.test(a)) hasFields = true; // -f, -ftitle=x, -Fk=v
  });
  // Fields make gh default to POST; only an explicit GET/HEAD keeps the call read-only.
  const verb = (method ?? (hasFields ? 'POST' : 'GET')).toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return `gh api writes are owner-only (${verb}); use read-only GET calls or ask the owner`;
  return null;
}

// ---- Entry point ----
let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const command = input?.tool_input?.command;
if ((input?.tool_name && input.tool_name !== 'Bash') || typeof command !== 'string' || !command.trim()) process.exit(0);

let reason;
try {
  reason = check(command, { cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd() });
} catch (err) {
  reason = `agent-guard could not evaluate this command (${err.message}); split it into simpler commands`;
}
if (reason) {
  process.stderr.write(`agent-guard: ${reason}\n`);
  process.exit(2);
}
process.exit(0);
