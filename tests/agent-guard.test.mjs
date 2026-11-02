import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const hook = `${root}.claude/hooks/agent-guard.mjs`;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

let tmp, mainRepo, featRepo, plainDir;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(dir, branch) {
  git(tmp, 'init', '-q', '-b', 'main', dir);
  writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-qm', 'init');
  if (branch !== 'main') git(dir, 'switch', '-qc', branch);
}

function runHook(stdin) {
  return spawnSync('node', [hook], { input: stdin, encoding: 'utf8', env });
}
const run = (command, cwd = featRepo) => runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agent-guard-'));
  mainRepo = path.join(tmp, 'on-main');
  featRepo = path.join(tmp, 'on-feat');
  plainDir = path.join(tmp, 'not-a-repo');
  makeRepo(mainRepo, 'main');
  makeRepo(featRepo, 'feat/x');
  mkdirSync(plainDir);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const mustBlock = [
  'git push origin main',
  'git push origin HEAD:main',
  'git push origin feat/x:main',
  'git push origin refs/heads/main',
  'git push origin feat/x:refs/heads/main',
  'git -C ../x push origin main',
  'git -c push.default=current push origin main',
  '/usr/bin/git push -f origin feat/x',
  'git push -uf origin feat/x',
  'git push origin +feat/x',
  'git push --force origin feat/x',
  'git push --mirror',
  'git push --all origin',
  'git push origin --delete main',
  'git push -d origin main',
  'git push origin :main',
  'bash -c "git push origin main"',
  "sh -c 'git push origin main'",
  "bash -lc 'echo hi; git push origin HEAD:main'",
  'eval "git push origin main"',
  '(cd /tmp && git push origin main)',
  'echo $(git push origin main)',
  'echo `git push origin main`',
  'sudo git push origin main',
  'sudo -u me git push origin main',
  'true && gh pr merge 5 --squash',
  'gh pr view 5 | cat; gh pr merge 5',
  'false || gh pr merge 5',
  'gh pr merge -R o/r 5',
  'gh pr merge --repo o/r 5 --merge --delete-branch',
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh api --method PUT repos/o/r/pulls/5/merge',
  'gh api repos/o/r/git/refs/heads/main -X PATCH -f sha=abc',
  'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc',
  'env A=1 gh pr merge 5',
  'A=1 B=2 gh pr merge 5',
  'scripts/land.sh 5',
  './scripts/land.sh 5',
  'bash scripts/land.sh 5',
  'sh /home/me/repo/scripts/land.sh 5',
  '/home/me/repo/scripts/land.sh 5',
  'codex exec -',
  'echo hi | codex exec -',
  '/opt/tools/codex/bin/codex exec',
  'scripts/codex-review.sh --pr 5',
  'bash scripts/codex-review.sh --pr 5',
  'scripts/codex-smoke.sh --isolation-root /tmp/smoke',
  'bash scripts/codex-smoke.sh --isolation-root /tmp/smoke',
  'git status\ngit push origin main',
  // shell option parsing: -o/-O consume the next word
  "bash -euo pipefail -c 'gh pr merge 5'",
  "bash -o pipefail -c 'gh pr merge 5'",
  "bash -O extglob -c 'gh pr merge 5'",
  "bash +O extglob -c 'gh pr merge 5'",
  "bash --norc -x -c 'gh pr merge 5'",
  "sh -eu -c 'gh pr merge 5'",
  "zsh -o errexit -c 'gh pr merge 5'",
  "dash -e -c 'gh pr merge 5'",
  'bash -euo pipefail scripts/land.sh 5',
  // push destinations resolved by git DWIM, globs and long-option abbreviations
  'git push origin feat/x:heads/main',
  'git push origin HEAD:heads/main',
  'git push origin feat/x:refs/remotes/../heads/main',
  "git push origin 'refs/heads/*:refs/heads/*'",
  "git push origin 'feat/*'",
  'git push --mirro origin',
  'git push --al origin',
  'git push --branc origin',
  'git push --forc origin feat/x',
  'git push --fo origin feat/x',
  'git push --del origin main',
  'git push origin --de main',
  // gh api writes of any kind
  'gh api -X POST repos/o/r/issues -f title=x',
  'gh api --method PATCH repos/o/r -f description=x',
  'gh api --method=DELETE repos/o/r/git/refs/heads/feat',
  'gh api -XPUT repos/o/r/topics',
  'gh api repos/o/r/issues -f title=x',
  'gh api repos/o/r/issues -F title=x',
  'gh api repos/o/r/issues --field title=x',
  'gh api repos/o/r/issues --field=title=x',
  'gh api repos/o/r/issues --raw-field=title=x',
  'gh api repos/o/r/issues --input body.json',
  "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",  // short field flags with attached values imply POST
  'gh api repos/o/r/issues -ftitle=x',
  'gh api repos/o/r/issues -Fkey=val',
  'gh api repos/o/r/git/refs -fref=refs/heads/x -fsha=abc',
  // GraphQL mutations and opaque --input bodies
  "gh api graphql -f query='mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='MUTATION{x}'",
  "gh api graphql -F query=@q.graphql -f note='Mutation'",
  'gh api graphql -F query=@q.graphql',
  'gh api graphql -Fquery=@q.graphql',
  'gh api graphql --input body.json',
  'gh api graphql --input=body.json',
  "gh api -f query='mutation{x}' graphql",
];

const mustAllow = [
  'git push -u origin feat/x',
  'git push --force-with-lease origin feat/x',
  'git push --force-with-lease=feat/x:abc --force-if-includes origin feat/x',
  'git push origin main-docs',
  'git push origin main:feat/x',
  'git push',
  'git pull origin main',
  'git fetch origin main',
  'git diff main...HEAD',
  'git log main',
  'git merge-base origin/main HEAD',
  'gh pr view 5',
  'gh pr list --head feat/x --json number,state',
  'gh pr create --base main --title "Merge-ready docs"',
  'gh api repos/o/r/pulls/5',
  'gh api repos/o/r/git/refs/heads/main',
  'cat scripts/land.sh',
  'less scripts/land.sh',
  'grep -n land.sh README.md',
  "sed -n '1,20p' scripts/land.sh",
  'git diff -- scripts/land.sh',
  'bash -n scripts/land.sh',
  'node --test tests/land.test.mjs',
  'grep -n codex README.md',
  'cat scripts/codex-review.sh',
  'node --test tests/codex-review.test.mjs',
  'scripts/codex-smoke.sh --owner-approved --scenario guard-allow-git-status --isolation-root /tmp/smoke',
  'bash scripts/codex-smoke.sh --owner-approved --scenario guard-block-main-push --isolation-root /tmp/smoke',
  'echo "git push origin main"',
  "git commit -m \"$(cat <<'EOF'\nDocs: don't run scripts/land.sh\ngit push origin main\nEOF\n)\"",
  'npm test 2>&1 | tail -5',
  'git push origin feat/x # comments are ignored: main',
  'git push --force-with origin feat/x',
  'git push --force-if origin feat/x',
  'git push --dry-run origin feat/x',
  'git push origin feat/x:feat/heads-main',
  "bash -euo pipefail -c 'git status'",
  'bash -n -o pipefail scripts/land.sh',
  'gh api repos/o/r/pulls/5/merge',
  'gh api -X GET repos/o/r/issues -f state=open',
  'gh api --method HEAD repos/o/r',
  'gh api graphql --method GET -f query=x',
  "gh api graphql -f query='query { viewer { login } }'",
  "gh api graphql -f query='{ repository(owner: \"o\", name: \"r\") { pullRequest(number: 5) { mergeable } } }'",
  "gh api graphql -f query='{ viewer { mutationsCount: login } }'",
];

for (const command of mustBlock) {
  test(`blocks: ${JSON.stringify(command)}`, () => {
    const r = run(command);
    assert.equal(r.status, 2, `expected block, stderr=${r.stderr}`);
    assert.match(r.stderr, /^agent-guard: .+\n$/, 'one-line reason on stderr');
  });
}

for (const command of mustAllow) {
  test(`allows: ${JSON.stringify(command)}`, () => {
    const r = run(command);
    assert.equal(r.status, 0, `expected allow, stderr=${r.stderr}`);
  });
}

test('known limitation: command words built at run time slip through', () => {
  // `$(echo gh)` is only known after execution; documented in the hook header.
  assert.equal(run('$(echo gh) pr merge 5').status, 0);
});

test('rule 6: commit/merge/rebase/cherry-pick/reset --hard blocked only on main', () => {
  for (const cmd of ['git commit -m x', 'git merge feat/x', 'git rebase feat/x', 'git cherry-pick abc', 'git reset --hard HEAD~1',
    'git revert abc', 'git am patch.mbox', 'git pull', 'git pull --rebase origin main', 'git pull origin main']) {
    const onMain = run(cmd, mainRepo);
    assert.equal(onMain.status, 2, `${cmd} on main: ${onMain.stderr}`);
    assert.match(onMain.stderr, /on main blocked/);
    assert.equal(run(cmd, featRepo).status, 0, `${cmd} on feature branch`);
    assert.equal(run(cmd, plainDir).status, 0, `${cmd} outside a repo`);
  }
  assert.equal(run('git reset --soft HEAD~1', mainRepo).status, 0);
  for (const cmd of ['git merge --abort', 'git revert --abort', 'git am --quit', 'git pull --ff-only', 'git pull --ff-only origin',
    'git pull --ff-only origin main', 'git pull --ff-only upstream main']) {
    assert.equal(run(cmd, mainRepo).status, 0, `${cmd} on main`);
  }
  assert.equal(run('git revert --continue', mainRepo).status, 2, 'only --abort/--quit are exempt');
  for (const cmd of ['git pull --ff-only origin my-feature', 'git pull --ff-only origin main feat/x', 'git pull --ff-only origin feat/x:main']) {
    assert.equal(run(cmd, mainRepo).status, 2, `${cmd} on main`);
    assert.equal(run(cmd, featRepo).status, 0, `${cmd} on feature branch`);
  }
});

test('rule 6: effective directory follows git -C and cd', () => {
  assert.equal(run(`git -C ${mainRepo} commit -m x`, featRepo).status, 2);
  assert.equal(run(`git -C ${featRepo} commit -m x`, mainRepo).status, 0);
  assert.equal(run(`cd ${mainRepo} && git commit -m x`, featRepo).status, 2);
});

test('implicit push destination is checked against the current branch', () => {
  assert.equal(run('git push', mainRepo).status, 2);
  assert.equal(run('git push origin HEAD', mainRepo).status, 2);
  assert.equal(run('git push origin HEAD', featRepo).status, 0);
});

test('non-JSON, empty, commandless and non-Bash input exit 0', () => {
  assert.equal(runHook('not json at all').status, 0);
  assert.equal(runHook('').status, 0);
  assert.equal(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: {} })).status, 0);
  assert.equal(runHook(JSON.stringify({ tool_name: 'Read', tool_input: { command: 'git push origin main' } })).status, 0);
});

test('missing cwd falls back to process cwd and still evaluates', () => {
  const r = runHook(JSON.stringify({ tool_input: { command: 'gh pr merge 5' } }));
  assert.equal(r.status, 2);
});
