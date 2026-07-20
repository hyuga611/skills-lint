#!/usr/bin/env node
// skills-lint — Anthropic Agent Skills (SKILL.md) の参照整合 + トリガ衝突を CI で落とす。
//
//   ・参照整合: SKILL.md 本文が指す scripts/ references/ assets/ などのパス/リンクが実在するか
//   ・衝突検出: スキル間で name 重複、description（発火トリガ）が近すぎて取り違える組み合わせ
//
// 依存ゼロ・言語非依存（description の類似は文字バイグラムで日本語もOK）。
// CI(GitHub Action)で毎PR走らせ、問題があれば exit 1 で PR を落とすのが本体。
//
//   node src/check.mjs [path ...]   # path = SKILL.md か、SKILL.md を含むディレクトリ
//   省略時は .claude/skills/ か skills/ を探索、無ければカレントを走査。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const CODE_EXT =
  /\.(m?[jt]sx?|json|ya?ml|toml|md|txt|sh|py|rb|go|rs|php|html?|css|lock|env|cfg|ini|xml|svg|png|jpe?g|gif|webp|pdf|csv)$/i;

/** SKILL.md 冒頭の YAML frontmatter を最小パース（zero-dep・単一行 key: value のみ）。 */
export function parseFrontmatter(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // 先頭 BOM を剥がす
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { hasFrontmatter: false, data: {}, body: t };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    data[mm[1]] = v;
  }
  return { hasFrontmatter: true, data, body: m[2] };
}

export function looksLikePath(t) {
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][\w+.-]*:\/\//i.test(t)) return false; // URL
  if (t.includes('*')) return false; // glob
  if (t.startsWith('#') || t.startsWith('@')) return false;
  return (t.includes('/') && !t.endsWith('/')) || CODE_EXT.test(t);
}

/** 本文中のバッククォートパス + markdown リンク先が、スキルディレクトリ内に実在するか。 */
export function scanRefs(text, exists = () => true) {
  const findings = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      const ln = i + 1;
      // 1) バッククォート `path`
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const t = m[1].trim();
        if (!looksLikePath(t)) continue;
        if (!exists(t.replace(/^\.\//, ''))) {
          findings.push({ ln, kind: 'path', msg: `参照 \`${t}\` が存在しません` });
        }
      }
      // 2) markdown リンク [text](target)
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        let target = m[1].trim().replace(/\s+["'][^"']*["']\s*$/, '').trim();
        if (!target || target.startsWith('#') || target.startsWith('/')) continue;
        if (/^[a-z][\w+.-]*:/i.test(target)) continue; // http: mailto: 等
        if (!looksLikePath(target)) continue;
        const rel = target.replace(/[#?].*$/, '').replace(/^\.\//, '');
        if (rel && !exists(rel)) {
          findings.push({ ln, kind: 'link', msg: `リンク先 \`${target}\` が存在しません` });
        }
      }
    });
  return findings;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** レーベンシュタイン距離（タイポ提案用）。 */
export function lev(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// Anthropic Agent Skills の frontmatter で認識するキー。
export const KNOWN_KEYS = new Set(['name', 'description', 'allowed-tools', 'license', 'metadata', 'version']);

/** frontmatter スキーマ検査：未知キー(タイポ)・allowed-tools 形式・name とディレクトリ名の一致。 */
export function checkSchema(data = {}, dirName = null) {
  const findings = [];
  for (const key of Object.keys(data)) {
    if (KNOWN_KEYS.has(key)) continue;
    const near = [...KNOWN_KEYS].sort((a, b) => lev(a, key) - lev(b, key))[0];
    const hint = near && lev(near, key) <= 2 ? `（"${near}" では？）` : '';
    findings.push({ ln: 1, kind: 'schema', msg: `未知の frontmatter キー "${key}"${hint}` });
  }
  const tools = data['allowed-tools'];
  if (tools !== undefined && String(tools).trim() !== '') {
    const items = String(tools).split(',').map((s) => s.trim());
    if (items.some((x) => x === '')) {
      findings.push({ ln: 1, kind: 'allowed-tools', msg: 'allowed-tools に空の要素があります（カンマ区切り）' });
    }
    for (const it of items) {
      if (it && !/^[A-Za-z0-9_.:()*\- ]+$/.test(it)) {
        findings.push({ ln: 1, kind: 'allowed-tools', msg: `allowed-tools の要素 "${it}" が不正な形式です` });
      }
    }
  }
  if (dirName && data.name && data.name !== dirName) {
    findings.push({ ln: 1, kind: 'name', msg: `name "${data.name}" がスキルのディレクトリ名 "${dirName}" と一致しません` });
  }
  return findings;
}

/** スキル単体の検査：frontmatter 妥当性 + スキーマ + 参照整合。 */
export function checkSkill({ hasFrontmatter, data = {}, body = '', exists = () => true, dirName = null }) {
  const findings = [];
  if (!hasFrontmatter) {
    findings.push({ ln: 1, kind: 'frontmatter', msg: 'YAML frontmatter (--- … ---) がありません' });
    return findings;
  }
  if (!data.name) {
    findings.push({ ln: 1, kind: 'frontmatter', msg: 'frontmatter に name がありません' });
  } else {
    if (!NAME_RE.test(data.name)) {
      findings.push({ ln: 1, kind: 'name', msg: `name "${data.name}" は小文字・数字・ハイフンのみにしてください` });
    }
    if (data.name.length > 64) {
      findings.push({ ln: 1, kind: 'name', msg: `name が64文字を超えています (${data.name.length})` });
    }
  }
  if (!data.description || !data.description.trim()) {
    findings.push({ ln: 1, kind: 'description', msg: 'frontmatter に description（発火トリガ）がありません' });
  } else if (data.description.length > 1024) {
    findings.push({ ln: 1, kind: 'description', msg: `description が1024文字を超えています (${data.description.length})` });
  }
  findings.push(...checkSchema(data, dirName));
  findings.push(...scanRefs(body, exists));
  return findings;
}

/** 文字バイグラム集合（空白除去・言語非依存＝日本語のトリガ文にも効く）。 */
export function bigrams(s) {
  s = String(s || '').toLowerCase().replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// 誤検出ゼロ優先で高めのしきい値。近すぎる description = 同じ入力で取り違える。
export const TRIGGER_THRESHOLD = 0.7;

/**
 * スキル間の衝突：name 重複（確実） + description 近似（トリガ取り違え）。
 * opts: { threshold=0.7, allow=Set<name> }。後方互換で数値を threshold として受ける。
 */
export function detectCollisions(skills, opts = {}) {
  if (typeof opts === 'number') opts = { threshold: opts };
  const threshold = opts.threshold ?? TRIGGER_THRESHOLD;
  const allow = opts.allow ?? new Set();
  const findings = [];
  const byName = new Map();
  for (const s of skills) {
    const n = s.data && s.data.name;
    if (!n) continue;
    if (byName.has(n)) {
      findings.push({ file: s.file, kind: 'dup-name', msg: `name "${n}" が ${byName.get(n)} と重複しています（インストール衝突）` });
    } else {
      byName.set(n, s.file);
    }
  }
  const grams = skills.map((s) => bigrams(s.data && s.data.description));
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const ni = skills[i].data && skills[i].data.name;
      const nj = skills[j].data && skills[j].data.name;
      if (allow.has(ni) || allow.has(nj)) continue; // 許可リストのスキルは衝突対象外
      const sim = jaccard(grams[i], grams[j]);
      if (sim >= threshold) {
        findings.push({
          file: skills[j].file,
          kind: 'trigger-overlap',
          msg: `description が ${ni || skills[i].file} と高類似 (${sim.toFixed(2)}) — 同じ入力で取り違える恐れ`,
        });
      }
    }
  }
  return findings;
}

// ---------------- CLI ----------------

/** paths（ファイル/ディレクトリ）から SKILL.md を集める。 */
export function findSkillFiles(paths) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const r = p.replace(/\\/g, '/');
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  };
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.name === 'SKILL.md') {
        add(join(dir, e.name));
      }
    }
  };
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, 0);
    else add(p);
  }
  return out;
}

function defaultTargets() {
  const cands = ['.claude/skills', 'skills'].filter((d) => existsSync(d));
  return cands.length ? cands : ['.'];
}

/** argv から --threshold / --allow を取り出し、残りをパスとして返す。 */
export function parseArgs(argv) {
  const paths = [];
  const allow = new Set();
  let threshold = process.env.SKILLS_LINT_THRESHOLD ? parseFloat(process.env.SKILLS_LINT_THRESHOLD) : undefined;
  const addAllow = (s) => (s || '').split(',').forEach((n) => n.trim() && allow.add(n.trim()));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--threshold') threshold = parseFloat(argv[++i]);
    else if (a.startsWith('--threshold=')) threshold = parseFloat(a.slice(12));
    else if (a === '--allow') addAllow(argv[++i]);
    else if (a.startsWith('--allow=')) addAllow(a.slice(8));
    else paths.push(a);
  }
  if (Number.isNaN(threshold)) threshold = undefined;
  return { paths, threshold, allow };
}

function report(file, findings, inActions) {
  if (findings.length === 0) return 0;
  console.error(`✗ ${file} — ${findings.length} 件`);
  for (const f of findings) {
    const ln = f.ln || 1;
    console.error(`  ${file}:${ln}\t${f.msg}`);
    if (inActions) console.log(`::error file=${file},line=${ln}::${f.msg.replace(/\r?\n/g, ' ')}`);
  }
  return findings.length;
}

export function main(argv) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const { paths, threshold, allow } = parseArgs(argv);
  const files = findSkillFiles(paths.length ? paths : defaultTargets());
  if (files.length === 0) {
    console.log('skills-lint: SKILL.md が見つかりません（.claude/skills/ か skills/、または引数で指定）。スキップ。');
    return 0;
  }
  const skills = [];
  let total = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      console.error(`skills-lint: ${file} を読めません`);
      return 2;
    }
    const fm = parseFrontmatter(text);
    const dir = dirname(file);
    const findings = checkSkill({ ...fm, exists: (p) => existsSync(resolve(dir, p)), dirName: basename(dir) });
    skills.push({ file, data: fm.data });
    if (findings.length === 0) console.log(`✓ ${file}`);
    total += report(file, findings, inActions);
  }
  // スキル間の衝突
  for (const c of detectCollisions(skills, { threshold, allow })) {
    console.error(`  ${c.file}:1\t${c.msg}`);
    if (inActions) console.log(`::error file=${c.file},line=1::${c.msg.replace(/\r?\n/g, ' ')}`);
    total += 1;
  }
  if (total > 0) {
    console.error(`\nskills-lint: ${total} 件`);
    return 1;
  }
  console.log(`skills-lint: ${files.length} 個のスキル、すべてOK`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
