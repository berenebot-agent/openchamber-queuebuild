# Work board (shared UI)

The work board is a full-surface React view over the server's work-board
projection. It renders lanes, cards, the queue column and every control; it does
not classify sessions itself.

## Ownership

- `WorkBoardView.tsx` — the view: tabs, lanes, drag-and-drop, opening a card into
  its session, queue rows, the project queue toggle, and the recovery dialogs.
  Its `mobile` prop renders the same board as a one-lane phone view for the
  mobile shells.
- `WorkBoardCardMenu.tsx` — a card's own three-dot menu: the board's entries
  (start Plan, back to To-do, remove the saved to-do, remove the card) and, for a
  card linked to a session, the session actions a sidebar row offers. Pin is not
  among them: a card already carries its own place on the board.
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
  the project's display name.
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
(rows, positions, running lease, forced builds, issue, enablement). The client
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
controls, and a lane-level control that pauses or resumes every waiting build at
once. (A session's `BuildQueueBanner` can also cancel its own waiting build; see
`chat/composer/DOCUMENTATION.md`.) There is no whole-queue pause on the server, so that control writes each
waiting item's own pause state (one refresh); a build queued after it still
dispatches, and resuming clears rows paused one at a time. A queued row's pause
control shows a pause glyph, and switches to a lit orange play glyph — kept
visible without hovering — while its item is paused.

Cancelling a waiting build keeps its prompt. The cancel route answers with the
removed item, and the board hands its text and file references to that session's
draft through `input-store.adoptPrompt` (appended, never replacing the draft),
then says so with an info toast. Only the text and files travel: a queued build
captures no chips. A build whose session cannot be resolved still cancels.

Placements are stamped by the server's clock, and each one carries the card
version the client read, so a change made on another device between the read and
the write is a 409 the board reports instead of an overwrite.

The card menu's session actions are the session's own, not board writes: rename
and AI rename title it, archive and delete run through the shared session actions
(a card's session is resolved with the same subtree walk a flat sidebar row uses,
and Delete goes through the global delete dialog), and Export Markdown saves the
conversation. Archiving or deleting leaves the card where it is; its brief is the
only copy of it.

Moving a card to or from Done also syncs the linked session's Done/In-work
state (`setSessionWorkState`). That write is separate and best-effort: the card
is placed even when the session write fails, and the failure is reported on its
own rather than rolled back, so a partial failure is visible.

## Ambiguous Force

A build forced outside the queue whose prompt was not confirmed is ambiguous: it
may or may not have started. The projection names that state (`needsReview`, the
targeted `itemId`, a recovery `action`); the board shows it with the error
treatment and a recovery control (`Continue queue` → the queue's resolve route).
It is never rendered as an ordinary running build, and never left without a way
to resolve it. A plain forced build stays display-only.

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
moves the queue rows' actions into a touch-sized menu, and scrolls vertically.
The lane picker remembers the last lane per client and connected server in
`workBoardMobileLane.ts`, and opens on the queue lane when nothing is stored or
storage is blocked. The search field is not drawn on a phone: one lane at a
time is already short enough to read.

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
