# Phase 0 — Upstream Baseline

## Goal

Prove that ELARA can load as an external DeepSeek Harness overlay on Windows without changing the upstream source tree.

## Acceptance criteria

1. Official `deepseek-ai/deepseek-harness` is used as the runtime.
2. DSH source is not committed into the ELARA repository.
3. Node is supported by the DSH-reported floor: 22.19+ on Node 22 or Node 24+.
4. pnpm is pinned to 11.7.0 for the DSH checkout.
5. The ELARA plugin overlay uses absolute plugin paths.
6. `elara-core` loads and exposes `elara_about`.
7. `elara-windows-tools` exposes the read-only `elara_windows_status` tool.
8. No unrestricted Windows shell capability is added by ELARA in Phase 0.
9. `.runtime/dsh-commit.txt` records the exact upstream commit used locally.
10. `ELARA` remains an independent project with explicit upstream attribution.

## Validation note

The repository can statically validate its own scaffold without downloading DSH. Runtime validation must be performed on a Windows machine after `bootstrap-local.ps1` completes successfully.
