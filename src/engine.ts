import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Tailwind's `ThemeOptions` bit flags. These live in a `const enum` inside
 * tailwindcss and are NOT importable at runtime, so we mirror the values.
 * The smoke guard ({@link assertEngineShape}) verifies they still hold.
 */
export const THEME_OPTION = {
  INLINE: 1,
  REFERENCE: 2,
  DEFAULT: 4,
  STATIC: 8,
  USED: 16,
} as const;

/** A single `@theme` entry as returned by `designSystem.theme.entries()`. */
export type ThemeEntry = {
  cssVar: string;
  value: string;
  options: number;
};

/** Loosely-typed surface of `@tailwindcss/node` (it ships no public types for these). */
type TailwindNodeModule = {
  __unstable__loadDesignSystem: (
    css: string,
    opts: { base: string },
  ) => Promise<{
    theme: { size: number; entries(): Iterable<[string, { value: string; options: number }]> };
  }>;
  compile: (
    css: string,
    opts: { base: string; onDependency?: (path: string) => void },
  ) => Promise<{ build: (candidates: string[]) => string }>;
};

async function importTailwindNode(): Promise<TailwindNodeModule> {
  try {
    return (await import("@tailwindcss/node")) as unknown as TailwindNodeModule;
  } catch (cause) {
    throw new Error(
      "Cannot load '@tailwindcss/node'. Install tailwindcss (>=4.2.0) in the target project; " +
        "tailwind-token-extractor resolves it as a peer dependency.",
      { cause },
    );
  }
}

/**
 * Tailwind theme namespaces, most-specific first. We match on a `--` token
 * boundary and pick the LONGEST match, so `--text-shadow-*` never collapses
 * into `--text-*`, and `--font-weight-*` never collapses into `--font-*`.
 */
const NAMESPACES: readonly string[] = [
  "color",
  "font-weight",
  "font",
  "text-shadow",
  "text",
  "tracking",
  "leading",
  "breakpoint",
  "container",
  "spacing",
  "radius",
  "inset-shadow",
  "shadow",
  "drop-shadow",
  "blur",
  "perspective",
  "aspect",
  "ease",
  "animate",
  "max-width",
  "max-height",
  "min-width",
  "min-height",
  "default",
];

const SORTED_NAMESPACES = [...NAMESPACES].sort((a, b) => b.length - a.length);

export type Classified = {
  namespace: string;
  /** Key within the namespace, e.g. `md`. Empty string for scalar namespaces (`--spacing`). */
  key: string;
  /** Modifier name when the var uses the `--base--modifier` form, else undefined. */
  modifier?: string;
};

/**
 * Classify a custom-property name into `{ namespace, key, modifier }`.
 *
 * `--color-fg-base`        -> { namespace: 'color', key: 'fg-base' }
 * `--text-md--line-height` -> { namespace: 'text', key: 'md', modifier: 'line-height' }
 * `--spacing`              -> { namespace: 'spacing', key: '' }
 * `--font-weight-medium`   -> { namespace: 'font-weight', key: 'medium' }
 */
export function classify(cssVar: string): Classified | null {
  const name = cssVar.replace(/^--/, "");
  for (const ns of SORTED_NAMESPACES) {
    if (name === ns) return { namespace: ns, key: "" };
    if (name.startsWith(`${ns}-`)) {
      const rest = name.slice(ns.length + 1);
      const [key, modifier] = rest.split("--");
      return { namespace: ns, key: key ?? rest, modifier };
    }
  }
  // Unknown namespace: fall back to the leading segment so nothing is dropped.
  const firstDash = name.indexOf("-");
  if (firstDash === -1) return { namespace: name, key: "" };
  return { namespace: name.slice(0, firstDash), key: name.slice(firstDash + 1) };
}

export type EngineResult = {
  /** Authoritative merged keyspace (never tree-shaken), from `theme.entries()`. */
  entries: ThemeEntry[];
  /** `build([])` output containing the literal `:root`/`.dark` custom-property blocks. */
  compiledCss: string;
  /** Files in the resolved `@import` graph. */
  dependencies: string[];
  tailwindVersion: string | null;
};

function detectTailwindVersion(base: string): string | null {
  try {
    const require = createRequire(join(base, "__resolve__.js"));
    const pkg = require("tailwindcss/package.json") as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Run the Tailwind engine against the CSS entry: load the design system (for the
 * authoritative keyspace) and compile it (for literal `:root`/`.dark` values).
 */
export async function runEngine(entry: string, base?: string): Promise<EngineResult> {
  const resolvedBase = base ?? dirname(entry);
  const css = await readFile(entry, "utf8");
  const tw = await importTailwindNode();

  const ds = await tw.__unstable__loadDesignSystem(css, { base: resolvedBase });
  const entries: ThemeEntry[] = [];
  for (const [cssVar, { value, options }] of ds.theme.entries()) {
    entries.push({ cssVar, value, options });
  }

  const dependencies: string[] = [];
  const compiled = await tw.compile(css, {
    base: resolvedBase,
    onDependency: (path) => dependencies.push(path),
  });
  const compiledCss = compiled.build([]);

  return {
    entries,
    compiledCss,
    dependencies,
    tailwindVersion: detectTailwindVersion(resolvedBase),
  };
}

/**
 * Fail loudly if the engine's output no longer matches the assumptions this
 * tool is built on (a Tailwind internals change). Exits with a clear message
 * rather than emitting silently-wrong tokens.
 */
export function assertEngineShape(result: EngineResult): void {
  const problems: string[] = [];
  if (result.entries.length === 0) {
    problems.push("designSystem.theme.entries() returned nothing");
  }
  const hasInline = result.entries.some((e) => (e.options & THEME_OPTION.INLINE) !== 0);
  const hasDefault = result.entries.some((e) => (e.options & THEME_OPTION.DEFAULT) !== 0);
  if (!hasInline && !hasDefault) {
    problems.push(
      "no entry carries an INLINE or DEFAULT option bit — ThemeOptions flags may have been renumbered",
    );
  }
  if (!/(:root|:host)/.test(result.compiledCss)) {
    problems.push("compiled output has no :root/:host block to read literal values from");
  }
  if (problems.length > 0) {
    const v = result.tailwindVersion ?? "unknown";
    throw new EngineShapeError(
      `tailwind-token-extractor is incompatible with the installed Tailwind (${v}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

export class EngineShapeError extends Error {
  override name = "EngineShapeError";
}
