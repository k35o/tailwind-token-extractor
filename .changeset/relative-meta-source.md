---
"tailwind-token-extractor": patch
---

Emit `meta.source` as a cwd-relative path instead of an absolute one, so the generated file stays stable across machines and CI (avoids spurious diffs when re-running the extractor).
