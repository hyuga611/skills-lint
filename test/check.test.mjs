import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  checkSkill,
  detectCollisions,
  scanRefs,
  jaccard,
  bigrams,
  parseArgs,
  checkSchema,
} from '../src/check.mjs';

// ---- frontmatter ----

test('frontmatter を name/description に分解', () => {
  const fm = parseFrontmatter('---\nname: my-skill\ndescription: "Use this when X"\n---\n本文');
  assert.equal(fm.hasFrontmatter, true);
  assert.equal(fm.data.name, 'my-skill');
  assert.equal(fm.data.description, 'Use this when X');
  assert.equal(fm.body.trim(), '本文');
});

test('frontmatter が無ければ hasFrontmatter=false', () => {
  const fm = parseFrontmatter('# ただの markdown');
  assert.equal(fm.hasFrontmatter, false);
});

// ---- 単体チェック ----

test('frontmatter 無しを検出', () => {
  const f = checkSkill(parseFrontmatter('# no frontmatter'));
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'frontmatter');
});

test('name 欠落を検出', () => {
  const f = checkSkill({ ...parseFrontmatter('---\ndescription: x\n---\n'), exists: () => true });
  assert.ok(f.some((x) => x.kind === 'frontmatter' && /name/.test(x.msg)));
});

test('name の形式違反を検出（大文字/アンダースコア）', () => {
  const f = checkSkill({ ...parseFrontmatter('---\nname: My_Skill\ndescription: x\n---\n'), exists: () => true });
  assert.ok(f.some((x) => x.kind === 'name'));
});

test('description 欠落を検出', () => {
  const f = checkSkill({ ...parseFrontmatter('---\nname: ok-skill\n---\n'), exists: () => true });
  assert.ok(f.some((x) => x.kind === 'description'));
});

test('本文の壊れた参照を検出（scripts/ 参照整合）', () => {
  const fm = parseFrontmatter('---\nname: ok-skill\ndescription: 使うとき\n---\n実行: `scripts/run.py`');
  const f = checkSkill({ ...fm, exists: (p) => p !== 'scripts/run.py' });
  assert.equal(f.filter((x) => x.kind === 'path').length, 1);
});

test('整合が取れていれば0件', () => {
  const fm = parseFrontmatter('---\nname: ok-skill\ndescription: 使うとき\n---\n参照 `references/a.md` と [b](assets/b.png)');
  const f = checkSkill({ ...fm, exists: () => true });
  assert.equal(f.length, 0);
});

// ---- 参照整合（reflint と同じエンジン）----

test('markdown リンク先の欠落を検出', () => {
  const f = scanRefs('- [doc](references/guide.md)', (p) => p !== 'references/guide.md');
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'link');
});

test('外部URL・アンカーは無視', () => {
  const f = scanRefs('[a](https://x.example/y) [b](#top)', () => false);
  assert.equal(f.length, 0);
});

// ---- 衝突検出 ----

test('name 重複を検出（インストール衝突）', () => {
  const f = detectCollisions([
    { file: 'a/SKILL.md', data: { name: 'dup', description: 'aaaa' } },
    { file: 'b/SKILL.md', data: { name: 'dup', description: 'bbbb' } },
  ]);
  assert.ok(f.some((x) => x.kind === 'dup-name'));
});

test('description が近すぎるトリガ衝突を検出', () => {
  const desc = 'PDFファイルを読み取って要約するときに使う。pdf 抽出 テキスト 変換 に対応。';
  const f = detectCollisions([
    { file: 'a/SKILL.md', data: { name: 'pdf-a', description: desc } },
    { file: 'b/SKILL.md', data: { name: 'pdf-b', description: desc + '（ほぼ同じ）' } },
  ]);
  assert.ok(f.some((x) => x.kind === 'trigger-overlap'));
});

test('別物の description は衝突しない（誤検出しない）', () => {
  const f = detectCollisions([
    { file: 'a/SKILL.md', data: { name: 'pdf', description: 'PDFを読み取って要約する' } },
    { file: 'b/SKILL.md', data: { name: 'xlsx', description: 'Excelの表を作成・集計する' } },
  ]);
  assert.equal(f.filter((x) => x.kind === 'trigger-overlap').length, 0);
});

test('jaccard/bigrams の基本性質', () => {
  assert.equal(jaccard(bigrams('abcd'), bigrams('abcd')), 1);
  assert.equal(jaccard(bigrams('abcd'), bigrams('wxyz')), 0);
});

// ---- しきい値・許可リスト（設定オプション）----

const nearPair = [
  { file: 'a/SKILL.md', data: { name: 'pdf-a', description: 'PDFを読み取って要約する。抽出とテキスト化に対応。' } },
  { file: 'b/SKILL.md', data: { name: 'pdf-b', description: 'PDFを読み取って要約する。抽出とテキスト化に少し対応。' } },
];

test('threshold を上げると衝突判定が緩む', () => {
  assert.ok(detectCollisions(nearPair, { threshold: 0.5 }).some((x) => x.kind === 'trigger-overlap'));
  assert.equal(detectCollisions(nearPair, { threshold: 0.99 }).filter((x) => x.kind === 'trigger-overlap').length, 0);
});

test('後方互換：第2引数に数値(threshold)を渡せる', () => {
  assert.equal(detectCollisions(nearPair, 0.99).filter((x) => x.kind === 'trigger-overlap').length, 0);
});

test('allow に入れたスキルは衝突対象から除外', () => {
  const allow = new Set(['pdf-a']);
  assert.equal(detectCollisions(nearPair, { threshold: 0.3, allow }).filter((x) => x.kind === 'trigger-overlap').length, 0);
});

test('parseArgs: --threshold / --allow を分離しパスを残す', () => {
  const { paths, threshold, allow } = parseArgs(['.claude/skills', '--threshold', '0.8', '--allow', 'x,y']);
  assert.deepEqual(paths, ['.claude/skills']);
  assert.equal(threshold, 0.8);
  assert.ok(allow.has('x') && allow.has('y'));
});

// ---- frontmatter スキーマ検査 ----

test('未知キーのタイポを提案（allowed_tools → allowed-tools）', () => {
  const f = checkSchema({ name: 'ok', description: 'x', allowed_tools: 'Read' });
  const hit = f.find((x) => x.kind === 'schema');
  assert.ok(hit);
  assert.match(hit.msg, /allowed-tools/);
});

test('正しいキーだけなら schema 指摘なし', () => {
  const f = checkSchema({ name: 'ok', description: 'x', 'allowed-tools': 'Read, Write, Bash(git:*)' });
  assert.equal(f.filter((x) => x.kind === 'schema' || x.kind === 'allowed-tools').length, 0);
});

test('allowed-tools の空要素を検出', () => {
  const f = checkSchema({ name: 'ok', description: 'x', 'allowed-tools': 'Read,,Write' });
  assert.ok(f.some((x) => x.kind === 'allowed-tools'));
});

test('name とディレクトリ名の不一致を検出', () => {
  const f = checkSchema({ name: 'pdf-reader', description: 'x' }, 'pdf_reader');
  assert.ok(f.some((x) => x.kind === 'name'));
});

test('name とディレクトリ名が一致すれば指摘なし', () => {
  const f = checkSchema({ name: 'pdf-reader', description: 'x' }, 'pdf-reader');
  assert.equal(f.length, 0);
});

test('checkSkill 経由でスキーマ指摘が出る', () => {
  const fm = parseFrontmatter('---\nname: ok\ndescription: 使う\ndescrption: typo\n---\n');
  const f = checkSkill({ ...fm, exists: () => true, dirName: 'ok' });
  assert.ok(f.some((x) => x.kind === 'schema' && /description/.test(x.msg)));
});
