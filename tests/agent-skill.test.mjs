import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const skills = [
  '.claude/skills/parallel-agent-workflow/SKILL.md',
  '.agents/skills/parallel-agent-workflow/SKILL.md',
];

test('the Claude and Codex skill copies are byte-identical regular files, not symlinks', () => {
  for (const skill of skills) {
    assert.ok(fs.lstatSync(path.join(root, skill)).isFile(), `${skill} must be a regular file, not a symlink`);
  }
  assert.ok(fs.readFileSync(path.join(root, skills[0])).equals(fs.readFileSync(path.join(root, skills[1]))), 'skill copies differ');
});

for (const skill of skills) {
  test(`${skill} routes through independent QA before owner acceptance`, () => {
    const content = fs.readFileSync(path.join(root, skill), 'utf8');
    assert.match(content, /## 6\. Independent QA/);
    assert.match(content, /separate.*session/);
    assert.match(content, /FAIL.*BLOCKED/);
    assert.match(content, /exact.*commit/);
    assert.match(content, /retest/);
  });

  test(`${skill} begins with frontmatter naming its directory and a non-empty description`, () => {
    const content = fs.readFileSync(path.join(root, skill), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    assert.ok(frontmatter, `${skill} must begin with YAML frontmatter`);
    assert.match(frontmatter[1], /^name:[ \t]*(?:parallel-agent-workflow|"parallel-agent-workflow"|'parallel-agent-workflow')[ \t]*$/m);
    const description = /^description:[ \t]*([^\r\n]*)(?:\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*))?/m.exec(frontmatter[1]);
    assert.ok(description, `${skill} needs a description field`);
    let value = description[1].trim();
    if (/^[|>][-+]?(?:[ \t]+#.*)?$/.test(value)) {
      value = (description[2] ?? '').trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    } else {
      value = value.replace(/(?:^|[ \t]+)#.*$/, '').trim();
      assert.doesNotMatch(value, /^(?:null|~)$/i, `${skill} description must not be null`);
    }
    assert.ok(value.length > 0, `${skill} description must not be empty`);
  });
}
