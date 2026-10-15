import { afterEach, expect, test } from 'bun:test';
import { useConfigStore } from './useConfigStore';
import type { Agent, Model, Provider } from '@/lib/opencode/model';

type Catalog = Provider & { models: Model[] };

const originalState = useConfigStore.getState();

afterEach(() => {
  useConfigStore.setState(originalState, true);
});

const model = (providerID: string, modelID: string, variants?: { id: string }[]): Model => {
  const base = { id: modelID, modelID, providerID, name: modelID };
  // SAFETY: the resolver reads only these fields; the wire record's remaining
  // fields are never consulted by the code under test.
  return (variants ? { ...base, variants } : base) as Model;
};

const provider = (id: string, models: Model[]): Catalog => {
  // SAFETY: the store reads a provider's `id` and its `models`; the wire
  // record carries more the resolver never touches.
  return { id, name: id, models } as Catalog;
};

const agent = (name: string, model?: { providerID: string; id: string; variant?: string }): Agent => {
  const base = { name, displayName: name, mode: 'primary' };
  // SAFETY: the resolver reads `name`, `mode`, and `model`; the wire record
  // carries more the fixture deliberately leaves out.
  return (model ? { ...base, model } : base) as Agent;
};

const base = () => ({
  providers: [provider('anthropic', [
    model('anthropic', 'plan-model', [{ id: 'high' }]),
    model('anthropic', 'settings-model'),
  ]), provider('opencode', [model('opencode', 'big-pickle')])],
  agents: [agent('build'), agent('plan', { providerID: 'anthropic', id: 'plan-model', variant: 'high' })],
  settingsDefaultModel: 'anthropic/settings-model',
  settingsDefaultVariant: undefined,
  opencodeDefaultModel: undefined,
  opencodeDefaultAgent: undefined,
  settingsDefaultAgent: undefined,
  agentModelSelections: {},
  activeDirectoryKey: 'global',
});

/**
 * The Work Board promotes a card on the model the Plan agent would use, and it
 * must read that without repointing the user's open composer — which is exactly
 * what `setAgent` would do.
 */
test('resolves the Plan agent model without mutating the live selection', () => {
  useConfigStore.setState({
    ...base(),
    currentProviderId: 'anthropic',
    currentModelId: 'settings-model',
    currentAgentName: 'build',
    selectionSource: 'auto',
  });

  const resolved = useConfigStore.getState().resolveAgentModel('plan');

  expect(resolved).toEqual({ providerId: 'anthropic', modelId: 'plan-model', variant: 'high' });
  // Reading the Plan model is not choosing it.
  expect(useConfigStore.getState().currentModelId).toBe('settings-model');
  expect(useConfigStore.getState().currentAgentName).toBe('build');
  expect(useConfigStore.getState().selectionSource).toBe('auto');
});

test('prefers a model the user saved for the agent over the agent pin', () => {
  useConfigStore.setState({
    ...base(),
    agentModelSelections: { plan: { providerId: 'anthropic', modelId: 'settings-model' } },
  });

  expect(useConfigStore.getState().resolveAgentModel('plan')).toEqual({
    providerId: 'anthropic',
    modelId: 'settings-model',
    variant: undefined,
  });
});

test('falls back to the settings default when the agent pins no model', () => {
  useConfigStore.setState({
    ...base(),
    agents: [agent('build'), agent('plan')],
  });

  expect(useConfigStore.getState().resolveAgentModel('plan')).toEqual({
    providerId: 'anthropic',
    modelId: 'settings-model',
    variant: undefined,
  });
});

test('falls back to OpenCode config model last, and returns null when nothing resolves', () => {
  useConfigStore.setState({
    ...base(),
    settingsDefaultModel: undefined,
    opencodeDefaultModel: 'opencode/big-pickle',
    agents: [agent('build'), agent('plan')],
  });
  expect(useConfigStore.getState().resolveAgentModel('plan')).toEqual({
    providerId: 'opencode',
    modelId: 'big-pickle',
    variant: undefined,
  });

  useConfigStore.setState({ ...base(), settingsDefaultModel: undefined, opencodeDefaultModel: undefined, agents: [agent('plan')] });
  expect(useConfigStore.getState().resolveAgentModel('plan')).toBeNull();
});
