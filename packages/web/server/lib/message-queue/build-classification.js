// Which submissions are project Build work.
//
// The client cannot decide this. A browser can post a prompt to the OpenCode
// proxy directly, and any `buildQueue` flag it attaches is a display hint at
// best — nothing stops a different client from sending a false one. The
// session is the authority: a prompt is Build work when the session it targets
// runs the `build` agent, the shell/slash shape is a normal prompt, and the
// project it belongs to has the queue enabled.
//
// The classification runs on live server facts (session record, agent list,
// command list), never on a request body's own claim about itself. Those facts
// are parsed here, at the boundary that reads OpenCode: everything below works
// on the parsed values.

import { z } from 'zod';

const BUILD_AGENT = 'build';

/** The fields of a session record the classification reads. */
export const modelFactSchema = z.object({
  id: z.string().min(1),
  providerID: z.string().min(1),
  variant: z.string().min(1).optional(),
});

const sessionFactSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1).nullish(),
  parentID: z.string().min(1).nullish(),
  model: modelFactSchema.nullish(),
});

/** `/api/agent`: the id and default mark of each agent. */
const agentFactSchema = z.array(z.object({
  id: z.string().min(1),
  default: z.boolean().optional(),
  isDefault: z.boolean().optional(),
}));

/** `/api/command`: the name and agent of each command. */
const commandFactSchema = z.array(z.object({
  name: z.string().min(1),
  agent: z.string().nullish(),
}));

export const parseSessionFact = (value) => sessionFactSchema.safeParse(value);
export const parseAgentFacts = (value) => agentFactSchema.safeParse(value);
export const parseCommandFacts = (value) => commandFactSchema.safeParse(value);

/**
 * The agent a prompt on this session actually runs, or null when it cannot be
 * established. `session.agent` is the selection OpenCode holds; a session that
 * never chose one runs the server's default agent, which the caller passes in.
 */
export const resolveTurnAgent = ({ session, defaultAgent }) => session?.agent || defaultAgent || null;

export const isBuildAgentName = (value) => value.toLowerCase() === BUILD_AGENT;

/**
 * Whether this prompt is Build work.
 *
 * Refusals are deliberate and each one has a reason:
 * - a slash command is resolved against OpenCode's own command list: a command
 *   that names `build` (its `agent` field) is Build work, anything else is not.
 *   An unknown command is not build work — it reaches OpenCode as typed.
 * - shell mode is a terminal command, never a build turn.
 * - an explicit steer into a running turn belongs to that session's own inbox
 *   and must not be re-queued; the queue only serializes new turns.
 * - a review/BTW child session (`parentID`) is not a project build.
 */
export const classifySubmission = ({
  session,
  defaultAgent = null,
  kind = 'prompt',
  text = '',
  delivery = null,
  running = false,
  commandAgent = null,
  commandResolved = false,
}) => {
  if (!session) return { build: false, reason: 'no-session' };
  if (session.parentID) return { build: false, reason: 'child-session' };
  if (kind === 'shell') return { build: false, reason: 'shell' };
  // A steer exists only for a session that is not idle; queueing it would
  // change what the user asked for.
  if (delivery === 'steer' && running) return { build: false, reason: 'steer' };

  const trimmed = text.trimStart();
  if (kind === 'command' || trimmed.startsWith('/')) {
    if (!commandResolved) return { build: false, reason: 'unresolved-command' };
    return commandAgent && isBuildAgentName(commandAgent)
      ? { build: true, reason: 'command-build' }
      : { build: false, reason: 'command-not-build' };
  }

  const agent = resolveTurnAgent({ session, defaultAgent });
  if (!agent) return { build: false, reason: 'unknown-agent' };
  return isBuildAgentName(agent)
    ? { build: true, reason: 'agent' }
    : { build: false, reason: 'agent-not-build' };
};

/**
 * The `agent` a slash command runs under, or null when the command is unknown.
 * A command that names none answers ''. Read from OpenCode's command list, so a
 * command a project defines as Build work is honoured without hardcoding names.
 */
export const commandAgentOf = (commands, name) => {
  const command = commands?.find((entry) => entry.name === name);
  if (!command) return null;
  return command.agent ?? '';
};

/** The slash command a prompt names, or '' when it is not one. */
export const slashCommandNameOf = (text) => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return '';
  const [head] = trimmed.split(/\s+/, 1);
  return head.slice(1);
};
