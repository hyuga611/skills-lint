# Changelog

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
