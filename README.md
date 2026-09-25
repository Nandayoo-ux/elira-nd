# ELARA

**Personal AI Computer Assistant — Developed by Tan**

ELARA is a local-first, cloud-ready personal AI system built around **DeepSeek Harness (DSH)** as the single harness layer. The project adds ELARA-specific plugins and integrations instead of rewriting the harness core.

## Architecture

```text
WhatsApp (Baileys) ─┐
Telegram            ├──> ELARA Gateway ──> DeepSeek Harness ──> 9Router / Models
Laptop UI           ┘                           │
                                               ├─ Memory / Tasks / Skills
                                               ├─ Verification / Policy
                                               └─ ELARA plugins
                                                       │
                                                       ▼
                                                Windows Companion
                                                       │
                                                       ▼
                                                   Your PC
```

## Design rules

1. **Reuse first, adapt second, rewrite last.**
2. DSH remains an upstream runtime; ELARA changes live in plugins/adapters.
3. The laptop executor is treated as a separate trusted device boundary.
4. Remote commands never become an unrestricted Windows shell by default.
5. Local mode must be able to become cloud mode without changing the device protocol.
6. OwnHermes V2 is optional and is not the foundation of ELARA.

## Current status

The repository contains P2B one-time approvals for reviewed host actions. The existing `profiles/local/cordis.patch.yml` must be updated to load `elara-access`, and the private access configuration must include `authorities.hostDeviceId` before the local runtime can use them. Bootstrap now refuses an existing patch that omits the access plugin. No upstream DSH source is vendored; the pinned runtime is cloned into ignored `.runtime/` during local bootstrap.

## Prerequisites

DeepSeek Harness currently documents Node.js **22.19+ or 24+**, pnpm 11.7.0 via Corepack, and Git 2.26+. Native Windows development is supported; WSL2 is optional. The current DSH development guide documents Node 22.19+ or 24+ and pnpm 11.7.0. See the official development guide before bootstrapping. 

## Local bootstrap

From PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\bootstrap-local.ps1
```

The bootstrap script clones the official DeepSeek Harness repository into `.runtime/deepseek-harness`, installs its dependencies, and creates an ELARA patch overlay without modifying the upstream source tree.

## Run

```powershell
.\scripts\run-local.ps1
```

The first milestone is deliberately small: prove that ELARA can load as a DSH plugin, expose an ELARA identity, and report Windows system status.

## Planned channels

- WhatsApp via Baileys
- Telegram Bot API
- Laptop dashboard
- Future cloud gateway

## Planned device model

```text
ELARA Cloud/Server
        │
        │ secure authenticated channel
        ▼
ELARA Companion (Windows)
        │
        └── local computer capabilities
```

## License

ELARA-specific code in this repository: MIT.
DeepSeek Harness remains upstream software under its own MIT license and notices.

## P2B approvals

ELARA routes reviewed host writes, edits, shell/code calls, and project actions through DSH's approval service during an active agent turn. The dashboard shows pending requests with the exact tool arguments and target device; WhatsApp sends the same details to the configured sender, who can reply `.approve <id>` or `.reject <id>`. Each answer expires after two minutes and applies to one live tool call. Closing the turn, aborting the call, restarting, or losing the answer channel fails closed.

Dashboard project buttons require a dashboard-owned agent session ID. They submit a request to that agent; the HTTP endpoint does not execute a tool directly. The dashboard token cannot answer a WhatsApp approval, and an unrelated WhatsApp identity cannot answer another user's request. DSH's own sandbox checks still apply and may request a separate approval.

P2A restrictions remain: `glob` and `grep` are disabled, private reads still require a later reviewed path, link/junction traversal is denied, companion mutation remains disabled, and cloud mode cannot execute native host tools. `profiles/local/access.json` must define `authorities.hostDeviceId`.

An approved shell or code command has broad host access during that one invocation; review its full arguments before allowing it. The path classifier cannot constrain what an arbitrary script reads after approval.

WhatsApp keeps voice-note transcription, quoted-message context, adaptive typing, explicit session reset, and its memory commands behind exact sender authorization. Memory rows are scoped by the configured principal ID. Older rows without trustworthy ownership remain preserved under a reserved, inaccessible owner; they are never assigned to a guessed user. The model-facing `elara_store_memory` tool remains denied by P2A until a separate policy review authorizes it.

Run `npm test` for baseline, access, approval, and adapter coverage; run `npm run verify` for the consolidated gate including type, scaffold, Windows command, and dashboard checks. Runtime tests use synthetic profiles and data, and do not activate the existing local profile.
