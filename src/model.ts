import { relative, resolve } from "node:path";
import { runEngine, assertEngineShape, classify, THEME_OPTION } from "./engine.ts";
import {
  buildDerefMaps,
  resolveValue,
  coerceNumeric,
  evalCalcNumber,
  immediateVarRef,
} from "./literals.ts";
import type {
  ExtractOptions,
  ExtractedTokens,
  ModifierValue,
  RawVar,
  ThemeToken,
  TokenValue,
} from "./types.ts";

function resolvePair(
  reference: string,
  light: Map<string, string>,
  dark: Map<string, string>,
  enabled: boolean,
): { light: TokenValue; dark: TokenValue; resolved: boolean } {
  if (!enabled) {
    return { light: coerceNumeric(reference), dark: coerceNumeric(reference), resolved: true };
  }
  const l = resolveValue(reference, light);
  const d = resolveValue(reference, dark);
  return {
    light: coerceNumeric(l.value),
    dark: coerceNumeric(d.value),
    resolved: l.resolved && d.resolved,
  };
}

/**
 * Extract the complete, fully-resolved Tailwind v4 token set from a CSS entry
 * point, following its entire `@import` graph (Tailwind defaults + imported
 * design systems + consumer additions).
 */
export async function extractTokens(options: ExtractOptions): Promise<ExtractedTokens> {
  const {
    entry,
    base,
    darkSelector = ".dark",
    resolveVars = true,
    injectVars,
    tailwindVersionCheck = true,
  } = options;

  const engine = await runEngine(entry, base);
  if (tailwindVersionCheck) assertEngineShape(engine);

  const maps = buildDerefMaps(engine.compiledCss, darkSelector);
  if (injectVars) {
    for (const [name, value] of Object.entries(injectVars)) {
      const key = name.startsWith("--") ? name : `--${name}`;
      maps.light.set(key, value);
      maps.dark.set(key, value);
    }
  }

  const themeVarNames = new Set(engine.entries.map((e) => e.cssVar));
  const unresolved: string[] = [];

  // --- @theme tokens -------------------------------------------------------
  // First pass: base tokens. Second pass: attach modifiers (`--x--modifier`).
  const tokenIndex = new Map<string, ThemeToken>();
  const theme: Record<string, ThemeToken[]> = {};
  const pendingModifiers: Array<{
    ns: string;
    key: string;
    modifier: string;
    value: ModifierValue;
  }> = [];

  for (const entryItem of engine.entries) {
    const c = classify(entryItem.cssVar);
    if (!c) continue;
    const pair = resolvePair(entryItem.value, maps.light, maps.dark, resolveVars);

    if (c.modifier) {
      pendingModifiers.push({
        ns: c.namespace,
        key: c.key,
        modifier: c.modifier,
        value: { light: pair.light, dark: pair.dark, resolved: pair.resolved },
      });
      if (!pair.resolved) unresolved.push(`${entryItem.cssVar}`);
      continue;
    }

    const token: ThemeToken = {
      cssVar: entryItem.cssVar,
      namespace: c.namespace,
      key: c.key,
      reference: entryItem.value,
      light: pair.light,
      dark: pair.dark,
      resolved: pair.resolved,
      isDefault: (entryItem.options & THEME_OPTION.DEFAULT) !== 0,
    };
    (theme[c.namespace] ??= []).push(token);
    tokenIndex.set(`${c.namespace}|${c.key}`, token);
    if (!pair.resolved) unresolved.push(entryItem.cssVar);
  }

  for (const m of pendingModifiers) {
    const token = tokenIndex.get(`${m.ns}|${m.key}`);
    if (!token) continue;
    (token.modifiers ??= {})[m.modifier] = m.value;
  }

  // --- raw var layer (non-@theme :root/.dark declarations) -----------------
  // Walk the union of light + dark keys so vars defined ONLY under the dark
  // selector still surface.
  const vars: RawVar[] = [];
  const rawNames = new Set<string>([...maps.light.keys(), ...maps.dark.keys()]);
  for (const cssVar of rawNames) {
    if (themeVarNames.has(cssVar)) continue;
    const lightRef = maps.light.get(cssVar);
    const darkRef = maps.dark.get(cssVar);
    // Fall back across modes when a var is defined in only one of them.
    const l = resolveVars
      ? resolveValue(lightRef ?? (darkRef as string), maps.light)
      : { value: lightRef ?? (darkRef as string), resolved: true };
    const d = resolveVars
      ? resolveValue(darkRef ?? (lightRef as string), maps.dark)
      : { value: darkRef ?? (lightRef as string), resolved: true };
    const resolved = l.resolved && d.resolved;
    // Capture the immediate ref from the SAME source string used for value
    // resolution above, so single-mode vars fall back across modes identically.
    const lightRefName = immediateVarRef(lightRef ?? (darkRef as string));
    const darkRefName = immediateVarRef(darkRef ?? (lightRef as string));
    const rawVar: RawVar = {
      name: cssVar.replace(/^--/, ""),
      cssVar,
      light: coerceNumeric(l.value),
      dark: coerceNumeric(d.value),
      resolved,
    };
    if (lightRefName !== null || darkRefName !== null) {
      rawVar.ref = { light: lightRefName, dark: darkRefName };
    }
    vars.push(rawVar);
    if (!resolved) unresolved.push(cssVar);
  }

  // Fold a numeric line-height modifier into a `lineHeightNumber` companion,
  // evaluating light and dark independently.
  const toNumber = (v: TokenValue): number | null =>
    typeof v === "number" ? v : evalCalcNumber(v);
  for (const tokens of Object.values(theme)) {
    for (const token of tokens) {
      const lh = token.modifiers?.["line-height"];
      if (!lh) continue;
      const lightNum = toNumber(lh.light);
      const darkNum = toNumber(lh.dark);
      if (lightNum == null && darkNum == null) continue;
      token.modifiers!["line-height-number"] = {
        light: lightNum ?? lh.light,
        dark: darkNum ?? lh.dark,
        resolved: lh.resolved,
      };
    }
  }

  return {
    theme,
    vars,
    meta: {
      // Record a cwd-relative path so the emitted file is stable across machines/CI.
      source: relative(process.cwd(), resolve(entry)) || entry,
      tailwindVersion: engine.tailwindVersion,
      unresolved,
      dependencies: engine.dependencies,
    },
  };
}
