import { describe, it, expect } from "vitest";
import { classify } from "../src/engine.ts";
import {
  resolveValue,
  evalCalcNumber,
  coerceNumeric,
  buildDerefMaps,
  immediateVarRef,
} from "../src/literals.ts";
import { emitTypeScript } from "../src/emit.ts";
import type { ExtractedTokens } from "../src/types.ts";

describe("classify", () => {
  it("splits a simple namespace + key", () => {
    expect(classify("--color-fg-base")).toEqual({ namespace: "color", key: "fg-base" });
  });

  it("prefers the longest namespace on a token boundary", () => {
    expect(classify("--text-shadow-sm")).toEqual({ namespace: "text-shadow", key: "sm" });
    expect(classify("--text-md")).toEqual({ namespace: "text", key: "md" });
    expect(classify("--font-weight-bold")).toEqual({ namespace: "font-weight", key: "bold" });
    expect(classify("--font-noto-sans-jp")).toEqual({ namespace: "font", key: "noto-sans-jp" });
    expect(classify("--inset-shadow-xs")).toEqual({ namespace: "inset-shadow", key: "xs" });
  });

  it("extracts the --base--modifier form", () => {
    expect(classify("--text-md--line-height")).toEqual({
      namespace: "text",
      key: "md",
      modifier: "line-height",
    });
  });

  it("treats a bare namespace as a scalar (empty key)", () => {
    expect(classify("--spacing")).toEqual({ namespace: "spacing", key: "" });
  });
});

describe("resolveValue", () => {
  it("resolves a direct var()", () => {
    const map = new Map([["--a", "red"]]);
    expect(resolveValue("var(--a)", map)).toEqual({ value: "red", resolved: true });
  });

  it("follows a var() chain to the literal", () => {
    const map = new Map([
      ["--a", "var(--b)"],
      ["--b", "oklch(0.5 0 0)"],
    ]);
    expect(resolveValue("var(--a)", map)).toEqual({ value: "oklch(0.5 0 0)", resolved: true });
  });

  it("uses a fallback when the var is missing", () => {
    expect(resolveValue("var(--missing, green)", new Map())).toEqual({
      value: "green",
      resolved: true,
    });
  });

  it("keeps a self-referential var verbatim and flags it unresolved", () => {
    const map = new Map([["--x", "var(--x)"]]);
    const result = resolveValue("var(--x)", map);
    expect(result.resolved).toBe(false);
    expect(result.value).toContain("var(--x)");
  });

  it("flags a missing var with no fallback as unresolved", () => {
    const result = resolveValue("var(--nope)", new Map());
    expect(result.resolved).toBe(false);
    expect(result.value).toBe("var(--nope)");
  });

  it("resolves multiple sibling var()s in one value", () => {
    const map = new Map([
      ["--a", "1px"],
      ["--b", "2px"],
    ]);
    expect(resolveValue("var(--a) var(--b)", map)).toEqual({ value: "1px 2px", resolved: true });
  });

  it("resolves nested var() fallbacks", () => {
    expect(resolveValue("var(--x, var(--y, red))", new Map())).toEqual({
      value: "red",
      resolved: true,
    });
  });

  it("resolves var()s nested inside another function and preserves the wrapper", () => {
    const map = new Map([
      ["--a", "red"],
      ["--b", "blue"],
    ]);
    expect(resolveValue("color-mix(in oklch, var(--a), var(--b))", map)).toEqual({
      value: "color-mix(in oklch, red, blue)",
      resolved: true,
    });
  });
});

describe("immediateVarRef", () => {
  it("returns the target name of a lone var()", () => {
    expect(immediateVarRef("var(--gray-900)")).toBe("gray-900");
  });

  it("returns the immediate target even when a fallback is present", () => {
    expect(immediateVarRef("var(--gray-900, white)")).toBe("gray-900");
  });

  it("returns null for a literal value", () => {
    expect(immediateVarRef("oklch(0.5 0 0)")).toBeNull();
    expect(immediateVarRef("1300")).toBeNull();
  });

  it("returns null when the value is not a single var()", () => {
    expect(immediateVarRef("var(--a) var(--b)")).toBeNull();
  });
});

describe("evalCalcNumber", () => {
  it("evaluates a numeric calc", () => {
    expect(evalCalcNumber("calc(1.5 / 1)")).toBe(1.5);
    expect(evalCalcNumber("calc(1.25 / 0.875)")).toBe(1.428571);
  });

  it("returns a plain number as-is", () => {
    expect(evalCalcNumber("1")).toBe(1);
  });

  it("refuses anything with units or functions", () => {
    expect(evalCalcNumber("1.5rem")).toBeNull();
    expect(evalCalcNumber("calc(1px + 2px)")).toBeNull();
  });
});

describe("coerceNumeric", () => {
  it("coerces pure numbers", () => {
    expect(coerceNumeric("1000")).toBe(1000);
    expect(coerceNumeric("1.5")).toBe(1.5);
  });
  it("leaves dimensioned/keyword values as strings", () => {
    expect(coerceNumeric("0.5rem")).toBe("0.5rem");
    expect(coerceNumeric("transparent")).toBe("transparent");
  });
});

describe("buildDerefMaps", () => {
  it("separates light and dark by selector class, not document position", () => {
    // Order is [light :root, .dark, consumer :root override] — a position-only
    // parser would pollute dark with the consumer's light override.
    const css = `
      :root { --c: red; }
      .dark { --c: black; }
      :root { --c: blue; }
    `;
    const maps = buildDerefMaps(css, ".dark");
    expect(maps.light.get("--c")).toBe("blue"); // last-wins within light
    expect(maps.dark.get("--c")).toBe("black"); // dark untouched by the consumer override
    expect(maps.darkOverridden.has("--c")).toBe(true);
  });

  it("supports an attribute dark selector", () => {
    const css = `:root { --c: red; } [data-theme="dark"] { --c: black; }`;
    const maps = buildDerefMaps(css, '[data-theme="dark"]');
    expect(maps.light.get("--c")).toBe("red");
    expect(maps.dark.get("--c")).toBe("black");
  });

  it("ignores declarations inside conditional at-rules", () => {
    const css = `:root { --c: red; } @media (max-width: 10px) { :root { --c: blue; } }`;
    const maps = buildDerefMaps(css, ".dark");
    expect(maps.light.get("--c")).toBe("red"); // the @media override is not collected
  });
});

describe("emitTypeScript", () => {
  const tokens: ExtractedTokens = {
    theme: {
      color: [
        {
          cssVar: "--color-primary",
          namespace: "color",
          key: "primary",
          reference: "var(--primary)",
          light: "oklch(0.66 0.165 180)",
          dark: "oklch(0.41 0.098 180)",
          resolved: true,
          isDefault: false,
        },
      ],
      spacing: [
        {
          cssVar: "--spacing",
          namespace: "spacing",
          key: "",
          reference: "0.25rem",
          light: "0.25rem",
          dark: "0.25rem",
          resolved: true,
          isDefault: false,
        },
      ],
    },
    vars: [
      { name: "z-modal", cssVar: "--z-modal", light: 1300, dark: 1300, resolved: true },
      {
        name: "primary",
        cssVar: "--primary",
        light: "oklch(0.66 0.165 180)",
        dark: "oklch(0.41 0.098 180)",
        resolved: true,
        ref: { light: "teal-500", dark: "teal-800" },
      },
    ],
    meta: { source: "x.css", tailwindVersion: "4.2.4", unresolved: [], dependencies: [] },
  };

  it("emits as-const tokens, a scalar namespace, light/dark objects and key types", () => {
    const code = emitTypeScript(tokens);
    expect(code).toContain("export const tokens = {");
    expect(code).toContain("} as const;");
    expect(code).toContain("spacing: '0.25rem'"); // scalar namespace collapses
    expect(code).toContain("light:"); // color stays light/dark
    expect(code).toContain("export type ColorToken = keyof typeof tokens.theme.color;");
    expect(code).toContain("z-modal");
  });

  it("emits a refs map of per-mode var() targets and a RefName type", () => {
    const code = emitTypeScript(tokens);
    expect(code).toContain("refs:");
    expect(code).toContain("light: 'teal-500'");
    expect(code).toContain("dark: 'teal-800'");
    expect(code).toContain("export type RefName = keyof typeof tokens.refs;");
  });
});
