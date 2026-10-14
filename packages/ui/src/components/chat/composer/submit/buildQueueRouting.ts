/**
 * Whether a composer submit belongs in the project build queue.
 *
 * The project build queue serializes Build-agent prompts one at a time per
 * project, but it only serializes what the composer hands it. The "hand it
 * over" rule has to read the same way in two very different submit shapes: a
 * send into an existing session, and the first message of a session that is
 * still a draft with no session id yet. Keeping the rule here as a pure
 * predicate lets both call it and lets it be tested without mounting the
 * composer.
 */

export interface BuildQueueSubmitFacts {
    /** The server-owned queue runtime delivers this client's messages. */
    serverOwnedQueue: boolean;
    /** Shell mode sends a command, not a prompt. */
    inputMode: 'normal' | 'shell' | undefined;
    /** A BTW panel owns the composer; its prompts are not project builds. */
    isBtwActive: boolean;
    /** The agent the composer would send with. */
    agentName: string | undefined;
    /** The target directory opted into the project build queue. */
    directoryEnabled: boolean;
    /** There is content worth sending. */
    hasContent: boolean;
    /** The text that would be sent, used to leave slash commands alone. */
    message: string;
    /** A queue-only submit is already queue work. */
    queuedOnly: boolean;
    /** A steer must not bypass a project-managed Build queue. */
    hasDelivery: boolean;
}

export const shouldQueueBuildPrompt = (facts: BuildQueueSubmitFacts): boolean =>
    facts.serverOwnedQueue
    && facts.inputMode === 'normal'
    && !facts.isBtwActive
    && !facts.queuedOnly
    && facts.directoryEnabled
    && facts.hasContent
    && facts.agentName?.toLowerCase() === 'build'
    && !facts.message.trimStart().startsWith('/');
