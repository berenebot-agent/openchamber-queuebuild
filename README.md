# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/openchamber-logo-dark.svg"><img src="docs/references/badges/openchamber-logo-light.svg" width="32" height="32" align="absmiddle" /></picture> OpenChamber

[![GitHub stars](https://img.shields.io/github/stars/openchamber/openchamber?style=flat&labelColor=100F0F&color=66800B)](https://github.com/openchamber/openchamber/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/openchamber/openchamber?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/openchamber/openchamber/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-join.svg?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)
[![Support the project](https://img.shields.io/badge/Support-Project-black?style=flat&labelColor=100F0F&color=EC8B49&logo=patreon&logoColor=FFFCF0)](https://www.patreon.com/openchamber)

<a href="https://www.blacksmith.sh/"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/blacksmith-dark.svg"><img src="docs/references/badges/blacksmith-light.svg" height="28" alt="CI powered by Blacksmith" /></picture></a>

## Run agent work. Keep control. Ship from anywhere.

**OpenChamber is an open-source workspace for running and reviewing AI coding work on desktop, web, VS Code, and mobile.**

Start agent work, see what changed, and take it through review and release. Your projects and sessions remain available when you switch devices or step away.

![OpenChamber Chat](docs/references/chat_example.png)

<details>
<summary>More screenshots</summary>

![VS Code Extension](packages/vscode/extension.jpg)

<p>
<img src="docs/references/pwa_chat_example.png" width="45%" alt="OpenChamber PWA chat">
<img src="docs/references/pwa_diff_example.png" width="45%" alt="OpenChamber PWA diff review">
</p>

</details>

## Berenebot fork: Queue Build

This fork adds **project-wide serial Build execution** for OpenCode agent sessions. You can plan different features in multiple sessions and enqueue the implementation turns without waiting for each previous one to finish.

1. Open your project, then select **Build queue** from the right-hand context rail and turn on **Enabled** for that project.
2. Continue using **Plan** mode freely in as many existing sessions as you need.
3. Select the **Build** agent in a session and send your implementation prompt. Its submission is added to the project queue; it does not start while another managed build is running.
4. Repeat from other sessions. The composer shows each session's queue position. Use the right-hand queue panel to reorder, cancel, or open those sessions.
5. When the active Build turn finishes, the server checks Git status. A clean repository starts the next turn; uncommitted or untracked changes pause the queue and require manual cleanup.

**Safety:** Builds receive a reminder to run tests and commit *only their own changes*. The server never automatically stages, commits, stashes, resets, or deletes unrelated working-tree files. Queue state and active leases survive browser disconnects and server restarts (subject to an accessible OpenCode backend).

**Initial scope:** This applies to existing sessions using the web/desktop OpenChamber composer with its queue preference enabled. New-session creation, external OpenCode API clients, and VS Code's separate queue implementation are not intercepted. Sessions from distinct worktree directories have separate queues. The enabled setting is local to each browser profile, while queued jobs live on the server.

**Running this fork:** Build/deploy the server and frontend from this repository instead of using upstream's published OpenChamber Docker image. Keep the existing OpenChamber data directory mounted persistently so queue state is retained. The included Docker Compose file builds this fork locally:

```bash
git clone https://github.com/berenebot-agent/openchamber-queuebuild.git
cd openchamber-queuebuild
# Until the pull request is merged:
git switch feat/project-build-queue
export OPENCHAMBER_UI_PASSWORD='replace-with-a-strong-password'
docker compose up -d --build
```

After a successful build, open `http://localhost:3000`. Persist the included `./data` and `./workspaces` bind mounts, or change their paths in the Compose file before deploying.

## What you can do with OpenChamber

### Work board in this fork

Open **Work board** from the session sidebar to see To-do, Plan, Queued,
Building, and Done columns. Use **Save to To-do** in the composer to save text
and files without starting an LLM. **Start Plan** creates a planning session
from the saved brief. The Build queue remains available inside chats.
See the [work board guide](docs/WORK_BOARD.md) for promotion, recovery, and
supported interfaces.

### Goals that continue on their own

Give a session a finish line with **Session Goals**. OpenChamber checks the result after every turn and keeps the agent working until it completes the goal, gets blocked, or reaches the limit you set. It can continue after you close the app.

### Compare and combine runs

Use **Multi-run** to give the same task to up to five models, each in its own session and optionally its own worktree. See what each one actually built, choose the best result, or use **Fusion** to combine the strongest parts into a new session.

### Guided changes walkthroughs

**Changes Walkthrough** turns a large diff into an AI-guided tour of the change. It groups related edits into steps, puts them in the order the change makes sense, and explains how the pieces fit together.

### Inspect a running app

Open your app beside the conversation with **Preview**. Point at an element to send the agent its screenshot, styles, position, and browser errors. No more trying to explain "this thing here." The desktop app can do the same with any web page in its built-in browser.

### GitHub context from issue to pull request

Start a session from a GitHub issue or pull request with its context attached. Send failed checks or review comments back to the agent, then update or merge the pull request from OpenChamber.

### Continue on another device

Open the same projects and sessions from Desktop, Web/PWA, VS Code, iOS, or Android. Check progress, answer questions, review changes, and reattach to a running terminal.

### Private remote access

Pair a device with a one-time QR code and connect through **Private Relay** without opening ports or exposing a public server. The connection is end-to-end encrypted and can be revoked at any time. Direct connections, LAN/VPN access, Cloudflare/Ngrok tunnels, and SSH are also supported.

### Track work across projects

See which sessions are working, waiting, finished, or failed, along with approvals, scheduled tasks, provider limits, token use, and costs. Organize sessions into folders and keep notes, todos, and reusable project actions nearby.

### Schedule recurring work

Run a prompt once, daily, weekly, or on a cron schedule. Scheduled tasks can use Session Goals, so they continue toward an outcome instead of stopping after one response.

## Use it where you work

| Surface | Role |
| --- | --- |
| **Desktop** | The complete workspace for macOS, Windows, and Linux, with multiple windows, Mini Chat, remote machines, SSH, and native notifications |
| **Web / PWA** | Open your workspace in a browser, install it as an app, and stay up to date through background notifications |
| **VS Code** | Keep sessions beside your code, send selections to the agent, open results in the editor, and compare parallel runs |
| **iOS / Android** | Review and steer work away from your desk, receive completion alerts, and use the terminal with touch controls |
| **CLI / Server** | Run OpenChamber on a workstation or server, schedule work, manage remote access, and keep it available after login |

## Quick start

### Desktop for macOS, Windows, and Linux

Download the latest release from [GitHub Releases](https://github.com/openchamber/openchamber/releases/latest). Desktop bundles the matching OpenCode CLI, so no separate OpenCode installation is required.

Linux releases come for x86_64 and ARM64 as a `.deb` (Debian, Ubuntu), an `.rpm` (Fedora, openSUSE) and an AppImage. The packages install OpenChamber into the app menu, and in-app updates ask for your password to install the new package:

```bash
sudo apt install ./OpenChamber-*-linux-amd64.deb    # Debian, Ubuntu
sudo dnf install ./OpenChamber-*-linux-x86_64.rpm   # Fedora
```

The AppImage needs no install. Make it executable and keep it in a writable location for in-app updates; on its first start it adds itself to the app menu:

```bash
chmod +x OpenChamber-*.AppImage
./OpenChamber-*.AppImage
```

Linux AppImages require FUSE (`libfuse.so.2`). Without FUSE, run with `APPIMAGE_EXTRACT_AND_RUN=1`.

### VS Code

Install [OpenChamber from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=fedaykindev.openchamber), or search for "OpenChamber" in Extensions.

### CLI for Web and PWA

Requires Node.js 24.14+. CLI/Web and VS Code use your installed [OpenCode CLI](https://opencode.ai).

```bash
curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash
openchamber --ui-password be-creative-here
```

Common operations:

```bash
openchamber status
openchamber connect-url --qr
openchamber tunnel start --provider cloudflare --mode quick --qr
openchamber startup enable
openchamber logs
openchamber stop
openchamber update
```

OpenChamber binds to localhost by default. Use `--lan` only on a trusted network and protect browser access with `--ui-password`.

## Guides

Go deeper with the OpenChamber guides:

- [Quick start](packages/docs/content/docs/quickstart.mdx)
- [Installation](packages/docs/content/docs/install.mdx)
- [Connect devices](packages/docs/content/docs/connect-devices.mdx)
- [Private Relay](packages/docs/content/docs/private-relay.mdx)
- [Multi-run](packages/docs/content/docs/multi-run.mdx)
- [Session Goals](packages/docs/content/docs/session-goals.mdx)
- [Changes Walkthrough](packages/docs/content/docs/walkthrough.mdx)
- [Preview and dev servers](packages/docs/content/docs/preview.mdx)
- [GitHub workflows](packages/docs/content/docs/github.mdx)
- [Mobile](packages/docs/content/docs/mobile.mdx)
- [Security](packages/docs/content/docs/security.mdx)
- [Troubleshooting](packages/docs/content/docs/troubleshooting.mdx)

For self-hosting details, see the [reverse proxy guide](docs/REVERSE_PROXY.md). For custom theme authoring, see the [custom themes guide](docs/CUSTOM_THEMES.md).

## Why OpenCode?

OpenChamber uses [OpenCode](https://opencode.ai) to run coding agents. We chose it because it is open source, has a solid API, and is easy to extend.

OpenChamber handles the rest of the workflow. You can decide what to try, keep the agent on track, review the result, connect from another device, and ship the change.

OpenChamber is an independent project and is not affiliated with the OpenCode team.

## Contributing

Bug fixes and small improvements are welcome as PRs. Features and behavior changes start in an [Ideas discussion](https://github.com/openchamber/openchamber/discussions/categories/ideas) so we agree on the product side before anyone writes code. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR; it has the setup, the review contract, and what happens to large unplanned PRs. Documentation authoring guidance lives in [`packages/docs`](packages/docs/README.md).

Bugs go to [issues](https://github.com/openchamber/openchamber/issues/new/choose). Questions go to [Q&A discussions](https://github.com/openchamber/openchamber/discussions/categories/q-a).

## Acknowledgments

Special thanks to:

- [OpenCode](https://opencode.ai) for the API and open-source architecture OpenChamber builds on
- [Pierre](https://pierrejs-docs.vercel.app/) for the diff viewer and syntax highlighting
- The [T3 Code](https://github.com/pingdotgg/t3code) team for their browser adapter for [libghostty-vt](https://github.com/ghostty-org/ghostty), which our terminal is built on
- [Yulia Ivashko](https://github.com/yulia-ivashko), who built the firework celebration that plays on every successful push
- Everyone who contributed code, reported bugs, or shared ideas

## License

MIT
