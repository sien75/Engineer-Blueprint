# Engineer-Blueprint

[中文](README_zh.md)

**Engineer-Blueprint** is a lightweight convention and toolkit for building live single-file `.html` applications with declarative SQLite schemas, seed data, natural-language backend workflows, and a persistent HTTP/WebSocket daemon.

## Prerequisites

- **`bun`** and **`sqlite`** — Required to run the `bp` CLI, daemon, and local SQLite persistence.
- **`ollama` (`qwen3.5:9b` model)** — Required for running natural-language flow decision routing.
- **`agy` CLI (optional)** — Required when executing `<script type="blueprint/ai" cli="agy">` nodes.

## Installation

Copy and send the following prompt to your coding agent to install Engineer-Blueprint on your machine:

> Please set up Engineer-Blueprint for me from this repository. First check that `bun`, `sqlite`, and `ollama` are installed and available on this machine, verify that `ollama` is running, and ensure the `qwen3.5:9b` model (used for natural-language flow decision routing) is pulled and available locally (install, pull, or report if anything is missing). Next, install the CLI from the `cli/` directory (link or expose its `bp` binary globally so `bp` can be invoked directly) and install the Agent skill from `skill/` (`skill/README.md`, `skill/def.md`, `skill/flow.md`, `skill/js.md`, `skill/sh.md`, `skill/ai.md`, `skill/daemon.md`, and `skill/workflows.md`) into my local agent skills directory (e.g. `~/.agents/skills/engineer-blueprint/`). Finally, verify that everything works by running the CLI test suite, checking that the `bp` command responds properly, and confirming `ollama` with `qwen3.5:9b` is ready.

## Repository Structure

- **[`skill/`](skill/README.md)** — **Specification & Agent Skill** (Chinese mirror [`skill/zh/README.md`](skill/zh/README.md)): Blueprint `.html` structure, declarative `<script type="blueprint/def">` SQLite schemas ([`def.md`](skill/def.md)), `<script type="blueprint/flow">` orchestration & SQL/emit nodes ([`flow.md`](skill/flow.md)), `<script type="blueprint/js">` ([`js.md`](skill/js.md)), `<script type="blueprint/sh">` ([`sh.md`](skill/sh.md)), `<script type="blueprint/ai">` ([`ai.md`](skill/ai.md)), persistent daemon + frontend `window.bp` API ([`daemon.md`](skill/daemon.md)), and typical usage workflows ([`workflows.md`](skill/workflows.md)).
- **[`cli/`](cli/)** — **Bun CLI & Daemon**: Zero-dependency `bp` tool built on `bun:sqlite` and `Bun.serve`, providing `bp up` / `bp down` (persistent daemon & scheduler), `bp reload` (incremental hot reload), `bp emit` (trigger events), `bp sql` (query/mutate SQLite), `bp logs` (inspect logs), and `bp run` (offline single run).
- **[`plans/2611/`](plans/2611/)** — **Design Notes**: Architecture and rationale notes ([`sql.md`](plans/2611/sql.md), [`flow.md`](plans/2611/flow.md), [`ai.md`](plans/2611/ai.md), [`daemon.md`](plans/2611/daemon.md)).
