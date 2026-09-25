# ELARA Architecture

## Boundary

DeepSeek Harness remains an upstream dependency. ELARA-specific behavior is implemented as plugins, channel adapters, and a device protocol.

## Local mode

```text
WhatsApp/Telegram/Laptop UI
          ↓
      ELARA local
          ↓
   DeepSeek Harness
          ↓
     Windows tools
```

## Cloud mode target

```text
WhatsApp/Telegram/Web
          ↓
      ELARA Server
          ↓ secure device protocol
   ELARA Companion
          ↓
       Windows
```

The device protocol is intentionally independent from deployment mode so the local implementation can later be hosted remotely without changing Windows capabilities.

## Plugin safety

DSH plugins are trusted host code, not a sandbox boundary. ELARA plugins must:

- keep dependencies minimal;
- avoid arbitrary command execution when a typed capability can be used;
- expose read-only system tools by default;
- route mutations through an explicit policy/approval layer;
- never embed secrets in source;
- pin production dependencies before cloud deployment.

## P2B approval boundary

`elara-access` asks DSH's approval service only from `tools/pre-execute` for a reviewed, sensitive host capability during an open turn. The request is displayed through the pending approval inbox. The inbox is in memory, expires requests after two minutes, and consumes an answer exactly once. Its identifier is not itself an execution grant. A grant is bound to the DSH execution token, tool name, call ID, frozen arguments, session cwd, principal, session binding, selected host device, policy, and runtime mode. The final `tools.guard()` rechecks that scope after other pre-execute listeners and consumes the token before dispatch. DSH's native sandbox can still ask separately during execution.

The dashboard token maps only to the configured dashboard principal. WhatsApp answers require the exact configured sender alias and are handled before the per-user conversation queue so a waiting turn cannot deadlock its own approval. Dashboard project actions enter a dashboard-owned agent turn; the endpoint never calls a tool implementation directly. The companion sender and receiver admit only reviewed remote status. Approval does not enable broad search, protected reads, link traversal, legacy remote mutation, or cloud host execution.

## WhatsApp and memory ownership

The WhatsApp adapter resolves the exact configured sender before creating a session, reading memory, handling commands, or downloading media. It retains the existing transcription, quoted-context, emotion, typing, bubble, and session-reset modules. Approval answers bypass the conversation queue but still require the matching principal and channel.

Memory queries and mutations use the access principal ID as the owner. Migration of older ownerless rows preserves them under the reserved `__elara_unattributed__` owner, which normal API calls cannot use. A previous shared `legacy` owner is quarantined the same way. A later migration may attribute a record only from independent evidence of ownership. The DSH model tool for storing memory remains policy-denied pending a separate review.
