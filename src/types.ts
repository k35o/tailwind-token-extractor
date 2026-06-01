/**
 * A resolved scalar token value. Numbers are emitted for purely numeric
 * values (e.g. z-index, line-height); everything else stays a string.
 */
export type TokenValue = string | number;

/**
 * A value that differs between light and dark. When `light === dark` the
 * emitter collapses it back to a bare {@link TokenValue}, so a `LightDark`
 * object in the output always means "this token actually changes in dark mode".
 */
export type LightDark = {
  light: TokenValue;
  dark: TokenValue;
};

/**
 * One `@theme` token, normalized. This is the in-memory representation; the
 * emitter decides how to render it (scalar vs `{ light, dark }` vs text object).
 */
export type ThemeToken = {
  /** Full custom property name, e.g. `--color-fg-base`. */
  cssVar: string;
  /** Tailwind theme namespace, e.g. `color`, `text`, `font-weight`. */
  namespace: string;
  /** Key within the namespace, e.g. `fg-base`, `md`. Empty for scalar namespaces like `spacing`. */
  key: string;
  /** Raw value as Tailwind registered it, e.g. `var(--fg-base)` or `0.5rem`. */
  reference: string;
  /** Value resolved against the light (`:root`) custom-property map. */
  light: TokenValue;
  /** Value resolved against the dark (`.dark`) custom-property map. */
  dark: TokenValue;
  /** Whether every `var()` in the chain resolved to a literal. */
  resolved: boolean;
  /** True when this token comes from a Tailwind built-in default (options bit `DEFAULT`). */
  isDefault: boolean;
  /** Tailwind modifiers, e.g. `{ 'line-height': { light, dark, ... } }` for `--text-md--line-height`. */
  modifiers?: Record<string, ModifierValue>;
};

export type ModifierValue = {
  light: TokenValue;
  dark: TokenValue;
  resolved: boolean;
};

/**
 * One raw custom property from `:root` / `.dark` that is NOT a `@theme` token —
 * the underlying design layer a theme references (palette scales, semantic
 * aliases, z-index, etc.).
 */
export type RawVar = {
  /** Name without the leading `--`, e.g. `gray-50`, `fg-base`, `z-overlay`. */
  name: string;
  cssVar: string;
  light: TokenValue;
  dark: TokenValue;
  resolved: boolean;
};

/** The structured result of {@link extractTokens}. */
export type ExtractedTokens = {
  /** Every `@theme` token, grouped by namespace then key. */
  theme: Record<string, ThemeToken[]>;
  /** The raw `:root`/`.dark` custom-property layer (non-`@theme`). */
  vars: RawVar[];
  meta: ExtractedMeta;
};

export type ExtractedMeta = {
  /** Absolute path of the CSS entry that was extracted. */
  source: string;
  /** Installed Tailwind version the extraction ran against (from `@tailwindcss/node`). */
  tailwindVersion: string | null;
  /** `--name`s whose `var()` chain could not be fully resolved (e.g. host-injected fonts). */
  unresolved: string[];
  /** Files that participated in the `@import` graph (for watch mode). */
  dependencies: string[];
};

export type ExtractOptions = {
  /** Path to the consumer CSS entry (e.g. `globals.css`). Required. */
  entry: string;
  /** node_modules resolution root. Defaults to `dirname(entry)`. */
  base?: string;
  /** Selector that marks dark-mode overrides. Defaults to `.dark`. */
  darkSelector?: string;
  /** Resolve `var()` chains to literals. Defaults to `true`. */
  resolveVars?: boolean;
  /** Pre-seed the resolver with values for host-injected vars (e.g. fonts). */
  injectVars?: Record<string, string>;
  /** Run the smoke guard that detects incompatible Tailwind internals. Defaults to `true`. */
  tailwindVersionCheck?: boolean;
};

export type EmitOptions = {
  /** Banner comment placed at the top of the generated file. */
  header?: string;
  /** Emit `as const`. Defaults to `true`. */
  asConst?: boolean;
};

export type GenerateOptions = ExtractOptions &
  EmitOptions & {
    /** Where to write the generated `.ts` file. */
    outFile: string;
  };
