---
"tailwind-token-extractor": minor
---

Add `tokens.refs`: the immediate `var()` target per light/dark mode for raw custom properties defined as `var(--x)`.

Full value resolution flattens `--fg-base: var(--gray-900)` to its literal `oklch(...)`, discarding the symbolic relationship. `tokens.refs` preserves it — e.g. `{ 'fg-base': { light: 'gray-900', dark: 'gray-50' } }` — so consumers (such as docs that map semantic tokens to palette swatches) can derive those mappings instead of hand-maintaining them. Literal values and one-mode-only references carry no ref. A `RefName` key-union type is also emitted.
