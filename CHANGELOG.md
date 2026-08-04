# Changelog

## 0.7.0

Driven by a real-world audit of the **46 first-party skills bundled in
[openclaw/openclaw](https://github.com/openclaw/openclaw)** (`.agents/skills/**`, commit
`3ac7083`, 2026-08) — 385k stars, the largest agent codebase in public. v0.6.1 reported
**201 errors** on that corpus. Thirteen were genuine. The rest are fixed below.

- **`existsLocal`: telling "is this written as a path" apart from "does it resolve".** Both
  questions were being answered by the same predicate. When the caller resolves references
  repository-wide — as it must for a skill checked into a repo — `openclaw/openclaw` starts
  looking like a path, because *some* directory named `openclaw` exists deep in the tree
  (`apps/android/…/ai/openclaw`). `isSkillPath`, `scanRefs` and `checkSkill` now take an
  optional stricter `existsLocal` for the head-segment test; it defaults to `exists`, so
  existing callers are unaffected. **19 false positives.**
- **A dotted numeric tail is a version, not a file extension.** The guard above `isSkillPath`
  claimed to keep model ids like `anthropic/claude-3.5-sonnet` out of reference checking, and
  did — but `openai/gpt-5.4`, `zai/glm-5.1` and `moonshot/kimi-k2.5` walked straight through
  it, because `.4`, `.1` and `.5` matched the "has an extension" test. `data.tar.gz` and
  `file.7z` are still paths. **6 false positives.**
- **Model identifiers are recognised explicitly.** In a monorepo the provider segment is often
  a real directory (openclaw ships `extensions/openai`, `extensions/anthropic`), so no
  existence heuristic can separate `openai/gpt-4o` from a genuine reference. The same
  vocabulary carrylint uses for its model-id rule is now inlined here (kept dependency-free).
- **Artifacts the document says it writes are excused everywhere, not just on the line that
  says so.** A skill writes `failures.json` in one step and reads it back three paragraphs
  later; only the first mention was excused and the read-back was reported missing. The
  produced set is now collected in a pre-pass over the whole document. **16 false positives —
  the single largest class.**
- **Option syntax and branch templates are not paths.** `openai/gpt-5.4,thinking=xhigh,fast`
  and `source_ref=release/YYYY.M.PATCH` are key/value and option strings; `release/YYYY.M.PATCH`
  and `extended-stable/YYYY.M.33` are branch-name templates. Anything containing `,` or `=`, or
  carrying a `YYYY`/`MM`/`DD`/`PATCH`/`MAJOR`/`MINOR` placeholder segment, is skipped. Bare
  all-caps filenames like `LICENSE` stay checkable. **11 false positives.**
- **An indented frontmatter block no longer loses every key.** Some authors indent the whole
  YAML block by a space or two; it is still one mapping, but the key pattern is anchored at
  column 0, so every key was dropped and the skill was reported as missing *both* name and
  description while both were plainly present. The block's common indent is now removed
  before parsing, which leaves relative indentation — the thing that marks nested objects and
  block scalars — untouched.
- **Frontmatter keys: `compatibility` added, runtime extensions accepted, unknown keys
  downgraded to a warning.** `compatibility` is part of the Agent Skills standard and was
  missing from `KNOWN_KEYS`. Claude Code and OpenClaw ship documented extensions
  (`user-invocable`, `disable-model-invocation`, `when_to_use`, `context`, `hooks`, `model`,
  `argument-hint`) which are now recognised. More importantly the standard requires a
  compliant runtime to *ignore* frontmatter keys it does not recognise — that is what keeps a
  skill portable — so an unrecognised key can no longer fail a build. A key within edit
  distance 2 of a known one is still an **error**, because a typo means the key it was meant
  to be is absent. On a 30-skill ClawHub pilot this alone moved 12 findings out of error.
- **`test/realworld.test.mjs`** pins all of the above to the actual snippets from that audit,
  alongside the genuine dangling references — `../openclaw-docs/SKILL.md` (a sibling skill that
  does not exist), `test/fixtures/test-timings.unit.json`, `scripts/test-parallel-memory.mjs` —
  which must keep being caught.

Net on that corpus, with the matching tenken 0.2.0 change: **201 errors → 43**, every one of the
13 genuine defects still reported.

## 0.6.1

- **Added `main` / `exports` so the package can be imported as a library.** With neither field
  present, `import { checkSkill } from '@hyuga/skills-lint'` did not resolve: the checks were
  reachable only by spawning the CLI, even though `src/check.mjs` had exported `checkSkill`,
  `detectCollisions`, `findSkillFiles`, `scanRefs` and the rest all along. Nothing about the CLI,
  its flags or its output changes.
- **Bare format names in prose are no longer treated as references.** A skill that says "read the
  scripts in `package.json`" or "write `AGENTS.md`" is naming a file in *the user's* repository,
  not one shipped beside the skill — but every such mention was reported as a missing reference,
  so any skill about config files failed. Bare, well-known names (`package.json`, `README.md`,
  `AGENTS.md`, `Dockerfile`, …) are now skipped; a path with a directory in it (`docs/AGENTS.md`)
  is still checked. reflint made the same fix in v0.6.0. Found by linting a skill that documents
  these files for a living.

## 0.6.0

Driven by a real-world audit of **120 public `SKILL.md` files from 120 repositories** (2026-07),
each checked against that repository's actual file tree.

- **Fixed a crash.** `parseFrontmatter` treated any indented block under a key as a nested object,
  so a multi-line `description:` (a normal YAML plain scalar, and common in Chinese/Japanese
  skills) produced an object and `checkSkill` threw `data.description.trim is not a function`.
  One of the 120 audited skills killed the linter outright — in CI that is a stack trace, not a
  lint result. Multi-line scalars and `>` / `|` block scalars are now read as text, and a
  non-string `description` is reported instead of thrown. This also fixed 23 bogus `metadata`
  findings that came from the same misparse.
- **Reference checking no longer flags things that are not skill files.** v0.5.1 reported 517
  missing references across 94 of 119 skills; v0.6.0 reports 202. Excluded, with the audit share
  each accounted for: files the skill *writes at runtime* (34% — `FULL-AUDIT-REPORT.md`,
  `SEO-REPORT.html`), `{placeholder}` / `[穴埋め]` / `${VAR}` / `SKILL_DIR/` paths (18%), model
  identifiers and env-var or home paths (12% — `anthropic/claude-3.5-sonnet`,
  `~/.openclaw/sessions`), bare extensions in prose (4%), host-prefixed URLs, `...` ellipses and
  output directories.
- **Extension-less references are only treated as paths when their first segment exists**, so a
  model id or namespace is not reported as a missing file.
- Regression tests distilled from the audit, including the crashing frontmatter.

## 0.5.1

Ordering fix: cross-skill collisions are merged into each file's findings before printing.

## 0.5.0 / 0.4.1 / 0.4.0

references/ cross-links, nested metadata schema, duplicate keys, and false-positive fixes from
running the linter over 32 real skills.

## 0.3.0

Frontmatter schema checks (unknown keys with typo hints, `allowed-tools` shape, name ↔ directory).

## 0.2.0

Configurable collision threshold and allow-list (`--threshold` / `--allow`).

## 0.1.0

Initial release. Reference integrity, name/description collision detection and frontmatter
validation for Agent Skills. Zero-dependency, GitHub Action with PR annotations.
