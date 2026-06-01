import postcss, { type AtRule, type Container, type Rule } from "postcss";
import valueParser from "postcss-value-parser";
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
  /** `light` overlaid with dark-selector declarations. */
  dark: Map<string, string>;
  /** Names that were explicitly overridden under the dark selector. */
  darkOverridden: Set<string>;
};

function selectorParts(rule: Rule): string[] {
  return rule.selector.split(",").map((s) => s.trim());
}

function isLightSelector(part: string): boolean {
  // :root, :host, :where(:root), :root:where(...)
  return /(^|[\s,])(:root|:host)\b/.test(part) || /^:where\(\s*:root\s*\)/.test(part);
}

const normalizeSelector = (s: string): string => s.replace(/["']/g, "").replace(/\s+/g, "");

/**
 * Build a matcher for the configured dark selector. Supports class selectors
 * (`.dark`, including the `:where(.dark, .dark *)` expansion), attribute
 * selectors (`[data-theme="dark"]`), and compound selectors (`html.dark`).
 */
function makeDarkMatcher(darkSelector: string): (part: string) => boolean {
  const target = normalizeSelector(darkSelector);
  if (target.startsWith(".")) {
    const cls = target.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\w-])\\.${cls}(?![\\w-])`);
    return (part) => re.test(normalizeSelector(part));
  }
  return (part) => normalizeSelector(part).includes(target);
}

/** True when the rule is nested inside a conditional at-rule (@media/@supports/@container). */
function inConditionalContext(rule: Rule): boolean {
  let parent: Container | undefined = rule.parent as Container | undefined;
  while (parent) {
    if (parent.type === "atrule" && /^(media|supports|container)$/i.test((parent as AtRule).name)) {
      return true;
    }
    parent = parent.parent as Container | undefined;
  }
  return false;
}

/**
 * Build the light/dark dereference maps from `compile().build([])` output.
 * Declarations inside conditional at-rules are ignored so context-dependent
 * values never masquerade as unconditional theme values.
 */
export function buildDerefMaps(compiledCss: string, darkSelector = ".dark"): DerefMaps {
  const light = new Map<string, string>();
  const darkOnly = new Map<string, string>();
  const isDark = makeDarkMatcher(darkSelector);

  const root = postcss.parse(compiledCss);
  root.walkRules((rule) => {
    if (inConditionalContext(rule)) return;
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

export type ResolveResult = {
  value: string;
  resolved: boolean;
};

const MAX_DEPTH = 64;

/**
 * Resolve every `var(--x[, fallback])` in `input` against `map`, following
 * chains until they bottom out in literals. Uses a real CSS value AST so it
 * handles multiple sibling `var()`s, nested fallbacks (`var(--x, var(--y, red))`),
 * and `var()` inside other functions (`color-mix(...)`). Self-referential or
 * missing variables are left verbatim and flagged `resolved: false` — this
 * never throws or loops forever.
 */
export function resolveValue(input: string, map: Map<string, string>): ResolveResult {
  let unresolved = false;

  const expandNodes = (
    nodes: valueParser.Node[],
    seen: ReadonlySet<string>,
    depth: number,
  ): string => nodes.map((node) => expandNode(node, seen, depth)).join("");

  const expandNode = (node: valueParser.Node, seen: ReadonlySet<string>, depth: number): string => {
    if (node.type === "function" && node.value === "var") {
      if (depth > MAX_DEPTH) {
        unresolved = true;
        return valueParser.stringify(node);
      }
      const commaIdx = node.nodes.findIndex((n) => n.type === "div" && n.value === ",");
      const nameNodes = commaIdx === -1 ? node.nodes : node.nodes.slice(0, commaIdx);
      const name = nameNodes.find((n) => n.type === "word")?.value;
      // Fallback is everything after the first comma, minus the conventional leading space.
      let fallback = commaIdx === -1 ? [] : node.nodes.slice(commaIdx + 1);
      while (fallback.length > 0 && fallback[0]!.type === "space") fallback = fallback.slice(1);

      if (name && !seen.has(name) && map.has(name)) {
        const next = new Set(seen).add(name);
        return expandNodes(valueParser(map.get(name) as string).nodes, next, depth + 1);
      }
      if (fallback.length > 0) {
        return expandNodes(fallback, seen, depth + 1);
      }
      unresolved = true;
      return valueParser.stringify(node);
    }
    if (node.type === "function") {
      // Preserve other functions (calc, color-mix, …) while resolving vars inside them.
      return `${node.value}(${node.before}${expandNodes(node.nodes, seen, depth)}${node.after})`;
    }
    return valueParser.stringify(node);
  };

  const out = expandNodes(valueParser(input).nodes, new Set(), 0).trim();

  let hasVar = false;
  valueParser(out).walk((n) => {
    if (n.type === "function" && n.value === "var") {
      hasVar = true;
      return false;
    }
    return undefined;
  });

  return { value: out, resolved: !unresolved && !hasVar };
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
  const trimmed = value.trim();
  const inner = trimmed.replace(/^calc\(([\s\S]*)\)$/, "$1");
  if (inner === trimmed) return NUMERIC_RE.test(inner) ? Number(inner) : null;
  if (!SAFE_CALC_RE.test(inner)) return null;
  try {
    const n = Function(`"use strict"; return (${inner});`)() as unknown;
    return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
  } catch {
    return null;
  }
}
