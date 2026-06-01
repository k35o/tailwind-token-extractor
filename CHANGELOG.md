# tailwind-token-extractor

## 0.1.1

### Patch Changes

- [#3](https://github.com/k35o/tailwind-token-extractor/pull/3) [`f4dccd0`](https://github.com/k35o/tailwind-token-extractor/commit/f4dccd0fe606f4b31109be9d8bda392fb3b9aff3) Thanks [@k35o](https://github.com/k35o)! - Emit `meta.source` as a cwd-relative path instead of an absolute one, so the generated file stays stable across machines and CI (avoids spurious diffs when re-running the extractor).

## 0.1.0

### Minor Changes

- [`6dd41fc`](https://github.com/k35o/tailwind-token-extractor/commit/6dd41fcaadbd8d71c603b13621225e872603f368) Thanks [@k35o](https://github.com/k35o)! - Initial release.

  Extract fully-resolved Tailwind CSS v4 design tokens from a CSS entry point — following the entire `@import` graph (Tailwind defaults + imported design systems + consumer additions), resolving `var()` chains to literal values, and capturing light and dark variants — into typed TypeScript.

  - Programmatic API: `extractTokens`, `emitTypeScript`, `generate`, `watch`, `defineConfig`
  - CLI: `tailwind-token-extractor <entry> -o <out>`, plus `--watch` and a `check` subcommand for CI drift detection
  - Hybrid engine + CSS-AST architecture with smoke guards against incompatible Tailwind internals
