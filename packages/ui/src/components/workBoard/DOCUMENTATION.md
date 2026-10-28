# Work board (shared UI)

The work board is a full-surface React view over the server's work-board
projection. It renders lanes, cards, the queue column and every control; it does
not classify sessions itself.

## Ownership

- `WorkBoardView.tsx` — the view: tabs, lanes, drag-and-drop, opening a card into
  its session, queue rows, the project queue toggle, and the recovery dialogs.
  Its `mobile` prop renders the same board as a one-lane phone view for the
  mobile shells.
- `WorkBoardCardMenu.tsx` — the board's own menus, in two forms each: the
  three-dot menu in a card's actions row (or a queued row's controls), and the
  same entries on the row's own right-click menu (a phone has neither right
  click nor a free long press, so it keeps the three-dot menu). A card's
  entries are the board's own (start Plan, back to To-do, remove the saved
  to-do, remove the card) and, for a card linked to a session, the session
  actions a sidebar row offers. Pin is not among them: a card already carries
  its own place on the board. A queued row's entries are its own queue actions
  (move up, move down, pause, force, cancel) and the same session actions.
- `workBoardMobileLane.ts` — the last lane the phone showed, remembered per
  client and connected server.
- `workBoardRecentProjects.ts` — the work board projects this device opened,
  remembered per client and connected server, which is what makes the phone's
  project picker recent-first.
- `workBoardWorkflow.ts` — pure helpers: lane ordering within a drop, feedback
  wording, queue rows/entries, tab badges, the attention count the phone's title
  badge shows, and the readers that adapt a server snapshot into what the view
  renders (lane, order, queue state).
- `workBoardSnapshot.fixture.ts` — a test fixture that builds a snapshot the way
  the server projection does.
- `WorkBoardProjectTabs.tsx`, `workBoardProjectState.ts` — project tab strip and
  the project's display name. The strip's `+` opens a project already on the
  board or the folder picker, which adds a new project.
- `WorkBoardProjectMarks.tsx` — the marks a board carries (pending asks, then the
  build queue), in one place, so the desktop tab strip and the phone's project
  picker read a board the same way.
- `WorkBoardMobileProjectPicker.tsx` — the phone's replacement for the tab strip:
  one control naming the board on screen, opening the device's recent-first list
  with each board's marks. Each tab carries its project's build load and,
  beside it, the asks waiting for the user (a question, a permission); the strip
  draws the header's separator behind itself so the selected tab's fill breaks
  the line and its base flares into the board.
- `useSavedTodoComposer.ts`, `workBoardSavedTodo.ts` — the saved-brief surfaces
  shared with the chat composer: the card the board opened is handed to its
  composer as the draft, and the save returns the user to the board. A brief
  handed to a new-session draft belongs to that draft: replacing it (New Plan,
  New To-do) gives the brief back the way Cancel does, so the next draft never
  inherits the card as its own.
- `lib/workBoardApi.ts` — the HTTP contract: stored cards, placements, viewed
  acknowledgement, the projection snapshot, and the project queue settings.

## The projection is the source of truth

The board renders `GET /api/work-board/snapshot` through `useWorkBoardSnapshot`
(`hooks/useWorkBoardSnapshot.ts`). The snapshot carries each card's effective
lane, each lane's order, live activity per session, the ask each session waits
for, the session's own name by id, and the queue's own state
(rows, positions, running lease, forced builds, issue, enablement, queue pause). The client
therefore never:

- polls a history timer — the server derives live activity and history once;
- classifies a session's lane from messages — the server owns the precedence
  (queue, then placement, then history);
- infers a completion order — the server already ordered each lane.

A card and queue row are labelled from the device's own session record first,
then the snapshot's `sessionTitles`, then the id fallback. The snapshot entry is
what a phone that never loaded the session list shows instead of `Session
ses_…`; the local record stays first because session events keep it fresher than
the snapshot interval.

The hook re-reads on the server's `build-queue-updated` and
`work-board-updated` events, on the tab becoming visible, and when the control
stream reconnects. A failed read keeps the last snapshot and reports the error;
it never replaces the board with an empty one.

## Writes and the boundaries they must not cross

Every write goes to the server: placements (`placeWorkBoardCard`,
`placeWorkBoardCards`), edits, removal, viewed acknowledgement, save-to-to-do,
and the queue's own routes. A drag writes the board and nothing else: it never
starts a turn, and it can neither put a card into nor take one out of the build
queue. The queue column is the queue's own management surface: each row's own
controls, and a lane-level control that writes `PUT /api/build-queue/pause` with
`{ directory, paused }`. The header reads `queue.paused` from the projection,
independently of row pause states, and stays available when the queue is empty.
The server holds existing and newly admitted Build entries until the queue is
resumed. Rows show Paused during the queue hold, while their own controls keep
editing their individual pause state. Resuming the queue preserves those
individual pauses. A session's `BuildQueueBanner` can also cancel its own waiting
build; see `chat/composer/DOCUMENTATION.md`. A queued row's pause
control shows a pause glyph, and switches to a lit orange play glyph — kept
visible without hovering — while its item is paused.
Project tab and mobile picker marks include queues manually paused by the user,
including empty paused queues. Review and Git problems retain their more specific
marks when present.

Cancelling a waiting build keeps its prompt. The cancel route answers with the
removed item, and the board hands its text and file references to that session's
draft through `input-store.adoptPrompt` (appended, never replacing the draft),
then says so with an info toast. Only the text and files travel: a queued build
captures no chips. A build whose session cannot be resolved still cancels.

Forcing a waiting build confirms first, and the confirmation asks how the queue
treats the build. The build starts in either case, beside the build already
running: `Force build, queue waits` counts it towards the queue, so the project
starts no further build until it finishes, and `Force build, queue moves on`
leaves the queue to ignore it. The choice travels to the server as the force
route's `mode`. The running row says which of the two it is, `Counts towards
the queue` or `Outside queue`.

Placements are stamped by the server's clock, and each one carries the card
version the client read, so a change made on another device between the read and
the write is a 409 the board reports instead of an overwrite.

The card menu's session actions are the session's own, not board writes: rename
and AI rename title it, archive and delete run through the shared session actions
(a card's session is resolved with the same subtree walk a flat sidebar row uses,
and Delete goes through the global delete dialog), and Export Markdown saves the
conversation. Archiving or deleting leaves the card where it is; its brief is the
only copy of it.

Archiving or deleting a card's session leaves the board on screen. The session
that goes away may be the one the chat behind the board still holds, and the
chat then opens a draft of its own to fill the empty space. That draft is the
chat's fallback, not the user asking to leave, so the board stays where it is
(`components/layout/mainSurfaceDismissal.ts` owns the rule). The user is still
working on the board, and the card they acted on is still on it.

Moving a card to or from Done also syncs the linked session's Done/In-work
state (`setSessionWorkState`). That write is separate and best-effort: the card
is placed even when the session write fails, and the failure is reported on its
own rather than rolled back, so a partial failure is visible. A move that lands a
card in Done from another lane sends `completed`, so the server stamps a new
completion: the card leads Done and its mark returns even after a rebuild.

## The queued row's menu

A waiting queue row carries the same menus a card carries: a three-dot menu and
a right-click menu, both opening one list — the row's own queue actions (move
up, move down, pause, force, cancel) first, then the session actions the other
cards show. The row's title sits beside the menu, so an item names the action
alone and keeps the row's name as its accessible one. A phone has neither right
click nor a free long press, so its row keeps the touch-sized menu alone, and
the desktop row keeps its own inline controls beside the three-dot.

### The running build's menu

A running build has one queue-participation action in its three-dot menu and its
desktop right-click menu. A lease holder or included build offers `Extract from
queue (Q moves on)`. An outside build offers `Include in queue (queue waits)`.
The run continues either way. All running builds render green; green does not
imply exclusive lease ownership. On a phone, the three-dot menu is the action
path.

### Why the queued row's menu holds both lists and not only the session's

A card's menu holds two lists: the card's own board actions, then the session
actions. A queued row is a card's peer, so its menu holds the same two lists
with the row's own queue actions where the card's board actions sit. The
alternative — the session actions alone — opens an empty menu whenever the
queue holds a session the board has not listed yet, and it split the row's
actions over two menus on a phone.

## Ambiguous Force

A build forced outside the queue whose prompt was not confirmed is ambiguous: it
may or may not have started. The projection names that state (`needsReview`, the
targeted `itemId`, a recovery `action`); the board shows it with the error
treatment and a recovery control (`Continue queue` → the queue's resolve route).
It is never rendered as an ordinary running build, and never left without a way
to resolve it. A confirmed forced build can change its queue participation while
it runs.

## Project queue toggle

The board owns the project's queue enablement (`Queue on` / `Queue off`), read
from and written to `GET`/`PUT /api/build-queue/settings`. The toggle writes the
project's own choice, and is optimistic and reverts on a failed write. A project
that never chose follows the instance default set on the Work board settings
page; the Projects page shows that same choice as Follow default / On / Off, so
the two surfaces write one value. The Git policy selector is not here: it lives
in Settings → Work board. The header's Settings button opens this board's
project page on its Work board section, where the project's own enablement, Git
behavior and repository choices sit; the instance defaults stay on Settings →
Work board.

## The board leads the app

The Work board button leads the titlebar cluster on every screen
(`components/layout/TitlebarLeftControls.tsx`), ahead of the sidebar toggle, and
opens the board on the project of the session on screen
(`rememberWorkBoardReturn`). A chip over the chat
(`MainLayout`, shown on chats once a board has been visited) is the same way
back from the chat itself. The board does not render its own title row or its
own close: it keeps the app header's session tabs and controls on the top row
and names itself nowhere, so nothing stacks two headers above the lanes.

### Why the board sits under the app header rather than replacing it

An earlier version gave the board the whole header (its name and a back arrow
in place of the session tabs) and drew a second header of its own under it. Two
rows of chrome pushed the session tabs off the top of the window and printed
the board's name twice. The tabs stay: they are how a session is picked, and
they now sit above the board like they sit above a chat.

### Why the `+` menu also adds a folder

The `+` lists the open tabs' projects and, after a separator, the folder picker
the sidebar and command palette open. A folder picked there becomes a project
the normal way, and its tab follows from the project list, so a project added
from the board is indistinguishable from one added anywhere else.

## Search

The header's search field narrows the card lanes to the cards whose title
contains what was typed, live, as part of one board. It matches the title the
card shows, so a brief-removed card is found by its session's name. The Build
queue keeps its own rows: it shows what the project is building now, and hiding
a running build or a waiting row the query does not name would misstate the
queue. A hidden card is hidden, never removed: it keeps its lane, its order and
its actions, the lane counts follow the query, and a lane's bulk completion
moves only the cards that lane shows. Escape clears the query. The query is
component state, so reopening the board starts with an empty field.

## Mobile presentation

`WorkBoardView` takes a `mobile` prop for the hosted-mobile and Capacitor
shells, which mount it from the sessions drawer. The board reads the same
snapshot, writes through the same routes and keeps every action. Only the
presentation changes. It shows one lane at a time behind a lane picker whose
counts match the lane it opens, replaces the tab strip with a project selector,
moves the queue rows' actions into a touch-sized menu, which carries the session
actions a card's menu shows as well, and scrolls vertically.
A menu item names the action alone, because the row beside it already carries
the card's name and a full title would make the menu wider than the phone; each
item keeps that name as its accessible one. The lane picker remembers the last
lane per client and connected server in `workBoardMobileLane.ts`, and opens on
the queue lane when nothing is stored or storage is blocked. The search field is
not drawn on a phone: one lane at a time is already short enough to read.

A running plan card keeps one line on a phone. The desktop card reserves an
empty status line so it stands the same height as the running build and the
waiting queue rows beside it; with a single lane on screen there is nothing to
line up with, so the reserved line would only make that card taller than the
cards around it. The card still carries the blue band and its working tint,
and the status line appears the moment it has something to say.

The project selector lists the boards this device opened first, most recent at
the top, and carries each board's marks (`WorkBoardProjectMarks`) so the list
says which board is waiting before it is opened. The recency is per client and
connected server (`workBoardRecentProjects.ts`), remembered whenever the phone
opens or switches a board. The shell's title badge shows how many open boards
wait on the user — a queue error, a paused queue, or a pending ask, never a
plain running build (`workBoardsNeedingAttention`) — and tapping it opens the
same selector, so the row is a way in rather than a readout.

The `onLeave` prop dismisses the board. The mobile shells draw the board over
the chat, so opening a session or starting a draft calls it; the desktop shells
pass nothing and close the board surface as before.
