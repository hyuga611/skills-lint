# AGENTS.md

skills-lint 自身の開発ガイド。

## コマンド

- テスト: `npm run test`
- 検出デモ（意図的に不整合な例）: `npm run poc`

## 構成

- チェッカ本体: `src/check.mjs`
- テスト: `test/check.test.mjs`
- GitHub Action 定義: `action.yml`
- 正しい例（CIが通る）: `examples/good`
- 壊れた例（poc が exit 1）: `examples/bad`
