import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type {
  AgentNetworkPolicyView,
  AgentNetworkPrefs,
  AgentNetworkTestPolicy,
  AgentNetworkUpdatePrefs,
} from '@open-design/contracts';

import { useI18n } from '../i18n';

export interface AgentNetworkDraft {
  mode: 'inherit' | 'direct' | 'custom';
  proxyUrl: string;
  noProxy: string;
  username: string;
  password: string;
  passwordAction: 'keep' | 'replace' | 'clear';
}

export interface AgentNetworkProxySectionProps {
  agentId: string;
  savedPrefs: AgentNetworkPrefs;
  onDraftChange: (agentId: string, policy: AgentNetworkTestPolicy) => void;
  onSave: (next: AgentNetworkUpdatePrefs) => Promise<AgentNetworkPrefs>;
}

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

type ValidationIssue =
  | 'proxyUrlRequired'
  | 'proxyUrlInvalid'
  | 'proxyUrlTooLong'
  | 'noProxyTooLong'
  | 'usernameTooLong'
  | 'passwordTooLong'
  | 'controlCharacters'
  | 'passwordRequiresUsername';

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);

export function draftFromPolicy(
  policy: AgentNetworkPolicyView | undefined,
): AgentNetworkDraft {
  if (!policy) {
    return {
      mode: 'inherit',
      proxyUrl: '',
      noProxy: '',
      username: '',
      password: '',
      passwordAction: 'keep',
    };
  }
  if (policy.mode === 'direct') {
    return {
      mode: 'direct',
      proxyUrl: '',
      noProxy: '',
      username: '',
      password: '',
      passwordAction: 'keep',
    };
  }
  return {
    mode: 'custom',
    proxyUrl: policy.proxyUrl,
    noProxy: policy.noProxy ?? '',
    username: policy.username ?? '',
    password: '',
    passwordAction: 'keep',
  };
}

function customFields(draft: AgentNetworkDraft) {
  return {
    mode: 'custom' as const,
    proxyUrl: draft.proxyUrl,
    ...(draft.noProxy === '' ? {} : { noProxy: draft.noProxy }),
    ...(draft.username === '' ? {} : { username: draft.username }),
  };
}

export function updateMapFromDraft(
  savedPrefs: AgentNetworkPrefs,
  agentId: string,
  draft: AgentNetworkDraft,
): AgentNetworkUpdatePrefs {
  const next: AgentNetworkUpdatePrefs = { ...savedPrefs };
  if (draft.mode === 'inherit') {
    delete next[agentId];
    return next;
  }
  if (draft.mode === 'direct') {
    next[agentId] = { mode: 'direct' };
    return next;
  }
  next[agentId] = {
    ...customFields(draft),
    ...(draft.passwordAction === 'replace' ? { password: draft.password } : {}),
    ...(draft.passwordAction === 'clear' ? { clearPassword: true } : {}),
  };
  return next;
}

export function testPolicyFromDraft(
  draft: AgentNetworkDraft,
  savedPolicy: AgentNetworkPolicyView | undefined,
): AgentNetworkTestPolicy {
  if (draft.mode === 'inherit') return { mode: 'inherit' };
  if (draft.mode === 'direct') return { mode: 'direct' };
  return {
    ...customFields(draft),
    ...(draft.passwordAction === 'replace' ? { password: draft.password } : {}),
    ...(draft.passwordAction === 'clear' ? { clearPassword: true } : {}),
    ...(draft.passwordAction === 'keep'
      && savedPolicy?.mode === 'custom'
      && savedPolicy.passwordConfigured
      ? { useStoredPassword: true }
      : {}),
  };
}

function validateDraft(draft: AgentNetworkDraft): ValidationIssue | null {
  if (draft.mode !== 'custom') return null;
  if (draft.proxyUrl.length === 0) return 'proxyUrlRequired';
  if (draft.proxyUrl.length > 2_048) return 'proxyUrlTooLong';
  if (draft.noProxy.length > 4_096) return 'noProxyTooLong';
  if (draft.username.length > 256) return 'usernameTooLong';
  if (draft.password.length > 1_024) return 'passwordTooLong';
  if (
    CONTROL_CHARACTERS.test(draft.proxyUrl)
    || CONTROL_CHARACTERS.test(draft.noProxy)
    || CONTROL_CHARACTERS.test(draft.username)
    || CONTROL_CHARACTERS.test(draft.password)
  ) {
    return 'controlCharacters';
  }
  let parsed: URL;
  try {
    parsed = new URL(draft.proxyUrl);
  } catch {
    return 'proxyUrlInvalid';
  }
  if (
    !PROXY_PROTOCOLS.has(parsed.protocol)
    || parsed.hostname === ''
    || (parsed.pathname !== '' && parsed.pathname !== '/')
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.username !== ''
    || parsed.password !== ''
  ) {
    return 'proxyUrlInvalid';
  }
  if (draft.passwordAction === 'replace' && draft.username.length === 0) {
    return 'passwordRequiresUsername';
  }
  return null;
}

const VALIDATION_KEYS: Record<ValidationIssue, Parameters<ReturnType<typeof useI18n>['t']>[0]> = {
  proxyUrlRequired: 'settings.agentNetwork.validation.proxyUrlRequired',
  proxyUrlInvalid: 'settings.agentNetwork.validation.proxyUrlInvalid',
  proxyUrlTooLong: 'settings.agentNetwork.validation.proxyUrlTooLong',
  noProxyTooLong: 'settings.agentNetwork.validation.noProxyTooLong',
  usernameTooLong: 'settings.agentNetwork.validation.usernameTooLong',
  passwordTooLong: 'settings.agentNetwork.validation.passwordTooLong',
  controlCharacters: 'settings.agentNetwork.validation.controlCharacters',
  passwordRequiresUsername: 'settings.agentNetwork.validation.passwordRequiresUsername',
};

export function AgentNetworkProxySection({
  agentId,
  savedPrefs,
  onDraftChange,
  onSave,
}: AgentNetworkProxySectionProps) {
  const { t } = useI18n();
  const groupId = useId();
  const previousSavedPrefsRef = useRef(savedPrefs);
  const dirtyAgentIdsRef = useRef(new Set<string>());
  const [baseline, setBaseline] = useState(savedPrefs);
  const [drafts, setDrafts] = useState<Record<string, AgentNetworkDraft>>(() => ({
    [agentId]: draftFromPolicy(savedPrefs[agentId]),
  }));
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const draft = drafts[agentId] ?? draftFromPolicy(baseline[agentId]);
  const savedPolicy = baseline[agentId];
  const saveState = saveStates[agentId] ?? { status: 'idle' as const };
  const anySaveRunning = Object.values(saveStates).some(
    (state) => state.status === 'saving',
  );
  const validationIssue = validateDraft(draft);

  useEffect(() => {
    if (previousSavedPrefsRef.current === savedPrefs) return;
    previousSavedPrefsRef.current = savedPrefs;
    setBaseline(savedPrefs);
    setDrafts((current) => Object.fromEntries(
      Object.entries(current).map(([draftAgentId, currentDraft]) => [
        draftAgentId,
        dirtyAgentIdsRef.current.has(draftAgentId)
          ? currentDraft
          : draftFromPolicy(savedPrefs[draftAgentId]),
      ]),
    ));
  }, [savedPrefs]);

  useEffect(() => {
    onDraftChange(agentId, testPolicyFromDraft(draft, savedPolicy));
  }, [agentId, draft, onDraftChange, savedPolicy]);

  const updateDraft = (patch: Partial<AgentNetworkDraft>) => {
    dirtyAgentIdsRef.current.add(agentId);
    setDrafts((current) => ({
      ...current,
      [agentId]: { ...(current[agentId] ?? draftFromPolicy(baseline[agentId])), ...patch },
    }));
    setSaveStates((current) => ({ ...current, [agentId]: { status: 'idle' } }));
  };

  const handleSave = async () => {
    if (validationIssue || anySaveRunning) return;
    const savingAgentId = agentId;
    const savingDraft = draft;
    setSaveStates((current) => ({
      ...current,
      [savingAgentId]: { status: 'saving' },
    }));
    try {
      const accepted = await onSave(
        updateMapFromDraft(baseline, savingAgentId, savingDraft),
      );
      dirtyAgentIdsRef.current.delete(savingAgentId);
      setBaseline(accepted);
      setDrafts((current) => ({
        ...current,
        [savingAgentId]: draftFromPolicy(accepted[savingAgentId]),
      }));
      setSaveStates((current) => ({
        ...current,
        [savingAgentId]: { status: 'saved' },
      }));
    } catch (error) {
      setSaveStates((current) => ({
        ...current,
        [savingAgentId]: {
          status: 'error',
          message: error instanceof Error && error.message
            ? error.message
            : t('settings.agentNetwork.saveFailure'),
        },
      }));
    }
  };

  const passwordConfigured = savedPolicy?.mode === 'custom'
    && savedPolicy.passwordConfigured
    && draft.passwordAction === 'keep';

  return (
    <section className="agent-network-section" aria-labelledby={`${groupId}-title`}>
      <div className="agent-network-heading">
        <h4 id={`${groupId}-title`}>{t('settings.agentNetwork.title')}</h4>
        <p id={`${groupId}-hint`} className="hint">
          {t('settings.agentNetwork.hint')}
        </p>
      </div>

      <fieldset className="agent-network-modes" aria-describedby={`${groupId}-hint`}>
        <legend className="sr-only">{t('settings.agentNetwork.modeLegend')}</legend>
        {(['inherit', 'direct', 'custom'] as const).map((mode) => (
          <label className="agent-network-mode" key={mode}>
            <input
              type="radio"
              name={`${groupId}-mode`}
              value={mode}
              checked={draft.mode === mode}
              onChange={() => updateDraft({ mode })}
            />
            <span>{t(`settings.agentNetwork.mode.${mode}`)}</span>
          </label>
        ))}
      </fieldset>

      {draft.mode === 'custom' ? (
        <div className="agent-network-fields">
          <label className="field agent-network-field agent-network-field-wide">
            <span className="field-label">{t('settings.agentNetwork.proxyUrl')}</span>
            <input
              value={draft.proxyUrl}
              placeholder={t('settings.agentNetwork.proxyUrlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${groupId}-status`}
              aria-invalid={validationIssue === 'proxyUrlRequired'
                || validationIssue === 'proxyUrlInvalid'
                || validationIssue === 'proxyUrlTooLong'}
              onChange={(event) => updateDraft({ proxyUrl: event.target.value })}
            />
          </label>
          <p className="agent-network-examples">
            {t('settings.agentNetwork.proxyUrlExamples')}
          </p>
          <label className="field agent-network-field agent-network-field-wide">
            <span className="field-label">{t('settings.agentNetwork.noProxy')}</span>
            <input
              value={draft.noProxy}
              placeholder={t('settings.agentNetwork.noProxyPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${groupId}-status`}
              aria-invalid={validationIssue === 'noProxyTooLong'
                || validationIssue === 'controlCharacters'}
              onChange={(event) => updateDraft({ noProxy: event.target.value })}
            />
          </label>
          <label className="field agent-network-field">
            <span className="field-label">{t('settings.agentNetwork.username')}</span>
            <input
              value={draft.username}
              autoComplete="off"
              aria-describedby={`${groupId}-status`}
              aria-invalid={validationIssue === 'usernameTooLong'
                || validationIssue === 'controlCharacters'}
              onChange={(event) => updateDraft({ username: event.target.value })}
            />
          </label>
          <label className="field agent-network-field">
            <span className="field-label">{t('settings.agentNetwork.password')}</span>
            <input
              type="password"
              value={draft.password}
              autoComplete="new-password"
              aria-describedby={`${groupId}-status`}
              aria-invalid={validationIssue === 'passwordTooLong'
                || validationIssue === 'passwordRequiresUsername'
                || validationIssue === 'controlCharacters'}
              onChange={(event) => updateDraft({
                password: event.target.value,
                passwordAction: 'replace',
              })}
            />
          </label>
          <div className="agent-network-password-state">
            {passwordConfigured ? (
              <span className="agent-network-configured">
                {t('settings.agentNetwork.passwordConfigured')}
              </span>
            ) : null}
            {savedPolicy?.mode === 'custom' && savedPolicy.passwordConfigured ? (
              <Button
                variant="ghost"
                className="agent-network-clear"
                disabled={draft.passwordAction === 'clear'}
                onClick={() => updateDraft({ password: '', passwordAction: 'clear' })}
              >
                {t('settings.agentNetwork.clearPassword')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="agent-network-actions">
        <Button
          variant="primary"
          disabled={Boolean(validationIssue) || anySaveRunning}
          onClick={() => void handleSave()}
        >
          {saveState.status === 'saving'
            ? t('settings.agentNetwork.saving')
            : t('settings.agentNetwork.save')}
        </Button>
        <div
          id={`${groupId}-status`}
          className={`agent-network-status${
            validationIssue || saveState.status === 'error'
              ? ' error'
              : saveState.status === 'saved'
                ? ' success'
                : ''
          }`}
          aria-live="polite"
        >
          {validationIssue ? t(VALIDATION_KEYS[validationIssue]) : null}
          {!validationIssue && saveState.status === 'saved'
            ? t('settings.agentNetwork.saved')
            : null}
          {!validationIssue && saveState.status === 'error'
            ? saveState.message
            : null}
        </div>
      </div>
    </section>
  );
}
