# Project Status

Snapshot date: 2026-10-24 (Asia/Shanghai)

This repository records the current source state. It is an unfinished project archive, not a release claim or a guarantee that the bot starts successfully on another machine. This archive pass did not start the bot or run the test suite.

## Project structure

- `src/` contains the Node.js bot, OneBot/NapCat integration, model and search tools, memory, image, sticker, forwarding, and recovery logic.
- `public/` contains the local management interface.
- `scripts/` contains Windows launch, setup, backup, and video-processing scripts.
- `desktop/` contains the Windows desktop launcher source; generated `bin/`, `obj/`, and `dist/` output is excluded.
- `test/` contains isolated and replay-oriented checks. `npm run test:p0` is the test command declared in `package.json`.
- `docs/` contains requirement and implementation records. `docs/project-requirements.md` and `docs/requirements.md` are the detailed status ledgers.
- `tools/` contains the optional ChatGPT web image-generation helper, which needs a separately logged-in browser session.

## Incomplete and unverified work

The requirement ledgers distinguish code present from evidence at simulation, model, web, or QQ runtime levels. This archive pass did not re-audit those claims against a live bot.

Known open items recorded in the ledgers include the role-reference management workflow (review, edit, remove, and scope controls), a backup restore rehearsal, and end-to-end checks against the currently running NapCat/QQ and external model/search services. Several features are marked partial or awaiting verification; consult the ledgers before treating them as complete.

## Setup requirements

- Node.js `>=20.9.0`, as declared by `package.json`; install dependencies with `npm ci`.
- Copy `.env.example` to a local `.env` and provide credentials locally. No credential values are part of this repository.
- Live access lists, group personas, knowledge, memories, stickers, diagnostics, and other runtime state belong under `data/` or `.local/`; they are not included. Only `data/*.example.json` files are tracked.
- The bot also depends on a separately installed and logged-in NapCat/QQ environment. The desktop project targets the .NET 8 SDK on Windows.

## Excluded from this public snapshot

- `.env` and other local environment files, live `data/` and `.local/` state, WorkBuddy metadata, `node_modules/`, backups, generated desktop binaries, and the machine-specific `.lnk` shortcut.
- Group-specific persona notes and persona history audit documents are kept out of this public code archive. The source copies remain in the local project.
- The public snapshot uses an empty default group allowlist. Configure authorized groups locally through the management interface.

The following local documents were omitted because they contain private persona or internal handoff material: `docs/ai-project-manager-handoff.md`, `docs/group-banter-feedback-20261023.md`, `docs/member-banter-memory-design-20261023.md`, `docs/persona-history-audit-20261024.md`, and `docs/persona-rewrite-20261023.md`.

## Verification performed for this archive

- Compared the current source tree with the clean `main` publication clone.
- Confirmed the existing remote repository and default branch through the connected GitHub account.
- Checked candidate files for credentials, known QQ identifiers, and local absolute user paths; the publication copy is scrubbed.
- No application tests or live service checks were run for this archival task.
