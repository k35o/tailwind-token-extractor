import { watch as fsWatch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { extractTokens } from "./model.ts";
import { emitTypeScript } from "./emit.ts";
import type { ExtractedTokens, GenerateOptions } from "./types.ts";

export { extractTokens } from "./model.ts";
export { emitTypeScript } from "./emit.ts";
export type * from "./types.ts";

/**
 * Extract tokens and write the generated TypeScript module to `outFile`.
 */
export async function generate(
  options: GenerateOptions,
): Promise<{ code: string; outFile: string; tokens: ExtractedTokens }> {
  const tokens = await extractTokens(options);
  const code = emitTypeScript(tokens, options);
  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, code, "utf8");
  return { code, outFile: options.outFile, tokens };
}

/**
 * Generate once, then re-generate whenever any file in the resolved `@import`
 * graph changes. Returns a handle with `close()`.
 */
export async function watch(
  options: GenerateOptions,
  onRebuild?: (tokens: ExtractedTokens) => void,
  onError?: (error: unknown) => void,
): Promise<{ close: () => void }> {
  const reportError =
    onError ??
    ((error: unknown) =>
      process.stderr.write(`tailwind-token-extractor watch: ${String(error)}\n`));
  const watchers = new Map<string, ReturnType<typeof fsWatch>>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const rebuild = async (): Promise<void> => {
    const { tokens } = await generate(options);
    syncWatchers(tokens.meta.dependencies);
    onRebuild?.(tokens);
  };

  const syncWatchers = (deps: string[]): void => {
    if (closed) return;
    const wanted = new Set([options.entry, ...deps]);
    for (const [file, w] of watchers) {
      if (!wanted.has(file)) {
        w.close();
        watchers.delete(file);
      }
    }
    for (const file of wanted) {
      if (watchers.has(file)) continue;
      try {
        watchers.set(
          file,
          fsWatch(file, () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              rebuild().catch(reportError);
            }, 50);
          }),
        );
      } catch {
        // A dependency may be unwatchable (e.g. inside a virtual package); skip it.
      }
    }
  };

  await rebuild();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

/** Identity helper for type-checked `tailwind-token-extractor.config.ts` files. */
export function defineConfig(config: GenerateOptions): GenerateOptions {
  return config;
}
