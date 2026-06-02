import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTokens } from "../src/model.ts";
import { emitTypeScript } from "../src/index.ts";
import type { ExtractedTokens, ThemeToken } from "../src/types.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const find = (tokens: ExtractedTokens, ns: string, key: string): ThemeToken | undefined =>
  tokens.theme[ns]?.find((t) => t.key === key);

describe("extractTokens (imported-CSS case)", () => {
  let tokens: ExtractedTokens;

  beforeAll(async () => {
    // consumer.css @imports design-system.css which @imports 'tailwindcss'.
    tokens = await extractTokens({ entry: join(fixtures, "consumer.css"), base: fixtures });
  });

  it("resolves a semantic color through its var() chain to light/dark literals", () => {
    const primary = find(tokens, "color", "primary");
    expect(primary).toBeDefined();
    expect(primary?.light).toBe("oklch(0.66 0.165 180)");
    expect(primary?.dark).toBe("oklch(0.41 0.098 180)");
    expect(primary?.resolved).toBe(true);
  });

  it("includes the consumer-added token (consumer wins)", () => {
    expect(find(tokens, "color", "accent")?.light).toBe("oklch(0.7 0.2 30)");
  });

  it("honors `--color-*: initial` — cleared Tailwind default colors are gone", () => {
    expect(find(tokens, "color", "red-500")).toBeUndefined();
    // ...but the design-system's own colors remain.
    expect(find(tokens, "color", "white")).toBeDefined();
  });

  it('captures surviving Tailwind defaults (proves @import "tailwindcss" was resolved)', () => {
    expect(tokens.theme.container?.length).toBeGreaterThan(0);
    expect(tokens.theme.blur?.length).toBeGreaterThan(0);
  });

  it("folds the text line-height modifier and computes lineHeightNumber", () => {
    const md = find(tokens, "text", "md");
    expect(md?.light).toBe("1rem");
    expect(md?.modifiers?.["line-height"]?.light).toBe("calc(1.5 / 1)");
    expect(md?.modifiers?.["line-height-number"]?.light).toBe(1.5);
  });

  it("surfaces the raw var layer with numeric coercion and dark overrides", () => {
    const zModal = tokens.vars.find((v) => v.name === "z-modal");
    expect(zModal?.light).toBe(1300);
    const primaryVar = tokens.vars.find((v) => v.name === "primary");
    expect(primaryVar?.light).toBe("oklch(0.66 0.165 180)");
    expect(primaryVar?.dark).toBe("oklch(0.41 0.098 180)");
  });

  it("preserves the immediate var() ref per mode for aliased vars", () => {
    const primaryVar = tokens.vars.find((v) => v.name === "primary");
    expect(primaryVar?.ref).toEqual({ light: "teal-500", dark: "teal-800" });
  });

  it("attaches no ref to vars whose value is a literal", () => {
    expect(tokens.vars.find((v) => v.name === "z-modal")?.ref).toBeUndefined();
    expect(tokens.vars.find((v) => v.name === "teal-500")?.ref).toBeUndefined();
  });

  it("surfaces a var defined only under the dark selector", () => {
    const darkOnly = tokens.vars.find((v) => v.name === "dark-only");
    expect(darkOnly).toBeDefined();
    expect(darkOnly?.dark).toBe("oklch(0.2 0 0)");
  });

  it("reports the Tailwind version and the @import dependency graph", () => {
    expect(typeof tokens.meta.tailwindVersion).toBe("string");
    expect(tokens.meta.dependencies.length).toBeGreaterThan(0);
  });

  it("records a cwd-relative source path (no machine-specific absolute path)", () => {
    expect(tokens.meta.source.startsWith("/")).toBe(false);
    expect(tokens.meta.source).toContain("consumer.css");
  });

  it("emits valid-looking TypeScript", () => {
    const code = emitTypeScript(tokens);
    expect(code).toContain("export const tokens = {");
    expect(code).toContain("export type ColorToken =");
  });

  it("emits TypeScript that type-checks under --strict", () => {
    const code = emitTypeScript(tokens);
    const dir = mkdtempSync(join(tmpdir(), "twte-emit-"));
    const file = join(dir, "tokens.ts");
    writeFileSync(file, code);
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    // execFileSync throws if tsc exits non-zero (i.e. the generated file has type errors).
    execFileSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--moduleResolution",
        "bundler",
        "--module",
        "ESNext",
        file,
      ],
      { stdio: "pipe" },
    );
  });
});
