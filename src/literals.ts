import postcss, { type Rule } from "postcss";
import type { TokenValue } from "./types.ts";

/**
 * Custom-property maps built from the compiled CSS, split BY SELECTOR CLASS.
 *
 * This split is load-bearing: the compiled output can be ordered
 * `[:root (light), .dark, consumer :root override]`, so a position-only
 * "last declaration wins" parse would let a consumer's light override leak
 * into the dark map. We collect light and dark separately and apply
 * last-wins only WITHIN each class.
 */
export type DerefMaps = {
  /** Union of all `:root`/`:host`-family declarations. */
  light: Map<string, string>;
  /** `light` overlaid with `.dark`-family declarations. */
  dark: Map<string, string>;
  /** Names that were explicitly overridden under the dark selector. */
  darkOverridden: Set<string>;
};

function selectorParts(rule: Rule): string[] {
  return rule.selector.split(",").map((s) => s.trim());
}

function isLightSelector(part: string): boolean {
  // :root, :host, :where(:root), :root:where(...), html (Tailwind preflight)
  return /(^|[\s,])(:root|:host)\b/.test(part) || /^:where\(\s*:root\s*\)/.test(part);
}

function makeDarkMatcher(darkSelector: string): (part: string) => boolean {
  // Default '.dark' -> matches `.dark` and `:where(.dark, .dark *)` forms.
  const className = darkSelector.replace(/^\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s,(])\\.${className}\\b`);
  return (part) => re.test(part);
}

/**
 * Build the light/dark dereference maps from `compile().build([])` output.
 */
export function buildDerefMaps(compiledCss: string, darkSelector = ".dark"): DerefMaps {
  const light = new Map<string, string>();
  const darkOnly = new Map<string, string>();
  const isDark = makeDarkMatcher(darkSelector);

  const root = postcss.parse(compiledCss);
  root.walkRules((rule) => {
    const parts = selectorParts(rule);
    const dark = parts.some(isDark);
    const lightish = parts.some(isLightSelector);
    if (!dark && !lightish) return;

    rule.each((node) => {
      if (node.type !== "decl") return;
      if (!node.prop.startsWith("--")) return;
      // Within a class, declaration order is source order → last wins.
      if (dark) darkOnly.set(node.prop, node.value);
      else light.set(node.prop, node.value);
    });
  });

  const dark = new Map(light);
  for (const [k, v] of darkOnly) dark.set(k, v);

  return { light, dark, darkOverridden: new Set(darkOnly.keys()) };
}

const VAR_RE = /var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/;

export type ResolveResult = {
  value: string;
  resolved: boolean;
};

/**
 * Resolve every `var(--x[, fallback])` in `input` against `map`, following
 * chains until they bottom out in literals. Self-referential or missing
 * variables (e.g. a host-injected `--font-x: var(--font-x)`) are left verbatim
 * and flagged `resolved: false` — this function never throws or loops forever.
 */
export function resolveValue(input: string, map: Map<string, string>): ResolveResult {
  let resolved = true;
  const expand = (value: string, seen: ReadonlySet<string>, depth: number): string => {
    if (depth > 64) {
      resolved = false;
      return value;
    }
    return value.replace(VAR_RE, (match, name: string, fallback?: string) => {
      if (seen.has(name)) {
        // Cycle: prefer the fallback, otherwise keep the raw var() and flag it.
        if (fallback != null) return expand(fallback, seen, depth + 1);
        resolved = false;
        return match;
      }
      if (map.has(name)) {
        const next = new Set(seen).add(name);
        return expand(map.get(name) as string, next, depth + 1);
      }
      if (fallback != null) return expand(fallback, seen, depth + 1);
      resolved = false;
      return match;
    });
  };

  const out = expand(input, new Set(), 0).trim();
  return { value: out, resolved: resolved && !out.includes("var(") };
}

const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
const SAFE_CALC_RE = /^[\d\s.+\-*/()]+$/;

/** Coerce a purely-numeric string to a number; otherwise return it unchanged. */
export function coerceNumeric(value: string): TokenValue {
  return NUMERIC_RE.test(value.trim()) ? Number(value) : value;
}

/**
 * Evaluate a `calc(...)` that contains only numbers and arithmetic, e.g.
 * `calc(1.5 / 1)` -> 1.5. Returns null for anything with units or unknown
 * functions (we keep the raw expression in that case).
 */
export function evalCalcNumber(value: string): number | null {
  const inner = value.trim().replace(/^calc\(([\s\S]*)\)$/, "$1");
  if (inner === value.trim()) return NUMERIC_RE.test(inner) ? Number(inner) : null;
  if (!SAFE_CALC_RE.test(inner)) return null;
  try {
    const n = Function(`"use strict"; return (${inner});`)() as unknown;
    return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
  } catch {
    return null;
  }
}
