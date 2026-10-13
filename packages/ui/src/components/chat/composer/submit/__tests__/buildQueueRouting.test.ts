import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldQueueBuildPrompt, type BuildQueueSubmitFacts } from '../buildQueueRouting';

const facts = (overrides: Partial<BuildQueueSubmitFacts> = {}): BuildQueueSubmitFacts => ({
    serverOwnedQueue: true,
    inputMode: 'normal',
    isBtwActive: false,
    agentName: 'build',
    directoryEnabled: true,
    hasContent: true,
    message: 'implement the thing',
    queuedOnly: false,
    hasDelivery: false,
    ...overrides,
});

describe('shouldQueueBuildPrompt', () => {
    test('queues a build prompt for a directory that opted in', () => {
        expect(shouldQueueBuildPrompt(facts())).toBe(true);
    });

    test('keeps plan prompts in the ordinary send path', () => {
        expect(shouldQueueBuildPrompt(facts({ agentName: 'plan' }))).toBe(false);
    });

    test('leaves slash commands to their own routers', () => {
        expect(shouldQueueBuildPrompt(facts({ message: '  /compact' }))).toBe(false);
    });

    test('does not intercept a directory that has not opted in', () => {
        expect(shouldQueueBuildPrompt(facts({ directoryEnabled: false }))).toBe(false);
    });

    test('does not intercept shell mode, BTW, queue-only or steer submits', () => {
        expect(shouldQueueBuildPrompt(facts({ inputMode: 'shell' }))).toBe(false);
        expect(shouldQueueBuildPrompt(facts({ isBtwActive: true }))).toBe(false);
        expect(shouldQueueBuildPrompt(facts({ queuedOnly: true }))).toBe(false);
        expect(shouldQueueBuildPrompt(facts({ hasDelivery: true }))).toBe(false);
    });

    test('needs something to send', () => {
        expect(shouldQueueBuildPrompt(facts({ hasContent: false }))).toBe(false);
    });

    test('runs only where the server owns the queue', () => {
        expect(shouldQueueBuildPrompt(facts({ serverOwnedQueue: false }))).toBe(false);
    });
});

const chatInputSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ChatInput.tsx'),
    'utf-8',
);

describe('the composer routes both submit shapes through the predicate', () => {
    // ChatInput's import graph keeps it out of bun test, so the wiring is
    // guarded at the source, the way the neighbouring composer tests guard
    // theirs. The regression this protects: a build prompt that starts a new
    // session came out of the draft path and never reached the queue.
    test('an existing session and a new-session draft both use the rule', () => {
        expect(chatInputSource).toContain('shouldQueueBuildPrompt({');
        expect(chatInputSource).toContain('queueBuildFromDraft');
        expect(chatInputSource).toContain('materializeOpenDraftSession(');
    });
});
