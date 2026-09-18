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
