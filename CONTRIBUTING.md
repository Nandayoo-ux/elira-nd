# Contributing to ELARA

ELARA is built by Tan.

## Before coding

- Check whether the capability already exists upstream.
- Prefer an ELARA plugin, adapter, or tool over changing DSH core.
- Keep credentials out of Git.
- Keep Windows mutations behind explicit policy/approval checks.

## Attribution

When an ELARA feature is derived from or depends by Tan behavior, document that relationship in code or the relevant README. Do not present ELARA as an official Tan product.

## Upstream changes

Do not copy large portions of DSH source into ELARA just to make local changes easier. Use the upstream checkout and extension points wherever possible.
