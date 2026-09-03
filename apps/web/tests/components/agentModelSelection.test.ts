import { describe, expect, it } from 'vitest';
import {
  agentModelIsSelectable,
  defaultAgentModelId,
  effectiveAgentModelChoice,
  effectiveAgentModelId,
} from '../../src/components/agentModelSelection';
import type { AgentInfo } from '../../src/types';

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'default', label: 'Default' },
    { id: 'gpt-5.4', label: 'GPT 5.4', enabled: true },
    { id: 'gpt-5.4-mini', label: 'GPT 5.4 mini', enabled: false },
  ],
};

describe('agent model selection', () => {
  it('keeps saved choices unchanged (no hosted-runtime normalization remains)', () => {
    // The hosted runtime whose plan-gated catalog motivated coercion away of
    // locked picks is retired; a saved choice is submitted verbatim.
    const choice = { model: 'gpt-5.4', reasoning: 'medium' };
    expect(effectiveAgentModelChoice(codexAgent, choice)).toEqual(choice);
  });

  it('resolves the effective model id through the declared default', () => {
    expect(effectiveAgentModelId(codexAgent, { model: 'default' })).toBe('default');
    expect(effectiveAgentModelId(codexAgent, undefined)).toBe('default');
    expect(effectiveAgentModelId(codexAgent, { model: 'gpt-5.4' })).toBe('gpt-5.4');
  });

  it('does not select a disabled model as the default when every catalog row is locked', () => {
    const lockedCatalog: AgentInfo = {
      ...codexAgent,
      models: [
        { id: 'gpt-5.4', label: 'GPT 5.4', enabled: false },
        { id: 'gpt-5.4-mini', label: 'GPT 5.4 mini', enabled: false, default: true },
      ],
    };

    expect(defaultAgentModelId(lockedCatalog)).toBeNull();
    expect(effectiveAgentModelChoice(lockedCatalog, undefined)).toBeUndefined();
  });

  // `agentModelIsSelectable` is the gate every model-list surface asks before
  // offering a row: offering a model the runtime would reject means the click
  // is written and then fails, which the user reads as "the picker ignored
  // me".
  describe('agentModelIsSelectable', () => {
    it('refuses a model the catalog marks disabled', () => {
      expect(agentModelIsSelectable(codexAgent, 'gpt-5.4-mini')).toBe(false);
    });

    it('allows every enabled model, plus the default sentinel', () => {
      expect(agentModelIsSelectable(codexAgent, 'gpt-5.4')).toBe(true);
      expect(agentModelIsSelectable(codexAgent, 'default')).toBe(true);
    });

    it('still refuses every model when the whole catalog is disabled', () => {
      const allLocked: AgentInfo = {
        ...codexAgent,
        models: [
          { id: 'gpt-5.4', label: 'GPT 5.4', enabled: false },
          { id: 'gpt-5.4-mini', label: 'GPT 5.4 mini', enabled: false },
        ],
      };
      expect(agentModelIsSelectable(allLocked, 'gpt-5.4')).toBe(false);
    });

    it('refuses an id that is not in the catalog at all', () => {
      expect(agentModelIsSelectable(codexAgent, 'gpt-6')).toBe(false);
    });

    it('allows anything while the catalog has not loaded', () => {
      expect(agentModelIsSelectable({ id: 'codex', models: [] }, 'anything')).toBe(true);
    });

    it('allows agents without a catalog anything, including custom ids', () => {
      const noCatalog: AgentInfo = { ...codexAgent, models: [] };
      expect(agentModelIsSelectable(noCatalog, 'custom-codex-model')).toBe(true);
    });

    it('refuses an empty model id', () => {
      expect(agentModelIsSelectable(codexAgent, '')).toBe(false);
      expect(agentModelIsSelectable(codexAgent, null)).toBe(false);
    });
  });

  it('keeps custom model choices unchanged', () => {
    const noCatalog: AgentInfo = { ...codexAgent, models: [] };
    expect(
      effectiveAgentModelChoice(noCatalog, {
        model: 'custom-codex-model',
        reasoning: 'high',
      }),
    ).toEqual({
      model: 'custom-codex-model',
      reasoning: 'high',
    });
  });
});
