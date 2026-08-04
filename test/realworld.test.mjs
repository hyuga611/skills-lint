// Regression tests distilled from a real-world audit of the 46 first-party skills bundled
// in openclaw/openclaw (.agents/skills/**, commit 3ac7083, 2026-08).
//
// v0.6.1 raised 201 errors on that corpus; 13 were genuine. Every line below is a real
// snippet from that repository.
//
//   mustNotFlag — patterns v0.6.1 wrongly reported; they must stay silent
//   mustFlag    — genuine dangling references that must keep being caught
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRefs, looksLikePath, isSkillPath, checkSchema, parseFrontmatter } from '../src/check.mjs';

// Resolution in a monorepo: `exists` answers "does it resolve anywhere in the repo",
// `existsLocal` answers "is this written as a path here". openclaw has extensions/openai,
// extensions/anthropic and a Java package dir apps/android/.../ai/openclaw, so the loose
// predicate says those heads exist while the strict one does not.
const repo = new Set([
  'extensions/openai/index.ts',
  'extensions/anthropic/index.ts',
  'apps/android/app/src/main/java/ai/openclaw/Main.java',
  'qa/scenarios/index.yaml',
  'scripts/test-hotspots.mjs',
]);
const exists = (p) => [...repo].some((f) => f === p || f.endsWith(`/${p}`) || f.startsWith(`${p}/`));
const existsLocal = (p) => [...repo].some((f) => f === p || f.startsWith(`${p}/`));

const refs = (text) => scanRefs(text, exists, existsLocal).map((f) => f.msg);
const flagged = (text, needle) => refs(text).some((m) => m.includes(needle));

// --- model identifiers are not paths -------------------------------------------------
const modelIds = [
  'openai/gpt-5.4',      // `.4` used to read as a file extension
  'zai/glm-5.1',
  'moonshot/kimi-k2.5',
  'openai/gpt-4o',
  'openai/gpt-5',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-sonnet-4',
  'google/gemini-3.1-pro-preview',
  'openai/gpt-5.4-pro',
];
for (const id of modelIds) {
  test(`mustNotFlag: model id ${id}`, () => {
    assert.ok(!flagged(`Set the default model explicitly to \`${id}\` before the agent turn.`, id));
  });
}

// --- branch / tag templates ----------------------------------------------------------
const templates = ['release/YYYY.M.PATCH', 'extended-stable/YYYY.M.33'];
for (const t of templates) {
  test(`mustNotFlag: branch template ${t}`, () => {
    assert.ok(!flagged(`Use \`${t}\` for the branch name.`, t));
  });
}

// --- option / key=value syntax -------------------------------------------------------
for (const t of ['source_ref=release/YYYY.M.PATCH', 'openai/gpt-5.4,thinking=xhigh,fast']) {
  test(`mustNotFlag: option syntax ${t}`, () => {
    assert.ok(!flagged(`Dispatch with \`${t}\`.`, t));
  });
}

// --- org/repo slugs ------------------------------------------------------------------
// `openclaw` exists only as a deep Java package directory, so it must not make
// `openclaw/openclaw` look like a repo-relative path.
for (const t of ['openclaw/openclaw', 'openclaw/releases', 'openclaw/discrawl']) {
  test(`mustNotFlag: org/repo slug ${t}`, () => {
    assert.ok(!flagged(`Open the PR against \`${t}\`.`, t));
  });
}

// --- artifacts the document says it writes, then reads back later --------------------
test('mustNotFlag: artifact produced earlier and read on a later line', () => {
  const doc = [
    'Write the failing cases to `failures.json` before continuing.',
    '',
    'Then read `failures.json` and summarise the top offenders.',
  ].join('\n');
  assert.ok(!flagged(doc, 'failures.json'));
});

test('mustNotFlag: artifact produced in a later line than it is read', () => {
  const doc = [
    'Inspect `summary.json` for the aggregate score.',
    'The QA lane generates `summary.json` at the end of the run.',
  ].join('\n');
  assert.ok(!flagged(doc, 'summary.json'));
});

// --- genuine dangling references must survive ---------------------------------------
const mustFlag = [
  ['openclaw-test-heap-leaks', 'Refresh `test/fixtures/test-timings.unit.json` after the run.', 'test/fixtures/test-timings.unit.json'],
  ['openclaw-refactor-docs', 'Read `../openclaw-docs/SKILL.md` first.', '../openclaw-docs/SKILL.md'],
  ['openclaw-test-performance', 'See `test/helpers/channels/AGENTS.md` for the lane contract.', 'test/helpers/channels/AGENTS.md'],
  ['openclaw-test-heap-leaks', 'Run `scripts/test-parallel-memory.mjs` to reproduce.', 'scripts/test-parallel-memory.mjs'],
];
for (const [skill, line, ref] of mustFlag) {
  test(`mustFlag: ${skill} → ${ref}`, () => {
    assert.ok(flagged(line, ref), `expected a finding for ${ref}`);
  });
}

// --- the guards themselves ----------------------------------------------------------
test('looksLikePath rejects option syntax and branch templates', () => {
  assert.equal(looksLikePath('openai/gpt-5.4,thinking=xhigh,fast'), false);
  assert.equal(looksLikePath('release/YYYY.M.PATCH'), false);
  assert.equal(looksLikePath('docs/guide.md'), true);
});

test('isSkillPath treats a dotted numeric tail as a version, not an extension', () => {
  assert.equal(isSkillPath('openai/gpt-5.4', () => true), false);
  assert.equal(isSkillPath('data.tar.gz', () => true), true);
  assert.equal(isSkillPath('file.7z', () => true), true);
});

test('isSkillPath uses the strict predicate for the head segment', () => {
  // loose says the head exists (deep dir), strict says it does not
  assert.equal(isSkillPath('openclaw/openclaw', () => true, () => false), false);
  assert.equal(isSkillPath('qa/scenarios', () => true, () => true), true);
});

// --- frontmatter keys, from a 30-skill ClawHub pilot (2026-08) -----------------------
test('compatibility is a standard key and is accepted', () => {
  assert.equal(checkSchema({ name: 'x', description: 'y', compatibility: '>=1' }).length, 0);
});

for (const k of ['user-invocable', 'disable-model-invocation', 'when_to_use', 'model', 'argument-hint']) {
  test(`runtime extension key "${k}" is accepted`, () => {
    assert.equal(checkSchema({ name: 'x', description: 'y', [k]: 'v' }).length, 0);
  });
}

test('an unrecognised key warns rather than fails — the standard says runtimes ignore it', () => {
  // `tags`, `author`, `source` are common in the wild and are not spec keys
  const f = checkSchema({ name: 'x', description: 'y', tags: 'a', author: 'b' });
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.severity === 'warn'), 'unknown keys must not be errors');
});

test('a near-miss of a known key stays an error, because the real key is then missing', () => {
  const f = checkSchema({ name: 'x', descriptoin: 'typo' });
  const typo = f.find((x) => x.msg.includes('descriptoin'));
  assert.ok(typo, 'the typo must be reported');
  assert.equal(typo.severity, 'error');
});

// --- an indented frontmatter block is still one YAML mapping ------------------------
// `audio-play` on ClawHub indents every key by one space. The key pattern is anchored at
// column 0, so all keys were dropped and the skill was reported as missing name AND
// description while both were plainly there.
test('frontmatter indented as a block still yields its keys', () => {
  const fm = parseFrontmatter('---\n name: audio-play\n description: Play audio files.\n---\n\n# Audio Play\n');
  assert.equal(fm.hasFrontmatter, true);
  assert.equal(fm.data.name, 'audio-play');
  assert.equal(fm.data.description, 'Play audio files.');
});

test('dedenting the block does not flatten a nested object', () => {
  const fm = parseFrontmatter('---\n name: x\n description: y\n metadata:\n   a: 1\n---\nbody');
  assert.equal(fm.data.name, 'x');
  assert.deepEqual(fm.data.metadata, { a: '1' });
});

test('dedenting the block does not break a block scalar', () => {
  const fm = parseFrontmatter('---\n name: x\n description: >-\n   long text here\n---\nbody');
  assert.equal(fm.data.description, 'long text here');
});

// --- fenced blocks are examples, not references -------------------------------------
// A skill that shows its own sample output, or a `cp src/a.ts dst/` snippet, was reported
// as pointing at files that do not exist — 10.8% of path/link findings across a
// 2,465-skill ClawHub sample. reflint puts fenced content behind --code-blocks; this
// matches that call so the two engines agree on what counts as a reference.
test('a path inside a fenced block is not a reference', () => {
  const doc = [
    'Sample output:',
    '',
    '```',
    '  [skills-lint] SKILL.md:12 reference `scripts/build-report.py` does not exist',
    '```',
  ].join('\n');
  assert.ok(!flagged(doc, 'scripts/build-report.py'));
});

test('a tilde-fenced block is skipped too', () => {
  const doc = ['~~~bash', 'cp `src/nowhere.ts` dist/', '~~~'].join('\n');
  assert.ok(!flagged(doc, 'src/nowhere.ts'));
});

test('a path outside the fence is still checked', () => {
  const doc = ['```', 'echo hi', '```', '', 'Then read `docs/missing-guide.md`.'].join('\n');
  assert.ok(flagged(doc, 'docs/missing-guide.md'), 'prose references must still be caught');
});
