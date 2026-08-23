# Cursor CLI ACP Route — Implementation Plan

> Saved from the approved Cursor CLI ACP plan. Spec: [2026-08-21-cursor-cli-acp-route-design.md](../specs/2026-08-21-cursor-cli-acp-route-design.md)

**Goal:** First-class `cursor` route (`agent acp`) with models, spawn-arg `--model`, and Terminal `--resume`.

**Tasks:** types/config → models parse → spawn-arg bridge → resume Terminal → setup detect/auth → docs/tests.
