# Work board

The work board groups project work into To-do, Plan, Queued, Building, and Done.
The existing Build queue panel remains available while a session is open.
Open it from the **Work board** button in the session sidebar header. Project
tabs across the board header switch between project boards. Choose **+** to add
another project tab, or close a tab to hide it from the board. Closing a tab
does not remove its project or cards. The open tabs and selected project are
saved per runtime and restored when the app restarts. The board includes saved
To-do cards and the selected project's top-level sessions in its root
directory. Worktree directories retain their own Build queues.

Choose **+** in the To-do column header to start a card. It opens a composer already set to
**To-do**, so the brief saves instead of running a model, and the To-do chip is
highlighted while that mode is active. A board the user has opened keeps a
**Work Board** button beside the chat in every session, which returns to the
board's last project.
The **+** buttons in Plan and Building open a fresh composer for the board's
project with the corresponding agent selected. Nothing runs until submission.
Build submissions enter the existing queue and may appear in Queued first.

## Save a to-do

Write the initial brief in the chat composer and attach files, then choose
**To-do** in the agent picker and submit to save. The text and files are saved
on the OpenChamber server. Saving a new-session draft does not create an
OpenCode session or call a model. Saving from an existing idle session links
the card to that conversation. Remove queued messages and wait for active work
to finish before parking an existing session. The composer clears only after
the server confirms the save. If the session becomes busy while To-do is
selected, its notes stay in the composer and cannot be queued for execution.

Saving a new-session draft returns to that project's board with a
**Saved to To-do** dialog showing the full saved text and attachment downloads.
Saving in an existing session keeps that session open. Its saved brief appears
at the end of the transcript in a **Saved to To-do** entry, including after
reopening the session or refreshing the page. Existing linked cards also appear
there without conversion. The entry reads the server card, so edits and removal
of that card also change what is shown in the session. It is not an OpenCode
user turn and does not send context or start a model.

Session entries are scoped by session ID, including when the session lives in a
worktree and its card belongs to the root project's board. A failed read keeps
the last loaded text visible and offers **Try again**. Session and runtime
changes discard reads that finish for the previous session or server.

To-do cards live on the board. They do not add empty sessions to the sidebar.

## Start planning

**Start Plan** creates a Plan session and submits the card's text and files as
its first prompt. The card retains its saved contents and links to the session.
Opening a linked card takes you to its chat.
The board starts the Plan turn on the model the Plan agent would use in a fresh
chat, resolved through the usual defaults. The board has no model picker; to run
a particular model, open the card's session and change it in the chat composer.
Auto routing is unavailable for promotion because it may select a different
agent.
Edit an unstarted card on the board to change its text, add files, or remove files.

If session creation or submission fails, the saved brief remains available.
A card that already links to a session must be inspected before attempting
another submission. A lost response can mean the original prompt was accepted.

## Continue work

Build submissions use the existing project Build queue. Queued and active work
is shown using the queue's server state. Open the session and choose the Build
agent to submit implementation work through the normal composer. A successful,
settled Build turn moves to Done. Done does not certify tests or a release.
Linked cards show the same live activity icons as the session list, including
background subagents and commands. The appearance setting for animated activity
indicators applies to cards too. Finished unread turns show the session list's
unread icon.

Failed or stopped unread turns show an attention notice. Opening the session
from the board or session list clears that notice and the unread icon. Another
unread failed or stopped turn can show the notice again. Build-queue recovery
warnings remain until resolved, even after opening the session.
An unavailable status stays visible as an error and is never treated as proof
of completion.
Compact cards retain these notices below their titles. Linked-card removal
and return actions wait for known session and queue state.

Returning an idle card to To-do preserves the linked conversation and saved
brief. It does not revert files or delete session history.
Submitting another Plan or Build prompt returns the card to the corresponding
lane. Changing the composer agent without submitting does not move it.

## Complete cards

Done is sorted by the successful Build turn's finish time, newest first.
Session creation dates and unrelated session updates do not affect this order.

An idle To-do or Plan card offers **Move to Done** in its card menu. This also
works for inherited sessions that have never been saved as board cards. Manual
completion is saved on the server and uses its completion time for Done ordering.
Submitting a later Plan or Build prompt reopens the card. Completion preserves
the conversation and never starts, stops, or cancels work.

The three-dot menu beside Plan's **+** offers **Move all cards to Done**.
The confirmation lists the cards and their count for the selected project.
Busy cards and cards with unavailable status are excluded, with their count
shown. The server rechecks idleness and saved-card revisions before each move.
If some moves fail, successful moves remain saved and the board reports the
failed cards. Refresh before retrying cards that changed during confirmation.

## Supported interfaces

The first version provides the board in web and Electron desktop chat. VS Code
and the dedicated mobile layouts do not provide a board entry point.
Hosted mobile and Capacitor session views can read saved linked briefs from the
same server. VS Code does not request board-backed session entries.
Stored cards belong to the OpenChamber server and are available to other
browser profiles connected to that server.
The board refreshes stored cards on focus, after writes, and every 30 seconds
while visible. Activity icons subscribe to the session list's live status index.
Lane classification also checks turn status every 5 seconds. History reads are
bounded and cached until the session changes.
