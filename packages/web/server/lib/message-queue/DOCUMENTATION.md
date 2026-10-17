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
  dispatch loop, event handling, build-queue settings, admission) and
  `registerMessageQueueRoutes(app, runtime)`.
- `admission.js` — the queue's own classification of a wire submission: the
  execution-start guard, the admission decision, and the response shape.
- `build-classification.js` — which submissions are project Build work, from
  live server facts.
- `prompt-admission-routes.js` — the middleware mounted ahead of the OpenCode
  proxy that admits or refuses an execution-starting session call.
- `runtime.test.js` — delivery, idleness gates, retries, holds, persistence,
  concurrency with in-flight sends, slash commands, project knowledge, build
  lanes, settings, admission and the per-session clear.
- `admission.test.js` — classification, guard and response shapes.
- `prompt-admission-routes.http.test.js` — what the middleware queues, refuses
  and forwards, through a real Express stack.

Wiring: created in `server/index.js` after the global event hub and the
session-knowledge runtime; routes registered in
`opencode/feature-routes-runtime.js` (before the generic OpenCode proxy) with
JSON bodies enabled in `opencode/core-routes.js`; stopped by
`opencode/shutdown-runtime.js`.

## Queue enablement

The queue is a property of the **project**, stored in its own config file
(`packages/web/server/lib/projects/project-config.js`, key
`buildQueueEnabled`). Only an explicit off is written; a project that never
chose has no key and reads as enabled. The whole checkout shares one setting,
so every worktree of a project answers the same way while each worktree keeps
its own lane and lease. The directory a request names cannot change the answer:
the server resolves it to its canonical project first, so a prompt cannot opt
itself out of its session's queue by asking with another directory.

`GET /api/build-queue/settings?directory=…` answers `{ enabled }`;
`PUT /api/build-queue/settings` with `{ directory, enabled }` saves it and
answers `{ enabled }`. A directory the server cannot place in a project is 400.
Turning the queue off is refused with 409 while a build is running, being
prepared, being dispatched, or waiting for that project — those builds would
otherwise be stranded.

## Admission

A client can reach OpenCode's own session routes, so a `buildQueue` flag it
sends is a display hint, never authority. The server decides from live facts:

- the **session's agent** (`session.agent`, else the server's default agent),
- whether the project's queue is enabled,
- and the shape of the request (prompt, command, shell, synthetic, skill).

Two paths use that decision.

**Capture.** A request marked with the header `x-openchamber-build-queue:
admit` is taken into the queue instead of running now: `POST
/api/session/:id/prompt` and `/command`. The shared UI marks every prompt and
command it sends (`lib/opencode/client.ts`), never a context synthetic: the
marker states "route this submission", and the classification above still decides
whether it is Build work. The item keeps the wire identity the
prompt arrived with — its message id, files, agents, skills and metadata — and
dispatch replays exactly that, so the client's optimistic row reconciles when
the real admission lands. Each newly admitted slot also captures the session's
model, variant and effective agent on the server, and restores that selection
at dispatch. A session without a model uses the directory's default model;
an unreadable selection refuses admission. As with ordinary merged Build slots,
later submissions keep the first slot's captured selection. Older persisted
admissions without a selection retain their existing session-based behavior.
Catalog and default-model reads use the encoded `x-opencode-directory` header.
The prompt route answers the full `SessionInbox.User`
record the SDK decodes, plus a top-level `queued: true` and the headers
`x-openchamber-queued` / `x-openchamber-queued-id`, which is how a sender learns
its prompt was queued and which optimistic record can settle (a queued prompt is
not a running turn, so the sender leaves live status to the event stream).
Context-only synthetics (`resume: false`) stay unmarked and are admitted
immediately, exactly as a direct send admits them. The
answer is idempotent by the prompt's own message id: a repeat while the item is
waiting, in flight, or already dispatched answers without admitting it twice.
`item.messageId` and `item.messageIds` carry those ids in public snapshots, so a
client that lost the response can confirm admission from the queue.
Prompts merged into one lane slot each keep their own id and payload in
`item.acceptedPrompts`, and dispatch sends them in order with their own files.
Older persisted admissions that lack per-prompt files use the slot's combined
attachments until those items drain. An admitted command gets a server-generated
queue identity when the client supplies none, retains its command name and
arguments, and dispatches through OpenCode's command route even with no arguments.

**Guard.** A request that would start execution on a Build session of an
enabled project, and was not captured, is refused with 409 instead of running
outside the lane. OpenCode starts execution by default and `resume: false` is
the only suppressor, so the guard reads the default as starting: `prompt`,
`command`, `shell`, `synthetic` (unless `resume: false`), and `skill` (unless
`resume: false`) qualify, as does `interrupt?resume=true`. A `move`, an inbox
`steer`, or a cancellation is refused while the queue holds something for that
session (`hasManagedWorkFor`), so a project's work cannot be walked away from.
Deliberately **not** guarded: `compact` (the compaction agent is its own
legitimate turn), `generate` (does not mutate history), and the benign
settings, agent, model, view, instructions and revert calls, none of which start
a turn. Failures are conservative where the queue is the owner: an unreadable
setting, an unreadable session, or an unknown agent refuses, because "unknown"
there could be a bypass; a request with no project to place it in, or a project
with the queue off, passes untouched.

**Delivery.** The prompt the queue dispatches is the turn's own initiator, so it
carries no `delivery` field at all — the same shape an ordinary queued message is
sent with. Stating `queue` here was the bug: upstream parks a `queue` delivery in
the session's inbox, and because the preamble synthetics had just been written to
that session, the user's request stayed pending while the turn ran on the
preamble alone. The preamble (`BUILD_INSTRUCTION`, staged leading context,
attachments, project knowledge) stays context-only (`resume: false`), so it never
starts a turn of its own. The idleness probe is not atomic with the send, so a
direct turn that starts in the gap would still swallow the build as a steer; that
race is the price of the prompt actually starting its turn, and the pre-send
idleness recheck above is the guard against it. An admitted prompt's own delivery
is not replayed. An explicit `steer` bypasses admission only when live status
confirms that session is running; otherwise a marked Build prompt is admitted as a
new queued turn. Ordinary queued messages are left as they were, since a steer
into a running turn is a legitimate thing for the user to have asked for.

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
  messageId?,     // the client's own prompt id, for a prompt admitted from the wire
  acceptedPrompts?, // [{ messageId, admission }]: every prompt this slot owes, in order
  admission?      // { kind, name?, text, files?, delivery, agents, skills, metadata, resume, leading }: how to replay it
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
persisted "sending" flag would strand a message forever. The admission
bookkeeping (which prompt ids were already dispatched) is in-memory too: it is a
dedupe window for a lost response, not durable state, and the window is bounded.

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
(`item.buildQueue`, a `buildOrder`, one lease per directory). One session holds
one lane slot. A Build prompt for a session that already
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
- the working tree satisfies the policy selected in Settings.

The Git policy selector in OpenChamber Settings (Chat page) applies to every
project on the instance, including when its current queue is empty. It has 3
policies:

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
A `dispatch-failed` or `restart-during-dispatch` lease is the other exception:
its own item is still queued, and releasing the lane would let the queue send
that item again. It stays parked for the human, whose Continue or unfreeze
drops the item and releases it. Without this, a lane parked for a turn that
later completed stayed held indefinitely.

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
dispatching.

The forced prompt carries no serialized-build instruction: `sendItem` skips
`BUILD_INSTRUCTION` for it, since the model is not running inside the queue. The
work board shows it above the waiting rows, marked as outside the queue, until
its session's own turn is done.

Every force is reserved before its prompt leaves, and that reservation is written
to the queue file first: a request arriving while the probes run, or a second one
after them, is refused (`409`), so one item cannot be dispatched twice, and a
crash cannot replay a prompt with no record of it. A confirmed send moves the
reservation to the in-memory `forced` list. A send that cannot be confirmed
leaves both the item queued and the reservation in place, flagged
`needsReview: true` with its `itemId` and `action: 'resolve'`; that state survives
a restart (`reviewReason: 'restart-during-force'`) and is never retried
automatically. While the reservation stands the item is not dispatched and
holds no place in the project's runnable order, so the rest of the queue keeps
flowing and the unresolved force never gates it. The user clears it with
`POST /api/build-queue/resolve` (`skip` plus the named `itemId`), which drops
the marker and returns the item to the queue; cancelling the queued item drops
the reservation with it. A `retry` is not accepted for a force.

`GET /api/build-queue` reports running forces and unresolved reservations
together in `forced`, separate from the lease in `active`. A resolved force
clears when the session's turn completes or the session is deleted.

The build snapshot is also the board's display source for a queued or running
build. Each `queued` row, and each `active` and `forced` entry, carries the
`model` the prompt was submitted with (the `sendConfig` captured at admission);
the lease and the forced entries also carry the build's own `content`, bounded
to 300 characters, so a card still shows why it is running after its item has
left the queue.

**Not covered by admission.** Prompts the server itself sends straight to
OpenCode — the session-goal continuation, and the control API's
`POST /api/openchamber/sessions[/:id/send]` dispatch — do not pass through the
middleware, which sits on the OpenChamber HTTP proxy. They keep their previous
behavior: they run immediately rather than joining the lane. A Build session
started from the control API therefore runs its first prompt outside the queue;
use the composer, which the queue covers.

The saved setting applies without a restart. `createMessageQueueRuntime` takes
`settingsFilePath` to point at another instance's file (tests, embedders).

Web, Electron, hosted mobile and Capacitor use this server-owned policy through
the Work Board, which is the one queue management surface. VS Code keeps the
build queue unavailable and retains its existing foreground message delivery
behavior.

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
| `GET /api/build-queue/settings?directory=` | `{ enabled }` for the project that directory belongs to |
| `PUT /api/build-queue/settings` | `{ directory, enabled }` → `{ enabled }`; 409 while that project's builds are running or waiting |
| `POST .../sessions/:id/items` | Append `{ directory, item }`; returns `{ revision, session, itemId }` and arms a dispatch (the session may already be idle) |
| `DELETE .../sessions/:id/items/:itemId` | Remove; `409` while that item is in flight. Returns `{ revision, session, item? }` — the removed item's full payload — so the composer can restore a cancelled build instead of losing the prompt |
| `POST .../sessions/:id/items/:itemId/take` | Remove and return the full item (payloads included); `404`/`409` |
| `POST .../sessions/:id/take` | Remove and return every item not in flight, in order |
| `PUT .../sessions/:id/order` | `{ itemIds }` must be a complete permutation |
| `PUT /api/build-queue/sessions/:id/items/:itemId/pause` | `{ paused: boolean }`; pending managed builds only |
| `POST /api/build-queue/force` | `{ directory, sessionId, itemId }`; start a waiting build now, outside the lease and Git policy, and remove it from the queue |
| `DELETE .../sessions/:id` | Clear; the in-flight item and every managed Build item stay (the project queue owns those; use `/api/build-queue` to cancel one) |
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
work board already reads `GET /api/build-queue`, and the queue
is the authority for order, pause state and the running lease. `wakeProject`
emits it, so every build mutation reaches it, and `enqueue` calls it for a
newly queued build; the preparation lifecycle emits its own as phases advance.
Clients re-read on that event instead of waiting for the next poll, so a build
appears on the board when it was submitted. The read also runs on a control-stream
reconnect, which is the missed-event fallback.

Limits: 20 items per session, 50 sessions (oldest evicted, never one with an
item in flight), 200k characters of content; attachment payloads are bounded
by the route family's 50 MB JSON limit.

## UI ownership

`packages/ui/src/stores/messageQueueStore.ts` is the projection: see its
section in `packages/ui/src/stores/DOCUMENTATION.md`. VS Code intentionally
does not use this module; with all OpenChamber webviews closed, queued
messages there are not delivered.
