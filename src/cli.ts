#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { cac } from "cac";
import { extractTokens } from "./model.ts";
import { emitTypeScript } from "./emit.ts";
import { generate, watch } from "./index.ts";
import type { ExtractOptions } from "./types.ts";

const cli = cac("tailwind-token-extractor");

type CliFlags = {
  out?: string;
  base?: string;
  dark: string;
  resolveVars: boolean;
  stdout?: boolean;
  watch?: boolean;
};

function extractOptions(entry: string, flags: CliFlags): ExtractOptions {
  return {
    entry: resolve(entry),
    base: flags.base ? resolve(flags.base) : undefined,
    darkSelector: flags.dark,
    resolveVars: flags.resolveVars,
  };
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function handleError(error: unknown): never {
  const err = error as { name?: string; message?: string };
  // Engine-incompatibility (Tailwind internals changed) → distinct exit code.
  if (err?.name === "EngineShapeError") fail(err.message ?? "engine shape error", 2);
  fail(`tailwind-token-extractor: ${err?.message ?? String(error)}`, 1);
}

cli
  .command("[entry]", "Extract Tailwind v4 tokens from a CSS entry into typed TypeScript")
  .option("-o, --out <file>", "Output .ts file")
  .option("--base <dir>", "node_modules resolution root (default: directory of <entry>)")
  .option("--dark <selector>", "Dark-mode selector", { default: ".dark" })
  .option("--no-resolve-vars", "Keep var() references instead of resolving them to literals")
  .option("--stdout", "Print generated code to stdout instead of writing a file")
  .option("-w, --watch", "Re-generate whenever the @import graph changes")
  .example("  tailwind-token-extractor src/app/globals.css -o src/generated/tokens.ts")
  .action(async (entry: string | undefined, flags: CliFlags) => {
    if (!entry) {
      cli.outputHelp();
      process.exit(1);
    }
    try {
      const opts = extractOptions(entry, flags);

      if (flags.stdout) {
        const tokens = await extractTokens(opts);
        process.stdout.write(emitTypeScript(tokens));
        return;
      }
      if (!flags.out) fail("Missing -o/--out <file> (or pass --stdout).", 1);
      const outFile = resolve(flags.out);

      if (flags.watch) {
        const handle = await watch({ ...opts, outFile }, (t) => {
          process.stdout.write(`✓ ${outFile} (${t.meta.dependencies.length} deps)\n`);
        });
        process.on("SIGINT", () => {
          handle.close();
          process.exit(0);
        });
        return;
      }

      const { tokens } = await generate({ ...opts, outFile });
      const note = tokens.meta.unresolved.length
        ? ` (${tokens.meta.unresolved.length} unresolved: ${tokens.meta.unresolved.join(", ")})`
        : "";
      process.stdout.write(`✓ wrote ${outFile}${note}\n`);
    } catch (error) {
      handleError(error);
    }
  });

cli
  .command("check <entry>", "Verify the generated file is up to date; exit 1 on drift")
  .option("-o, --out <file>", "Output .ts file to compare against")
  .option("--base <dir>", "node_modules resolution root (default: directory of <entry>)")
  .option("--dark <selector>", "Dark-mode selector", { default: ".dark" })
  .option("--no-resolve-vars", "Keep var() references instead of resolving them to literals")
  .action(async (entry: string, flags: CliFlags) => {
    try {
      if (!flags.out) fail("Missing -o/--out <file>.", 1);
      const outFile = resolve(flags.out);
      const opts = extractOptions(entry, flags);
      const tokens = await extractTokens(opts);
      const expected = emitTypeScript(tokens);
      const actual = await readFile(outFile, "utf8").catch(() => "");
      if (actual.trim() !== expected.trim()) {
        fail(`✗ ${outFile} is out of date — re-run tailwind-token-extractor.`, 1);
      }
      process.stdout.write(`✓ ${outFile} is up to date\n`);
    } catch (error) {
      handleError(error);
    }
  });

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

cli.help();
cli.version(version);
cli.parse();
