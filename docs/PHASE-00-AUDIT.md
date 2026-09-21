# PHASE 00 — Audit + Baseline

Date: 2026-09-19. Project root: `D:\Tan\script\elara-ai`.

**STATUS: PARTIAL. NEXT PHASE READINESS: NOT READY.**

The initial repository audit and baseline capture are delivered. PHASE 00 cannot be signed off under the master prompt's definition of done: baseline checks have failures and runtime validation remains incomplete. No PHASE 01 implementation was started. Missing future product features are recorded as architecture gaps, not treated as requirements to implement during this audit.

## Work completed

- Read and applied `C:\Users\LENOVO\Downloads\MASTER_PROMPT.md` as project instructions, together with the user's PHASE 00 scope and confirmed parent repository root.
- Inventoried first-party source, configuration, documentation, tests, placeholder directories, and the upstream dependency boundary.
- Inspected all first-party production plugin modules, the companion client, WhatsApp adapter, and dashboard source; reviewed relevant existing changes against HEAD.
- Inspected the actual dashboard in a browser using a temporary static preview. Reviewed its backend separately.
- Compared current functionality against every major target architecture layer and safety contract.
- Ran default tests, scoped typechecking, build and scaffold commands, syntax checks, and isolated filesystem/Windows execution probes.
- Recorded findings, limitations, decisions, and the next-phase gate. The companion, AI runtime, and external messaging channels were not started.

## Instruction and documentation inventory

The supplied master prompt has SHA-256 `9855a6ed80b63bcf0daad3336261a542b8efb6395c6550f2bd1f0ae80634e7b8`. It contains product requirements, safety rules, architecture, evidence/risk/action expectations, and phase completion/reporting rules. It contains **no numbered phase sequence or PHASE 00/01 specifications**. PHASE 00's audit scope comes from the user's explicit request.

No repository `MASTER_PROMPT.md`, additional prompt-pack phase files, or applicable `AGENTS.md` was found in the searched project/ancestor locations. A focused filename search in Downloads found only the supplied master prompt. This is not a claim about unrelated locations elsewhere on disk.

Existing `docs/PHASE-0.md` is **ELARA Upstream Baseline**, and `docs/ROADMAP.md` describes ELARA assistant phases 0–10. Neither defines the storage-cleaner phase sequence. Existing agent persona/planning prompt text in the preset is application configuration, not instructions to this auditing agent. The cleaner's later phases must not be inferred from the assistant roadmap.

## Files changed

Only these audit documents were added:

- `docs/PHASE-00-AUDIT.md` — this report.
- `docs/phase-00-baseline.json` — environment, baseline results, existing Git status, and SHA-256 inventory of 61 pre-existing source/configuration/documentation files.

No existing application, configuration, test, or prompt file was edited. No dependencies were installed, bootstrap run, commit made, or existing changes reverted. `cleaner/` remains empty. Disposable policy-test files were created under the OS temporary directory and removed after guarded path validation; the junction fixture was unlinked before recursive fixture cleanup. The temporary static preview and browser tab were stopped/closed.

At entry the working tree already contained **20 modified tracked files and 10 untracked files** when directories are expanded. HEAD was `89239581d884ad3eae19a73e5f939315f327d772` (`feat: complete ELARA Phase 10.5 WhatsApp Typing Indicator`). Audit findings describe that dirty working tree, not just HEAD. The JSON source hashes were captured after checks and before adding the report artifacts; they are a handoff snapshot, not a historical pre-session backup.

## Current architecture and project structure

```text
apps/dashboard/              Plain HTML/CSS/browser JavaScript control center
plugins/dashboard-api.ts     Loopback Node HTTP API and SSE events
channels/whatsapp-baileys/    Remote chat/media ingress into DSH agents
plugins/elara-core.ts        Identity and model-facing memory tools
plugins/elara-memory.ts      Owner-scoped SQLite conversational memory
plugins/windows-tools.ts     DSH tool registration and local/cloud routing
plugins/windows-tools-local.ts
                             Filesystem/process helpers and Windows metrics
plugins/companion-api.ts     Loopback HTTP/SSE request broker
apps/companion/index.ts      Windows client; ACK -> execute -> result
profiles/                   Cordis overlay and ELARA coding-agent preset
.runtime/deepseek-harness/   Ignored upstream runtime checkout
scripts/                    Bootstrap, launch, unit and legacy integration checks
docs/                       Existing assistant architecture, roadmap, baseline
integrations/               DSH/9Router notes
channels/telegram/          Documentation placeholder
packages/*                  Eight empty subsystem directories
cleaner/                    Empty; no application entry point
```

Runtime: Node ESM with TypeScript plugins; installed Node `v24.13.1`, npm `11.8.0`. Root declares `pnpm@11.7.0` and Node `>=22.19.0`; the bootstrap script more specifically rejects Node 23. Package-manager installation/version execution was not performed.

The root manifest declares no dependencies/devDependencies and its pnpm lock has an empty root importer. `node_modules` is a junction into the DSH dependency tree. The separate WhatsApp package has its own manifest/lockfile and uses Baileys `7.0.0-rc14`. DSH's local manifest identifies `0.1.6-alpha.2` and Node `^22.19.0 || >=24.0.0`. Recorded upstream commit matches checkout HEAD: `ddefc45fbc7f8e46dd73185e68295696d1297887`. No tracked upstream edits appeared in its status; untracked runtime/test artifacts are present. Upstream internals were not comprehensively audited.

The normal flow is dashboard/WhatsApp -> DSH agents/preset -> ELARA/native tools -> local executor or companion. Memory stores conversational facts. There is no storage intelligence pipeline. Empty `packages/policy`, `packages/protocol`, and sibling directories must not be mistaken for implemented services.

## Existing functionality and UI

- Dashboard has Overview, Chat, Sessions, PC Health, Projects, Tools, Activity, Logs, and Settings views. Navigation among Overview/Projects/Chat/PC Health/Settings was visually verified. Source covers the other views.
- Dashboard API implements status, session/tool listings, chat, allowlisted project command names, and event streams. It binds to `127.0.0.1`, checks a token on API paths, emits security headers, and escapes displayed values in the main UI rendering paths.
- Windows status uses a fixed read-only PowerShell/CIM query for CPU/RAM/battery and aggregate C: disk usage. This is not recursive storage discovery, and the dashboard's own PC Health API does not expose disk usage.
- Memory implements owner-scoped CRUD/retrieval, duplicate handling, legacy-owner isolation, and heuristic secret rejection.
- WhatsApp code implements direct-message processing, per-sender queues, deduplication, persistent session mappings, commands, and media intake. Live transport behavior was not exercised.
- Companion implements token authentication, loopback transport, request IDs, ACK/result messages, reconnect attempts, and failure on detected execution disconnect. These are useful mechanisms but not a durable cleanup transaction system.
- Legacy filesystem/process tools are registration-gated by `ELARA_ENABLE_LEGACY_TOOLS=1`. Project test/build/typecheck tools remain registered. The normal ELARA preset includes native filesystem and PowerShell tools.

The static browser preview intentionally had no backend. It showed Disconnected and persistent Loading placeholders. This validates rendering/navigation and the current failure UI, not a successful application startup. No token was entered and no chat/project action was submitted. Chat uses placeholder-only input identification; the token label lacks a `for` association; there is no viewport meta tag. Fixed sidebar/layout choices and small-screen behavior need dedicated future validation. Project buttons stay enabled when disconnected. The UI has no scan, evidence, risk, preview/approval, quarantine, restore, or recovered-space views.

## Comparison against target requirements

| Required layer/contract | Evidence in current repository | Gap |
| --- | --- | --- |
| UI and application boundary | Dashboard, HTTP APIs, companion protocol | General assistant flows only; no cleaner domain API |
| Storage intelligence/scanners | C: aggregate metrics and legacy directory listing | No bounded recursive scan, cancellation, storage accounting, residue discovery, or inaccessible-object results |
| Evidence store | SQLite conversational memory | No candidate identity/size/attributes/ACL/lock/application/installation/service/package provenance schema |
| Classification/recommendation | General AI chat | No evidence-driven cleanup classifier; no SAFE through BLOCKED risk model |
| Bounded AI advisor | Coding-agent preset with execution-capable tools | No strict cleanup output schema, contradiction validation, or fail-closed REVIEW/BLOCKED path |
| Deterministic policy | Workspace resolution and executable argument checks | No cleanup action authorization, protected-artifact rules, risk gates, evidence freshness, or user decision binding |
| Cleanup planner | None found | No typed action IDs/targets/expected bytes/risk/authorization/preconditions/postconditions/rollback plans |
| Executor/quarantine | Generic file write/process helpers | No approved-action-only executor, dry-run default, quarantine, rollback, or durable recovery journal |
| Official Windows cleanup | None found in first-party code | No supported component-store/hibernation/driver-store cleanup adapters; raw deletion must remain unavailable for these artifacts |
| Verification | Generic child exit status and tool events | No target-state/postcondition/health verification or measured released bytes |
| Reporting/audit | Console logs, SSE, historical test reports | No persistent cleanup evidence/decision/action/result chain |
| Tests/release | Small unit suite and legacy scripts | No cleaner fixtures, safety invariants, Windows deployment verification, or root CI/lint configuration |

Also absent: tested handling for locked/permission-denied/hidden/system objects, hard links and allocated-vs-logical size, reparse changes between planning/execution, long/UNC/device paths, concurrent changes, volume differences, crash recovery, least-privilege elevation boundaries, and cancellation during multi-step jobs. These are future design/test requirements; their absence does not justify implementing later phases in this session.

## Important security and safety findings

Severity below is audit priority, not a cleanup candidate classification. Source-observed risks are distinguished from reproduced failures.

1. **HIGH — Existing process policy is not a cleaner security boundary.** `plugins/windows-tools-local.ts:29` rejects a few Node flags but accepts arbitrary script paths and `--import`; `tsc` accepts all arguments. Validator-only probes confirmed external-script and preload acceptance without executing them. `safeExec` constrains cwd, not what a child process can access. Generic workspace writes can overwrite code/configuration and have no action-specific approval or rollback. Registration gating helps the default model catalog but the exported executor/companion path has no equivalent legacy feature gate. Any future cleaner must use deterministic typed actions, not reuse this interface as deletion authority.

2. **HIGH — Remote sender authorization is missing at the adapter boundary.** `channels/whatsapp-baileys/plugin.ts:368` filters self/group/duplicate messages, then queues other senders into the ELARA preset; no sender allowlist or device-owner authorization check appears in this adapter. `.pc` directly invokes the Windows status helper. The preset includes native filesystem/PowerShell tools. This is a confirmed adapter-level authorization gap; the effective upstream approval/sandbox behavior and end-to-end impact were not tested, so unrestricted remote execution is not asserted.

3. **HIGH — Cloud routing can fall back to the local machine.** In `plugins/windows-tools.ts:13`, cloud routing requires both cloud mode and a companion service; otherwise execution is local. Missing service injection in cloud mode therefore changes the execution target instead of failing closed. This is unacceptable as a future cleanup fallback. Offline-but-present companion behavior does throw. Static finding; no cloud mutation attempted.

4. **HIGH for cleanup reuse — Companion completion is not durable verification.** `plugins/companion-api.ts` stores requests only in memory, accepts a result without requiring an executing state, and deletes expired/uncertain records so late results cannot be reconciled despite comments suggesting otherwise. Broadcast requests carry no evidence-bound authorization or expiry/preconditions. `lastSeen` is assigned but not enforced as a heartbeat timeout. `apps/companion/index.ts:91` has no durable executed-ID journal; its outer `ok` is based on whether execution throws, even when the nested process result has `ok:false`. The Windows plugin unwraps nested failure later, but the transport state itself can say completed. ACK refusal and avoiding automatic execution retries are useful existing protections. Static findings, not a claim that duplicate destructive execution was observed.

5. **HIGH — Diagnostic script exposes secrets.** `scripts/test-env.mjs:1` prints values of environment variables matching KEY/ROUTER/API/DEEPSEEK. It was read but not executed. This can leak provider credentials into terminal/session logs. No secrets were needed for this audit.

6. **MEDIUM — Path checks are useful but incomplete for destructive use.** `resolveSafePath` uses realpath and relative containment; outside reads/writes and a static junction escape were correctly rejected in isolated fixtures. Resolution and file operations are separate, leaving identity-change/race concerns. There are no destructive-operation tests for ACLs, hard links, ADS/device paths, or reparse changes. No race exploit was attempted.

7. **MEDIUM — Token and input handling need further hardening.** Dashboard bearer tokens persist in browser localStorage and SSE query strings; there is no rotation/expiry workflow. Token files request POSIX mode `0600`, but effective Windows ACL protection was not verified. Empty existing token files are not rejected at initialization. Dashboard URL decoding occurs outside the route try/catch; malformed escapes can reject the async handler. Companion/body shapes use `any`, and body limits count decoded string characters rather than raw bytes. These are source findings; no live-service crash or token disclosure was attempted.

8. **MEDIUM — Resource and audit limits are incomplete.** Media is downloaded into a full buffer before checking actual size; the advertised-size check is not a streaming bound. Chat/agent queues and UI logs lack robust bounded retention. SSE and console messages are not a persistent audit record. Success from process exit alone cannot support cleanup claims.

Positive protections preserved: loopback binding, token checks, main HTML escaping, CSP/referrer headers, owner-scoped SQL statements, default legacy registration gating, realpath containment, process/output limits, no automatic companion execution retry, and use of disposable directories by the current memory unit test. Their existence does not establish compliance with all cleaner safety requirements.

## Technical risks and regressions

- **Reproduced Windows execution failure:** `plugins/windows-tools-local.ts:223` invokes `npm.cmd` through `spawn(..., shell:false)`. A temporary project whose build only runs `node --version` failed with `spawn EINVAL`. This affects the shared project-command mechanism; commands run directly from PowerShell are separate and did work. Do not fix this by introducing an unrestricted shell.
- **Scaffold verification has drifted:** `scripts/verify-scaffold.mjs:40` requires the old exact core injection declaration. Current core correctly also injects memory. Further stale expectations look for `powershell.exe` in the registration module (now in the local executor) and placeholders in the generated local patch instead of the template. The run stopped at the first mismatch; additional mismatches were found by inspection.
- **Typecheck is narrow:** root `tsconfig.json` disables strict mode and several safety checks, skips library checks, and explicitly includes eight files. It excludes the companion entry point, test files, and dashboard JavaScript. Passing does not validate runtime module resolution or all source.
- **Dependency reproducibility is incomplete:** bootstrap clones upstream default HEAD if absent and records the resulting commit in ignored runtime state; it does not check out a version pinned by this repository. Root tooling depends on a local junction and upstream packages. Direct dashboard import failed on `@deepseek-ai/dsh-llm`. This is an isolated-import failure, not proof that the normal DSH loader cannot start the app. No fresh-machine bootstrap was attempted.
- **Bootstrap reliability:** external native-command exit statuses are not explicitly checked after each install/build; `$ErrorActionPreference` alone is not a demonstrated fail-fast guarantee for all supported PowerShell versions. WhatsApp's `pnpm-workspace.yaml` has unresolved string placeholders for build approval settings. These need validation in a future isolated bootstrap run.
- **Coverage was narrowed in pre-existing changes:** the working-tree WhatsApp test file now tests formatting only; HEAD had adapter-behavior test code. Persona tests now check source markers rather than assembled runtime prompts. This is a demonstrable coverage change, not proof that the removed tests worked. The memory test named legacy migration inserts a legacy-owner row into a current schema, so it does not exercise migration from the old schema.
- **Legacy checks are not current release gates:** Windows/cloud scripts expect legacy tools to be registered and errors returned as strings; current wrappers gate tools and throw errors. Other scripts launch the real local profile, call live provider endpoints, terminate process trees, or lack substantive assertions. The old regression report is historical evidence only.
- **Configuration/docs drift:** the companion README still describes a reserved component although an implementation exists. Companion URL is hard-coded despite an example `ELARA_SERVER_URL` variable. UI `chat.sent` logging expects `message` although the API deliberately omits it. Module-root fallbacks use URL pathname stripping rather than URL decoding, creating a spaces/Unicode path risk not exercised by this repository's current path.

## Tests/checks performed and results

| Check | Result | Evidence/limit |
| --- | --- | --- |
| Root/status/structure/prompt inventory | PASS | Parent confirmed; cleaner and eight packages directories empty; existing work recorded |
| `npm.cmd test` | PASS | 12 passed, 0 failed; memory/config/persona/formatting only |
| `npm.cmd run typecheck` | PASS | Exit 0 under existing limited non-strict configuration |
| `npm.cmd run build` | NO-OP | Exit 0, prints `No build step required for local plugins`; no build artifact |
| `npm.cmd run verify:scaffold` | FAIL | Exit 1: `Core plugin missing marker: export const inject = ['tools']` |
| `node --check apps/dashboard/app.js` | PASS | JavaScript syntax |
| PowerShell AST parse of bootstrap/run scripts | PASS | Zero parse errors in both; scripts not executed |
| Disposable filesystem/policy probes | PARTIAL | Six assertions pass; one harmless Windows project-build assertion fails with `spawn EINVAL` |
| Node argument validator observations | SAFETY GAP | External script and preload accepted; validator-only, not execution |
| Isolated dashboard import with Node/tsx | FAIL | `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/dsh-llm`; failed before server/fixture creation |
| Static UI preview/browser interaction | PASS, LIMITED | Rendering/navigation verified; backend intentionally unavailable |
| Upstream recorded commit vs checkout | PASS | Both `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| Root lint/CI | NOT CONFIGURED | No root lint script/config or tracked `.github` workflows found |
| Live runtime/WhatsApp/provider/cloud integration | NOT RUN | Would use real profiles/services; existing scripts unsuitable for isolated baseline |
| Cleaner destructive/health/recovery checks | NOT AVAILABLE | Cleaner components do not exist; no real deletion or recovery claimed |

Before the unit suite, `ELARA_MEMORY_DB` was removed only from the child-shell environment to prevent an inherited override from redirecting the memory test to a real database. The unit test creates its own temporary root. The policy fixture used only temporary directories and a harmless build command. Temporary cleanup validated the resolved path under the OS temporary directory and removed its junction explicitly first.

No claim is made about fresh installation, full DSH startup, effective runtime approvals, real messaging, NTFS edge cases, administrator behavior, system health after cleanup, dependency vulnerability status, or measured recovered bytes. These were not tested.

## Files inspected

Full production-source review: `apps/dashboard/index.html`, `apps/dashboard/app.js`, `apps/dashboard/style.css`, `apps/companion/index.ts`; `plugins/companion-api.ts`, `plugins/dashboard-api.ts`, `plugins/elara-core.ts`, `plugins/elara-memory.ts`, `plugins/windows-tools.ts`, `plugins/windows-tools-local.ts`, `plugins/test-presets.ts`; `channels/whatsapp-baileys/plugin.ts`, `channels/whatsapp-baileys/format.ts`.

Configuration/workflow review: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `.gitignore`, `.env.example` variable names, `profiles/cordis.patch.template.yml`, selected structure/path fields in `profiles/local/cordis.patch.yml`, `profiles/local/.agent-presets/elara/agent.cordis.yml`, `profiles/local/.agent-presets/elara/preset.yml`, `channels/whatsapp-baileys/package.json`, its `tsconfig.json` and `pnpm-workspace.yaml`; `scripts/bootstrap-local.ps1`, `scripts/run-local.ps1`, `scripts/run-ps.mjs`.

Documentation: supplied external master prompt; `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/PHASE-0.md`, `docs/UPSTREAM.md`, `THIRD_PARTY_NOTICES.md`, license header, `apps/companion/README.md`, both integration READMEs, both channel READMEs, `elara-regression-report.md`.

Test review: full `scripts/test-memory.mjs`, `scripts/test-persona.mjs`, `scripts/test-config.mjs`, `scripts/verify-scaffold.mjs`, `scripts/test-windows.mjs`, `scripts/test-dashboard.mjs`, `scripts/test-cloud.mjs`, `channels/whatsapp-baileys/plugin.test.ts`, `test-e2e.mjs`, and `scratch.ts`. Targeted side-effect/assertion review of `scripts/test-env.mjs`, `scripts/test-typing.mjs`, `scripts/test-web.mjs`, `scripts/test-9router-direct.mjs`, `scripts/run-regression.mjs`, `test-startup.mjs`, and `concurrency.test.mjs`. Selected diffs reviewed for existing test/core-tool changes. Adapter lockfiles and the old cloud sleep fixture were inventoried, not exhaustively audited.

Dependency metadata: `.runtime/dsh-commit.txt`, DSH manifest relevant fields and Git status, and the `node_modules` junction target. Private credentials, tokens, sessions, WhatsApp authentication data, and real memory contents were not read. Those exclusions are deliberate and are not evidence that the corresponding security configurations are safe.

## Decisions and remaining work

1. Preserve the existing UI/overlay and record reusable components. No evidence justifies a rewrite or populating `cleaner/` during the audit.
2. Treat generic AI coding tools and the future cleaner executor as different authority boundaries. Prompt wording and model confidence cannot authorize deletion.
3. Keep existing safety protections and avoid running legacy checks against the user's real services. Use temporary fixtures and report uncertainty instead of treating skipped integration checks as passing.
4. Capture failures without repairing application code in this phase. Updating the scaffold assertions, Windows launcher, isolation harness, and coverage requires a bounded follow-up; it is not silently included here.
5. Preserve the current working tree. Establish a coherent reviewed source/dependency baseline before subsequent implementation; do not discard the pre-existing uncommitted work.

Before PHASE 00 can be validated for handoff: resolve the failing scaffold and Windows command checks safely; establish an isolated normal-loader startup/API baseline with external channels disabled; make build/lint/typecheck applicability explicit and cover the companion execution boundary; review the high-priority authorization/routing findings. Define reproducible dependency/commit handling and retain meaningful failure-path tests. These are outstanding baseline/hardening items, not completed changes.

For the next phase, obtain its actual prompt/specification and acceptance criteria. No PHASE 01 title, implementation scope, stack migration, scanner design, or phase order has been invented. Future storage features remain the architecture gap list above and must be scheduled according to that prompt pack.

**NEXT PHASE HANDOFF: NOT READY. Audit evidence is available, but PHASE 00 status is PARTIAL and its validation gate is not satisfied. PHASE 01 was not started.**
