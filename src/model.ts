import { runEngine, assertEngineShape, classify, THEME_OPTION } from "./engine.ts";
import { buildDerefMaps, resolveValue, coerceNumeric, evalCalcNumber } from "./literals.ts";
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
  const vars: RawVar[] = [];
  for (const cssVar of maps.light.keys()) {
    if (themeVarNames.has(cssVar)) continue;
    const reference = maps.light.get(cssVar) as string;
    const l = resolveVars
      ? resolveValue(reference, maps.light)
      : { value: reference, resolved: true };
    const darkRef = maps.dark.get(cssVar) ?? reference;
    const d = resolveVars ? resolveValue(darkRef, maps.dark) : { value: darkRef, resolved: true };
    const resolved = l.resolved && d.resolved;
    vars.push({
      name: cssVar.replace(/^--/, ""),
      cssVar,
      light: coerceNumeric(l.value),
      dark: coerceNumeric(d.value),
      resolved,
    });
    if (!resolved) unresolved.push(cssVar);
  }

  // Fold a numeric line-height modifier into a `lineHeightNumber` companion.
  for (const tokens of Object.values(theme)) {
    for (const token of tokens) {
      const lh = token.modifiers?.["line-height"];
      if (lh && typeof lh.light === "string") {
        const n = evalCalcNumber(lh.light);
        if (n != null)
          token.modifiers!["line-height-number"] = { light: n, dark: n, resolved: true };
      }
    }
  }

  return {
    theme,
    vars,
    meta: {
      source: entry,
      tailwindVersion: engine.tailwindVersion,
      unresolved,
      dependencies: engine.dependencies,
    },
  };
}
