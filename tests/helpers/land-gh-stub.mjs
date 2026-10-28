// Stub `gh` for tests/land.test.mjs. Answers from $LAND_GH_STUB_DIR/fixture.json,
// logs every call to calls.log and every `pr merge` to merge.log.
import fs from 'node:fs';

const dir = process.env.LAND_GH_STUB_DIR;
const fx = JSON.parse(fs.readFileSync(`${dir}/fixture.json`, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(`${dir}/calls.log`, `${args.join(' ')}\n`);

// Successive calls walk through a list; the last entry repeats.
function next(key, list) {
  const file = `${dir}/count-${key}`;
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  return list[Math.min(n, list.length - 1)];
}
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [cmd, sub, path] = args;
if (cmd === 'pr' && sub === 'view') {
  out(next('pr-view', fx.prViews));
} else if (cmd === 'pr' && sub === 'merge') {
  fs.appendFileSync(`${dir}/merge.log`, `${args.join(' ')}\n`);
  process.stdout.write('merged\n');
} else if (cmd === 'api' && /\/contents\/scripts\/land\.sh\?ref=[0-9a-f]{40}$/.test(sub)) {
  if (!fx.landSha) fail('gh: Not Found (HTTP 404)');
  out({ sha: fx.landSha });
} else if (cmd === 'api' && /\/commits\/main$/.test(sub)) {
  out({ sha: next('main', fx.mainShas) });
} else if (cmd === 'api' && /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(sub)) {
  out({ behind_by: fx.behindBy, ahead_by: 1 });
} else if (cmd === 'api' && /\/deployments\/\d+\/statuses$/.test(sub)) {
  out(fx.statuses[sub.match(/deployments\/(\d+)\//)[1]] ?? []);
} else if (cmd === 'api' && /\/deployments\?sha=[0-9a-f]{40}$/.test(sub)) {
  out(fx.deployments);
} else {
  fail(`gh stub: unexpected call: ${args.join(' ')} ${path ?? ''}`);
}
