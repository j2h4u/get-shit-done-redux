---
type: Fixed
pr: 855
---

Codex skill generation now rewrites command-position bare `gsd-tools` calls to the installed Codex shim path, and shared workflow launchers now also probe repo-local and home-local `.codex/gsd-core/bin/gsd-tools.cjs`. Shim-only Codex installs can run generated `$gsd-*` skills without requiring `gsd-tools` to be on `PATH`. (#725)
