# Mobile Work Board staging branch

Base: `0f0a758bd2c2c7597c86ffcb79c8425235102224` on 17 October 2026.
Branch: `tmp-mobile-ui`. Do not commit this work to `main` until it has been tested against the latest mainline code.

## Implemented

- The existing Work Board now supports a `mobile` presentation. It uses the same stored cards, session activity, queue snapshots, action endpoints and conflict resolution as desktop.
- The phone/tablet UI has a native project selector, one lane at a time, lane counts, a Build queue switch, touch-sized action menus, and a fullscreen navigation surface.
- Mobile PWA/Capacitor sessions drawer now links to Work Board; its footer keeps primary destinations reachable, with lesser-used pages grouped under More.
- Saving new To-do drafts from the mobile composer is enabled, and opening a board card returns to chat.
- Project Build queue enablement moves to the OpenChamber server's existing persisted message-queue state, and is read by all clients. Legacy locally enabled projects are migrated on initial preference refresh when no explicit server value exists.
- The composer refreshes server queue enablement before submitting an ordinary Build turn. A missing server response blocks that direct Build submission rather than running a build outside the queue.
- The server tags Build-agent messages sent through its shared message-queue API as managed builds when enabled, even if a client's opt-in snapshot was stale.
- Existing server queue integration tests now cover shared enabled-state persistence, restart, Plan exclusion and stale-client submissions. Mobile lane tests cover reopening, server switching and blocked storage.

## Integration

```bash
git fetch origin tmp-mobile-ui
git switch main
git merge --no-ff origin/tmp-mobile-ui
```

This branch is based on the 17 October head; mainline modifications to WorkBoardView, ChatInput, MobileApp or the queue runtime may require conflict resolution. Merge only after the other queue coordinator fixes land.

## Validation still needed

No Bun toolchain or checked-out repository was available in the review environment. The following have not been executed here:

```bash
bun install --frozen-lockfile
bun run check:changed
bun run type-check:ui
bun run type-check:web
bun run --cwd packages/web test -- lib/message-queue/runtime.test.js
bun run --cwd packages/ui test
bun run build:mobile
```

Hands-on checks: mobile web 320px/375px, Android Capacitor, iPad layout; queue enable on one device reflects on another; phone creates To-do and Plan drafts; Plan remains direct; Force/Cancel confirmation and ordering; opening a session dismisses the board; keyboard and safe-area behaviour; server restart retains the setting.

## Deliberate scope limits

Direct external OpenCode API prompting is not intercepted by this queue, and VS Code still has its own local queue. Explicit steering and Force Build also bypass normal sequencing. This staging branch **does not include the separate P1/P2 coordinator safety fixes** identified during code review (Force Build reservation/restart replay, ambiguous-dispatch duplicate execution, and frozen-dispatch races). Apply those on main before unattended usage.
