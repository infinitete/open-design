import type { AgentInfo, AgentModelChoice } from '../types';

type AgentModelSource =
  | {
      id: AgentInfo['id'];
      models?: Array<{ id: string; enabled?: boolean; default?: boolean }>;
    }
  | null
  | undefined;

export function defaultAgentModelId(agent: AgentModelSource): string | null {
  const models = agent?.models ?? [];
  return (
    models.find((model) => model.default === true && model.enabled !== false)?.id ??
    models.find((model) => model.enabled !== false)?.id ??
    null
  );
}

export function effectiveAgentModelChoice(
  _agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return choice;
}

export function effectiveAgentModelId(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): string | null {
  const configuredModel = choice?.model?.trim();
  return configuredModel && configuredModel !== 'default'
    ? configuredModel
    : defaultAgentModelId(agent);
}

/**
 * Whether `modelId` may be OFFERED to the user as a selectable model.
 *
 * This is the single definition of "locked" for every model-list surface — the
 * home composer's compact list, the execution-settings picker, and the project
 * composer's `AvatarMenu` list all ask it instead of re-deriving the rule.
 * Every supported agent's list is its own model ids and stays fully
 * selectable; a retired runtime's historical agent id has no catalog and no
 * selectable rows either.
 */
export function agentModelIsSelectable(
  agent: AgentModelSource,
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  if (modelId === 'default') return true;
  const models = agent?.models ?? [];
  // No catalog — nothing to gate against, and no surface can render a row
  // for a model it has not been told about.
  if (models.length === 0) return true;
  const option = models.find((model) => model.id === modelId) ?? null;
  return option !== null && option.enabled !== false;
}
