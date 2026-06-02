# tailwind-token-extractor

Extract **fully-resolved Tailwind CSS v4 design tokens** from a CSS entry point into typed TypeScript.

Tailwind v4 keeps design tokens in CSS (`@theme`), so there is no first-class way to read the resolved token set back in TypeScript — which makes it painful to render token tables in docs, share values with non-Tailwind code, or build a design-system reference. `tailwind-token-extractor` reverses the direction: point it at the CSS your app actually loads, and it gives you the complete token set as a typed `.ts` module.

"Complete" means it follows the **entire `@import` graph** the way Tailwind itself does:

- **Tailwind defaults** — pulled from the actually-installed Tailwind via `@import 'tailwindcss'` (so `container`, `blur`, `ease`, … come through, version-accurate, and `--namespace-*: initial` clears are honored).
- **Imported design systems** — `@import '@your-scope/design-system/styles.css'` is resolved from `node_modules`.
- **Consumer additions** — anything you add in your own `globals.css` wins, per the cascade.
- **Resolved values** — `var()` chains are followed to literal `oklch(...)`/lengths, with separate **light and dark** values.

## How it works

A hybrid of the Tailwind engine and a CSS AST pass — each job handled by the source that actually carries the data:

| Need                                                                                     | Source                                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Authoritative, merged keyspace (never tree-shaken); surviving defaults; `initial` clears | `@tailwindcss/node` `__unstable__loadDesignSystem().theme.entries()`                |
| Literal `oklch`/length values; the raw `:root` var layer; light **and** dark             | `compile().build([])` output, parsed by selector class (`:root`/`:host` vs `.dark`) |
| `@import` graph resolution (incl. `node_modules`)                                        | the Tailwind engine's own resolver                                                  |

`var()` chains are then dereferenced against the light map and the dark map separately. Unresolvable chains (e.g. a host-injected `--font-*: var(--font-*)`) are kept verbatim and reported in `meta.unresolved` rather than crashing.

## Install

```bash
pnpm add -D tailwind-token-extractor
```

`tailwindcss` (>=4.2) and `@tailwindcss/node` are peer dependencies — the tool extracts against the version your project already has installed.

## CLI

```bash
# Write a typed tokens module
tailwind-token-extractor src/app/globals.css -o src/generated/tokens.ts

# Watch the @import graph and regenerate on change
tailwind-token-extractor src/app/globals.css -o src/generated/tokens.ts --watch

# Print to stdout
tailwind-token-extractor src/app/globals.css --stdout

# CI guard: fail (exit 1) if the committed file is stale
tailwind-token-extractor check src/app/globals.css -o src/generated/tokens.ts
```

Options: `--base <dir>` (node_modules resolution root, defaults to the entry's directory), `--dark <selector>` (default `.dark`), `--no-resolve-vars`.

Exit codes: `0` ok · `1` extraction error / drift · `2` incompatible Tailwind internals (prints the detected version).

## Programmatic API

```ts
import { extractTokens, emitTypeScript, generate, watch } from "tailwind-token-extractor";

const tokens = await extractTokens({ entry: "src/app/globals.css" });
const code = emitTypeScript(tokens);

// or in one step
await generate({ entry: "src/app/globals.css", outFile: "src/generated/tokens.ts" });
```

## Generated output

```ts
export const tokens = {
  theme: {
    color: {
      "fg-base": { light: "oklch(0.25 0.0015 235)", dark: "oklch(0.975 0.001 235)" },
      // cleared defaults (e.g. red-500 under `--color-*: initial`) are absent here
    },
    text: {
      md: { value: "1rem", lineHeight: "calc(1.5 / 1)", lineHeightNumber: 1.5 },
    },
    radius: { md: "0.5rem" },
    container: { md: "28rem" }, // surviving Tailwind default
    spacing: "0.25rem",
  },
  vars: {
    // the raw :root/.dark layer the theme references
    "gray-50": "oklch(0.975 0.001 235)",
    "fg-base": { light: "oklch(0.25 0.0015 235)", dark: "oklch(0.975 0.001 235)" },
    "z-overlay": 1000,
  },
  refs: {
    // the symbolic var() target each aliased var points at, per mode
    "fg-base": { light: "gray-900", dark: "gray-50" },
  },
} as const;

export type ColorToken = keyof typeof tokens.theme.color;
export type VarName = keyof typeof tokens.vars;
export type RefName = keyof typeof tokens.refs;
```

- A namespace with a single bare token (`--spacing`) collapses to a scalar.
- A token that changes in dark mode becomes `{ light, dark }`; otherwise it stays a scalar.
- Purely numeric values (`z-index`, unit-less `line-height`) are emitted as `number`.
- `refs` records the immediate `var()` target of each var defined as `var(--x)`,
  per light/dark mode — the symbolic link (`fg-base` → `gray-900`/`gray-50`) that
  the resolved `vars` literals discard. Literals and one-mode-only references are
  omitted; entries are always a `{ light, dark }` mapping.

## Scope (v1)

Out of scope for now: consumer `@utility`/`@custom-variant` declarations (only resolved token values are emitted), generated-utility metadata, and dark modes expressed via `@media (prefers-color-scheme)` or arbitrary variants (the `.dark` class form is supported; `--dark` is configurable).

## License

MIT © k8o
