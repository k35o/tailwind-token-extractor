import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // CHANGELOG.md and .changeset/ (ledger.yaml etc.) are generated and owned
    // by pnpm's release management; don't format-check them.
    ignorePatterns: ["CHANGELOG.md", ".changeset"],
  },
  run: {
    tasks: {
      build: {
        command: "vp pack",
        input: [{ auto: true }, "!dist/**", "!node_modules/**"],
      },
    },
  },
  pack: {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
    },
    dts: true,
    format: ["esm", "cjs"],
  },
  staged: {
    "*.{js,ts,cjs,mjs,jsx,tsx,json,jsonc}": "vp check --fix",
  },
  test: {},
});
