---
"tailwind-token-extractor": minor
---

Initial release.

Extract fully-resolved Tailwind CSS v4 design tokens from a CSS entry point — following the entire `@import` graph (Tailwind defaults + imported design systems + consumer additions), resolving `var()` chains to literal values, and capturing light and dark variants — into typed TypeScript.

- Programmatic API: `extractTokens`, `emitTypeScript`, `generate`, `watch`, `defineConfig`
- CLI: `tailwind-token-extractor <entry> -o <out>`, plus `--watch` and a `check` subcommand for CI drift detection
- Hybrid engine + CSS-AST architecture with smoke guards against incompatible Tailwind internals
