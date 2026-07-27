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
function stripQuotes(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

export function parseFrontmatter(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // 先頭 BOM を剥がす
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { hasFrontmatter: false, data: {}, body: t, dupes: [] };
  const data = {};
  const dupes = [];
  const set = (k, v) => {
    if (Object.prototype.hasOwnProperty.call(data, k)) dupes.push(k);
    data[k] = v;
  };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const mm = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1];
    // 値が空 + 次行がインデント = 1段ネストのオブジェクト（metadata: など）
    if (mm[2].trim() === '' && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      const obj = {};
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        const sub = lines[++i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (sub) obj[sub[1]] = stripQuotes(sub[2]);
      }
      set(key, obj);
    } else {
      set(key, stripQuotes(mm[2]));
    }
  }
  return { hasFrontmatter: true, data, body: m[2], dupes };
}

export function looksLikePath(t) {
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][\w+.-]*:\/\//i.test(t)) return false; // URL
  if (t.includes('\\')) return false; // Windows パス（バックスラッシュ）は対象外
  if (/^[a-zA-Z]:/.test(t)) return false; // ドライブレター絶対パス (C:\ X:\ 等・NASを叩かない)
  if (t.startsWith('/')) return false; // 絶対パス / スラッシュコマンド (/newpage 等) は対象外
  if (t.includes('<') || t.includes('>')) return false; // テンプレプレースホルダ (foo_<slug>.md 等)
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
          findings.push({ ln, kind: 'path', msg: `reference \`${t}\` does not exist` });
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
          findings.push({ ln, kind: 'link', msg: `link target \`${target}\` does not exist` });
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
    findings.push({ ln: 1, kind: 'schema', msg: `unknown frontmatter key "${key}"${hint}` });
  }
  const tools = data['allowed-tools'];
  if (tools !== undefined && String(tools).trim() !== '') {
    const items = String(tools).split(',').map((s) => s.trim());
    if (items.some((x) => x === '')) {
      findings.push({ ln: 1, kind: 'allowed-tools', msg: 'allowed-tools has an empty entry (comma-separated list)' });
    }
    for (const it of items) {
      if (it && !/^[A-Za-z0-9_.:()*\- ]+$/.test(it)) {
        findings.push({ ln: 1, kind: 'allowed-tools', msg: `allowed-tools entry "${it}" is malformed` });
      }
    }
  }
  if (dirName && data.name && data.name !== dirName) {
    findings.push({ ln: 1, kind: 'name', msg: `name "${data.name}" does not match its directory "${dirName}"` });
  }
  // metadata が入れ子オブジェクトなら、その中身も検査（深いスキーマ）
  if (data.metadata && typeof data.metadata === 'object') {
    for (const [k, v] of Object.entries(data.metadata)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(k)) {
        findings.push({ ln: 1, kind: 'metadata', msg: `metadata key "${k}" is malformed` });
      }
      if (v === '' || v == null) {
        findings.push({ ln: 1, kind: 'metadata', msg: `metadata.${k} is empty` });
      }
    }
  }
  return findings;
}

/** references/ 配下のファイル群の内部参照を検査（純粋・テスト可能）。 */
export function checkReferenceFiles(refFiles) {
  const out = [];
  for (const rf of refFiles) {
    for (const f of scanRefs(rf.text, rf.exists)) {
      out.push({ file: rf.file, ...f });
    }
  }
  return out;
}

/** スキル単体の検査：frontmatter 妥当性 + スキーマ + 参照整合。 */
export function checkSkill({ hasFrontmatter, data = {}, body = '', exists = () => true, dirName = null, dupes = [] }) {
  const findings = [];
  if (!hasFrontmatter) {
    findings.push({ ln: 1, kind: 'frontmatter', msg: 'missing YAML frontmatter (--- … ---)' });
    return findings;
  }
  for (const k of dupes) {
    findings.push({ ln: 1, kind: 'duplicate-key', msg: `duplicate frontmatter key "${k}"` });
  }
  if (!data.name) {
    findings.push({ ln: 1, kind: 'frontmatter', msg: 'frontmatter is missing name' });
  } else {
    if (!NAME_RE.test(data.name)) {
      findings.push({ ln: 1, kind: 'name', msg: `name "${data.name}" must be lowercase letters, digits, and hyphens only` });
    }
    if (data.name.length > 64) {
      findings.push({ ln: 1, kind: 'name', msg: `name exceeds 64 characters (${data.name.length})` });
    }
  }
  if (!data.description || !data.description.trim()) {
    findings.push({ ln: 1, kind: 'description', msg: 'frontmatter is missing description (the trigger the agent matches on)' });
  } else if (data.description.length > 1024) {
    findings.push({ ln: 1, kind: 'description', msg: `description exceeds 1024 characters (${data.description.length})` });
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
      findings.push({ file: s.file, kind: 'dup-name', msg: `name "${n}" collides with ${byName.get(n)} — they cannot be installed together` });
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
          msg: `description is ${sim.toFixed(2)} similar to ${ni || skills[i].file} — the agent may fire the wrong one`,
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

/** スキルディレクトリ配下 references/ の markdown ファイルを集める。 */
function collectRefMarkdown(skillDir) {
  const out = [];
  const refDir = join(skillDir, 'references');
  if (!existsSync(refDir)) return out;
  const walk = (d, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.md$/i.test(e.name)) out.push(full);
    }
  };
  walk(refDir, 0);
  return out;
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
  console.error(`✗ ${file} — ${findings.length} problem${findings.length === 1 ? '' : 's'}`);
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
    console.log('skills-lint: no SKILL.md found (looked in .claude/skills/ and skills/; pass a path to override) — skipping.');
    return 0;
  }
  const skills = [];
  const results = [];
  let total = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      console.error(`skills-lint: cannot read ${file}`);
      return 2;
    }
    const fm = parseFrontmatter(text);
    const dir = dirname(file);
    const findings = checkSkill({ ...fm, exists: (p) => existsSync(resolve(dir, p)), dirName: basename(dir) });
    skills.push({ file, data: fm.data });

    // references/ 配下の markdown の内部参照（相互リンク・スクリプト参照）を検査
    const refInputs = [];
    for (const rp of collectRefMarkdown(dir)) {
      let rtext;
      try {
        rtext = readFileSync(rp, 'utf8');
      } catch {
        continue;
      }
      const rdir = dirname(rp);
      refInputs.push({ file: rp, text: rtext, exists: (p) => existsSync(resolve(rdir, p)) });
    }
    const refFindings = checkReferenceFiles(refInputs);

    const byFile = new Map();
    for (const rf of refFindings) {
      if (!byFile.has(rf.file)) byFile.set(rf.file, []);
      byFile.get(rf.file).push(rf);
    }
    // 衝突はスキルを全部読み終えるまで確定しないので、ここでは出力せず溜める。
    // 先に ✓ を出してしまうと「OK と言った直後に指摘が続く」表示になる。
    results.push({ file, findings, byFile });
  }

  // スキル間の衝突を、該当ファイルの findings に合流させる
  for (const c of detectCollisions(skills, { threshold, allow })) {
    const r = results.find((x) => x.file === c.file);
    if (r) r.findings.push({ ln: 1, kind: 'collision', msg: c.msg });
    else {
      console.error(`  ${c.file}:1\t${c.msg}`);
      if (inActions) console.log(`::error file=${c.file},line=1::${c.msg.replace(/\r?\n/g, ' ')}`);
      total += 1;
    }
  }

  for (const { file, findings, byFile } of results) {
    if (findings.length === 0 && byFile.size === 0) console.log(`✓ ${file}`);
    total += report(file, findings, inActions);
    for (const [rfile, rfs] of byFile) total += report(rfile, rfs, inActions);
  }
  if (total > 0) {
    console.error(`\nskills-lint: ${total} problem${total === 1 ? '' : 's'}`);
    return 1;
  }
  console.log(`skills-lint: ${files.length} skill${files.length === 1 ? '' : 's'}, all clean`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
