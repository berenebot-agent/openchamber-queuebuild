# Work board

The work board groups project work into To-do, Plan, Queued, Building, and Done.
The existing Build queue panel remains available while a session is open.
Open it from the **Work board** button in the session sidebar header. Choose
a project and a model in the board header. The board includes saved To-do cards
and that project's top-level sessions in its root directory. Worktree directories
retain their own Build queues.

## Save a to-do

Write the initial brief in the chat composer and attach files, then choose
**Save to To-do**. The text and files are saved on the OpenChamber server.
Saving does not create an OpenCode session or call a model. The composer clears
only after the server confirms the save.

To-do cards live on the board. They do not add empty sessions to the sidebar.

## Start planning

**Start Plan** creates a Plan session and submits the card's text and files as
its first prompt. The card retains its saved contents and links to the session.
Opening a linked card takes you to its chat.
Choose an explicit model for this action. Auto routing is unavailable for
promotion because it may select a different agent.
Edit an unstarted card on the board to change its text, add files, or remove files.

If session creation or submission fails, the saved brief remains available.
A card that already links to a session must be inspected before attempting
another submission. A lost response can mean the original prompt was accepted.

## Continue work

Build submissions use the existing project Build queue. Queued and active work
is shown using the queue's server state. Open the session and choose the Build
agent to submit implementation work through the normal composer. A successful,
settled Build turn moves to Done. Done does not certify tests or a release.
Failed or stopped turns show an attention notice. An unavailable status stays
visible as an error and is never treated as proof of completion.

Returning an idle card to To-do preserves the linked conversation and saved
brief. It does not revert files or delete session history.
Submitting another Plan or Build prompt returns the card to the corresponding
lane. Changing the composer agent without submitting does not move it.

## Supported interfaces

The first version provides the board in web and Electron desktop chat. VS Code
and the dedicated mobile layouts do not provide a board entry point.
Stored cards belong to the OpenChamber server and are available to other
browser profiles connected to that server.
The board refreshes stored cards on focus, after writes, and every 30 seconds
while visible. Live turn status is checked every 5 seconds. History reads are
bounded and cached until the session changes.
