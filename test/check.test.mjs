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
  checkReferenceFiles,
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

// ---- references/ 相互リンク検査 ----

test('references/ の壊れた内部参照を検出', () => {
  const refFiles = [
    { file: 'skill/references/a.md', text: '関連 [b](b.md) と `../scripts/x.py`', exists: (p) => p === 'b.md' },
  ];
  const f = checkReferenceFiles(refFiles);
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'skill/references/a.md');
  assert.match(f[0].msg, /x\.py/);
});

test('references/ の内部参照がすべて解決すれば0件', () => {
  const f = checkReferenceFiles([{ file: 'r/a.md', text: '[b](b.md)', exists: () => true }]);
  assert.equal(f.length, 0);
});

// ---- metadata 入れ子スキーマ・重複キー ----

test('parseFrontmatter: metadata の入れ子オブジェクトを解釈', () => {
  const fm = parseFrontmatter('---\nname: s\ndescription: d\nmetadata:\n  type: user\n  node: memory\n---\n本文');
  assert.equal(typeof fm.data.metadata, 'object');
  assert.equal(fm.data.metadata.type, 'user');
  assert.equal(fm.data.metadata.node, 'memory');
});

test('parseFrontmatter: 重複キーを dupes に記録', () => {
  const fm = parseFrontmatter('---\nname: a\nname: b\ndescription: d\n---\n');
  assert.ok(fm.dupes.includes('name'));
});

test('checkSchema: metadata の空値・不正キーを検出', () => {
  const f = checkSchema({ name: 'ok', description: 'x', metadata: { good: 'v', empty: '' } });
  assert.ok(f.some((x) => x.kind === 'metadata'));
});

test('checkSkill: 重複キーを検出', () => {
  const fm = parseFrontmatter('---\nname: ok\nname: dup\ndescription: d\n---\n');
  const f = checkSkill({ ...fm, exists: () => true, dirName: 'ok' });
  assert.ok(f.some((x) => x.kind === 'duplicate-key'));
});

test('Windows/NAS 絶対パスは参照検査の対象外（実スキルで判明したNAS stallの修正）', () => {
  const winPath = String.raw`X:\01\a.md`;
  const f = scanRefs('参照 `' + winPath + '` と `C:/x/b.md`', () => false);
  assert.equal(f.length, 0);
});

test('スラッシュコマンド/プレースホルダは参照検査の対象外（実スキルで判明したFP）', () => {
  const f = scanRefs('`/newpage` と `brief_<slug>.md`', () => false);
  assert.equal(f.length, 0);
});

// --- 実データ監査（公開リポジトリ 120スキル・2026-07）由来 ---

test('複数行の description でリンタが落ちない（実データでクラッシュした形）', () => {
  const text = [
    '---', 'name: web-access',
    'description:',
    '  所有联网操作必须通过此 skill 处理，包括：搜索、网页抓取、登录后操作。',
    '  触发场景：用户要求搜索信息、查看网页内容。',
    'metadata:', '  author: eze', '---', '# body',
  ].join('\n');
  const fm = parseFrontmatter(text);
  assert.equal(typeof fm.data.description, 'string');
  assert.ok(fm.data.description.includes('所有联网操作'));
  assert.equal(fm.data.metadata.author, 'eze');
  const f = checkSkill({ hasFrontmatter: true, data: fm.data, body: fm.body, exists: () => true, dirName: 'web-access' });
  assert.equal(f.some((x) => x.kind === 'description'), false);
});

test('`>` / `|` のブロックスカラーも文字列として読む', () => {
  const y = (marker) => parseFrontmatter(`---\nname: x\ndescription: ${marker}\n  一行目\n  二行目\n---\nbody`);
  assert.equal(typeof y('>').data.description, 'string');
  assert.ok(y('|').data.description.includes('一行目'));
});

test('description が構造になっていたら、落ちずに指摘する', () => {
  const f = checkSkill({ hasFrontmatter: true, data: { name: 'x', description: { a: 1 } }, body: '', exists: () => true, dirName: 'x' });
  assert.ok(f.some((x) => x.kind === 'description' && /not a nested structure/.test(x.msg)));
});

test('実行時に決まるパス・穴埋めを参照扱いしない', () => {
  const cases = [
    '`${CLAUDE_SKILL_DIR}/config.env`',
    '`SKILL_DIR/references/token-validation.md`',
    '`references/[風格名].md`',
    '`references/design-systems/{name}.md`',
    '`~/.openclaw/agents/main/sessions`',
    '`anthropic/claude-3.5-sonnet`',
    '`r.jina.ai/example.com`',
    '`.md`',
    '`logs/observer.log`',
  ];
  for (const c of cases) assert.deepEqual(scanRefs(c, () => false), [], c);
});

test('スキルが作るファイルは同梱物として要求しない', () => {
  assert.deepEqual(scanRefs('Write the result to `FULL-AUDIT-REPORT.md`.', () => false), []);
  assert.deepEqual(scanRefs('結果を `SEO-REPORT.html` に出力する', () => false), []);
  // 「読め」と書いてあるものは従来どおり同梱物として検査する
  assert.equal(scanRefs('See `references/guide.md` for details.', () => false).length, 1);
});

// 「作ると書いてあるファイルは同梱されていなくて当然」の除外は、PRODUCES を行単位で
// 当てて決めている。ところが `Never generate ...` の "generat" も PRODUCES に当たるので、
// **禁止文が「このスキルが作る成果物」の宣言として読まれていた。**
//
// 結果は誤検知ではなく逆で、そのファイルへの本物の参照が文書中のどこにあっても黙る。
// 出なかった警告は見えないので、誤検知より質が悪い。
// carrylint 0.4.1 と同じ形（禁止を書いた人が損をする）だが、向きが逆に出た例。
test('禁止文は「作る」の宣言ではない——本物の壊れた参照を黙らせない', () => {
  const body = 'Never generate `scripts/missing.py`.\nWhen asked to deploy, execute `scripts/missing.py`.';
  const f = scanRefs(body, () => false);
  assert.equal(f.length, 1, '実行しろと書いてある行は報告されること');
  assert.equal(f[0].ln, 2, '報告するのは禁止文の行ではなく実行を指示している行');
});

test('禁止文そのものは報告しない（消えたファイルを「使うな」と書くのは正しい）', () => {
  const f = scanRefs('Never execute `scripts/legacy-deploy.py`; it was removed after the migration.', () => false);
  assert.deepEqual(f, [], '禁止を明記した人が警告されないこと');
});

test('本当に作ると書いてある成果物は、これまでどおり後から読み返せる', () => {
  const body = 'Write the results to `failures.json`.\nLater, read `failures.json` back.';
  assert.deepEqual(scanRefs(body, () => false), [], '生成物の読み返しは除外されたまま');
});

// description は「いつ発火するか」を書く欄で、トリガの衝突判定はその発火面を比べている。
// ところが「〜には使うな」という否定節も同じ袋に入っていたため、**互いを明示的に
// 除外し合っている2つのスキルほど似て見えた**（排他を書くと 1.00 になる）。
// 否定節はアンチトリガなので、発火面ではない。
test('互いを明示的に除外し合う description は衝突ではない', () => {
  const skills = [
    { file: 'production-deploy/SKILL.md', data: { name: 'production-deploy', description: 'Use for production deployment requests. Never use for staging deployment requests.' } },
    { file: 'staging-deploy/SKILL.md', data: { name: 'staging-deploy', description: 'Use for staging deployment requests. Never use for production deployment requests.' } },
  ];
  const f = detectCollisions(skills);
  assert.deepEqual(f, [], '排他を明記した人が衝突として報告されないこと');
});

test('否定節を外しても、本当に近いトリガは従来どおり衝突する', () => {
  const skills = [
    { file: 'a/SKILL.md', data: { name: 'a', description: 'Use when the user asks to extract text from PDF files.' } },
    { file: 'b/SKILL.md', data: { name: 'b', description: 'Use when the user asks to extract text from PDF files quickly.' } },
  ];
  assert.equal(detectCollisions(skills).length, 1, '近すぎる description は引き続き検出されること');
});
