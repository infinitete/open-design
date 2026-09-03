// InlineModelSwitcher — top-bar chip exposing CLI/BYOK + model picker.
//
// Lives in the entry view's sticky top-bar so users can swap between a
// local CLI and BYOK (and the active model under either) without having
// to open the full Settings dialog. The chip is intentionally narrow —
// it shows the active mode + agent/provider + model in one line and
// opens a compact popover for switching. All persistence is delegated
// upward through the same callbacks `AvatarMenu` already uses, so the
// switcher inherits autosave + daemon sync without re-implementing it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { VisuallyHidden } from '@open-design/components';
import { useT } from '../i18n';
import {
  agentIdToTracking,
  byokProtocolToTracking,
  modelIdForTracking,
} from '@open-design/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import { getResolvedDeviceId } from '../analytics/client';
import {
  trackDeepSeekCampaignModelBenefitSurfaceView,
  trackExecutionSettingsPopoverClick,
} from '../analytics/events';
import { KNOWN_PROVIDERS } from '../state/config';
import { fetchProviderModels } from '../providers/provider-models';
import { SUGGESTED_MODELS_BY_PROTOCOL } from '../state/apiProtocols';
import type { AgentInfo, ApiProtocol, AppConfig, ExecMode } from '../types';
import { apiProtocolLabel } from '../utils/apiProtocol';
import { isVisibleLocalCliAgent } from '../utils/visibleAgents';
import { AgentIcon } from './AgentIcon';
import { Icon } from './Icon';
import { modelProviderIconSrc } from './modelProviderIcon';
import {
  agentModelIsSelectable,
  defaultAgentModelId,
  effectiveAgentModelChoice,
} from './agentModelSelection';
import {
  orderModelOptionsByAvailability,
  SearchableModelSelect,
} from './modelOptions';
import {
  mergeProviderModelOptions,
  providerModelsCacheKey,
  type ProviderModelsCache,
} from './providerModelsCache';
import { isDeepSeekV4FlashCampaignModel } from '../campaigns/deepseek-v4-flash';
import { useDeepSeekV4FlashCampaignVisibility } from '../campaigns/use-deepseek-v4-flash-campaign';

const workspaceBillingBalanceUsd = (..._a: unknown[]): string | null => null;
const useWorkspaceContext = (): { context: { workspaceType?: string; permissions?: Record<string, boolean> } | null; loading: boolean } => ({ context: null, loading: false });
function PlanBadge(_p: Record<string, unknown>) { return null; }
const useWorkspaceBillingResponse = (..._a: unknown[]) => null;

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  providerModelsCache?: ProviderModelsCache;
  compact?: boolean;
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string; serviceTier?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  /** Lets the home picker warm the shared cache itself. Without it the picker
   *  only READS the cache (warmed by Settings/onboarding), so on a fresh load
   *  the BYOK list falls back to the small static seed list. */
  onProviderModelsCacheChange?: Dispatch<SetStateAction<ProviderModelsCache>>;
  onOpenSettings: (
    section?:
      | 'execution'
      | 'media'
      | 'composio'
      | 'language'
      | 'appearance'
      | 'notifications'
      | 'about',
  ) => void;
}

const API_PROTOCOL_TABS: Array<{ id: ApiProtocol; title: string }> = [
  { id: 'anthropic', title: 'Anthropic' },
  { id: 'openai', title: 'OpenAI' },
  { id: 'azure', title: 'Azure' },
  { id: 'google', title: 'Google' },
  { id: 'aihubmix', title: 'AIHubMix' },
];

function displayAgentName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.name;
}

function displayAgentChipName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return displayAgentName(agent);
}

export function InlineModelSwitcher({
  config,
  agents,
  providerModelsCache,
  compact = false,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onProviderModelsCacheChange,
  onOpenSettings,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  // Both flags are reserved presentation branches with no trigger wired yet:
  // `campaignRestricted` (已暂停 badge) is reserved for the backend
  // usage-limit signal — no trigger wired yet — and `campaignNeedsUpgrade`
  // (升级可用 badge) is reserved for a real unpaid-audience signal reaching
  // this component. Until those land, every campaign badge renders the paid
  // state.
  const campaignRestricted = false;
  const campaignNeedsUpgrade = false;
  const campaignVisibility = useDeepSeekV4FlashCampaignVisibility();
  const campaignModelBadge = campaignRestricted
    ? t('campaign.deepseekV4Flash.restricted.modelBadge')
    : campaignNeedsUpgrade
      ? t('campaign.deepseekV4Flash.unpaid.modelBadge')
      : t('campaign.deepseekV4Flash.paid.modelBadge');
  const campaignModelTooltip = campaignRestricted
    ? t('campaign.deepseekV4Flash.restricted.tooltip')
    : campaignNeedsUpgrade
      ? t('campaign.deepseekV4Flash.unpaid.tooltip')
      : t('campaign.deepseekV4Flash.ruleSummary');
  const campaignBadgeStateClass = campaignRestricted
    ? ' is-restricted'
    : campaignNeedsUpgrade
      ? ' is-unpaid'
      : '';
  const {
    context: workspaceContext,
    loading: workspaceContextLoading,
  } = useWorkspaceContext();
  const workspaceBillingResponse = useWorkspaceBillingResponse();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const campaignBenefitTrackedForOpenRef = useRef(false);
  // Viewport clamp for the popover (issue #99): the anchor chip can sit
  // anywhere on screen (home hero mid-page, chat composer at the bottom), so
  // a fixed downward placement runs past the screen edge once the model list
  // is long. Measured on open: cap the height to the space on the chosen
  // side and flip upward when below is tight.
  const [popoverPlacement, setPopoverPlacement] = useState<{
    up: boolean;
    maxHeight: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPlacement(null);
      return;
    }
    const update = () => {
      const anchor = wrapRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewportHeight = window.innerHeight;
      const below = viewportHeight - anchor.bottom - 16;
      const above = anchor.top - 16;
      const up = below < 280 && above > below;
      setPopoverPlacement({
        up,
        maxHeight: Math.max(160, Math.min(560, up ? above : below)),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const providerModelsFetchingRef = useRef<Set<string>>(new Set());

  const getModelPopoverBoundary = useCallback(() => {
    const scrollContainer = wrapRef.current?.closest<HTMLElement>(
      '.entry-main--scroll',
    );
    const scrollRect = scrollContainer?.getBoundingClientRect();
    const topbarRect = scrollContainer
      ?.querySelector<HTMLElement>('.entry-main__topbar')
      ?.getBoundingClientRect();
    return {
      top: Math.max(8, (topbarRect?.bottom ?? scrollRect?.top ?? 0) + 8),
      right: Math.min(
        window.innerWidth - 8,
        (scrollRect?.right ?? window.innerWidth) - 8,
      ),
      bottom: Math.min(
        window.innerHeight - 8,
        (scrollRect?.bottom ?? window.innerHeight) - 8,
      ),
      left: Math.max(8, (scrollRect?.left ?? 0) + 8),
    };
  }, []);

  const handleAgentButtonClick = useCallback(
    (agentId: string) => {
      trackExecutionSettingsPopoverClick(analytics.track, {
        page_name: 'home',
        area: 'execution_settings_popover',
        element: 'agent_card',
        cli_provider_id: agentIdToTracking(agentId),
      });
      onAgentChange?.(agentId);
    },
    [analytics.track, onAgentChange],
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      const target = e.target as Node;
      if (wrapRef.current.contains(target)) return;
      // The model picker (`SearchableModelSelect`) renders its option list in a
      // portal on `document.body`, so a click on an option lands OUTSIDE
      // `wrapRef`. Without this guard the mousedown would close the whole
      // switcher panel before the option's click fires, unmounting the picker
      // and dropping the selection — the model would never change.
      if (
        target instanceof Element &&
        target.closest('.model-select-searchable__popover')
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const scrollContainer = wrapRef.current?.closest('.entry-main--scroll');
    if (!(scrollContainer instanceof HTMLElement)) return;
    let frame = 0;
    const updateAnchorVisibility = () => {
      frame = 0;
      const trigger = chipRef.current;
      const triggerRect = trigger?.getBoundingClientRect();
      if (!triggerRect) return;
      const scrollRect = scrollContainer.getBoundingClientRect();
      const topbar = scrollContainer.querySelector<HTMLElement>('.entry-main__topbar');
      const anchorInTopbar = trigger ? topbar?.contains(trigger) === true : false;
      const topbarBottom = topbar?.getBoundingClientRect().bottom;
      const safeTop = anchorInTopbar
        ? scrollRect.top
        : Math.max(scrollRect.top, topbarBottom ?? scrollRect.top);
      const safeBottom = Math.min(window.innerHeight, scrollRect.bottom);
      const safeLeft = Math.max(0, scrollRect.left);
      const safeRight = Math.min(window.innerWidth, scrollRect.right);
      if (
        triggerRect.bottom <= safeTop ||
        triggerRect.top >= safeBottom ||
        triggerRect.right <= safeLeft ||
        triggerRect.left >= safeRight
      ) {
        setOpen(false);
      }
    };
    const scheduleVisibilityUpdate = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(updateAnchorVisibility);
    };
    updateAnchorVisibility();
    scrollContainer.addEventListener('scroll', scheduleVisibilityUpdate, {
      passive: true,
    });
    window.addEventListener('resize', scheduleVisibilityUpdate);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      scrollContainer.removeEventListener('scroll', scheduleVisibilityUpdate);
      window.removeEventListener('resize', scheduleVisibilityUpdate);
    };
  }, [open]);

  const installedAgents = useMemo(
    () => agents.filter((a) => a.available && isVisibleLocalCliAgent(a)),
    [agents],
  );
  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );
  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const effectiveCurrentChoice = effectiveAgentModelChoice(currentAgent, currentChoice) ?? currentChoice;
  const currentAgentId = currentAgent?.id ?? null;
  const normalizedCurrentModelId = effectiveCurrentChoice.model ?? null;
  const normalizedCurrentReasoning = effectiveCurrentChoice.reasoning;
  const normalizedCurrentServiceTier = effectiveCurrentChoice.serviceTier;
  const currentAgentModels = currentAgent?.models ?? [];
  const currentAgentModelIds = currentAgentModels.map((m) => m.id);
  const configuredModelId =
    typeof effectiveCurrentChoice.model === 'string' && effectiveCurrentChoice.model
      ? effectiveCurrentChoice.model
      : null;
  const currentModelId =
    configuredModelId ?? defaultAgentModelId(currentAgent);
  const currentModelOption =
    currentAgentModels.find((m) => m.id === currentModelId) ?? null;
  // `agentId` and `agentModels` intentionally retain the last local-agent
  // choice while BYOK is active so switching back restores that choice. Do
  // not let campaign UI read that dormant state: in BYOK mode the visible
  // model comes from `config.model` and usage is billed by the user's provider.
  const deepSeekCampaignVisibleForCurrentExecution =
    campaignVisibility.visible
    && config.mode === 'daemon';

  const unlimitedBadgeForModel = useCallback(
    (
      modelId: string | null | undefined,
    ): { label: string; tooltip: string | null; stateClass: string } | null => {
      // Same guard the campaign uses: in BYOK mode the visible model is billed
      // by the user's own provider, and a dormant selection must not leak an
      // entitlement claim onto it.
      if (config.mode !== 'daemon') return null;
      if (
        deepSeekCampaignVisibleForCurrentExecution
        && isDeepSeekV4FlashCampaignModel(modelId)
      ) {
        return {
          label: campaignModelBadge,
          tooltip: campaignModelTooltip,
          stateClass: campaignBadgeStateClass,
        };
      }
      return null;
    },
    [
      campaignBadgeStateClass,
      campaignModelBadge,
      campaignModelTooltip,
      config.mode,
      deepSeekCampaignVisibleForCurrentExecution,
    ],
  );


  const currentModelLabel =
    currentModelOption?.label ?? null;
  const inlineAgentModelOptions = useMemo(
    () => orderModelOptionsByAvailability(currentAgentModels),
    [currentAgentModels],
  );

  /**
   * The ONLY path from a model row to `onAgentModelChange` in this component.
   * Both model lists (the compact home list and the execution-settings picker)
   * write through here, so the availability gate cannot be forgotten by a list
   * added later — there is no second sink to forget it in. Returns false when
   * the pick was refused, which is the signal a row should not close the panel
   * or report a selection that did not happen.
   */
  const applyAgentModel = useCallback(
    (modelId: string, extra?: { serviceTier?: string }) => {
      const agentId = currentAgent?.id;
      if (!agentId) return false;
      if (!agentModelIsSelectable(currentAgent, modelId)) {
        return false;
      }
      onAgentModelChange?.(agentId, { model: modelId, ...extra });
      return true;
    },
    [currentAgent, onAgentModelChange],
  );

  /**
   * Compact-list rows carry the same verdict the sink enforces, so a locked row
   * is rendered as locked instead of as a normal row whose click silently
   * reverts (issue: clicking a model in the home list did nothing).
   */
  const compactModelRows = useMemo(
    () =>
      inlineAgentModelOptions.map((model) => ({
        model,
        selectable: agentModelIsSelectable(currentAgent, model.id),
      })),
    [currentAgent, inlineAgentModelOptions],
  );

  useEffect(() => {
    if (!open) {
      campaignBenefitTrackedForOpenRef.current = false;
      return;
    }
    if (!compact || !deepSeekCampaignVisibleForCurrentExecution
      || campaignBenefitTrackedForOpenRef.current) {
      return;
    }
    // One impression per campaign model actually on screen, not one for the
    // popover: the campaign runs two models and product compares their reach
    // separately, so a single row-agnostic event would make Pro and Flash
    // indistinguishable in the funnel.
    const visibleCampaignModelIds = compactModelRows
      .filter(({ model }) => isDeepSeekV4FlashCampaignModel(model.id))
      .map(({ model }) => model.id);
    if (visibleCampaignModelIds.length === 0) return;
    campaignBenefitTrackedForOpenRef.current = true;
    for (const modelId of visibleCampaignModelIds) {
      trackDeepSeekCampaignModelBenefitSurfaceView(analytics.track, {
        page_name: 'home',
        area: 'execution_settings_popover',
        element: 'deepseek_v4_pro_benefit',
        campaign_id: 'deepseek_v4_pro',
        user_state: campaignNeedsUpgrade ? 'unpaid' : 'paid',
        model_id: modelId,
      });
    }
  }, [
    analytics.track,
    campaignNeedsUpgrade,
    compact,
    compactModelRows,
    deepSeekCampaignVisibleForCurrentExecution,
    open,
  ]);


  const apiProtocol = config.apiProtocol ?? 'anthropic';
  const providerForProtocol = useMemo(
    () =>
      KNOWN_PROVIDERS.find(
        (p) =>
          p.protocol === apiProtocol &&
          (config.apiProviderBaseUrl
            ? p.baseUrl === config.apiProviderBaseUrl
            : false),
      ) ?? KNOWN_PROVIDERS.find((p) => p.protocol === apiProtocol),
    [apiProtocol, config.apiProviderBaseUrl],
  );
  const providerModelsKey = useMemo(
    () =>
      providerModelsCacheKey(
        apiProtocol,
        config.baseUrl,
        config.apiKey,
        config.apiVersion ?? '',
      ),
    [apiProtocol, config.apiKey, config.apiVersion, config.baseUrl],
  );
  const fetchedApiModelOptions = providerModelsCache?.[providerModelsKey] ?? [];

  // Warm the shared provider-models cache from the home picker itself. The
  // picker otherwise depends on Settings/onboarding having fetched first, so on
  // a fresh load the BYOK list shows only the small static seed list instead of
  // the live catalogue. We fetch when the panel is open in BYOK mode and the
  // preconditions for the active protocol are met (AIHubMix's catalogue is
  // public, so it needs no key; every other protocol needs one). Results are
  // keyed identically to Settings (`providerModelsKey`), so a single fetch
  // serves both surfaces and replaces any stale slot.
  useEffect(() => {
    if (!open || config.mode !== 'api' || !onProviderModelsCacheChange) return;
    if (apiProtocol === 'azure' || apiProtocol === 'ollama') return;
    if (apiProtocol !== 'aihubmix' && !config.apiKey.trim()) return;
    const baseUrl = config.baseUrl.trim();
    if (!/^https?:\/\//i.test(baseUrl)) return;
    const key = providerModelsKey;
    if (fetchedApiModelOptions.length) return;
    if (providerModelsFetchingRef.current.has(key)) return;
    providerModelsFetchingRef.current.add(key);
    let active = true;
    void fetchProviderModels({
      protocol: apiProtocol,
      baseUrl,
      apiKey: config.apiKey,
    })
      .then((result) => {
        if (active && result.ok && result.models?.length) {
          onProviderModelsCacheChange((current) => ({
            ...current,
            [key]: result.models ?? [],
          }));
        }
      })
      .catch(() => {
        // Non-fatal: the picker falls back to the static seed list.
      })
      .finally(() => {
        providerModelsFetchingRef.current.delete(key);
      });
    return () => {
      active = false;
    };
  }, [
    open,
    config.mode,
    config.apiKey,
    config.baseUrl,
    apiProtocol,
    providerModelsKey,
    fetchedApiModelOptions.length,
    onProviderModelsCacheChange,
  ]);

  const suggestedApiModelIds = useMemo(
    () =>
      Array.from(
        new Set(
          providerForProtocol?.preferredModels.length
            ? providerForProtocol.preferredModels
            : SUGGESTED_MODELS_BY_PROTOCOL[apiProtocol],
        ),
      ),
    [apiProtocol, providerForProtocol],
  );
  const apiModelOptions = useMemo(
    () => mergeProviderModelOptions(fetchedApiModelOptions, suggestedApiModelIds),
    [fetchedApiModelOptions, suggestedApiModelIds],
  );
  const apiModelIds = useMemo(
    () => apiModelOptions.map((model) => model.id),
    [apiModelOptions],
  );
  const apiModelChoices = useMemo(
    () => apiModelOptions.map((model) => ({ ...model, label: model.label })),
    [apiModelOptions],
  );

  // Chip text — keep it tight so the pill doesn't wrap on small viewports.
  // CLI: "Claude · Sonnet 4.5"; BYOK: "Anthropic · sonnet-4.5".
  const chipMode =
    config.mode === 'daemon'
      ? t('inlineSwitcher.chipCli')
      : t('inlineSwitcher.chipByok');
  const chipPrimary =
    config.mode === 'daemon'
      ? currentAgent
        ? displayAgentChipName(currentAgent)
        : t('inlineSwitcher.noAgent')
      : apiProtocolLabel(apiProtocol);
  const chipModel =
    config.mode === 'daemon'
      ? isDeepSeekV4FlashCampaignModel(currentModelId)
        ? currentModelLabel ?? 'DeepSeek V4 Flash'
        : currentModelLabel && currentModelId !== 'default'
          ? currentModelLabel
          : t('inlineSwitcher.modelDefault')
      : config.model.trim() || t('inlineSwitcher.modelDefault');

  const chipUnlimitedBadge = unlimitedBadgeForModel(currentModelId);

  // Compact home chip surfaces the selected model name + a connection-status
  // dot; label/tooltip fall back to the agent name. In CLI mode the agent's
  // `available` flag is the connection signal (reachable on PATH); API/BYOK is
  // a user-configured endpoint, treated as connected.
  const chipConnected =
    config.mode === 'daemon' ? currentAgent?.available === true : true;
  const chipAgentLabel = currentAgent
    ? displayAgentName(currentAgent)
    : t('inlineSwitcher.chipTitle');

  const handleChipClick = useCallback(() => {
    setOpen(!open);
  }, [open]);

  return (
    <div
      className={`inline-switcher${compact ? ' inline-switcher--compact' : ''}`}
      ref={wrapRef}
      data-testid="inline-model-switcher"
    >
      <button
        ref={chipRef}
        type="button"
        className={
          'inline-switcher__chip od-tooltip' +
          (compact ? ' inline-switcher__chip--icon' : '')
        }
        data-testid="inline-model-switcher-chip"
        onClick={handleChipClick}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          compact
            ? `${chipAgentLabel} · ${chipModel}`
            : `${chipMode} · ${chipPrimary} · ${chipModel}`
        }
        data-tooltip={
          compact
            ? `${chipAgentLabel} · ${chipModel}`
            : `${chipMode} · ${chipPrimary} · ${chipModel}`
        }
        data-tooltip-placement="bottom"
      >
        {compact ? (
          <>
            {/* Same agent logo (with the BYOK link-glyph fallback) the full
                chip leads with, so the compact pill still says which agent the
                model belongs to. */}
            <span className="inline-switcher__chip-icon" aria-hidden="true">
              {config.mode === 'daemon' && currentAgent ? (
                <AgentIcon id={currentAgent.id} size={18} />
              ) : (
                <span className="inline-switcher__byok-glyph">
                  <Icon name="link" size={14} />
                </span>
              )}
            </span>
            {/* Divider sits right after the agent logo; the status dot then
                leads the model name so the dot reads as part of the model
                label rather than trailing the logo. */}
            <span className="inline-switcher__chip-divider" aria-hidden="true" />
            <span
              className="inline-switcher__chip-conn"
              data-connected={chipConnected ? 'true' : 'false'}
              aria-hidden="true"
            />
            <span className="inline-switcher__chip-model-name">{chipModel}</span>
            {chipUnlimitedBadge ? (
              <span
                className={
                  'inline-switcher__campaign-badge'
                  + (chipUnlimitedBadge.tooltip ? ' od-tooltip' : '')
                  + chipUnlimitedBadge.stateClass
                }
                data-tooltip={chipUnlimitedBadge.tooltip ?? undefined}
                data-tooltip-placement={chipUnlimitedBadge.tooltip ? 'top' : undefined}
                aria-label={chipUnlimitedBadge.tooltip ?? undefined}
                data-testid="inline-model-switcher-chip-unlimited-badge"
              >
                {chipUnlimitedBadge.label}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="inline-switcher__chip-icon" aria-hidden="true">
              {config.mode === 'daemon' && currentAgent ? (
                <AgentIcon id={currentAgent.id} size={18} />
              ) : (
                <span className="inline-switcher__byok-glyph">
                  <Icon name="link" size={14} />
                </span>
              )}
            </span>
            <span className="inline-switcher__chip-text">
              <span className="inline-switcher__chip-mode">{chipMode}</span>
              <span className="inline-switcher__chip-sep" aria-hidden="true">
                ·
              </span>
              <span className="inline-switcher__chip-primary">{chipPrimary}</span>
              <span className="inline-switcher__chip-sep" aria-hidden="true">
                ·
              </span>
              <span className="inline-switcher__chip-model">{chipModel}</span>
            </span>
            <Icon
              name="chevron-down"
              size={12}
              className="inline-switcher__chip-chevron"
            />
          </>
        )}
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className={`inline-switcher__popover${popoverPlacement?.up ? ' inline-switcher__popover--up' : ''}`}
          role="menu"
          data-testid="inline-model-switcher-popover"
          style={popoverPlacement ? { maxHeight: `${popoverPlacement.maxHeight}px`, overflowY: 'auto' } : undefined}
        >
          {compact ? null : (
          <div className="inline-switcher__row">
            <span className="inline-switcher__label">
              {t('inlineSwitcher.modeLabel')}
            </span>
            <div className="inline-switcher__seg" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={config.mode === 'daemon'}
                className={
                  'inline-switcher__seg-btn' +
                  (config.mode === 'daemon' ? ' is-active' : '')
                }
                data-testid="inline-model-switcher-mode-daemon"
                disabled={!daemonLive && config.mode !== 'daemon'}
                onClick={() => {
                  trackExecutionSettingsPopoverClick(analytics.track, {
                    page_name: 'home',
                    area: 'execution_settings_popover',
                    element: 'mode_local_cli',
                  });
                  // Optional-call so a transient Fast Refresh state where a
                  // parent has not yet re-rendered with the new prop signature
                  // does not crash the entire entry view. The same defensive
                  // pattern is applied to every callback below.
                  onModeChange?.('daemon');
                  if (!daemonLive) {
                    setOpen(false);
                    onOpenSettings?.('execution');
                  }
                }}
                title={
                  !daemonLive
                    ? t('inlineSwitcher.daemonOffline')
                    : t('inlineSwitcher.useCli')
                }
              >
                {t('inlineSwitcher.chipCli')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={config.mode === 'api'}
                className={
                  'inline-switcher__seg-btn' +
                  (config.mode === 'api' ? ' is-active' : '')
                }
                data-testid="inline-model-switcher-mode-api"
                onClick={() => {
                  trackExecutionSettingsPopoverClick(analytics.track, {
                    page_name: 'home',
                    area: 'execution_settings_popover',
                    element: 'mode_byok',
                  });
                  onModeChange?.('api');
                }}
                title={t('inlineSwitcher.useByok')}
              >
                {t('inlineSwitcher.chipByok')}
              </button>
            </div>
          </div>
          )}

          {/* The popover body always reflects the ACTIVE execution mode:
              `compact` only chooses layout density, never which catalogue is
              on offer. A BYOK chip therefore always opens onto the BYOK
              provider's model list (regression: the compact home popover kept
              listing the local CLI agent's cloud models while the chip showed
              the BYOK model). */}
          {config.mode === 'api' ? (
            <>
              {compact ? null : (
              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.providerLabel')}
                </span>
                <div className="inline-switcher__chips" role="tablist">
                  {API_PROTOCOL_TABS.map((tab) => {
                    const active = apiProtocol === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={
                          'inline-switcher__chip-tab' +
                          (active ? ' is-active' : '')
                        }
                        data-testid={`inline-model-switcher-provider-${tab.id}`}
                        onClick={() => {
                          // Unlike Settings (which skips unmapped protocols),
                          // report the click even when the protocol has no v2
                          // provider_id (e.g. aihubmix) — just omit the field.
                          trackExecutionSettingsPopoverClick(analytics.track, {
                            page_name: 'home',
                            area: 'execution_settings_popover',
                            element: 'byok_provider_tab',
                            provider_id:
                              byokProtocolToTracking(tab.id) ?? undefined,
                          });
                          onApiProtocolChange?.(tab.id);
                        }}
                      >
                        {tab.title}
                      </button>
                    );
                  })}
                </div>
              </div>
              )}

              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.modelLabel')}
                </span>
                {apiModelOptions.length > 0 ? (
                  <SearchableModelSelect
                    className="inline-switcher__select"
                    popoverClassName="inline-model-popover"
                    data-testid="inline-model-switcher-api-model"
                    searchInputTestId="inline-model-switcher-api-model-search"
                    popoverTestId="inline-model-switcher-api-model-popover"
                    searchPlaceholder={t('designs.searchPlaceholder')}
                    getPopoverBoundary={getModelPopoverBoundary}
                    aria-label={t('inlineSwitcher.modelLabel')}
                    models={apiModelChoices}
                    value={config.model}
                    onChange={(nextValue) => {
                      trackExecutionSettingsPopoverClick(analytics.track, {
                        page_name: 'home',
                        area: 'execution_settings_popover',
                        element: 'model_dropdown',
                        execution_mode: 'byok',
                        provider_id:
                          byokProtocolToTracking(apiProtocol) ?? undefined,
                        model_id: modelIdForTracking(nextValue),
                      });
                      onApiModelChange?.(nextValue);
                    }}
                    additionalOptions={
                      config.model && !apiModelIds.includes(config.model)
                        ? [
                            {
                              value: config.model,
                              label: `${config.model} ${t('inlineSwitcher.customSuffix')}`,
                            },
                          ]
                        : undefined
                    }
                  />
                ) : (
                  <span className="inline-switcher__hint">
                    {t('inlineSwitcher.openSettingsForModel')}
                  </span>
                )}
              </div>

              {!config.apiKey ? (
                <div className="inline-switcher__warn" role="status">
                  {t('inlineSwitcher.missingApiKey')}
                </div>
              ) : null}
            </>
          ) : compact ? (
            // Compact home popover: a plain list of the CURRENT agent's model
            // names (no header, no agent icons) — switching agents lives in
            // the execution settings entry below.
            <div className="inline-switcher__row">
              {currentAgent && compactModelRows.length > 0 ? (
                <div className="inline-switcher__agent-grid" role="radiogroup">
                  {compactModelRows.map(({ model: m, selectable }) => {
                    const active = currentModelId === m.id;
                    const unlimitedBadge = unlimitedBadgeForModel(m.id);
                    return (
                      <div key={m.id} className="inline-switcher__agent-row">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-disabled={selectable ? undefined : 'true'}
                          className={
                            'inline-switcher__agent' +
                            (active ? ' is-active' : '') +
                            (selectable ? '' : ' is-locked')
                          }
                          data-testid={`inline-model-switcher-compact-model-${m.id}`}
                          onClick={() => {
                            // The sink is the authority, not the row's styling.
                            if (!applyAgentModel(m.id)) {
                              return;
                            }
                            trackExecutionSettingsPopoverClick(analytics.track, {
                              page_name: 'home',
                              area: 'execution_settings_popover',
                              element: 'model_dropdown',
                              execution_mode: 'local_cli',
                              model_id: modelIdForTracking(m.id),
                            });
                            setOpen(false);
                          }}
                        >
                          <span
                            className="inline-switcher__agent-logo"
                            aria-hidden="true"
                          >
                            {(() => {
                              const src = modelProviderIconSrc(m.id);
                              return src ? (
                                <img
                                  src={src}
                                  alt=""
                                  width={16}
                                  height={16}
                                />
                              ) : (
                                <AgentIcon id={currentAgent.id} size={16} />
                              );
                            })()}
                          </span>
                          <span className="inline-switcher__agent-name">
                            {m.label}
                          </span>
                          {!selectable ? (
                            <span
                              className="inline-switcher__agent-lock"
                              data-testid={`inline-model-switcher-compact-model-lock-${m.id}`}
                            >
                              <Icon name="lock" size={12} />
                              <VisuallyHidden>
                                {t('inlineSwitcher.modelLockedHint')}
                              </VisuallyHidden>
                            </span>
                          ) : null}
                          {unlimitedBadge ? (
                            <span
                              className={
                                'inline-switcher__campaign-badge'
                                + (unlimitedBadge.tooltip ? ' od-tooltip' : '')
                                + unlimitedBadge.stateClass
                              }
                              data-tooltip={unlimitedBadge.tooltip ?? undefined}
                              data-tooltip-placement={unlimitedBadge.tooltip ? 'top' : undefined}
                              aria-label={unlimitedBadge.tooltip ?? undefined}
                              data-testid={`inline-model-switcher-unlimited-badge-${m.id}`}
                            >
                              {unlimitedBadge.label}
                            </span>
                          ) : null}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className="inline-switcher__hint">
                  {t('inlineSwitcher.openSettingsForModel')}
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.agentLabel')}
                </span>
                {installedAgents.length === 0 ? (
                  <span className="inline-switcher__hint">
                    {t('inlineSwitcher.noAgentsDetected')}
                  </span>
                ) : (
                  <div
                    className="inline-switcher__agent-grid"
                    role="radiogroup"
                  >
                    {installedAgents.map((a) => {
                      const active = config.agentId === a.id;
                      const agentName = displayAgentChipName(a);
                      return (
                        <div
                          key={a.id}
                          className="inline-switcher__agent-row"
                        >
                          <button
                            type="button"
                            role="radio"
                            aria-checked={active}
                            aria-label={agentName}
                            className={
                              'inline-switcher__agent' +
                              (active ? ' is-active' : '')
                            }
                            data-testid={`inline-model-switcher-agent-${a.id}`}
                            onClick={() => handleAgentButtonClick(a.id)}
                            title={a.version ? `${agentName} · ${a.version}` : agentName}
                          >
                            <AgentIcon id={a.id} size={20} />
                            <span className="inline-switcher__agent-name">
                              {agentName}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

              </div>

              {currentAgent &&
              currentAgent.models &&
              currentAgent.models.length > 0 ? (
                <div className="inline-switcher__row">
                  <span className="inline-switcher__label">
                    {t('inlineSwitcher.modelLabel')}
                  </span>
                  <SearchableModelSelect
                    className="inline-switcher__select"
                    popoverClassName="inline-model-popover"
                    data-testid="inline-model-switcher-agent-model"
                    searchInputTestId="inline-model-switcher-agent-model-search"
                    popoverTestId="inline-model-switcher-agent-model-popover"
                    searchPlaceholder={t('designs.searchPlaceholder')}
                    getPopoverBoundary={getModelPopoverBoundary}
                    aria-label={t('inlineSwitcher.modelLabel')}
                    models={inlineAgentModelOptions}
                    value={currentModelId ?? ''}
                    onChange={(nextValue) => {
                      // Same sink as the compact list — `serviceTier: undefined`
                      // is load-bearing here: `mergeAgentModelChoice` reads the
                      // own property to DROP a stale tier from the previous
                      // model, so the key must survive the hand-off.
                      if (
                        !applyAgentModel(nextValue, { serviceTier: undefined })
                      ) {
                        return;
                      }
                      trackExecutionSettingsPopoverClick(analytics.track, {
                        page_name: 'home',
                        area: 'execution_settings_popover',
                        element: 'model_dropdown',
                        execution_mode: 'local_cli',
                        model_id: modelIdForTracking(nextValue),
                      });
                    }}
                    additionalOptions={
                      currentModelId &&
                      !currentAgent.models.some((m) => m.id === currentModelId)
                        ? [
                            {
                              value: currentModelId,
                              label: `${currentModelId} ${t('inlineSwitcher.customSuffix')}`,
                            },
                          ]
                        : undefined
                    }
                  />
                </div>
              ) : null}
            </>
          )}

          <button
            type="button"
            className="inline-switcher__more"
            data-testid="inline-model-switcher-open-settings"
            onClick={() => {
              trackExecutionSettingsPopoverClick(analytics.track, {
                page_name: 'home',
                area: 'execution_settings_popover',
                element: 'open_execution_settings',
              });
              setOpen(false);
              onOpenSettings?.('execution');
            }}
          >
            <Icon name="settings" size={13} />
            <span>{t('inlineSwitcher.openFullSettings')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
