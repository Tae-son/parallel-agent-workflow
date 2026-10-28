import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const hook = `${root}.githooks/pre-push`;
const localSha = '1111111111111111111111111111111111111111';
const remoteSha = '2222222222222222222222222222222222222222';

function runHook(input, env = {}) {
  return spawnSync(hook, ['origin', 'https://github.com/example-org/example-repo.git'], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('pre-push hook allows a feature-branch destination', () => {
  const result = runHook(`refs/heads/chore/vercel-readiness ${localSha} refs/heads/chore/vercel-readiness ${remoteSha}\n`);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('pre-push hook blocks any source ref mapped to main', () => {
  const result = runHook(`refs/heads/other-ref ${localSha} refs/heads/main ${remoteSha}\n`);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /push to refs\/heads\/main blocked/i);
});

test('pre-push hook has an explicit emergency override', () => {
  const result = runHook(
    `refs/heads/other-ref ${localSha} refs/heads/main ${remoteSha}\n`,
    { ALLOW_MAIN_PUSH: '1' },
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /emergency override/i);
});
