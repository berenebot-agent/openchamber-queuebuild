# Message Queue

## Purpose

Owns the messages a user queued while a session was busy, and sends them the
moment the session goes idle. The queue lives in the web server so a closed
tab, a locked phone, or a dropped connection no longer strands it. Structural
template: `permission-auto-accept` — the server is authoritative, the shared UI
renders a projection, and VS Code (which has no server of its own) keeps its
UI-side queue and foreground auto-send hook.

## Files

- `runtime.js` — `createMessageQueueRuntime(...)` (state, persistence,
  dispatch loop, event handling) and `registerMessageQueueRoutes(app, runtime)`.
- `runtime.test.js` — delivery, idleness gates, retries, holds, persistence,
  concurrency with in-flight sends, slash commands, and project knowledge.

Wiring: created in `server/index.js` after the global event hub and the
session-knowledge runtime; routes registered in
`opencode/feature-routes-runtime.js` (before the generic OpenCode proxy) with
JSON bodies enabled in `opencode/core-routes.js`; stopped by
`opencode/shutdown-runtime.js`.

## Auto routing

`resolveAutoSelection` (the routing runtime) runs right before the send when
the queued send config names `openchamber/auto`, and answers with the real
model and agent. OpenCode 2.x holds both on the session, so the queue applies
them with the `POST /api/session/:id/model` and `/agent` calls it already
makes. The queue captures the sentinel like any other send config. The request
text it routes on carries the same image attachment fact as a direct send
(`attachmentHint`).

## Item

An item is what the UI would have sent itself, captured at queue time so the
send never re-resolves mutable UI state:

```
{
  id, createdAt,
  content,        // raw text for display and editing
  contextPreview?, // bounded display-only summary captured by the UI
  text,           // text to deliver (agent mention stripped, file mentions resolved); defaults to content
  agentMention?,  // delivered as an `agent` part
  attachments: [{ id, filename, mimeType, size, source, serverPath?, dataUrl }],
  context: [      // what the composer had attached, in send order
    { kind: 'context', text, metadata, instructions? },  // a draft chip or linked issue/PR; metadata is the UI's structured payload
    { kind: 'instruction', text },                       // derived from the text (skill instruction)
    { kind: 'synthetic', text },                         // handed to the composer by another surface
  ],
  sendConfig: { providerID, modelID, agent?, variant? }   // required
}
```

The server is a courier for `context`: it validates the shape (a kind it
knows, a `metadata` object on `context` entries) and delivers each entry as a
synthetic text part, an entry's `instructions` going out as its own part just
before it and its `metadata` riding the part verbatim so the timeline renders
the context block back. The payload inside `metadata` is the UI's contract
(`lib/messages/contextParts.ts`), parsed by the UI on the way back.

`parseQueuedItemInput` rejects anything the server could not deliver later
(no text, attachments, or context; missing model; malformed attachment or
context entry). Public snapshots and broadcasts strip the payloads —
attachment `dataUrl` (megabytes of base64) and `context` (a PR diff, say) —
so they do not ride every update; the only way to get them back is a `take`.

Snapshots retain `contextPreview`, capped at 100 characters plus an ellipsis.
It carries the attached comment or context label when `content` is empty and
never replaces editable text or delivered parts. Older items without a summary
derive one from the attached comment metadata or the first non-instruction
context text. This optional field needs no queue-file migration.

## Scheduled items

Scheduled tasks use the same items with an optional `scheduledTask` field
containing `projectId` and `taskId`. Reuse does not change the target's goal or
auto-accept policy.
Only the server can enqueue this provenance. Enqueue deduplicates the project
and task across all session queues. A scheduled item can omit its model to
keep the target session selection. Normal composer items still require their
captured model. The UI retains both kinds in the same projection.

Scheduled send guards and terminal result callbacks apply only to scheduled
items. A definitive before-send target or task refusal with 404 or 409 removes
that item and lets the next item proceed. This includes removed or retargeted
tasks and moved targets. Other validation errors and all send failures use the
existing queue retry policy, including model-switch 404 or 409 responses.
Successful send reports `sent` without waiting for an assistant reply. Removing,
clearing or evicting a waiting scheduled item reports `cancelled`. Scheduled
items can be reordered and removed, but cannot be taken for editing or manual
send. Bulk take returns only ordinary items and leaves scheduled items queued.
Disable, delete and retarget use `cancelScheduledTask`. Existing composer
persistence, retries, directory query and delivery gates remain unchanged.

## Queue file

`<data-dir>/message-queue.json` (`OPENCHAMBER_DATA_DIR` or
`~/.config/openchamber`): `{ version, revision, sessions: { [sessionId]:
{ directory, items } } }`, written atomically (temp file + rename) through a
serialized write chain. A missing file is an empty queue. A malformed file is
a failure, not an empty queue: it is moved aside as
`message-queue.json.corrupt-<timestamp>` before the runtime starts empty, so
the next write cannot overwrite the user's data. A failed read leaves writes
disabled until a later load succeeds. `revision` is a global monotonic counter
bumped on every mutation; clients use it to reject stale snapshots.

In-memory only, deliberately: the in-flight item (`sendingId`), retry
backoff, abort timestamps, and holds. A restart has no in-flight sends; a
persisted "sending" flag would strand a message forever.

## Delivery loop

1. `start()` subscribes to the global upstream hub and loads the file; on
   load and on every hub `connect` it arms every session that has items.
2. `session.status` for a queued session: `idle` arms a short quiet timer
   (500 ms, coalescing the burst around a turn boundary), `busy`/`retry`
   clears it. A `message.updated` for a completed assistant reply arms as
   well, so a missed idle event cannot strand the queue. `session.deleted`
   drops the session's queue. An assistant `MessageAbortedError` records an
   abort.
3. `tick(sessionId)` bails when the queue is empty, an item is in flight, or
   the session is held. It re-arms after a 2 s post-abort hold (the UI's
   old behavior: a stop is not immediately followed by the next prompt) or
   while the head item is in retry backoff.
4. Idleness is re-verified against OpenCode before sending, because
   a prompt into a running turn steers into it instead of starting the
   next one: `GET /api/session/active` must not list the session, and the
   trailing message must not be an unfinished assistant reply (that route
   lists only running sessions, so a missed busy event leaves no entry while
   a turn still streams). An unfinished reply created before this
   runtime started does not block: its run died with the previous server and
   will never complete, so a restored queue would wait on it forever. A reply
   with no `created` time still blocks. A failed fetch is unknown, never idle:
   the tick re-arms with backoff.
   The turn must also be over for the session's subagents: a parent idles
   while a background subagent works and runs again when OpenCode hands the
   result back. While `../opencode/session-activity.js` finds a running descendant
   the head waits (the rerun's idle event re-arms it, a 5 s recheck covers a
   missed one); a failed check is unknown and backs off like the rest.
   The descendant check follows live active sessions through at most 8 parent
   links, including idle intermediate subagents; a deeper chain counts as
   unrelated, as in the UI. Unreadable lineage, cycles and the shared fetch
   deadline keep the queue held with the existing retry policy. It does not scan historical child pages.
 5. After the lane and persistence checks, activity and descendants are checked
    once more before the session model, agent or synthetic context is changed.
    If another turn started during preparation, the in-flight mark and build
    lease are cleared and the queued item waits. OpenCode has no atomic
    send-if-idle operation, so a direct send can still begin after this final
    check.
 6. The head is marked in flight (broadcast), then sent. The captured model and
   agent are switched onto the session first (`POST /session/:id/model`,
   `/agent`), because v2 holds both on the session rather than in the body; a
   captured `openchamber/auto` is resolved into a real pair by the routing
   runtime beforehand. Then the captured context goes ahead as synthetic
   messages (`POST /session/:id/synthetic` with `resume: false`, an attached
   item's metadata riding along), followed by pending project knowledge
   (`sessionKnowledgeRuntime.resolvePendingForSession`, recorded as delivered
   only after the send is accepted), and then the message itself:
   - text starting with `/` that names a command in OpenCode's `/command`
     list (skills included) goes to `POST /session/:id/command` (body fields
     `name` and `text` since OpenCode 2.0.8) with its file attachments. The
     command route takes files only, which is why the context went ahead of
     it; sending "/name args" as a prompt instead would skip the template
     OpenCode expands only on that route. The command lookup runs before
     anything is admitted, so a failed lookup fails the send without leaving
     context behind for the retry to duplicate;
   - otherwise `POST /session/:id/prompt` with the user's text, files and
     agent mention.
   Success removes the item, persists, broadcasts, and marks the user
   message sent for notifications. Failure keeps the item, backs off
   2 s → 60 s (doubling per consecutive failure of that item), and re-arms.
 7. The next item goes out after the next busy → idle cycle.

### Project build queue

The fork extends this queue with a project-wide lane for `build`-agent prompts
(`item.buildQueue`, a `buildOrder`, one lease per directory). The composer
captures those prompts, including the first prompt of a new session, which it
queues against a session it creates first
(`packages/ui/src/components/chat/composer/submit/buildQueueRouting.ts`).
One session holds one lane slot. A Build prompt for a session that already
waits appends to the item that session holds — its text, attachments and
context join it, and its id, place in the project order, pause state and
captured selection stay — so a session never appears twice in the pane however
many prompts are pending for it. A prompt for the session that holds the lease
is not a lane entry at all: it joins that session's own queue, the one
OpenChamber delivers when the session goes idle, and an explicit steer is not
intercepted either (a steer exists only for a session that is not idle), so
OpenCode's own inbox takes it into the running turn.
The lane is held for the session, not for one turn: the monitor releases it
only once the session has nothing left to deliver. What the user sent while the
Build ran goes out first, and a pending Build of that same session is the
lane's own next work, so it does not hold the lane.
Pending builds can be paused individually (`item.buildPaused`). Paused items
remain in their project order, can still be reordered or cancelled, and are
skipped when selecting the next runnable build. A paused head still holds its
own session queue; other sessions' unpaused builds may proceed. Resuming arms
dispatch without changing the item's order. Active or already-started builds
cannot be paused.
When the head of a session's queue is a managed build, admission additionally
requires:

- no other session in the same directory currently holds the project's build
  lease (`activeBuilds`), and
- this item is the oldest pending build across every session of that directory
  (`pendingBuilds(directory)[0]`), and
- the working tree satisfies the policy selected in the build queue pane.

The queue pane's "Queue behavior" selector applies to every project on the
instance, including when its current queue is empty. It has 3 policies:

- **Allow continue**, `continue`, skips Git checks and creates no commits.
- **Commit staged changes using model**, `commit`, prepares a clean repository
  before dispatch. The Git service initializes Git when necessary and installs
  the bundled ignore baseline for a new repository. It commits **only files
  explicitly staged in Git** and refuses unstaged/untracked changes or common
  secret patterns before sending the staged diff to OpenCode for the message.
  No other files are staged. There is no confirmation step; staging is the
  explicit selection. A new repository must have its intended files staged
  before preparation succeeds.
- **Pause queue**, `pause`, waits for `git status --porcelain` to report a clean
  working tree. A missing repository or failed check keeps the items queued.
  The existing recheck timer resumes the queue when Git becomes clean or a saved
  policy allows preparation or continuation.

The policy is `buildQueueGitPolicy`, read from the merged settings at admission.
Null or absent keeps the legacy `buildQueueRequireCleanGit` behavior, true for
pause and false for continue. Missing or unreadable settings default to pause.
Existing users never opt into automatic commits through migration. The selector
replaces the old Chat settings checkbox and its Settings search entry.

Preparation reserves the directory before any asynchronous Git or model work.
The Git service serializes index mutations by repository. The queue resolves an
Auto selection for preparation and reuses that selection for the ensuing send.
Preparation uses the policy captured at its start, even if the selector changes
while the model runs. Session and descendant activity are rechecked afterwards,
and dispatch still requires a durable build lease.

`GET /api/build-queue` adds `preparation`, with directory and phase, and `commits`,
with the last successful preparation's directory, hash and subject. Both are
in-memory display state. Preparation phases are `initializing`, `staging`,
`generating` and `committing`. They emit the existing build-queue update event.
The pane shows the phase, the resulting commit and failures beside the selector.

A preparation failure retains queued items and any Git changes already made.
It blocks another model call for that item until "Retry preparation" uses
`POST /api/build-queue/resolve` with `action: 'retry'`, or a different policy
is observed. The existing uncertain-dispatch review flow remains separate.
A restart re-inspects Git; an already completed clean commit is a no-op. A restored running lease is released only when a completed assistant turn is verifiable; otherwise the queue remains paused for manual review.
Live leases that remain verifiably idle without completion evidence for 30 seconds
also enter manual review. Delayed startup can settle during this grace period.
A busy session, active descendant, or failed activity/history read resets the
idle grace period. Unknown status keeps the lease held; it never admits the next
Build.
The Git service's scope, ignore rules and failure contract are documented in
`../git/DOCUMENTATION.md`, under "Automatic build preparation".

An interruption parks the lease synchronously before checking history. The
check reads up to 8 newest-first pages of 50 messages, stopping at the lease's
start. A successful `idle` record after dispatch proves that a later turn was
interrupted; the review flag is cleared and monitoring resumes. A completed
assistant tool step alone does not prove success. Missing, unreadable or
incomplete history keeps the lease paused for human acknowledgement. An
in-flight monitor cannot release a lease parked during its activity reads.

A flagged lane is still monitored, so a flag that has gone stale clears itself
without a human: when the session is idle, no descendant runs and a completed
assistant reply for the lease's own turn exists, the monitor releases the lane.
`persistence-failed` is the one reason that never self-clears — its cause is
storage, and re-dispatching onto a queue that cannot be written is unsafe.
Without this, a lane parked for a turn that later completed stayed held
indefinitely.

A parked lane also holds the queue of the session that owns it. Delivery into
that session is what made the freeze unresolvable: the freeze does not stop an
ordinary message, and the message kept the session busy, so a release gate that
required idleness had nothing idle to see. Held items stay queued and are
delivered once the lane is resolved, before the lane's next build. Other
sessions in the project are unaffected; only the lane's own session is what the
user is being asked about.

Continue acknowledges the reported problem and releases the lease without
rerunning it or changing its files. Release is gated on the lease's own turn
having ended — a terminal `succeeded` or `interrupted` record for it, or an idle
session with nothing of its own span still streaming — not on the session being
idle at that instant. A later turn the user started does not hold the lane
hostage. When such a turn is running, Continue adopts it: the flag is cleared,
the running turn becomes the lane's active build, and the queue resumes when it
ends. Unreadable history still refuses with 409. The UI includes the lease's
`itemId` in the resolve request, so an old confirmation cannot release a
different build. Legacy callers can omit this optional field. The server
retains retry support for pending dispatches; the review banner offers only Open
session and Continue. The common request middleware parses JSON for
`/api/build-queue`, including resolve, reorder and pause requests.

### Unfreezing from the session

A Build prompt submitted to the session that holds a review-frozen lease is the
user unfreezing that lease from the chat the error belongs to. `enqueue` treats
it as the same decision Continue makes: it drops the frozen item, clears the
lease and the project problem, and the new prompt takes the session's lane slot.
Only the lease-holding session can unfreeze itself, and only a Build prompt
counts; a plain message to that session, or a Build prompt to another session in
the same directory, leaves the lane parked.

The lease is released at enqueue without a fresh idle check. Dispatch timing
stays with the tick, so an ambiguous dispatch that really did start leaves the
session busy and the new build waits for that turn to end rather than steering
into it.

`persistence-failed` is the one review reason this does not clear. Its cause is
the queue file failing to write, so an unfreeze would dispatch onto an enqueue
that cannot be persisted either; the lane stays parked until storage is repaired.
A Build prompt from the lease-holding session is rejected with a storage error
while this review is active. The frozen item stays unchanged, so Continue cannot
discard the newly submitted prompt; retry the prompt after repairing storage.

### Forcing a build outside the queue

A waiting build can be started now, outside the queue lane, with
`POST /api/build-queue/force` (`{ directory, sessionId, itemId }`). The project's
lease, its dispatch order and the Git policy are all skipped: the item is sent to
its own idle session through the same `sendItem` path and then removed from the
queue. It takes no lease, so the gate stays free and the rest of the queue keeps
dispatching. It is never parked for review, because the queue does not own it.

The forced prompt carries no serialized-build instruction: `sendItem` skips
`BUILD_INSTRUCTION` for it, since the model is not running inside the queue. The
queue pane and the work board show it above the waiting rows, marked as outside
the queue, until its session's own turn is done.

`GET /api/build-queue` reports these in `forced` (`sessionId`, `directory`,
`startedAt`), separate from the lease in `active`. They are in-memory only, are
never persisted, and clear when the session's turn completes or the session is
deleted. A force whose prompt cannot be confirmed keeps the item queued and
answers with `warning`, because the prompt may have started and there is no lease
to park.

The saved setting applies without a restart. `createMessageQueueRuntime` takes
`settingsFilePath` to point at another instance's file (tests, embedders).

Web, Electron, hosted mobile and Capacitor use this server-owned policy through
their queue pane. VS Code keeps the build queue unavailable and retains its
existing foreground message delivery behavior.

A 2xx HTML app-shell response is a failed dispatch, not acceptance. The queued item stays persisted and uses the existing retry backoff. Project knowledge is recorded as delivered only after the prompt or command is accepted.

## Holds

Auto-review is driven from the UI and bounces the original session through
idle between iterations; the UI tells the server to hold that session's queue
(`PUT .../hold { held: true, ttlMs? }`) while a run is going and releases it
when the run ends. A hold expires on its own (default 5 min, cap 10 min)
because the UI that asserted it may be gone; the UI re-asserts it every two
minutes while the run continues. Its expiry timer wakes queued delivery even if
no session event arrives. Releasing arms a dispatch, and renewing replaces the
previous expiry timer.

## Routes (`/api/message-queue`)

Normal authenticated OpenChamber runtime routes; never on browser URL-token
allowlists.

| Route | Purpose |
|---|---|
| `GET /api/message-queue` | Full snapshot `{ revision, sessions[] }` |
| `POST .../sessions/:id/items` | Append `{ directory, item }`; returns `{ revision, session, itemId }` and arms a dispatch (the session may already be idle) |
| `DELETE .../sessions/:id/items/:itemId` | Remove; `409` while that item is in flight. Returns `{ revision, session, item? }` — the removed item's full payload — so the composer can restore a cancelled build instead of losing the prompt |
| `POST .../sessions/:id/items/:itemId/take` | Remove and return the full item (payloads included); `404`/`409` |
| `POST .../sessions/:id/take` | Remove and return every item not in flight, in order |
| `PUT .../sessions/:id/order` | `{ itemIds }` must be a complete permutation |
| `PUT /api/build-queue/sessions/:id/items/:itemId/pause` | `{ paused: boolean }`; pending managed builds only |
| `POST /api/build-queue/force` | `{ directory, sessionId, itemId }`; start a waiting build now, outside the lease and Git policy, and remove it from the queue |
| `DELETE .../sessions/:id` | Clear; the in-flight item stays |
| `PUT .../sessions/:id/hold` | `{ held, ttlMs? }` |

Every mutation broadcasts `openchamber:message-queue.updated` with
`{ revision, session }` to all connected clients (SSE and WS), so several
devices on one server see one queue. SSE uses the shared control stream at
`/api/openchamber/events`; `/api/global/event` carries no OpenChamber events.
The UI subscribes independently of its OpenCode transport and re-reads the
snapshot whenever either stream reconnects. The session in that payload always names
its `directory`, including the broadcast that removes the last item: the UI
keys its projection by directory, and a broadcast without one left the
delivered message on screen (a session's directory is remembered until the
session is deleted or evicted).

Build-lane changes additionally broadcast `openchamber:build-queue.updated` with
`{ directory }` to every connected client. It carries no snapshot because the
build pane and the work board already read `GET /api/build-queue`, and the queue
is the authority for order, pause state and the running lease. `wakeProject`
emits it, so every build mutation reaches it, and `enqueue` calls it for a
newly queued build; the preparation lifecycle emits its own as phases advance.
Clients re-read on that event instead of waiting for the next poll, so a build
appears in the pane and on the board when it was submitted. The poll remains as
the reconnect and missed-event fallback.

Limits: 20 items per session, 50 sessions (oldest evicted, never one with an
item in flight), 200k characters of content; attachment payloads are bounded
by the route family's 50 MB JSON limit.

## UI ownership

`packages/ui/src/stores/messageQueueStore.ts` is the projection: see its
section in `packages/ui/src/stores/DOCUMENTATION.md`. VS Code intentionally
does not use this module; with all OpenChamber webviews closed, queued
messages there are not delivered.
