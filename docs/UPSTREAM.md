# Upstream Policy

ELARA is an extension project, not a rewrite of DeepSeek Harness.

## Repository roles

- `deepseek-ai/deepseek-harness` — upstream harness runtime.
- `TanDjendra/elara-ai` — ELARA-specific plugins, adapters, device protocol, channels, and product behavior.

## Rules

1. Keep DeepSeek Harness out of the ELARA Git tree unless a future decision explicitly changes this.
2. Pin the upstream commit used by each ELARA release.
3. Prefer plugin/adapter extension points over upstream source modifications.
4. Keep ELARA code separable so upstream updates can be pulled without manual conflict resolution across the whole runtime.
5. Preserve upstream copyright and license notices when distributing upstream code.

## Local layout

```text
elara-ai/
└── .runtime/
    └── deepseek-harness/   # local upstream checkout, ignored by Git
```

The `.runtime/` directory is disposable. ELARA source remains outside it.
