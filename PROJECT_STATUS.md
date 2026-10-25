# Project Status

Snapshot date: 2026-10-25 (Asia/Shanghai)

This repository records the current source state. It is an unfinished project archive, not a release claim or a guarantee that the bot starts successfully on another machine. The archive pass itself did not start the bot or run the test suite.

## Project structure

- `src/` contains the Node.js bot, OneBot/NapCat integration, model and search tools, memory, image, sticker, forwarding, and recovery logic.
- `public/` contains the local management interface.
- `scripts/` contains Windows launch, setup, backup, and video-processing scripts.
- `desktop/` contains the Windows desktop launcher source; generated `bin/`, `obj/`, and `dist/` output is excluded.
- `test/` contains isolated and replay-oriented checks. `npm run test:p0` is the test command declared in `package.json`.
- `docs/` contains requirement and implementation records. `docs/project-requirements.md` and `docs/requirements.md` are the detailed status ledgers.
- `tools/` contains the optional ChatGPT web image-generation helper, which needs a separately logged-in browser session.

## Incomplete and unverified work

The requirement ledgers distinguish code present from evidence at simulation, model, web, or QQ runtime levels. The P0 runtime has been deployed and locally startup-checked. Remaining gaps include real QQ message delivery and live model/search responses, plus processing a real external or user-provided media file through FFmpeg. Synthetic checks and an active OneBot socket do not establish successful message delivery or real model responses.

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
- No application tests or live service checks were run for that archival pass.

## P0 delivery closeout

- **PR #1:** merged into `main` on 2026-10-25. Merge commit: `2ba91906477f9809492ee8ecfc36f4266f04d082`. PR head before merge: `1c2ec909b329cf0f1391b6fca50c25466e90215b`.
- **Included work:** P0-03 memory authorization and privacy boundaries; P0-04 bounded model retries, cancellation and diagnostics; P0-05 quoted-message identity and scope checks; P0-06.1 authorized fixture for the protected character identity path.
- **Local validation (2026-10-25, candidate `ca0219e3baee7ef7d80e12b7022bdcf35d15165b`, tree `e44d5939d2b98ff1b5784dcfe7f2a30d208888fd`):** a fresh `npm.cmd run test:p0` exited 0 with 184/184 checks (P0 isolation 108, memory privacy 45, model reliability 17, message context 14); `node test/character-reliability.mjs` exited 0 with 19/19. The deployed runtime comparison checked 108 tracked files: 107 matched and the sole difference was `README.md`; executable source, tests, management UI, scripts, and package files matched. `git diff --check` and sanitized-document checks passed.
- **CI and review:** local review of the cumulative P0 diff found no blocking issue. The repository has no configured branch protection or rulesets; the merged commit had no GitHub Actions check runs, and the PR had no independent GitHub review. These are not reported as CI or human-review passes.
- **Deployment (2026-10-25):** deployed the source and test files from merged tree `e44d5939d2b98ff1b5784dcfe7f2a30d208888fd` to the confirmed local bot runtime. A 349-file, 47.13 MB pre-deploy backup was checksum-verified. `.env`, live data, `node_modules`, private documents, and desktop build outputs were preserved. After restart, fresh local health reported core ready and OneBot connected; the management and OneBot listeners belonged to the bot process. This verifies process startup and OneBot connection only, not message delivery or real model/QQ end-to-end behavior. The only observed live-data change was the memory-index maintenance timestamp; its entry counts stayed unchanged.
- **Backup restore rehearsal (2026-10-25):** extracted the pre-deploy archive into a unique isolated directory, validated all 349 files against the embedded SHA-256 manifest, and removed the temporary extraction. The original archive was unchanged. The archive intentionally excludes `node_modules`; this rehearsal did not run `npm ci` or start a second bridge.
- **FFmpeg (2026-10-25):** the deployed `ffmpeg-static` executable launched successfully and reported version 6.1.1. A synthetic video encode and single-frame extraction using generated test media both exited successfully. No external or user-provided media was processed.
- **Role-reference management (2026-10-25):** static inspection confirmed the authenticated local management page and API support per-group/global scope, list/filter, edit, status review, select/withdraw, disable/reject, and delete actions. Synthetic regressions passed: storage 55 checks, visual consumer 11, learning 9. An isolated management-API exercise passed 8/8 checks for authentication denial, synthetic admin setup, group/shared scope reads, scope denial, edit, delete, and global view. No authenticated live UI mutation or real user image was used.
- **Git object hygiene (2026-10-25):** the local publication clone has 13 unreachable objects (10 blobs, one commit, and two trees). A heuristic scan of the orphan commit found no confirmed credential, cookie, absolute user path, QQ identifier, or timestamped chat record. Some loose report-like blobs contain timestamp/path-like text; no credential pattern was confirmed. GitHub lookup for representative objects returned 404. These objects were not deleted or pruned and no history rewrite was attempted; the scan is not a guarantee that every possible secret format is absent.
- **Allowlist and live-test authorization (2026-10-25):** the owner pointed out that the authorized test group had always been allowlisted. Re-reading the live configuration through the production access-control reader confirmed it is present in `accessControl.groupIds` (two groups total); the configuration file timestamp did not change. The owner authorized a small plain-text and quoted-message test with real model requests. The diagnostic ring recorded successful model-request activity at 09:58 and 09:59 China Standard Time. A later snapshot at 10:07 showed two logical request IDs: one had one start and one HTTP 200 without a recorded terminal event; the other had four starts and four HTTP 200 responses, 13 tool events, and one success. Diagnostics omit sender/group attribution and message content, so none of these calls can be tied to the authorized test or confirm QQ delivery. The owner was unsure whether the prompts had been sent; the closeout operator did not initiate these requests. Group and account identifiers are intentionally omitted from this public document.
- **Still unverified:** live QQ message delivery and real model/search responses; processing real external/user media with FFmpeg; restoring and then reinstalling dependencies and starting an isolated second bridge. No test QQ message or real model call was sent by the closeout operator.

