import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { Button } from '@open-design/components';
import { reportAgentDetectDiagnostics } from './analytics/agent-detect';
import { useAnalytics } from './analytics/provider';
import {
  trackExperienceSurveyDismissed,
  trackExperienceSurveySent,
  trackExperienceSurveyShown,
  trackFileUploadResult,
  trackProjectCreateResult,
} from './analytics/events';
import { deriveUploadCohort } from './analytics/upload-tracking';
import { setPendingDesignSystemCreateEntry } from './analytics/ds-create-entry';
import { detectClientType } from './analytics/identity';
import {
  stashOnboardingEntryForProject,
  type OnboardingEntry,
} from './onboarding/onboarding-entry';
import {
  deriveConfigureGlobals,
  projectKindFromMetadataToTracking,
  fidelityToTracking,
} from '@open-design/contracts/analytics';
import type {
  AmrModelsResponse,
  ChatSessionMode,
  CreateProjectExampleReference,
  RunContextSelection,
  ProjectScenarioTaskProfile,
} from '@open-design/contracts';
import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID } from '@open-design/contracts';
import { EntryView } from './components/EntryView';
import type { ProjectTitleHint } from './components/EntryShell';
import type { IntegrationTab } from './components/IntegrationsView';
import { MarketplaceView } from './components/MarketplaceView';
import { PluginDetailView } from './components/PluginDetailView';
import type { CreateInput, ImportClaudeDesignOutcome } from './components/NewProjectPanel';
import {
  MemoryToast,
  memoryToastSubscriptionMode,
} from './components/MemoryToast';
import { Toast } from './components/Toast';
import { CenteredLoader } from './components/Loading';
import {
  ProjectView,
  type ProjectRenameFenceToken,
  type ProjectNameAuthorityResolution,
} from './components/ProjectView';
import { ProjectCreationPendingView } from './components/ProjectCreationPendingView';
import { ExperienceSurvey } from './components/ExperienceSurvey';
import { TooltipLayer } from './components/TooltipLayer';
import { UpdateDialog } from './components/UpdateDialog';
import { UpdaterPopup } from './components/UpdaterPopup';
import {
  openWorkspaceTab,
  removeWorkspaceProjectTabs,
  WorkspaceTabsBar,
} from './components/WorkspaceTabsBar';
import {
  DesignSystemCreationFlow,
  DesignSystemDetailView,
} from './components/DesignSystemFlow';
import {
  IframeKeepAliveProvider,
  useIframeKeepAlivePool,
} from './components/IframeKeepAlivePool';
import {
  SettingsDialog,
  switchApiProtocolConfig,
  updateCurrentApiProtocolConfig,
  type SettingsSection,
  type SettingsHighlight,
} from './components/SettingsDialog';
import { PrivacyConsentModal } from './components/PrivacyConsentModal';
import {
  daemonIsLive,
  fetchAppVersionInfo,
  fetchAgentsStream,
  fetchDesignSystems,
  fetchDesignTemplates,
  invalidateProjectFilesCache,
  fetchPromptTemplates,
  fetchSkills,
  openExternalUrl,
  uploadProjectFiles,
  replaceProjectWorkingDir,
} from './providers/registry';
import { openFirstPartyExternalLinkFromClick } from './first-party-external-link';
import {
  fetchAmrModels,
} from './providers/daemon';
import { CommunityView } from './components/CommunityView';
import { seedHomeComposerPrompt } from './components/HomeView';
import {
  createPluginUseHandoff,
  stashHomePromptHandoff,
} from './components/home-hero/plugin-authoring';
import { goBack, navigate, useRoute, type Route } from './router';
import {
  fetchDaemonConfig,
  DEFAULT_CONFIG,
  DEFAULT_NOTIFICATIONS,
  fetchMediaProvidersFromDaemon,
  hasAnyConfiguredProvider,
  fetchComposioConfigFromDaemon,
  loadConfig,
  mergeDaemonConfig,
  mergeDaemonMediaProviders,
  saveConfig,
  shouldSyncLocalMediaProvidersToDaemon,
  syncComposioConfigToDaemon,
  syncConfigToDaemon,
  syncMediaProvidersToDaemon,
} from './state/config';
import { createSilentUpdatePreferenceWriter } from './state/silent-update-preference';
import { applyAppearanceToDocument } from './state/appearance';
import { isMacPlatform } from './utils/platform';
import { randomUUID } from './utils/uuid';
import { summarizeProjectNameFromPrompt } from './utils/projectName';
import { armCompletionFeedbackOnFirstGesture } from './utils/notifications';
import { installFontRecovery } from './runtime/font-recovery';
import {
  bootstrapProjectRoute,
  createDesignSystemProjectFromProject,
  createProject,
  createPluginShareProject,
  deleteProject as deleteProjectApi,
  duplicateProject,
  getProject,
  importClaudeDesignZip,
  importFolderProject,
  invalidatePluginCatalogCache,
  listProjects,
  listTemplates,
  deleteTemplate,
  duplicatePluginAsProject,
  patchProject,
} from './state/projects';
import { useModalWindowDragGuard } from './hooks/useModalWindowDragGuard';
import { resumeThumbnailLoads, suspendThumbnailLoads } from './lib/thumbnail-load-gate';
import type {
  PluginShareAction,
  PluginShareProjectOutcome,
} from './state/projects';
import {
  markProjectDisplaySnapshotsDirty,
  patchProjectDisplaySnapshots,
  projectDisplaySnapshotKey,
  readProjectDisplaySnapshot,
  removeProjectFromDisplaySnapshots,
  writeProjectDisplaySnapshot,
} from './state/project-display-cache';
import { getOpenDesignHost, type OpenDesignHostProjectImportSuccess } from '@open-design/host';
import { useI18n } from './i18n';
import { liveArtifactTabId } from './types';
import type {
  AgentInfo,
  AgentModelChoice,
  ApiProtocol,
  AppConfig,
  AppVersionInfo,
  ChatAttachment,
  DesignSystemGenerationJob,
  DesignSystemSummary,
  Project,
  ProjectMetadata,
  ProjectTemplate,
  ProviderModelOption,
  PromptTemplateSummary,
  SkillSummary,
} from './types';

type AppCreateProjectInput = Omit<CreateInput, 'metadata'> & {
  metadata?: CreateInput['metadata'];
  pendingPrompt?: string;
  pluginId?: string;
  pluginSource?: string;
  pluginType?: string;
  appliedPluginSnapshotId?: string;
  pluginInputs?: Record<string, unknown>;
  automaticStrategyTaskProfile?: ProjectScenarioTaskProfile;
  /** Official example card the user picked under the automatic route. */
  exampleReference?: CreateProjectExampleReference;
  initialRunContext?: RunContextSelection | null;
  conversationMode?: ChatSessionMode;
  autoSendFirstMessage?: boolean;
  requestId?: string;
  pendingFiles?: File[];
  userWorkingDirToken?: string;
  linkedDirs?: string[] | null;
  onboardingEntry?: OnboardingEntry;
};

interface PendingProjectCreation {
  projectId: string;
  prompt: string;
}

const APP_CONFIG_CHANGED_EVENT = 'open-design:app-config-changed';
const AMR_AGENT_ID = 'amr';
const AMR_PROFILE_ENV_KEY = 'OPEN_DESIGN_AMR_PROFILE';
const AGENT_FOCUS_REFRESH_THROTTLE_MS = 10_000;

/**
 * Whether this launch should hand the user to the first-run onboarding flow.
 *
 * Two conditions, both about the *user*, neither about where they happen to be
 * in the app: they have never completed onboarding (on either the local or the
 * daemon copy — `mergeDaemonConfig` ratchets the two before this runs), and
 * they did not arrive through an explicit deep link that onboarding must not
 * hijack (the collab demo and the community gallery are shareable URLs).
 *
 * Deliberately a pure predicate over a resolved config: the redirect belongs to
 * the one-shot boot pass, and expressing it as a function of "who the user is"
 * rather than "what just happened" keeps it from being re-decided mid-session.
 */
export function shouldRouteToFirstRunOnboarding(
  config: AppConfig,
  pathname: string,
): boolean {
  if (config.onboardingCompleted === true) return false;
  if (
    pathname.startsWith('/projects/')
    || pathname.startsWith('/community')
  ) {
    return false;
  }
  return true;
}

export function shouldSyncMediaProvidersOnSave(
  mediaProviders: AppConfig['mediaProviders'],
  options?: { force?: boolean },
): boolean {
  return Boolean(options?.force) || hasAnyConfiguredProvider(mediaProviders);
}

function normalizeSavedComposioConfig(config: AppConfig['composio']): AppConfig['composio'] {
  const apiKey = config?.apiKey?.trim() ?? '';
  if (apiKey) {
    return {
      ...config,
      apiKey: '',
      apiKeyConfigured: true,
      apiKeyTail: apiKey.slice(-4),
    };
  }
  return { ...(config ?? {}) };
}

function amrProfileForConfig(config: AppConfig): string | null {
  const profile = config.agentCliEnv?.[AMR_AGENT_ID]?.[AMR_PROFILE_ENV_KEY];
  return typeof profile === 'string' && profile ? profile : null;
}

function mergeLinkedDirsIntoMetadata(
  metadata: ProjectMetadata | undefined,
  linkedDirs?: string[] | null,
): ProjectMetadata | undefined {
  const nextDirs = (linkedDirs ?? []).map((dir) => dir.trim()).filter(Boolean);
  if (nextDirs.length === 0) return metadata;
  const baseMetadata = metadata ?? { kind: 'other' };
  return {
    ...baseMetadata,
    linkedDirs: Array.from(new Set([...(baseMetadata.linkedDirs ?? []), ...nextDirs])),
  };
}

function sameAgentModelChoice(
  left: AgentModelChoice | undefined,
  right: AgentModelChoice | undefined,
): boolean {
  return (left?.model ?? null) === (right?.model ?? null)
    && (left?.reasoning ?? null) === (right?.reasoning ?? null)
    && (left?.serviceTier ?? null) === (right?.serviceTier ?? null);
}

export function mergeAgentModelChoice(
  previous: AgentModelChoice | undefined,
  next: { model?: string; reasoning?: string; serviceTier?: string },
): AgentModelChoice {
  const merged = { ...(previous ?? {}), ...next };
  if (
    Object.prototype.hasOwnProperty.call(next, 'serviceTier') &&
    next.serviceTier === undefined
  ) {
    delete merged.serviceTier;
  }
  return merged;
}

function clearStaleAmrModelChoiceOnProfileChange(
  previous: AppConfig,
  next: AppConfig,
): AppConfig {
  if (amrProfileForConfig(previous) === amrProfileForConfig(next)) return next;

  const previousChoice = previous.agentModels?.[AMR_AGENT_ID];
  const nextChoice = next.agentModels?.[AMR_AGENT_ID];
  if (!nextChoice || !sameAgentModelChoice(previousChoice, nextChoice)) return next;

  const nextAgentModels = { ...(next.agentModels ?? {}) };
  delete nextAgentModels[AMR_AGENT_ID];
  return { ...next, agentModels: nextAgentModels };
}

type ProjectListRequest = {
  generation: number;
  mutationVersion: number;
};

type PendingProjectNameProjection = {
  project: Project;
  mutationVersion: number;
  confirmed: boolean;
};

type QueuedProjectRenameState = {
  generation: number;
  confirmed: Project;
  pending: number;
  tail: Promise<void>;
};

export async function persistComposioConfigChange(
  current: AppConfig,
  composio: AppConfig['composio'],
  sync: (config: AppConfig['composio']) => Promise<boolean> = syncComposioConfigToDaemon,
): Promise<AppConfig> {
  const saved = await sync(composio);
  if (!saved) throw new Error('Composio config save failed');
  return {
    ...current,
    composio: normalizeSavedComposioConfig(composio),
  };
}

export function buildPersistedConfig(next: AppConfig, current: AppConfig): AppConfig {
  const stalePrivacySnapshot =
    current.privacyDecisionAt != null && next.privacyDecisionAt == null;
  return {
    ...next,
    onboardingCompleted: current.onboardingCompleted ? true : next.onboardingCompleted,
    ...(stalePrivacySnapshot
      ? {
          installationId: current.installationId,
          privacyDecisionAt: current.privacyDecisionAt,
          telemetry: current.telemetry,
        }
      : {}),
    composio: next.composio
      ? {
          apiKey: '',
          apiKeyConfigured: Boolean(next.composio.apiKeyConfigured),
          apiKeyTail: next.composio.apiKeyTail ?? '',
        }
      : next.composio,
  };
}

/**
 * True when `next` and `last` produce an identical persisted shape —
 * i.e. the only diffs between them are fields that buildPersistedConfig
 * intentionally strips before disk/daemon writes (the Composio API key
 * draft today; any future save-on-explicit-confirm secrets later).
 *
 * The autosave loop in Settings uses this to skip the "All changes
 * saved" indicator transition when the user has only typed an unsaved
 * secret. Without it, autosave completes a no-op write and flashes
 * "Saved" — misleading users into trusting that a sensitive key has
 * been persisted when in fact only the section-local "Save key"
 * gesture commits it.
 */
export function isAutosaveDraftOnlyChange(next: AppConfig, last: AppConfig): boolean {
  return (
    JSON.stringify(buildPersistedConfig(next, next))
    === JSON.stringify(buildPersistedConfig(last, last))
  );
}

export function resolveSettingsCloseConfig(
  rendered: AppConfig,
  latestPersisted: AppConfig,
): AppConfig {
  const base = latestPersisted === rendered ? rendered : latestPersisted;
  return base.onboardingCompleted ? base : { ...base, onboardingCompleted: true };
}

function mergeAmrModelsIntoAgents(
  agents: AgentInfo[],
  amrModels: AmrModelsResponse | null,
): AgentInfo[] {
  if (!amrModels || amrModels.models.length === 0) return agents;
  return agents.map((agent) => {
    if (agent.id !== 'amr') return agent;
    const shouldPreferAgentModels =
      amrModels.source === 'preset' &&
      Array.isArray(agent.models) &&
      agent.models.length > 0;
    if (shouldPreferAgentModels) return agent;
    return { ...agent, models: amrModels.models, modelsSource: 'live' };
  });
}

const CANONICAL_AGENT_ORDER = [
  'amr',
  'claude',
  'codex',
  'devin',
  'gemini',
  'opencode',
  'hermes',
  'trae-cli',
  'grok-build',
  'kimi',
  'cursor-agent',
  'qwen',
  'qoder',
  'copilot',
  'pi',
  'kiro',
  'kilo',
  'vibe',
  'deepseek',
  'aider',
  'antigravity',
  'reasonix',
] as const;

const CANONICAL_AGENT_ORDER_INDEX = new Map<string, number>(
  CANONICAL_AGENT_ORDER.map((id, index) => [id, index]),
);

function orderAgentsByRegistry(agents: AgentInfo[]): AgentInfo[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const leftRank =
        CANONICAL_AGENT_ORDER_INDEX.get(left.agent.id) ??
        CANONICAL_AGENT_ORDER.length;
      const rightRank =
        CANONICAL_AGENT_ORDER_INDEX.get(right.agent.id) ??
        CANONICAL_AGENT_ORDER.length;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    })
    .map(({ agent }) => agent);
}

function upsertAgent(agents: AgentInfo[], agent: AgentInfo): AgentInfo[] {
  const index = agents.findIndex((item) => item.id === agent.id);
  if (index === -1) return [...agents, agent];
  const next = agents.slice();
  next[index] = agent;
  return next;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function App() {
  // `reducedMotion="user"` makes every motion/react component honor the OS
  // `prefers-reduced-motion` setting: transform/layout animations are zeroed
  // out while opacity-only changes are kept. The CSS `@media (prefers-reduced-
  // motion: reduce)` block covers the CSS-keyframe surfaces, but the dialogs,
  // toasts and popovers that moved to motion/react need this gate too — without
  // it they keep springing/sliding for users who asked us not to animate.
  return (
    <MotionConfig reducedMotion="user">
      <IframeKeepAliveProvider>
        <AppInner />
      </IframeKeepAliveProvider>
    </MotionConfig>
  );
}

function AppInner() {
  const { t } = useI18n();
  const iframeKeepAlivePool = useIframeKeepAlivePool();
  const clientType = useMemo(() => detectClientType(), []);
  const hostPlatform = useMemo(() => getOpenDesignHost()?.client.platform, []);
  useModalWindowDragGuard();
  const listCurrentProjects = useCallback(
    (options?: { throwOnError?: boolean }) => {
      return listProjects(options);
    },
    [],
  );
  useEffect(() => {
    const onFirstPartyExternalLink = (event: MouseEvent) => openFirstPartyExternalLinkFromClick(
      event,
      (url) => { void openExternalUrl(url); },
    );
    // React handlers append AMR attribution while the event bubbles; bridge the final URL afterwards.
    document.addEventListener('click', onFirstPartyExternalLink);
    return () => document.removeEventListener('click', onFirstPartyExternalLink);
  }, []);
  // Icon fonts whose startup fetch lost a race stay tofu forever without
  // this — see runtime/font-recovery.ts.
  useEffect(() => installFontRecovery(), []);
  // Observability marker. `apps/web/src/observability/white-screen.ts`
  // keys its "app actually mounted" success condition on this attribute
  // because the dynamic-import loading shell (`<div class="od-loading-shell">
  // Loading OpenDesign…</div>`) is itself >MIN_VISIBLE_TEXT and would
  // otherwise be mistaken for a real mount. Survives subsequent render
  // crashes — once App has mounted at least once, it's no longer a white
  // screen (subsequent failures show up as `$exception`).
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-od-app-mounted', '1');
      document.querySelectorAll('.od-loading-shell').forEach((node) => node.remove());
    }
  }, []);
  // Desktop vibrancy focus response: an unfocused window drops the cream
  // scrim to let the wallpaper show through more clearly; on focus the scrim
  // returns to full strength (app-wash.css keys off this class).
  useEffect(() => {
    if (
      clientType !== 'desktop'
      || hostPlatform !== 'darwin'
      || typeof window === 'undefined'
    ) return undefined;
    const root = document.documentElement;
    const sync = () => root.classList.toggle('is-window-blurred', !document.hasFocus());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      root.classList.remove('is-window-blurred');
    };
  }, [clientType, hostPlatform]);
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const configRef = useRef(config);
  configRef.current = config;
  const latestPersistedConfigRef = useRef(config);
  latestPersistedConfigRef.current = config;
  const settingsDraftConfigRef = useRef<AppConfig | null>(null);
  const completionFeedbackGestureConsumedRef = useRef(false);
  useEffect(() => {
    if (completionFeedbackGestureConsumedRef.current) return undefined;
    const notifications = config.notifications ?? DEFAULT_NOTIFICATIONS;
    if (!notifications.soundEnabled && !notifications.desktopEnabled) return undefined;
    return armCompletionFeedbackOnFirstGesture(notifications, ({ desktopPermission }) => {
      completionFeedbackGestureConsumedRef.current = true;
      if (
        !notifications.desktopEnabled
        || desktopPermission === null
        || desktopPermission === 'granted'
      ) return;
      // The product default expresses intent, but an unsupported/denied browser
      // permission cannot honestly remain Active. Reconcile only the desktop
      // switch; the independent completion-sound preference stays enabled.
      setConfig((previous) => {
        const previousNotifications = previous.notifications ?? DEFAULT_NOTIFICATIONS;
        if (!previousNotifications.desktopEnabled) return previous;
        const next: AppConfig = {
          ...previous,
          notifications: { ...previousNotifications, desktopEnabled: false },
        };
        latestPersistedConfigRef.current = next;
        saveConfig(next);
        return next;
      });
    });
  }, [config.notifications?.desktopEnabled, config.notifications?.soundEnabled]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Surfaced when a Home-picked working dir could not be applied to a freshly
  // created project (expired/invalid desktop token, daemon rejection). Without
  // this the failure was swallowed and the user believed their folder was in
  // effect while the project actually stayed in the managed root.
  const [workingDirError, setWorkingDirError] = useState<string | null>(null);
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null);
  const [projectOpenError, setProjectOpenError] = useState<string | null>(null);
  const [deepLinkResolutionFailure, setDeepLinkResolutionFailure] = useState<{
    projectId: string;
    failure: 'missing' | 'materialization-failed';
  } | null>(null);
  const [deepLinkRetryRevision, setDeepLinkRetryRevision] = useState(0);
  const [settingsWelcome, setSettingsWelcome] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('execution');
  const [settingsHighlight, setSettingsHighlight] = useState<SettingsHighlight>(null);
  const [integrationInitialTab, setIntegrationInitialTab] = useState<IntegrationTab>('mcp');
  const [daemonLive, setDaemonLive] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const amrModelsRef = useRef<AmrModelsResponse | null>(null);
  const amrPollGenerationRef = useRef(0);
  const agentStreamRequestSeqRef = useRef(0);
  const agentStreamAbortRef = useRef<AbortController | null>(null);
  const agentFocusRefreshLastRunRef = useRef(Date.now());
  const [amrPollRestartToken, setAmrPollRestartToken] = useState(0);
  const [providerModelsCache, setProviderModelsCache] = useState<
    Record<string, ProviderModelOption[]>
  >({});
  // Functional skills (capabilities the agent invokes mid-task) — stays
  // small and lives under the Settings → Skills surface.
  const [workspaceSkills, setWorkspaceSkills] = useState<{
    identity: string;
    items: SkillSummary[];
  }>(() => ({
    identity: 'local',
    items: [],
  }));
  const skills =
    workspaceSkills.identity === 'local'
      ? workspaceSkills.items
      : [];
  // Design templates (rendering catalogue: decks, prototypes, image/video/
  // audio templates) — sourced from /api/design-templates and shown in the
  // EntryView Templates tab. See specs/current/skills-and-design-templates.md.
  const [designTemplates, setDesignTemplates] = useState<SkillSummary[]>([]);
  const [workspaceDesignSystems, setWorkspaceDesignSystems] = useState<{
    identity: string;
    items: DesignSystemSummary[];
  }>(() => ({
    identity: 'local',
    items: [],
  }));
  const designSystems = workspaceDesignSystems.identity === 'local'
    ? workspaceDesignSystems.items
    : [];
  const skillsRequestGenerationRef = useRef<Map<string, number>>(new Map());
  const designSystemsRequestGenerationRef = useRef<Map<string, number>>(new Map());
  const [pendingDesignSystemRevisionJobs, setPendingDesignSystemRevisionJobs] = useState<
    Record<string, DesignSystemGenerationJob>
  >({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [pendingProjectCreation, setPendingProjectCreation] =
    useState<PendingProjectCreation | null>(null);
  const [appliedProjectListWitness, setAppliedProjectListWitness] = useState<{
    generation: number;
    projectIds: ReadonlySet<string>;
  } | null>(null);
  const projectsRef = useRef<Project[]>(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  const [projectRunActivity, setProjectRunActivity] = useState<{
    projectId: string | null;
    active: boolean;
  }>({ projectId: null, active: false });
  const handleProjectRunActivityChange = useCallback(
    (projectId: string, active: boolean) => {
      setProjectRunActivity({ projectId, active });
    },
    [],
  );
  const pendingLocalProjectIdsRef = useRef<Set<string>>(new Set());
  const locallyDeletedProjectIdsRef = useRef<Map<string, number>>(new Map());
  const projectListMutationVersionRef = useRef(0);
  const projectRenameStatesRef = useRef<Map<string, QueuedProjectRenameState>>(new Map());
  const pendingProjectNameProjectionsRef = useRef<Map<string, PendingProjectNameProjection>>(
    new Map(),
  );
  const projectListRequestGenerationRef = useRef(0);
  const latestAppliedProjectListGenerationRef = useRef(0);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [promptTemplates, setPromptTemplates] = useState<
    PromptTemplateSummary[]
  >([]);
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(
    null,
  );


  const [daemonMediaProviders, setDaemonMediaProviders] = useState<
    AppConfig['mediaProviders'] | null
  >(null);
  const [daemonMediaProvidersFetchState, setDaemonMediaProvidersFetchState] = useState<
    'idle' | 'ok' | 'error'
  >('idle');
  const [mediaProvidersNotice, setMediaProvidersNotice] = useState<string | null>(null);
  // Per-resource loading flags. Each goes false the moment its own fetch
  // resolves so each entry-view tab can render as its data lands instead of
  // every tab waiting on the slowest endpoint (typically `/api/agents`,
  // which probes CLI versions and can take seconds on cold start). The entry
  // view picks the right flag for whichever tab the user is currently on.
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(true);
  // Functional skills and design templates are two independent registry reads
  // that gate ONE loader: the EntryView must not stop spinning until both have
  // answered, or whichever tab the user is on renders an incomplete catalog as
  // if it were final. They are now read from two different places (the boot pass
  // reads templates; the workspace-keyed effect reads skills once the caller's
  // identity is known), so the pair of flags lives here rather than inside one
  // effect's closure.
  const skillRegistriesReadyRef = useRef({ functional: false, templates: false });
  const markSkillRegistryReady = useCallback((half: 'functional' | 'templates') => {
    skillRegistriesReadyRef.current[half] = true;
    const { functional, templates } = skillRegistriesReadyRef.current;
    if (functional && templates) setSkillsLoading(false);
  }, []);
  const [dsLoading, setDsLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [promptTemplatesLoading, setPromptTemplatesLoading] = useState(true);
  // Goes true once the daemon-persisted config (agentId/designSystemId/etc.)
  // has merged into local state. Auto-selection effects below wait on this
  // so they don't race ahead of the daemon-stored choice and overwrite it
  // with a freshly picked first-available agent.
  const [daemonConfigLoaded, setDaemonConfigLoaded] = useState(false);
  // True only when GET /api/app-config returned a real config object. Used to
  // gate silent-update default seeding: a failed/null fetch must not be treated
  // as "no preference yet" or we would overwrite a daemon-backed opt-out.
  const [daemonAppConfigReady, setDaemonAppConfigReady] = useState(false);
  // Narrower flag dedicated to the Composio API key hydration. The key is
  // persisted by the daemon (and only reflected back via apiKeyConfigured
  // + apiKeyTail), so after a dev-server restart there is a window where
  // the dialog can render an empty Composio input even though a saved key
  // exists. Settings → Connectors uses this to render a skeleton over the
  // input + buttons instead of an empty input that the user might
  // mistake for "no key saved" — and to disable Save/Clear so a misclick
  // can't overwrite the saved state with `''` before hydration lands.
  const [composioConfigLoading, setComposioConfigLoading] = useState(true);
  const route = useRoute();
  const routeRef = useRef(route);
  routeRef.current = route;
  const settingsReturnTargetRef = useRef<{ route: Extract<Route, { kind: 'project' }> } | null>(null);
  const currentProjectDisplayKey = projectDisplaySnapshotKey({
    view: undefined,
  });
  // Display snapshots may prevent a warm view from flashing a loader.
  const projectDisplayKeyRef = useRef(currentProjectDisplayKey);
  if (projectDisplayKeyRef.current !== currentProjectDisplayKey) {
    const snapshot = readProjectDisplaySnapshot(currentProjectDisplayKey);
    if (snapshot) {
      setProjects(snapshot.projects);
      setProjectsLoading(false);
    }
  }
  const analytics = useAnalytics();

  // Single-flight guard for `/api/agents?stream=1`: beginning a new request
  // physically aborts the previous stream, not just invalidates its
  // callbacks. Stacked live streams are what deadlocked the packaged app —
  // each navigation/focus refresh opened another slow cold-probe stream,
  // and once they pinned every upstream connection slot the whole od://
  // proxy starved (see apps/packaged/src/index.ts ignore-connections-limit
  // note for the other half of that fix).
  const beginAgentStreamRequest = useCallback(() => {
    agentStreamAbortRef.current?.abort();
    agentStreamAbortRef.current = new AbortController();
    agentStreamRequestSeqRef.current += 1;
    return agentStreamRequestSeqRef.current;
  }, []);

  const isCurrentAgentStreamRequest = useCallback((requestId: number) => {
    return agentStreamRequestSeqRef.current === requestId;
  }, []);

  const restartAmrPolling = useCallback(() => {
    amrPollGenerationRef.current += 1;
    setAmrPollRestartToken((current) => current + 1);
  }, []);

  // v2 schema removed the standalone `app_launch` event; the initial
  // page_view fires from each top-level page surface (home / projects /
  // automations / plugins / design_systems / integrations) instead.
  // `detectClientType` still feeds analytics identity via the provider.
  void detectClientType;

  const rememberLocalProject = useCallback((projectId: string) => {
    pendingLocalProjectIdsRef.current.add(projectId);
    locallyDeletedProjectIdsRef.current.delete(projectId);
    projectListMutationVersionRef.current += 1;
    markProjectDisplaySnapshotsDirty();
  }, []);

  const clearLocalProject = useCallback((projectId: string, options?: { deleted?: boolean }) => {
    pendingLocalProjectIdsRef.current.delete(projectId);
    projectListMutationVersionRef.current += 1;
    if (options?.deleted) {
      locallyDeletedProjectIdsRef.current.set(
        projectId,
        projectListMutationVersionRef.current,
      );
    }
  }, []);

  const beginProjectListRequest = useCallback((): ProjectListRequest => {
    projectListRequestGenerationRef.current += 1;
    return {
      generation: projectListRequestGenerationRef.current,
      mutationVersion: projectListMutationVersionRef.current,
    };
  }, []);

  const reconcileFetchedProjects = useCallback((list: Project[], request: ProjectListRequest) => {
    const projectedList = list.map((project) => {
      const key = JSON.stringify([
        project.id,
      ]);
      const pending = pendingProjectNameProjectionsRef.current.get(key);
      if (!pending) return project;
      if (
        pending.confirmed
        && request.mutationVersion >= pending.mutationVersion
      ) {
        // A request issued after the local mutation settled is authoritative,
        // even when another tab has already committed a newer name. The fence
        // only protects requests that were already in flight when the local
        // optimistic rename began; keeping it past the first post-write read
        // would permanently hide later remote renames.
        pendingProjectNameProjectionsRef.current.delete(key);
        return project;
      }
      return {
        ...project,
        name: pending.project.name,
        metadata: pending.project.metadata,
        updatedAt: Math.max(project.updatedAt, pending.project.updatedAt),
      };
    });
    const pendingLocalProjectIds = pendingLocalProjectIdsRef.current;
    const locallyDeletedProjectIds = locallyDeletedProjectIdsRef.current;
    const fetchedIds = new Set(projectedList.map((project) => project.id));
    if (request.generation < latestAppliedProjectListGenerationRef.current) {
      const visibleList =
        locallyDeletedProjectIds.size > 0
          ? projectedList.filter((project) => !locallyDeletedProjectIds.has(project.id))
          : projectedList;
      if (visibleList.length === 0) return false;
      const hydratableProjects = visibleList.filter(
        (project) =>
          pendingLocalProjectIds.has(project.id),
      );
      if (hydratableProjects.length === 0) return false;
      const hydratableById = new Map(
        hydratableProjects.map((project) => [project.id, project]),
      );
      for (const project of hydratableProjects) {
        pendingLocalProjectIds.delete(project.id);
      }
      setProjects((current) => {
        let changed = false;
        const currentIds = new Set<string>();
        const next = current.map((project) => {
          currentIds.add(project.id);
          const hydrated = hydratableById.get(project.id);
          if (!hydrated) return project;
          changed = true;
          hydratableById.delete(project.id);
          return hydrated;
        });
        for (const project of hydratableById.values()) {
          if (currentIds.has(project.id)) continue;
          changed = true;
          next.push(project);
        }
        return changed ? next : current;
      });
      return true;
    }
    latestAppliedProjectListGenerationRef.current = request.generation;
    setAppliedProjectListWitness({
      generation: request.generation,
      projectIds: fetchedIds,
    });
    for (const id of fetchedIds) pendingLocalProjectIds.delete(id);
    for (const [id, deletedAtMutationVersion] of locallyDeletedProjectIds) {
      if (
        request.mutationVersion >= deletedAtMutationVersion
        && !fetchedIds.has(id)
      ) {
        locallyDeletedProjectIds.delete(id);
      }
    }
    const activeDeletedProjectIds = new Set(locallyDeletedProjectIds.keys());
    const visibleList =
      activeDeletedProjectIds.size > 0
        ? projectedList.filter((project) => !activeDeletedProjectIds.has(project.id))
        : projectedList;
    const visibleFetchedIds =
      activeDeletedProjectIds.size > 0
        ? new Set(visibleList.map((project) => project.id))
        : fetchedIds;
    writeProjectDisplaySnapshot({
      view: undefined,
    }, visibleList);
    setProjects((current) => {
      const preserved = current.filter(
        (project) =>
          pendingLocalProjectIds.has(project.id) &&
          !visibleFetchedIds.has(project.id) &&
          !activeDeletedProjectIds.has(project.id),
      );
      return preserved.length > 0 ? [...preserved, ...visibleList] : visibleList;
    });
    return true;
  }, []);

  // Propagate the Privacy toggle through to PostHog without a reload —
  // posthog-js's opt_out_capturing flips a localStorage flag that makes
  // every subsequent capture() a no-op. When the user opts back in we
  // call opt_in_capturing to resume.
  useEffect(() => {
    analytics.setConsent(config.telemetry?.metrics === true);
  }, [analytics.setConsent, config.telemetry?.metrics]);

  // Sync PostHog's distinct_id with the anonymous installationId, both on
  // first opt-in (when the daemon stamps a fresh id) and on Delete-my-data
  // rotation (when PrivacySection.tsx generates a new one). posthog-js
  // caches the previous id in localStorage; identify() alone would stitch
  // the two ids together, so applyIdentity() does reset() first to
  // guarantee the new session is fully decoupled from the deleted one.
  useEffect(() => {
    if (config.telemetry?.metrics !== true) return;
    analytics.setIdentity(config.installationId ?? null);
  }, [analytics.setIdentity, config.installationId, config.telemetry?.metrics]);

  // v2 analytics requires every event to carry the configure-state
  // triplet (has_available_configure_cli / configure_type /
  // configure_availability). We push it into the PostHog global register
  // whenever the user's execution-mode config or the detected agent list
  // changes; the next capture inherits the fresh values, so dashboards
  // can segment by execution setup without per-helper boilerplate.
  //
  // Gated on `agentsLoading` so the cold-start probe (`fetchAgentsStream()`
  // lands asynchronously after this effect's first run) does not stamp
  // the first home/projects/plugins page_view with
  // has_available_configure_cli=false / configure_availability=unavailable
  // on machines that DO have an installed CLI. While the probe is in
  // flight we leave the boot defaults ('unknown'/'unknown') in place,
  // matching what the helper would return for an empty agent list with
  // no mode pinned.
  useEffect(() => {
    if (agentsLoading) return;
    const byokConfigured = (() => {
      const protocols = config.apiProtocolConfigs;
      if (!protocols) return Boolean(config.apiKey?.trim());
      return Object.values(protocols).some(
        (cfg) => Boolean(cfg?.apiKey?.trim()),
      );
    })();
    const globals = deriveConfigureGlobals({
      mode: config.mode,
      agentId: config.agentId,
      agents: agents.map((a) => ({ id: a.id, available: a.available })),
      byokConfigured,
      amrAuthorized: false,
    });
    analytics.setConfigureGlobals(globals);
  }, [
    analytics.setConfigureGlobals,
    agentsLoading,
    config.mode,
    config.agentId,
    config.apiKey,
    config.apiProtocolConfigs,
    agents,
  ]);

  // Stamp the app appearance onto the <html> element so CSS variables pick it
  // up. The theme itself is a constant (light-only), but the accent still comes
  // from config, and the stamp must be re-applied whenever that changes.
  // useLayoutEffect (vs useEffect) fires before the browser paints, so no
  // 1-frame flash. Safe here because the component tree is ssr:false.
  useLayoutEffect(() => {
    applyAppearanceToDocument({ accentColor: config.accentColor });
  }, [config.accentColor]);

  // Tell the daemon what the user is currently looking at, so the MCP
  // server can surface it as `get_active_context` to a coding agent in
  // another repo. Best-effort fire-and-forget; the daemon holds it in
  // memory with a short TTL and the MCP layer falls back to
  // {active:false} if this hasn't run.
  const activeProjectId = route.kind === 'project' ? route.projectId : null;
  const activeFileName = route.kind === 'project' ? route.fileName : null;
  // While a project route is active, background home-surface thumbnail
  // documents must not compete with the project's own foreground reads; the
  // card-click handler suspends the gate synchronously and this effect keeps
  // it authoritative for every other entry path (deep links, quick switcher)
  // and resumes it when the user returns home (Batch A §4.2).
  useEffect(() => {
    if (route.kind === 'project') suspendThumbnailLoads();
    else resumeThumbnailLoads();
  }, [route.kind]);
  // Gate the privacy banner on three things:
  //   1. Daemon config has hydrated (privacyDecisionAt is daemon-owned).
  //   2. The user has not yet made a privacy decision.
  //   3. Onboarding is complete (Skip and design-system creation both flip
  //      onboardingCompleted to true; see handleCompleteOnboarding wiring).
  // Once onboarding is done the banner is allowed on any route — including
  // the project view the design-system finish path drops the user into, so
  // they can read and acknowledge the disclosure while the first generation
  // is running. Settings is irrelevant to visibility; the banner sits above
  // the modal-backdrop layer in index.css so opening Settings does not hide
  // it.
  const showPrivacyConsent =
    daemonConfigLoaded &&
    config.privacyDecisionAt == null &&
    config.onboardingCompleted === true;
  useEffect(() => {
    const body = activeProjectId
      ? { projectId: activeProjectId, fileName: activeFileName }
      : { active: false };
    fetch('/api/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // Daemon down or transient network — not worth surfacing.
    });
  }, [activeProjectId, activeFileName]);

  useEffect(() => {
    if (!daemonLive) return;
    let cancelled = false;
    let timer: number | null = null;
    const pollGeneration = amrPollGenerationRef.current + 1;
    amrPollGenerationRef.current = pollGeneration;
    const pollDelayMs = 1_000;
    const maxPresetPolls = 10;
    let presetPolls = 0;

    const applyAmrModels = async () => {
      const result = await fetchAmrModels();
      if (
        cancelled ||
        amrPollGenerationRef.current !== pollGeneration ||
        !result ||
        !Array.isArray(result.models) ||
        result.models.length === 0
      ) {
        return;
      }
      amrModelsRef.current = result;
      setAgents((current) => mergeAmrModelsIntoAgents(current, result));
      const shouldPollPreset =
        result.source === 'preset' &&
        !result.remoteError &&
        presetPolls < maxPresetPolls;
      if (shouldPollPreset) {
        presetPolls += 1;
        timer = window.setTimeout(() => {
          void applyAmrModels();
        }, pollDelayMs);
      }
    };

    void applyAmrModels();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [amrPollRestartToken, daemonLive]);

  // Bootstrap — detect daemon, then fan out independent fetches so each
  // entry-view tab can render the moment its own data lands. Earlier this
  // was one Promise.all behind a global "Loading workspace…" placeholder,
  // which made the slowest endpoint (typically `/api/agents` on cold start)
  // gate every tab including the ones that don't need agents at all.
  //
  // Boot is a ONE-SHOT: every dependency below is a stable callback, so this
  // runs once per app launch and never again. That is load-bearing, not
  // incidental — this pass owns the first-run onboarding routing decision and
  // rewrites the merged config back to localStorage + the daemon. Re-running it
  // on navigation replays both: a user is re-judged against a config read that
  // may lag their own completion, and gets bounced into the first-run flow they
  // already finished. Anything route- or workspace-derived that boot needs must
  // be read through a ref (see `workspaceProjectViewRef`), and anything that
  // must react to those changes belongs in its own effect.
  useEffect(() => {
    let cancelled = false;
    let effectAgentStreamAbort: AbortController | null = null;
    (async () => {
      const alive = await daemonIsLive();
      if (cancelled) return;
      setDaemonLive(alive);
      if (!alive) {
        // No daemon — clear every loading flag so empty states render
        // instead of the entry view sitting on indefinite spinners.
        setAgentsLoading(false);
        setSkillsLoading(false);
        setDsLoading(false);
        setProjectsLoading(false);
        setPromptTemplatesLoading(false);
        setDaemonConfigLoaded(true);
        setDaemonAppConfigReady(false);
        // Composio hydration also depends on the daemon. With no daemon
        // we just keep whatever localStorage already held; drop the
        // skeleton so the Settings → Connectors input reflects state.
        setComposioConfigLoading(false);
        return;
      }

      const agentRequestId = beginAgentStreamRequest();
      effectAgentStreamAbort = agentStreamAbortRef.current;
      void fetchAgentsStream({
        signal: effectAgentStreamAbort?.signal,
        onAgent: (agent) => {
          if (cancelled || !isCurrentAgentStreamRequest(agentRequestId)) return;
          setAgents((current) =>
            mergeAmrModelsIntoAgents(
              upsertAgent(current, agent),
              amrModelsRef.current,
            ),
          );
        },
      })
        .then((list) => {
          if (cancelled || !isCurrentAgentStreamRequest(agentRequestId)) return;
          reportAgentDetectDiagnostics(analytics.track, list);
          setAgents(
            mergeAmrModelsIntoAgents(
              orderAgentsByRegistry(list),
              amrModelsRef.current,
            ),
          );
        })
        .catch((err) => {
          if (
            cancelled ||
            isAbortError(err) ||
            !isCurrentAgentStreamRequest(agentRequestId)
          ) {
            return;
          }
          setAgents([]);
        })
        .finally(() => {
          if (cancelled || !isCurrentAgentStreamRequest(agentRequestId)) return;
          setAgentsLoading(false);
        });

      // Functional skills + design templates land independently. Both
      // gate `skillsLoading` together so the EntryView stops rendering
      // its loader once both registries respond — neither tab would have
      // a complete picture if we cleared the flag on the first reply.
      //
      // Only the TEMPLATE half is read here. Functional skills are
      // workspace-scoped on the daemon and must carry the caller's identity
      // headers, which do not exist until `/api/workspace/context` settles —
      // so that read belongs to the workspace-keyed effect below, which owns
      // the `functional` half of this gate. Reading it here as well would
      // spend a second `/api/skills` request per launch, and the first one
      // would be the headerless (fail-closed) answer.
      void fetchDesignTemplates().then((list) => {
        if (cancelled) return;
        setDesignTemplates(list);
        markSkillRegistryReady('templates');
      });

      void fetchDesignSystems().then((list) => {
        if (cancelled) return;
        setWorkspaceDesignSystems({
          identity: 'local',
          items: list,
        });
        setDsLoading(false);
      });

      const request = beginProjectListRequest();
      void listCurrentProjects().then((list) => {
        if (cancelled) return;
        reconcileFetchedProjects(list, request);
        setProjectsLoading(false);
      });

      void listTemplates().then((list) => {
        if (cancelled) return;
        setTemplates(list);
      });

      void fetchPromptTemplates().then((list) => {
        if (cancelled) return;
        setPromptTemplates(list);
        setPromptTemplatesLoading(false);
      });

      void fetchAppVersionInfo().then((info) => {
        if (cancelled) return;
        setAppVersionInfo(info);
      });

      // Daemon-persisted config + composio config + media provider config land
      // together so the welcome-modal decision and daemon-backed settings
      // apply in one merge, avoiding a flash where local-only state is shown
      // before daemon overrides it.
      void Promise.all([
        fetchDaemonConfig(),
        fetchComposioConfigFromDaemon(),
        fetchMediaProvidersFromDaemon(),
      ]).then(async ([
        daemonConfig,
        daemonComposioConfig,
        daemonMediaProvidersResult,
      ]) => {
        if (cancelled) return;
        const daemonMediaProvidersLoaded =
          daemonMediaProvidersResult.status === 'ok'
            ? daemonMediaProvidersResult.providers
            : null;
        setDaemonMediaProviders(daemonMediaProvidersLoaded);
        setDaemonMediaProvidersFetchState(daemonMediaProvidersResult.status);
        setMediaProvidersNotice(
          daemonMediaProvidersResult.status === 'error'
            ? t('settings.mediaProviderLoadError')
            : null,
        );
        // Settings remain interactive while daemon hydration is in flight.
        // Rebase the daemon response on the latest persisted state so a
        // completed user write cannot be overwritten by the boot snapshot.
        const baseConfig = latestPersistedConfigRef.current;
        const migratedLocalMediaProviders = shouldSyncLocalMediaProvidersToDaemon(
          baseConfig.mediaProviders,
          daemonMediaProvidersLoaded,
        );
        const next = mergeDaemonMediaProviders(
          clearStaleAmrModelChoiceOnProfileChange(
            baseConfig,
            mergeDaemonConfig(baseConfig, daemonConfig),
          ),
          daemonMediaProvidersLoaded,
        );
        const hasLocalComposioKey = Boolean(next.composio?.apiKey?.trim());
        if (!hasLocalComposioKey && daemonComposioConfig) {
          next.composio = daemonComposioConfig;
        }
        // The Composio PUT treats an explicit empty apiKey as a destructive
        // clear. Bootstrap used to issue that write unconditionally, which
        // allowed the empty startup request to arrive after the user's first
        // explicit Save and erase the freshly stored key (plus connector
        // credentials). Startup only needs to write when migrating a legacy
        // plaintext key. Keep the credentials surface locked until that one
        // migration settles so an older key cannot race a user replacement.
        if (hasLocalComposioKey) {
          const migrated = await syncComposioConfigToDaemon(next.composio);
          if (cancelled) return;
          // Only remove the legacy plaintext after the daemon confirms it was
          // stored. A failed migration deliberately leaves the existing local
          // draft intact so the user can retry Save instead of losing the only
          // remaining copy of the credential.
          if (migrated) {
            next.composio = normalizeSavedComposioConfig(next.composio);
          }
        }
        saveConfig(next);
        if (
          daemonMediaProvidersResult.status === 'ok'
          && migratedLocalMediaProviders
          && hasAnyConfiguredProvider(next.mediaProviders)
        ) {
          void syncMediaProvidersToDaemon(next.mediaProviders, {
            daemonProviders: daemonMediaProvidersLoaded,
          });
        }
        // Migrate localStorage prefs to daemon on first boot with the new
        // endpoint. If daemon already had values the merge above used them;
        // writing back is idempotent and keeps both sides in sync.
        void syncConfigToDaemon(next);
        latestPersistedConfigRef.current = next;
        setConfig(next);

        // Route first-run users through the global onboarding panel.
        // The onboarding panel and the privacy banner have independent
        // lifecycles: onboarding keys off `onboardingCompleted`, the
        // banner keys off `privacyDecisionAt`. They may coexist on the
        // first launch; the banner sits above the modal layer so it
        // stays actionable regardless of the active view.
        if (shouldRouteToFirstRunOnboarding(next, window.location.pathname)) {
          navigate({ kind: 'home', view: 'onboarding' }, { replace: true });
        }
        setDaemonConfigLoaded(true);
        // Only a non-null GET payload means we actually observed daemon prefs.
        setDaemonAppConfigReady(daemonConfig != null);
        // Composio key hydration is part of this same daemon-config
        // fetch — by the time we land here the daemon has either
        // returned the saved-key shape (apiKeyConfigured + tail) or
        // it errored and we kept whatever localStorage held. Either
        // way it is safe to drop the skeleton.
        setComposioConfigLoading(false);
      });
    })();
    return () => {
      cancelled = true;
      effectAgentStreamAbort?.abort();
    };
    // `workspaceProjectView` is intentionally absent: it is route-derived, and
    // depending on it would turn this one-shot boot pass into a per-navigation
    // one. It is read through `workspaceProjectViewRef` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    beginAgentStreamRequest,
    beginProjectListRequest,
    isCurrentAgentStreamRequest,
    listCurrentProjects,
    reconcileFetchedProjects,
  ]);

  // Keep the active projection's last-good display in sync with optimistic
  // local mutations (rename/delete/create). Related projections are marked
  // dirty by the mutation helpers and still revalidate when selected.
  useEffect(() => {
    if (projectsLoading) return;
    writeProjectDisplaySnapshot({
      view: undefined,
    }, projects);
  }, [
    currentProjectDisplayKey,
    projects,
    projectsLoading,
  ]);

  // Auto-pick the first available agent once both the daemon-stored config
  // and the agents listing have landed. Splitting this out of bootstrap
  // avoids racing the local-config initial value against a slow agents
  // probe — by the time this runs, daemonConfig has already overlaid the
  // user's previous choice, so we only fill an empty slot.
  //
  // First-run onboarding is the one time we must NOT do this: the onboarding
  // flow is the sole authority for the initial agent pick (AMR is the
  // recommended default there), and AMR (vela) detection is asynchronous. If
  // this fallback fires during onboarding while AMR is still being detected it
  // snaps the slot to the registry-first *detected* agent (Claude) and
  // persists it to the daemon, which then races and clobbers the user's AMR
  // selection on the next launch. Gate on onboardingCompleted so this only
  // backfills an empty slot for returning users.
  useEffect(() => {
    if (!daemonConfigLoaded || agentsLoading) return;
    if (config.onboardingCompleted !== true) return;
    if (config.agentId) return;
    const firstAvailable = agents.find((a) => a.available);
    if (!firstAvailable) return;
    setConfig((prev) => {
      if (prev.agentId) return prev;
      const next: AppConfig = { ...prev, agentId: firstAvailable.id };
      saveConfig(next);
      void syncConfigToDaemon(next);
      return next;
    });
  }, [
    daemonConfigLoaded,
    agentsLoading,
    agents,
    config.agentId,
    config.onboardingCompleted,
  ]);

  // Auto-pick the default design system the same way — only after daemon
  // config has merged so we never overwrite a daemon-stored selection.
  useEffect(() => {
    if (!daemonConfigLoaded || dsLoading) return;
    if (config.designSystemId) return;
    if (designSystems.length === 0) return;
    const id =
      designSystems.find((d) => d.id === 'default')?.id ?? designSystems[0]!.id;
    setConfig((prev) => {
      if (prev.designSystemId) return prev;
      const next: AppConfig = { ...prev, designSystemId: id };
      saveConfig(next);
      void syncConfigToDaemon(next);
      return next;
    });
  }, [daemonConfigLoaded, dsLoading, designSystems, config.designSystemId]);

  const refreshProjects = useCallback(async () => {
    const request = beginProjectListRequest();
    const list = await listCurrentProjects();
    reconcileFetchedProjects(list, request);
  }, [beginProjectListRequest, listCurrentProjects, reconcileFetchedProjects]);

  const refreshDesignSystems = useCallback(async (options?: {
    force?: boolean;
  }) => {
    const list = await fetchDesignSystems(options);
    setWorkspaceDesignSystems({ identity: 'local', items: list });
    // Bootstrap and this refresh can overlap on launch.
    // Either response is a complete catalog, so do not leave a successful
    // refresh hidden behind bootstrap's loader when that duplicate request is
    // cancelled or stalls.
    setDsLoading(false);
  }, []);

  useEffect(() => {
    void refreshDesignSystems();
  }, [refreshDesignSystems]);

  const refreshSkills = useCallback(async () => {
    const list = await fetchSkills();
    setWorkspaceSkills({ identity: 'local', items: list });
    markSkillRegistryReady('functional');
  }, [markSkillRegistryReady]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const refreshTemplates = useCallback(async () => {
    const list = await listTemplates();
    setTemplates(list);
  }, []);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    const ok = await deleteTemplate(id);
    if (ok) await refreshTemplates();
    return ok;
  }, [refreshTemplates]);

  const reloadMediaProvidersFromDaemon = useCallback(async () => {
    const result = await fetchMediaProvidersFromDaemon();
    if (result.status !== 'ok') {
      setDaemonMediaProvidersFetchState('error');
      setMediaProvidersNotice(
        t('settings.mediaProviderLoadError'),
      );
      return null;
    }
    setDaemonMediaProviders(result.providers);
    setDaemonMediaProvidersFetchState('ok');
    setMediaProvidersNotice(null);
    setConfig((prev) => {
      const merged = mergeDaemonMediaProviders(prev, result.providers);
      saveConfig(merged);
      return merged;
    });
    return result.providers;
  }, []);

  /**
   * Non-optimistic, serialized write for the daemon-owned silent-update
   * preference. Concurrent Settings / popup toggles cannot commit out of
   * order: only the latest request applies to app state after its daemon
   * write succeeds.
   */
  const silentUpdatePreferenceWriterRef = useRef(
    createSilentUpdatePreferenceWriter<AppConfig>({
      readBase: () => latestPersistedConfigRef.current,
      writeDaemon: async (next) => {
        await syncConfigToDaemon(next, { throwOnError: true });
      },
      commit: (allowSilentUpdates) => {
        const next: AppConfig = {
          ...latestPersistedConfigRef.current,
          allowSilentUpdates,
        };
        latestPersistedConfigRef.current = next;
        setConfig((prev) => ({ ...prev, allowSilentUpdates }));
        // saveConfig strips daemon-owned keys from localStorage; in-memory
        // config still carries allowSilentUpdates for the rest of the session.
        saveConfig(next);
      },
    }),
  );
  const handleSilentUpdatePreferenceChange = useCallback(async (allowSilentUpdates: boolean) => {
    await silentUpdatePreferenceWriterRef.current.write(allowSilentUpdates);
  }, []);

  /**
   * Autosave-driven persistence path. The settings dialog calls this on
   * every committed edit (via a debounced effect) so localStorage and
   * the daemon stay in lock-step with the user's draft. We deliberately
   * do NOT touch the Composio secret here — it has its own gesture
   * (handleConfigPersistComposioKey) so partial keys never leave the
   * browser. Onboarding is also left alone; the dialog's close path
   * is the canonical "I'm done" signal.
   */
  const handleConfigPersist = useCallback(async (
    next: AppConfig,
    options?: { forceMediaProviderSync?: boolean },
  ) => {
    // Strip the in-flight Composio secret before anything hits disk so
    // a half-typed key can't survive in localStorage. If the dialog is
    // closing, preserve any onboarding completion that the close gesture
    // already committed so an unmount autosave cannot re-open the welcome flow.
    // allowSilentUpdates is daemon-owned and must not be applied optimistically:
    // keep the previous value in memory until the daemon write succeeds.
    const prevSilent = latestPersistedConfigRef.current.allowSilentUpdates;
    const nextSilent = next.allowSilentUpdates;
    const silentChanged = nextSilent !== prevSilent;
    const nextForOptimistic = silentChanged
      ? { ...next, allowSilentUpdates: prevSilent }
      : next;
    const persisted = buildPersistedConfig(nextForOptimistic, configRef.current);
    latestPersistedConfigRef.current = persisted;
    saveConfig(persisted);
    setConfig(persisted);
    const shouldSyncMediaProviders =
      daemonMediaProvidersFetchState === 'ok'
      && shouldSyncMediaProvidersOnSave(persisted.mediaProviders, {
        force: options?.forceMediaProviderSync,
      });
    const daemonPayload = silentChanged
      ? { ...persisted, allowSilentUpdates: nextSilent }
      : persisted;
    await Promise.all([
      shouldSyncMediaProviders
        ? syncMediaProvidersToDaemon(persisted.mediaProviders, {
            force: options?.forceMediaProviderSync,
            daemonProviders: daemonMediaProviders,
            throwOnError: options?.forceMediaProviderSync,
          })
        : Promise.resolve(),
      syncConfigToDaemon(daemonPayload, { throwOnError: true }),
    ]);
    if (silentChanged) {
      latestPersistedConfigRef.current = {
        ...latestPersistedConfigRef.current,
        allowSilentUpdates: nextSilent,
      };
      setConfig((curr) => ({ ...curr, allowSilentUpdates: nextSilent }));
    }
  }, [daemonMediaProviders, daemonMediaProvidersFetchState]);

  const handleSettingsDraftChange = useCallback((draft: AppConfig) => {
    settingsDraftConfigRef.current = draft;
  }, []);

  const handlePrivacyConsentChoice = useCallback((share: boolean) => {
    const base = settingsDraftConfigRef.current ?? latestPersistedConfigRef.current;
    const installationId = share
      ? base.installationId ?? generateInstallationIdSafe()
      : null;
    void handleConfigPersist({
      ...base,
      installationId,
      privacyDecisionAt: Date.now(),
      telemetry: {
        ...(base.telemetry ?? {}),
        metrics: share,
        content: share,
      },
    });
  }, [handleConfigPersist]);

  /**
   * Explicit Composio API-key save. Called from the section-local
   * "Save key" button so secrets never ride the autosave keystroke
   * loop. Once the daemon confirms, we normalize the saved config
   * (strip the secret, store apiKeyConfigured + apiKeyTail) and feed
   * it back into local state so the saved-key badge appears.
   */
  const handleConfigPersistComposioKey = useCallback(
    async (composio: AppConfig['composio']) => {
      const next = await persistComposioConfigChange(
        latestPersistedConfigRef.current,
        composio,
      );
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      setConfig(next);
    },
    [],
  );

  const handleModeChange = useCallback(
    (mode: AppConfig['mode']) => {
      const next = { ...latestPersistedConfigRef.current, mode };
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      setConfig(next);
    },
    [],
  );

  const handleAgentChange = useCallback(
    (agentId: string) => {
      const next = { ...latestPersistedConfigRef.current, agentId };
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [],
  );

  const handleAgentModelChange = useCallback(
    (agentId: string, choice: { model?: string; reasoning?: string; serviceTier?: string }) => {
      const current = latestPersistedConfigRef.current;
      const prev = current.agentModels?.[agentId] ?? {};
      const merged = mergeAgentModelChoice(prev, choice);
      const nextAgentModels = {
        ...(current.agentModels ?? {}),
        [agentId]: merged,
      };
      const next = { ...current, agentModels: nextAgentModels };
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [],
  );

  // BYOK protocol switch — also flips `mode` to 'api' so the user does
  // not have to take a second step after picking a provider from the
  // inline switcher. The helper preserves any per-protocol fields the
  // user had previously configured for the target protocol.
  const handleApiProtocolChange = useCallback(
    (protocol: ApiProtocol) => {
      const next = switchApiProtocolConfig(
        latestPersistedConfigRef.current,
        protocol,
      );
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [],
  );

  // BYOK model picker — patches `model` (and the per-protocol shadow
  // copy) without touching apiKey/baseUrl so the user can swap models
  // mid-session without retyping their key.
  const handleApiModelChange = useCallback(
    (model: string) => {
      const next = updateCurrentApiProtocolConfig(
        latestPersistedConfigRef.current,
        { model },
      );
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [],
  );

  const handleChangeDefaultDesignSystem = useCallback(
    (designSystemId: string | null) => {
      const next = {
        ...latestPersistedConfigRef.current,
        designSystemId,
      };
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [],
  );

  const refreshAgents = useCallback(
    async (options?: { throwOnError?: boolean; agentCliEnv?: AppConfig['agentCliEnv'] }) => {
      if (options && Object.prototype.hasOwnProperty.call(options, 'agentCliEnv')) {
        const current = latestPersistedConfigRef.current;
        const nextConfig = clearStaleAmrModelChoiceOnProfileChange(current, {
          ...current,
          agentCliEnv: options.agentCliEnv ?? {},
        });
        latestPersistedConfigRef.current = nextConfig;
        amrModelsRef.current = null;
        saveConfig(nextConfig);
        setConfig(nextConfig);
        await syncConfigToDaemon(nextConfig);
      }
      const agentRequestId = beginAgentStreamRequest();
      setAgentsLoading(true);
      try {
        const next = await fetchAgentsStream({
          signal: agentStreamAbortRef.current?.signal,
          onAgent: (agent) => {
            if (!isCurrentAgentStreamRequest(agentRequestId)) return;
            setAgents((current) =>
              mergeAmrModelsIntoAgents(
                upsertAgent(current, agent),
                amrModelsRef.current,
              ),
            );
          },
        });
        const ordered = orderAgentsByRegistry(next);
        reportAgentDetectDiagnostics(analytics.track, ordered);
        if (isCurrentAgentStreamRequest(agentRequestId)) {
          setAgents(mergeAmrModelsIntoAgents(ordered, amrModelsRef.current));
          setAgentsLoading(false);
        }
        return ordered;
      } catch (err) {
        if (!isCurrentAgentStreamRequest(agentRequestId)) return [];
        setAgentsLoading(false);
        if (options?.throwOnError) throw err;
        setAgents([]);
        return [];
      }
    },
    [beginAgentStreamRequest, isCurrentAgentStreamRequest],
  );

  useEffect(() => {
    if (!daemonLive || agentsLoading) return;

    const refreshIfDue = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - agentFocusRefreshLastRunRef.current < AGENT_FOCUS_REFRESH_THROTTLE_MS) return;
      agentFocusRefreshLastRunRef.current = now;
      void refreshAgents();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshIfDue();
    };

    window.addEventListener('focus', refreshIfDue);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshIfDue);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [agentsLoading, daemonLive, refreshAgents]);

  useEffect(() => {
    const handleAppConfigChanged = () => {
      void fetchDaemonConfig().then((daemonConfig) => {
        const previous = latestPersistedConfigRef.current;
        const next = clearStaleAmrModelChoiceOnProfileChange(
          previous,
          mergeDaemonConfig(previous, daemonConfig),
        );
        const amrProfileChanged = amrProfileForConfig(previous) !== amrProfileForConfig(next);
        latestPersistedConfigRef.current = next;
        saveConfig(next);
        setConfig(next);
        amrModelsRef.current = null;
        restartAmrPolling();
        void refreshAgents();
      });
    };
    window.addEventListener(APP_CONFIG_CHANGED_EVENT, handleAppConfigChanged);
    return () => window.removeEventListener(APP_CONFIG_CHANGED_EVENT, handleAppConfigChanged);
  }, [refreshAgents, restartAmrPolling]);

  const handleCreateProject = useCallback(
    async (
      input: AppCreateProjectInput,
    ): Promise<boolean> => {
      // Honor an explicit `null` design system — the create panel defaults
      // to "None" for every kind now, and the user expects that to land
      // as a no-design-system project rather than silently inheriting the
      // workspace default.
      const derivedPendingPrompt =
      input.pendingPrompt ??
      (input.metadata?.promptTemplate?.prompt?.trim() || undefined);

      const metadata = mergeLinkedDirsIntoMetadata(input.metadata, input.linkedDirs);
      const kind = metadata?.kind ?? null;
      const fidelity = fidelityToTracking(metadata?.fidelity ?? null);
      const creationSource: 'blank' | 'template' | 'zip' | 'folder' =
        kind === 'template' ? 'template' : 'blank';
      let optimisticProjectId: string | null = null;
      let result;
      try {
        // Home already accepted the run, so move
        // into the project frame immediately. The id is client-owned and the
        // daemon already accepts that exact id for idempotent retries. Keep the
        // real ProjectView unmounted until the response settles; the pending
        // surface is deliberately read-free so an unpersisted project cannot
        // fan out unauthorized conversation/file/presence requests.
        if (input.autoSendFirstMessage) {
          optimisticProjectId = randomUUID();
          const now = Date.now();
          const optimisticProject: Project = {
            id: optimisticProjectId,
            name: input.name.trim(),
            skillId: input.skillId,
            designSystemId: input.designSystemId,
            createdAt: now,
            updatedAt: now,
            ...(derivedPendingPrompt ? { pendingPrompt: derivedPendingPrompt } : {}),
            ...(metadata ? { metadata } : {}),
            ...(input.appliedPluginSnapshotId
              ? { appliedPluginSnapshotId: input.appliedPluginSnapshotId }
              : {}),
          };
          rememberLocalProject(optimisticProjectId);
          flushSync(() => {
            setPendingProjectCreation({
              projectId: optimisticProjectId!,
              prompt: derivedPendingPrompt ?? '',
            });
            setProjects((current) => [
              optimisticProject,
              ...current.filter((project) => project.id !== optimisticProjectId),
            ]);
          });
          const optimisticRoute = {
            kind: 'project',
            projectId: optimisticProjectId,
            fileName: null,
          } as const;
          openWorkspaceTab(optimisticRoute);
          navigate(optimisticRoute);
        }
        result = await createProject({
          ...(optimisticProjectId ? { id: optimisticProjectId } : {}),
          name: input.name,
          skillId: input.skillId,
          designSystemId: input.designSystemId,
          pendingPrompt: derivedPendingPrompt,
          metadata,
          ...(input.conversationMode ? { conversationMode: input.conversationMode } : {}),
          ...(input.pluginId ? { pluginId: input.pluginId } : {}),
          ...(input.pluginSource ? { pluginSource: input.pluginSource } : {}),
          ...(input.appliedPluginSnapshotId
            ? { appliedPluginSnapshotId: input.appliedPluginSnapshotId }
            : {}),
          ...(input.pluginInputs ? { pluginInputs: input.pluginInputs } : {}),
          ...(input.automaticStrategyTaskProfile
            ? { automaticStrategyTaskProfile: input.automaticStrategyTaskProfile }
            : {}),
          ...(input.exampleReference
            ? { exampleReference: input.exampleReference }
            : {}),
        });
      } catch (err) {
        const errorCode =
          err instanceof Error && err.message.trim()
            ? err.message
            : 'CREATE_REQUEST_FAILED';
        trackProjectCreateResult(
          analytics.track,
          {
            page_name: 'home',
            area: 'new_project',
            project_source: 'create_button',
            project_id: null,
            project_kind: projectKindFromMetadataToTracking(metadata),
            fidelity,
            result: 'failed',
            error_code: errorCode,
          },
          { requestId: input.requestId },
        );
        if (optimisticProjectId) {
          clearLocalProject(optimisticProjectId);
          removeWorkspaceProjectTabs(optimisticProjectId);
          setProjects((current) => current.filter((project) => project.id !== optimisticProjectId));
          setPendingProjectCreation((current) =>
            current?.projectId === optimisticProjectId ? null : current);
          if (
            routeRef.current.kind === 'project'
            && routeRef.current.projectId === optimisticProjectId
          ) {
            navigate({ kind: 'home', view: 'home' });
          }
          setProjectCreateError(errorCode);
          return false;
        }
        throw err;
      }
      if (!result) {
        trackProjectCreateResult(
          analytics.track,
          {
            page_name: 'home',
            area: 'new_project',
            project_source: 'create_button',
            project_id: null,
            project_kind: projectKindFromMetadataToTracking(metadata),
            fidelity,
            ...(input.pluginId ? { plugin_id: input.pluginId } : {}),
            ...(input.pluginType ? { plugin_type: input.pluginType } : {}),
            result: 'failed',
            error_code: 'CREATE_REQUEST_FAILED',
          },
          { requestId: input.requestId },
        );
        return false;
      }
      const project = result.appliedPluginSnapshotId
        ? {
            ...result.project,
            appliedPluginSnapshotId: result.appliedPluginSnapshotId,
          }
        : result.project;
      if (optimisticProjectId) {
        rememberLocalProject(project.id);
        flushSync(() => {
          setProjects((curr) => [
            project,
            ...curr.filter((candidate) => candidate.id !== project.id),
          ]);
        });
      }
      try {
        const pendingFiles = Array.isArray(input.pendingFiles)
          ? input.pendingFiles.filter((file): file is File => file instanceof File)
          : [];
        // Flip the project onto the user-picked working directory BEFORE
        // uploading staged Home attachments. `replaceProjectWorkingDir` changes
        // `metadata.baseDir`, so the project starts reading from the external
        // folder. If we uploaded first, the staged files would land in the
        // temporary managed `.od/projects/<id>` root and then silently vanish
        // from Design Files and the first auto-send context once the working
        // dir flips. Doing the handoff first means the initial upload lands in
        // the final tree.
        const userWorkingDir = metadata?.userWorkingDir;
        let workingDirHandoffFailed = false;
        if (userWorkingDir) {
          try {
            await replaceProjectWorkingDir(
              result.project.id,
              userWorkingDir,
              input.userWorkingDirToken,
            );
          } catch (err) {
            // The desktop working-dir token is short-lived (~60s TTL); if the
            // user lingered on Home or the POST was otherwise rejected, the
            // handoff fails AFTER the project already exists. Do NOT swallow
            // this and do NOT proceed: uploading staged attachments or
            // auto-sending the first message would target the managed
            // `.od/projects/<id>` root the user did not choose. Mark the
            // handoff as failed so the upload + auto-send branches below are
            // skipped, then surface a create-time error so the user can
            // re-pick the working directory from inside the project.
            console.warn('Failed to set working directory for new project', userWorkingDir, err);
            workingDirHandoffFailed = true;
            setWorkingDirError(
              `Couldn't apply the chosen folder "${userWorkingDir}". The project was created in the default location — re-pick the working directory from the project before uploading files or sending a message.`,
            );
          }
        }
        let firstMessageAttachments: ChatAttachment[] = [];
        if (!workingDirHandoffFailed && pendingFiles.length > 0) {
          // Home composer attaches stay client-side until submit lands a
          // project; the actual upload happens here. v2 doc wants one
          // file_upload_result per surface — `page_name='home'` /
          // `area='chat_composer'` so it's distinguishable from the
          // file_manager Upload button and the chat_panel composer.
          const cohort = deriveUploadCohort(pendingFiles);
          const uploadResult = await uploadProjectFiles(
            result.project.id,
            pendingFiles,
          );
          firstMessageAttachments = uploadResult.uploaded;
          const partial = uploadResult.failed.length > 0;
          if (partial) {
            console.warn('Some Home attachments failed to upload', uploadResult.failed);
          }
          trackFileUploadResult(analytics.track, {
            page_name: 'home',
            area: 'chat_composer',
            project_id: result.project.id,
            ...cohort,
            result: partial ? 'failed' : 'success',
            ...(partial && uploadResult.error
              ? { error_code: uploadResult.error }
              : {}),
          });
        }
        trackProjectCreateResult(
          analytics.track,
          {
            page_name: 'home',
            area: 'new_project',
            project_source: 'create_button',
            project_id: result.project.id,
            project_kind: projectKindFromMetadataToTracking(metadata),
            fidelity,
            ...(input.pluginId ? { plugin_id: input.pluginId } : {}),
            ...(input.pluginType ? { plugin_type: input.pluginType } : {}),
            result: 'success',
          },
          { requestId: input.requestId },
        );
        // PluginLoopHome flow: the user already typed (or accepted) the
        // first message on Home. Mark this project so ProjectView fires
        // sendMessage(pendingPrompt) once on mount instead of just
        // pre-filling the composer. Scoped to sessionStorage so a page
        // reload after the run has started does not refire.
        if (
          !workingDirHandoffFailed &&
          input.autoSendFirstMessage &&
          (derivedPendingPrompt !== undefined || firstMessageAttachments.length > 0)
        ) {
          try {
            window.sessionStorage.setItem(
              `od:auto-send-first:${result.project.id}`,
              '1',
            );
            if (derivedPendingPrompt !== undefined) {
              window.sessionStorage.setItem(
                `od:auto-send-prompt:${result.project.id}`,
                derivedPendingPrompt,
              );
            } else {
              window.sessionStorage.removeItem(
                `od:auto-send-prompt:${result.project.id}`,
              );
            }
            if (firstMessageAttachments.length > 0) {
              window.sessionStorage.setItem(
                `od:auto-send-attachments:${result.project.id}`,
                JSON.stringify(firstMessageAttachments),
              );
            } else {
              window.sessionStorage.removeItem(
                `od:auto-send-attachments:${result.project.id}`,
              );
            }
            if (input.initialRunContext && Object.keys(input.initialRunContext).length > 0) {
              window.sessionStorage.setItem(
                `od:auto-send-context:${result.project.id}`,
                JSON.stringify(input.initialRunContext),
              );
            } else {
              window.sessionStorage.removeItem(
                `od:auto-send-context:${result.project.id}`,
              );
            }
          } catch {
            /* sessionStorage may be unavailable (e.g. SSR / private mode); fall
               back to manual send. */
          }
        }
        // Home recommendation handoff: now that the project exists and its id is
        // known, stash the onboarding entry keyed by that id. Studio consumes it
        // by the same id on mount. Keying by id (instead of a single global slot
        // written before create) removes the race where opening an unrelated
        // project mid-create could steal the personalized funnel context, and
        // means a failed/aborted create leaves nothing behind.
        if (input.onboardingEntry) {
          // Cache the prefilled seed prompt WITH the entry so the first-prompt
          // funnel's `has_prefilled_prompt` comparison base survives a
          // reopen-before-send (project.pendingPrompt is wiped on first mount).
          stashOnboardingEntryForProject(result.project.id, {
            ...input.onboardingEntry,
            ...(derivedPendingPrompt
              ? { seedPrompt: derivedPendingPrompt.trim() }
              : {}),
          });
        }
        if (!optimisticProjectId) {
          rememberLocalProject(project.id);
          flushSync(() => {
            setProjects((curr) => [
              project,
              ...curr.filter((candidate) => candidate.id !== project.id),
            ]);
          });
        }
      } catch (err) {
        if (!optimisticProjectId) throw err;
        const errorCode =
          err instanceof Error && err.message.trim() ? err.message : 'PROJECT_SETUP_FAILED';
        console.warn('Failed to finish setting up new project', project.id, err);
        setProjectCreateError(errorCode);
      } finally {
        setPendingProjectCreation((current) =>
          current?.projectId === optimisticProjectId ? null : current,
        );
      }
      const projectRoute = {
        kind: 'project',
        projectId: project.id,
        fileName: null,
      } as const;
      // The Home auto-send path already owns this route from the optimistic
      // handoff. Do not re-navigate after persistence: if the user deliberately
      // backed out while creation finished, reopening the project would steal
      // focus. Non-optimistic creation paths retain the existing navigation.
      if (!optimisticProjectId) {
        openWorkspaceTab(projectRoute);
        navigate(projectRoute);
      }
      return true;
    },
    [analytics.track, clearLocalProject, rememberLocalProject],
  );

  const handleCreateProjectFromDesignSystem = useCallback(
    async (designSystemId: string, designSystemTitle: string) => {
      // "Create with this design system" must NOT assume a prototype. Route
      // the click through the hidden default design router (od-default) —
      // exactly like a free-form Home prompt. The preset prompt seeds the
      // conversation and is auto-sent so the router can infer the task type
      // from the brief, asking only when the route remains ambiguous. `kind`
      // stays the neutral 'other' so no surface-specific default leaks back
      // in on the daemon side.
      const presetPrompt = t('nextStep.brandCreateDesignPrompt', {
        designSystem: designSystemTitle,
      });
      await handleCreateProject({
        name: t('common.untitled'),
        skillId: null,
        designSystemId,
        pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
        pluginInputs: { prompt: presetPrompt },
        pendingPrompt: presetPrompt,
        autoSendFirstMessage: true,
        conversationMode: 'design',
        metadata: {
          kind: 'other',
          nameSource: 'generated',
        },
      });
    },
    [handleCreateProject, t],
  );

  const handleCreateDesignSystemFromProject = useCallback(
    async (
      sourceProjectId: string,
      input: { name?: string; pendingPrompt?: string },
    ) => {
      const result = await createDesignSystemProjectFromProject(
        sourceProjectId,
        input,
      );
      try {
        window.sessionStorage.setItem(`od:auto-send-first:${result.project.id}`, '1');
        const pendingPrompt = input.pendingPrompt ?? result.project.pendingPrompt;
        if (pendingPrompt !== undefined) {
          window.sessionStorage.setItem(
            `od:auto-send-prompt:${result.project.id}`,
            pendingPrompt,
          );
        }
      } catch {
        // If sessionStorage is unavailable, the project still opens with the
        // pending prompt ready for the user to send manually.
      }
      rememberLocalProject(result.project.id);
      setProjects((curr) => [
        result.project,
        ...curr.filter((p) => p.id !== result.project.id),
      ]);
      void refreshDesignSystems();
      navigate({
        kind: 'project',
        projectId: result.project.id,
        conversationId: result.conversationId,
        fileName: null,
      });
    },
    [refreshDesignSystems, rememberLocalProject],
  );

  const handleDuplicateProject = useCallback(
    async (sourceProjectId: string, input: { name?: string } = {}) => {
      const result = await duplicateProject(sourceProjectId, input);
      rememberLocalProject(result.project.id);
      setProjects((curr) => [
        result.project,
        ...curr.filter((p) => p.id !== result.project.id),
      ]);
      navigate({
        kind: 'project',
        projectId: result.project.id,
        conversationId: result.conversationId,
        fileName: null,
      });
    },
    [rememberLocalProject],
  );

  const handleCreatePluginShareProject = useCallback(
    async (
      pluginId: string,
      action: PluginShareAction,
      locale?: string,
    ): Promise<PluginShareProjectOutcome> => {
      const outcome = await createPluginShareProject(pluginId, action, locale);
      if (!outcome.ok) return outcome;
      try {
        window.sessionStorage.setItem(
          `od:auto-send-first:${outcome.project.id}`,
          '1',
        );
        if (outcome.project.pendingPrompt !== undefined) {
          window.sessionStorage.setItem(
            `od:auto-send-prompt:${outcome.project.id}`,
            outcome.project.pendingPrompt,
          );
        }
      } catch {
        // If sessionStorage is unavailable, the project still opens with
        // the prepared prompt in the composer.
      }
      const project = outcome.appliedPluginSnapshotId
        ? {
            ...outcome.project,
            appliedPluginSnapshotId: outcome.appliedPluginSnapshotId,
          }
        : outcome.project;
      rememberLocalProject(project.id);
      setProjects((curr) => [
        project,
        ...curr.filter((p) => p.id !== project.id),
      ]);
      navigate({
        kind: 'project',
        projectId: project.id,
        fileName: null,
      });
      return outcome;
    },
    [rememberLocalProject],
  );

  const handleImportClaudeDesign = useCallback(async (
    file: File,
  ): Promise<ImportClaudeDesignOutcome> => {
    try {
      const result = await importClaudeDesignZip(file);
      rememberLocalProject(result.project.id);
      setProjects((curr) => [
        result.project,
        ...curr.filter((p) => p.id !== result.project.id),
      ]);
      navigate({
        kind: 'project',
        projectId: result.project.id,
        fileName: result.entryFile,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'The ZIP could not be imported.',
      };
    }
  }, [rememberLocalProject]);

  const handleImportFolder = useCallback(async (baseDir: string) => {
    const result = await importFolderProject({ baseDir });
    rememberLocalProject(result.project.id);
    setProjects((curr) => [result.project, ...curr.filter((p) => p.id !== result.project.id)]);
    navigate({
      kind: 'project',
      projectId: result.project.id,
      fileName: null,
    });
  }, [rememberLocalProject]);

  // PR #974: on desktop, the host bridge owns the picker and import POST
  // atomically. The renderer never sees the path, token, or daemon DTO;
  // it receives host-owned project identifiers and refreshes project state
  // through the normal daemon API.
  const handleImportFolderResponse = useCallback(async (result: OpenDesignHostProjectImportSuccess) => {
    rememberLocalProject(result.projectId);
    const project = await getProject(result.projectId);
    if (project != null) {
      setProjects((curr) => [project, ...curr.filter((p) => p.id !== project.id)]);
    } else {
      // Daemon hasn't materialized the full record yet (race between the
      // host's import POST and our /api/projects read). Seed a minimal
      // placeholder so the route stays alive and ProjectView mounts; the
      // pending-local id keeps reconcileFetchedProjects from evicting the
      // stub until a project-list snapshot actually includes it, and the
      // next refresh swaps it for the real Project record. Without the
      // stub, a stale `[]` list response would replace `projects` with `[]`
      // and the route-guard effect would bounce the user back to Home.
      const stub: Project = {
        id: result.projectId,
        name: '',
        skillId: null,
        designSystemId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setProjects((curr) => [stub, ...curr.filter((p) => p.id !== stub.id)]);
    }
    navigate({
      kind: 'project',
      projectId: result.projectId,
      fileName: null,
    });
  }, [rememberLocalProject]);

  const handleOpenProject = useCallback(async (
    id: string,
    fileName?: string,
    projectTitleHint?: ProjectTitleHint,
  ): Promise<boolean> => {
    const routeFileName = fileName ?? null;
    const hintedProjectName = projectTitleHint?.name.trim() || null;
    const knownLocalProject = projectsRef.current.find((project) => project.id === id);
    if (knownLocalProject) {
      if (hintedProjectName && knownLocalProject.name !== hintedProjectName) {
        setProjects((current) => current.map((project) =>
          project.id === id ? { ...project, name: hintedProjectName } : project));
      }
      navigate({ kind: 'project', projectId: id, fileName: routeFileName });
      return true;
    }
    try {
      const project = await getProject(id);
      if (project) {
        const openedProject = hintedProjectName ? { ...project, name: hintedProjectName } : project;
        setProjects((curr) => [
          openedProject,
          ...curr.filter((candidate) => candidate.id !== openedProject.id),
        ]);
        navigate({ kind: 'project', projectId: id, fileName: routeFileName });
        return true;
      }
      const request = beginProjectListRequest();
      const list = await listCurrentProjects();
      const reconciledList = hintedProjectName
        ? list.map((candidate) =>
            candidate.id === id ? { ...candidate, name: hintedProjectName } : candidate)
        : list;
      reconcileFetchedProjects(reconciledList, request);
      const fetchedProject = locallyDeletedProjectIdsRef.current.has(id)
        ? undefined
        : reconciledList.find((candidate) => candidate.id === id);
      if (fetchedProject) {
        navigate({ kind: 'project', projectId: id, fileName: routeFileName });
        return true;
      }
    } catch {
      // Fall through to the same visible missing-project state.
    }
    setProjectOpenError(t('project.missing'));
    return false;
  }, [
    beginProjectListRequest,
    listCurrentProjects,
    reconcileFetchedProjects,
    t,
  ]);

  const handleOpenLiveArtifact = useCallback((projectId: string, artifactId: string) => {
    navigate({ kind: 'project', projectId, fileName: liveArtifactTabId(artifactId) });
  }, []);

  const handleDeleteProject = useCallback(async (id: string) => {
    await deleteProjectApi(id);
    removeProjectFromDisplaySnapshots({ projectId: id });
    clearLocalProject(id, { deleted: true });
    removeWorkspaceProjectTabs(id);
    iframeKeepAlivePool.evictProject(id, { includeActive: true });
    setProjects((curr) => curr.filter((p) => p.id !== id));
    if (route.kind === 'project' && route.projectId === id) {
      navigate({ kind: 'home', view: 'home' });
    }
    return true;
  }, [clearLocalProject, iframeKeepAlivePool, route]);

  const handleRenameProject = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const previous = projectsRef.current.find((project) => project.id === id) ?? null;
    const renameProjectionKey = JSON.stringify([id]);
    let renameState = projectRenameStatesRef.current.get(renameProjectionKey);
    if (!renameState || renameState.pending === 0) {
      if (!previous) return;
      renameState = {
        generation: 0,
        confirmed: previous,
        pending: 0,
        tail: Promise.resolve(),
      };
      projectRenameStatesRef.current.set(renameProjectionKey, renameState);
    }
    const renameGeneration = ++renameState.generation;
    renameState.pending += 1;
    projectListMutationVersionRef.current += 1;
    const renameMutationVersion = projectListMutationVersionRef.current;
    const optimistic = { ...(previous ?? renameState.confirmed), name: trimmed };
    pendingProjectNameProjectionsRef.current.set(renameProjectionKey, {
      project: optimistic,
      mutationVersion: renameMutationVersion,
      confirmed: false,
    });
    setProjects((curr) =>
      curr.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
    );
    patchProjectDisplaySnapshots({
      patch: (cachedProjects) => cachedProjects.map((project) =>
        project.id === id ? { ...project, name: trimmed } : project),
    });
    const runRename = async () => {
      const persisted = await patchProject(id, { name: trimmed });
      if (persisted) renameState.confirmed = persisted;
      const isLatestQueuedRename =
        projectRenameStatesRef.current.get(renameProjectionKey) === renameState
        && renameState.generation === renameGeneration;
      if (!isLatestQueuedRename) return;
      const nextProject = persisted ?? renameState.confirmed;
      const pendingProjection = pendingProjectNameProjectionsRef.current.get(renameProjectionKey);
      if (pendingProjection?.mutationVersion === renameMutationVersion) {
        pendingProjection.project = nextProject;
        pendingProjection.confirmed = true;
      }
      patchProjectDisplaySnapshots({
        patch: (cachedProjects) => cachedProjects.map((project) =>
          project.id === id && (persisted || project.name === trimmed)
            ? {
                ...project,
                name: nextProject.name,
                metadata: nextProject.metadata,
                updatedAt: nextProject.updatedAt,
              }
            : project),
      });
      if (!persisted) {
        setProjects((current) => current.map((project) =>
          project.id === id && project.name === trimmed
            ? {
                ...project,
                name: nextProject.name,
                metadata: nextProject.metadata,
                updatedAt: nextProject.updatedAt,
              }
            : project
        ));
        await refreshProjects();
        return;
      }
      setProjects((current) => current.map((project) =>
        project.id === id
          ? {
              ...project,
              name: persisted.name,
              metadata: persisted.metadata,
              updatedAt: persisted.updatedAt,
            }
          : project
      ));
      await refreshProjects();
    };
    const queued = renameState.tail.then(runRename, runRename);
    renameState.tail = queued.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      renameState.pending -= 1;
      if (
        renameState.pending === 0
        && projectRenameStatesRef.current.get(renameProjectionKey) === renameState
      ) {
        projectRenameStatesRef.current.delete(renameProjectionKey);
      }
    });
    await queued;
  }, [refreshProjects]);

  // The project header back button is an escape hatch back to Home. Avoid
  // depending on browser history here: tab restores and template-create flows
  // can leave an in-app history entry that points back to the same project.
  const handleBack = useCallback(() => {
    const currentProjectId = route.kind === 'project' ? route.projectId : null;
    navigate({ kind: 'home', view: 'home' }, {
      onCommit: () => {
        if (!currentProjectId) return;
        iframeKeepAlivePool.evictProject(currentProjectId, { includeActive: true });
      },
    });
  }, [iframeKeepAlivePool, route]);

  const handleClearPendingPrompt = useCallback(() => {
    const projectId = route.kind === 'project' ? route.projectId : null;
    if (!projectId) return;
    setProjects((curr) =>
      curr.map((p) =>
        p.id === projectId ? { ...p, pendingPrompt: undefined } : p,
      ),
    );
    patchProjectDisplaySnapshots({
      patch: (cachedProjects) => cachedProjects.map((project) =>
        project.id === projectId ? { ...project, pendingPrompt: undefined } : project),
    });
    void patchProject(projectId, { pendingPrompt: null });
  }, [route]);

  const handleTouchProject = useCallback(() => {
    const projectId = route.kind === 'project' ? route.projectId : null;
    if (!projectId) return;
    const updatedAt = Date.now();
    setProjects((curr) =>
      curr.map((p) => (p.id === projectId ? { ...p, updatedAt } : p)),
    );
    patchProjectDisplaySnapshots({
      patch: (cachedProjects) => cachedProjects.map((project) =>
        project.id === projectId ? { ...project, updatedAt } : project),
    });
    void patchProject(projectId, { updatedAt });
  }, [route]);

  const handleProjectChange = useCallback((updated: Project) => {
    const routeSnapshot = routeProjectSnapshotRef.current;
    if (
      routeRef.current.kind === 'project'
      && routeRef.current.projectId === updated.id
      && routeSnapshot?.project.id === updated.id
    ) {
      routeProjectSnapshotRef.current = {
        ...routeSnapshot,
        project: updated,
      };
      setRouteProjectSnapshotRevision((current) => current + 1);
    }
    setProjects((curr) => {
      const previous = curr.find((p) => p.id === updated.id);
      if (
        previous
        && (
          previous.skillId !== updated.skillId
          || previous.designSystemId !== updated.designSystemId
          || previous.customInstructions !== updated.customInstructions
        )
      ) {
        iframeKeepAlivePool.evictProject(updated.id, { includeActive: true });
      }
      return curr.map((p) => (p.id === updated.id ? updated : p));
    });
    patchProjectDisplaySnapshots({
      patch: (cachedProjects) => cachedProjects.map((project) =>
        project.id === updated.id ? { ...project, ...updated } : project),
    });
  }, [iframeKeepAlivePool]);

  const handleProjectRenameStarted = useCallback((optimistic: Project): ProjectRenameFenceToken => {
    projectListMutationVersionRef.current += 1;
    const mutationVersion = projectListMutationVersionRef.current;
    const key = JSON.stringify([optimistic.id]);
    pendingProjectNameProjectionsRef.current.set(
      key,
      {
        project: optimistic,
        mutationVersion,
        confirmed: false,
      },
    );
    return {
      projectId: optimistic.id,
      mutationVersion,
    };
  }, []);

  const handleProjectRenameSettled = useCallback((
    token: ProjectRenameFenceToken | null,
    confirmed: Project,
  ) => {
    if (!token || token.projectId !== confirmed.id) return;
    const key = JSON.stringify([token.projectId]);
    const pending = pendingProjectNameProjectionsRef.current.get(key);
    if (!pending || pending.mutationVersion !== token.mutationVersion) return;
    pending.project = confirmed;
    pending.confirmed = true;
  }, []);

  // ProjectView's prompt-context signature derives from SkillSummary /
  // DesignSystemSummary fields, so a body-only registry edit (same name,
  // description, etc.) leaves every signature unchanged and the active
  // preview keeps serving stale prompt context. Settings → Skills /
  // Settings → Design Systems call back through these handlers after
  // every successful mutation; we drop any pool entry whose project
  // depends on the affected id — active or parked — so the next mount
  // recomposes the system prompt with the new body.

  const handleSkillsChanged = useCallback(
    (affectedSkillId?: string) => {
      void refreshSkills();
      void fetchDesignTemplates().then((list) => setDesignTemplates(list));
      iframeKeepAlivePool.evictMatching(
        (entry) => {
          const proj = projectsRef.current.find((p) => p.id === entry.projectId);
          if (!proj) return false;
          if (affectedSkillId) return proj.skillId === affectedSkillId;
          return proj.skillId != null;
        },
        { includeActive: true },
      );
    },
    [iframeKeepAlivePool, refreshSkills],
  );

  const handleDesignSystemsChanged = useCallback(
    (affectedDesignSystemId?: string) => {
      void refreshDesignSystems();
      iframeKeepAlivePool.evictMatching(
        (entry) => {
          const proj = projectsRef.current.find((p) => p.id === entry.projectId);
          if (!proj) return false;
          if (affectedDesignSystemId) {
            return proj.designSystemId === affectedDesignSystemId;
          }
          return proj.designSystemId != null;
        },
        { includeActive: true },
      );
    },
    [iframeKeepAlivePool, refreshDesignSystems],
  );

  /**
   * Invariant: leaving `/design-systems/create` returns the user to whatever
   * surface opened it — the project conversation they were mid-task in, the
   * composer's design-system picker, the Library, a home card — instead of a
   * fixed destination. The page is reachable from all of those, so a hardcoded
   * exit route silently abandons the work the user was in the middle of
   * (OPEND-2249: creating a design system from inside a project conversation
   * dropped them on the Design systems tab).
   *
   * The Design systems tab stays the fallback: it is where the standalone
   * entry lives, so a deep link or fresh load — the only case with no in-app
   * layer to step back to — still lands somewhere that makes sense.
   */
  const handleDesignSystemCreateBack = useCallback(() => {
    goBack({ kind: 'home', view: 'design-systems' });
  }, []);

  const handleDesignSystemImportRebuildJob = useCallback(
    (designSystemId: string, job: DesignSystemGenerationJob) => {
      setPendingDesignSystemRevisionJobs((current) => ({
        ...current,
        [designSystemId]: job,
      }));
    },
    [],
  );
  const handleDesignSystemRevisionJobConsumed = useCallback((designSystemId: string, jobId: string) => {
    setPendingDesignSystemRevisionJobs((current) => {
      if (current[designSystemId]?.id !== jobId) return current;
      const next = { ...current };
      delete next[designSystemId];
      return next;
    });
  }, []);

  // The project list belongs to the shell's ambient Workspace and is cleared
  // immediately when the navigation rail switches A -> B. An already-open
  // project is not ambient: retain its persisted row independently so that
  // clearing/replacing the Home catalog cannot tear down ProjectView, lose the
  // exact A authority, or reinterpret the same route under B.
  const routeProjectSnapshotRef = useRef<{
    project: Project;
    capturedAfterListGeneration: number;
    resolvedDir?: string | null;
  } | null>(null);
  const [, setRouteProjectSnapshotRevision] = useState(0);
  let loadedActiveProject: Project | null = null;
  if (route.kind === 'project') {
    const listedProject = projects.find((project) => project.id === route.projectId);
    if (listedProject) {
      const previous = routeProjectSnapshotRef.current;
      routeProjectSnapshotRef.current = {
        project: listedProject,
        capturedAfterListGeneration: latestAppliedProjectListGenerationRef.current,
        ...(previous && previous.resolvedDir !== undefined
          ? { resolvedDir: previous.resolvedDir }
          : {}),
      };
    } else if (
      routeProjectSnapshotRef.current?.project.id !== route.projectId
      || (
        appliedProjectListWitness
        && appliedProjectListWitness.generation
          > routeProjectSnapshotRef.current.capturedAfterListGeneration
        && !appliedProjectListWitness.projectIds.has(route.projectId)
      )
    ) {
      routeProjectSnapshotRef.current = null;
    }
    loadedActiveProject =
      listedProject
      ?? routeProjectSnapshotRef.current?.project
      ?? null;
  } else {
    routeProjectSnapshotRef.current = null;
  }
  // Deep-linked route to a project we don't have yet (e.g. after a refresh
  // that finishes after the project list comes back). Fetch it in the
  // background so the view can render rather than bouncing to home.
  useEffect(() => {
    if (route.kind !== 'project') return;
    if (loadedActiveProject) return;
    if (projects.some((p) => p.id === route.projectId)) return;
    let cancelled = false;
    const projectId = route.projectId;
    setDeepLinkResolutionFailure((current) =>
      current?.projectId === projectId ? null : current
    );
    void (async () => {
      const bootstrap = await bootstrapProjectRoute(projectId, {
        accountGeneration: 0,
      });
      if (cancelled) return;
      if (bootstrap.kind === 'found') {
        routeProjectSnapshotRef.current = {
          project: bootstrap.project,
          capturedAfterListGeneration: latestAppliedProjectListGenerationRef.current,
          resolvedDir: bootstrap.resolvedDir,
        };
        setRouteProjectSnapshotRevision((current) => current + 1);
        setDeepLinkResolutionFailure((current) =>
          current?.projectId === projectId ? null : current
        );
        return;
      }
      if (bootstrap.kind === 'not-found') {
        setDeepLinkResolutionFailure({ projectId, failure: 'missing' });
        return;
      }
      // unavailable: retried on dependency change.
    })();
    return () => {
      cancelled = true;
    };
  }, [
    route.kind,
    route.kind === 'project' ? route.projectId : null,
    loadedActiveProject?.id,
    projects,
  ]);

  const openSettings = useCallback((
    section: SettingsSection = 'execution',
    opts?: { highlight?: SettingsHighlight },
  ) => {
    if (section === 'composio' || section === 'mcpClient' || section === 'integrations') {
      settingsReturnTargetRef.current = null;
      setIntegrationInitialTab(
        section === 'composio'
          ? 'connectors'
          : section === 'mcpClient'
            ? 'mcp'
            : 'use-everywhere',
      );
      navigate({ kind: 'home', view: 'integrations' });
      return;
    }
    const currentRoute = routeRef.current;
    settingsReturnTargetRef.current =
      currentRoute.kind === 'project'
        ? { route: { ...currentRoute } }
        : null;
    setSettingsWelcome(false);
    setSettingsInitialSection(section);
    setSettingsHighlight(opts?.highlight ?? null);
    navigate({ kind: 'home', view: 'settings' });
  }, []);

  const openMcpSettings = useCallback(() => {
    setIntegrationInitialTab('mcp');
    navigate({ kind: 'home', view: 'integrations' });
  }, []);

  // The composer "+" menu's "add plugin" / "add connector" rows route to the
  // home plugin-registry / connector-integration surfaces.
  const openPluginRegistry = useCallback(() => {
    navigate({ kind: 'home', view: 'plugins' });
  }, []);

  const openConnectorIntegrations = useCallback(() => {
    setIntegrationInitialTab('connectors');
    navigate({ kind: 'home', view: 'integrations' });
  }, []);

  const handleCompleteOnboarding = useCallback(() => {
    const current = latestPersistedConfigRef.current;
    if (current.onboardingCompleted) return;
    const next: AppConfig = { ...current, onboardingCompleted: true };
    latestPersistedConfigRef.current = next;
    saveConfig(next);
    void syncConfigToDaemon(next);
    setConfig(next);
  }, []);

  // Cmd+, (mac) / Ctrl+, (win/linux) opens Settings. Capture phase so we
  // beat the browser's default Preferences dialog. Platform-gated so
  // meta/ctrl don't conflict across OS.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const primary = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (primary && !e.shiftKey && !e.altKey && e.key === ',') {
        if (e.isComposing) return;
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [openSettings]);

  // When the user lands on the entry view (route.kind === 'home'), pull
  // a fresh template list. The template store is global — if they just
  // saved a template inside a project, returning home should reflect it
  // immediately in the From-template tab without forcing a page reload.
  // Same rationale for design systems: a brand extraction (or any in-project
  // design-system creation) registers a `user:<id>` system out of band, so the
  // Design systems tab must re-fetch to show it — and the brand-ready prompt
  // relies on the new system being present so it can preselect it.
  useEffect(() => {
    if (route.kind !== 'home') return;
    void refreshTemplates();
    void refreshDesignSystems();
  }, [route.kind, refreshTemplates, refreshDesignSystems]);

  // Existing card grids (DesignsTab, ProjectView), pickers (NewProjectPanel,
  // ChatComposer mention) all look skills up by id without caring whether
  // the id resolves to a functional skill or a design template. Pass them
  // the union so the post-split refactor stays invisible to those callers.
  const allSkillSummaries = useMemo(
    () => [...skills, ...designTemplates],
    [skills, designTemplates],
  );
  const enabledSkills = useMemo(
    () =>
      allSkillSummaries.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [allSkillSummaries, config.disabledSkills],
  );
  // Functional-skills-only enabled subset — what ProjectView's chat
  // composer @-picker should see. Without this, a skill the user has
  // disabled in Settings still appears in an existing project's @-mention
  // popover and can ride along to the daemon via skillIds, breaking the
  // Library toggle for projects opened on the post-split branch.
  const enabledFunctionalSkills = useMemo(
    () =>
      skills.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [skills, config.disabledSkills],
  );
  // Templates-only enabled subset — what the EntryView Templates gallery
  // actually renders. Filtering in App keeps the EntryView prop surface
  // narrow ("here are the templates the user has not disabled").
  const enabledDesignTemplates = useMemo(
    () =>
      designTemplates.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [designTemplates, config.disabledSkills],
  );
  const enabledDS = useMemo(
    () =>
      designSystems.filter(
        (d) => !(config.disabledDesignSystems ?? []).includes(d.id),
      ),
    [designSystems, config.disabledDesignSystems],
  );

  const handleCloseSettings = () => {
    // Closing Settings is still the canonical "I'm done" gesture now that
    // there is no global Save button. The same close path is shared by the
    // legacy modal and the full-page route. We mark onboardingCompleted on
    // close so the welcome modal stops re-prompting on every refresh,
    // regardless of whether the user changed anything during the session.
    const next = resolveSettingsCloseConfig(config, latestPersistedConfigRef.current);
    if (!next.onboardingCompleted || !config.onboardingCompleted) {
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    }
    setSettingsOpen(false);
    settingsDraftConfigRef.current = null;
    setSettingsHighlight(null);
    if (route.kind === 'home' && route.view === 'settings') {
      const returnTarget = settingsReturnTargetRef.current;
      settingsReturnTargetRef.current = null;
      navigate(
        returnTarget
          ? returnTarget.route
          : { kind: 'home', view: 'home' },
      );
    }
  };

  const handleResetOnboarding = useCallback((next: AppConfig) => {
    latestPersistedConfigRef.current = next;
    saveConfig(next);
    void syncConfigToDaemon(next, { allowOnboardingReset: true });
    setConfig(next);
    setSettingsOpen(false);
    settingsDraftConfigRef.current = null;
    setSettingsHighlight(null);
    navigate({ kind: 'home', view: 'onboarding' });
  }, []);

  const renderSettingsSurface = (presentation: 'modal' | 'page') => (
    <SettingsDialog
      presentation={presentation}
      initial={config}
      agents={agents}
      agentsLoading={agentsLoading}
      daemonLive={daemonLive}
      appVersionInfo={appVersionInfo}
      welcome={presentation === 'modal' ? settingsWelcome : false}
      initialSection={settingsInitialSection}
      initialHighlight={settingsHighlight}
      composioConfigLoading={composioConfigLoading}
      onPersist={handleConfigPersist}
      onSilentUpdatePreferenceChange={handleSilentUpdatePreferenceChange}
      onDraftChange={handleSettingsDraftChange}
      onPersistComposioKey={handleConfigPersistComposioKey}
      onClose={handleCloseSettings}
      onResetOnboarding={handleResetOnboarding}
      onRefreshAgents={refreshAgents}
      daemonMediaProviders={daemonMediaProviders}
      daemonMediaProvidersFetchState={daemonMediaProvidersFetchState}
      mediaProvidersNotice={mediaProvidersNotice}
      onReloadMediaProviders={reloadMediaProvidersFromDaemon}
      onProjectsRefresh={refreshProjects}
      onSkillsChanged={handleSkillsChanged}
      onDesignSystemsChanged={handleDesignSystemsChanged}
      onDesignSystemImportRebuildJob={handleDesignSystemImportRebuildJob}
      providerModelsCache={providerModelsCache}
      onProviderModelsCacheChange={setProviderModelsCache}
    />
  );

  // Phase 2B / spec §11.6 — marketplace deep UI dispatch. The
  // /marketplace and /marketplace/:id routes render outside the
  // EntryView / ProjectView split so the discovery surface stays
  // independent of any active project.
  let appMain: ReactNode;
  const pendingFirstRunOnboardingRoute =
    route.kind === 'home' &&
    route.view === 'home' &&
    config.onboardingCompleted !== true &&
    !daemonConfigLoaded;
  if (pendingFirstRunOnboardingRoute) {
    appMain = (
      <div className="entry-shell entry-shell--no-header">
        <CenteredLoader label={t('entry.loadingWorkspace')} />
      </div>
    );
  } else if (route.kind === 'marketplace') {
    appMain = <MarketplaceView />;
  } else if (route.kind === 'marketplace-detail') {
    appMain = <PluginDetailView pluginId={route.pluginId} />;
  } else if (route.kind === 'community') {
    appMain = (
      <CommunityView
        onRemixTemplate={({ templateId, prompt }) => {
          // Remix carries the template's PROJECT along, not just its prompt:
          // duplicate the plugin's example artifact into a fresh project,
          // seed the composer with the template prompt, then open it on the
          // copied entry file (keep in sync with the EntryShell-embedded
          // community tab). Templates without a duplicable artifact fall
          // back to the old prompt-only project.
          void (async () => {
            const name = summarizeProjectNameFromPrompt(prompt) || t('common.untitled');
            try {
              const result = await duplicatePluginAsProject(templateId, { name });
              const seeded = await patchProject(
                result.projectId,
                { pendingPrompt: prompt },
              );
              if (!seeded) {
                // The project itself exists and is bound — only the prompt seed
                // was refused. Keep the user on it (retrying through the catch
                // below would leave the copy orphaned and create a second,
                // empty project) and surface the dropped seed instead of
                // discarding it silently.
                console.error('Community remix: could not seed the template prompt.');
              }
              navigate({
                kind: 'project',
                projectId: result.projectId,
                conversationId: result.conversationId,
                fileName: result.relPath,
              });
            } catch {
              await handleCreateProject({
                name,
                skillId: null,
                designSystemId: null,
                metadata: { kind: 'other', nameSource: 'prompt' },
                pendingPrompt: prompt,
              });
            }
          })();
        }}
        onUsePrompt={(target) => {
          seedHomeComposerPrompt(target.prompt);
          stashHomePromptHandoff(createPluginUseHandoff(Date.now(), target.templateId, {
            action: 'use',
            chipId: target.chipId,
            projectKind: target.projectKind,
          }));
          navigate({ kind: 'home', view: 'home' });
        }}
        onUsePlugin={(record, action, target) => {
          stashHomePromptHandoff(createPluginUseHandoff(Date.now(), record.id, {
            action,
            chipId: target.chipId,
            projectKind: target.projectKind,
          }));
          navigate({ kind: 'home', view: 'home' });
        }}
      />
    );
  } else if (route.kind === 'design-system-create') {
    appMain = (
      <DesignSystemCreationFlow
        onBack={handleDesignSystemCreateBack}
        designSystems={enabledDS}
        onCreated={(projectId, project, conversationId) => {
          if (project) {
            setProjects((curr) => [
              project,
              ...curr.filter((p) => p.id !== project.id),
            ]);
          }
          navigate({ kind: 'project', projectId, conversationId: conversationId ?? null, fileName: null });
        }}
        onProjectPrepared={(project) => {
          setProjects((curr) => [
            project,
            ...curr.filter((p) => p.id !== project.id),
          ]);
        }}
        onSystemsRefresh={refreshDesignSystems}
        config={config}
        onOpenConnectorsTab={() => openSettings('composio')}
      />
    );
  } else if (route.kind === 'design-system-detail') {
    appMain = (
      <DesignSystemDetailView
        id={route.designSystemId}
        selectedId={config.designSystemId}
        config={config}
        agents={agents}
        onBack={() => navigate({ kind: 'home', view: 'design-systems' })}
        onOpenProject={(projectId) => void handleOpenProject(projectId)}
        onSetDefault={handleChangeDefaultDesignSystem}
        onSystemsRefresh={refreshDesignSystems}
        onProjectsRefresh={refreshProjects}
        initialRevisionJob={pendingDesignSystemRevisionJobs[route.designSystemId] ?? null}
        onInitialRevisionJobConsumed={(jobId) =>
          handleDesignSystemRevisionJobConsumed(route.designSystemId, jobId)
        }
      />
    );
  } else if (route.kind === 'home' && route.view === 'settings') {
    appMain = renderSettingsSurface('page');
  } else if (route.kind === 'project') {
    const activeProject =
      loadedActiveProject
      ?? (routeProjectSnapshotRef.current?.project.id === route.projectId
        ? routeProjectSnapshotRef.current.project
        : null);
    const pendingCreation =
      activeProject && pendingProjectCreation?.projectId === activeProject.id
        ? pendingProjectCreation
        : null;
    const routeSurfaceState: 'ready' | 'loading-projects' | 'resolving-deep-link' | 'missing' | 'materialization-failed' | 'daemon-unavailable' =
      activeProject
        ? 'ready'
        : projectsLoading
          ? 'loading-projects'
          : !daemonLive
            ? 'daemon-unavailable'
            : deepLinkResolutionFailure?.projectId === route.projectId
              ? deepLinkResolutionFailure.failure
              : 'resolving-deep-link';
    if (pendingCreation && activeProject) {
      // Same `div.app` element as the ProjectView branch below, deliberately.
      // React reconciles one element across the pending -> real hand-off, so
      // the `.app` entrance animation plays once for the whole transition
      // instead of restarting when ProjectView takes over (the pending surface
      // lives ~150ms, shorter than the 180ms animation, so a second mount read
      // as the project frame flashing twice).
      appMain = (
        <div className="app">
          <ProjectCreationPendingView
            project={activeProject}
            prompt={pendingCreation.prompt}
            agentId={config.agentId}
            onBack={handleBack}
          />
        </div>
      );
    } else if (
      routeSurfaceState === 'loading-projects'
      || routeSurfaceState === 'resolving-deep-link'
    ) {
      appMain = (
        <div className="entry-shell entry-shell--no-header">
          <CenteredLoader label={t('entry.loadingWorkspace')} />
        </div>
      );
    } else if (routeSurfaceState !== 'ready') {
      const canRetry = routeSurfaceState === 'materialization-failed';
      appMain = (
        <div className="entry-shell entry-shell--no-header">
          <div className="centered-loader">
            <span role="alert">
              {routeSurfaceState === 'missing'
                ? t('project.missing')
                : t('connectors.unavailable')}
            </span>
            <Button
              onClick={
                canRetry
                  ? () => setDeepLinkRetryRevision((current) => current + 1)
                  : handleBack
              }
            >
              {canRetry
                ? t('promptTemplates.retry')
                : t('project.backToProjects')}
            </Button>
          </div>
        </div>
      );
    } else if (activeProject) {
      appMain = (
        <div className="app">
        <ProjectView
          key={activeProject.id}
          project={activeProject}
          initialProjectDetail={
            routeProjectSnapshotRef.current?.project.id === activeProject.id
            && routeProjectSnapshotRef.current.resolvedDir !== undefined
              ? {
                  project: routeProjectSnapshotRef.current.project,
                  resolvedDir: routeProjectSnapshotRef.current.resolvedDir,
                }
              : undefined
          }
          routeFileName={route.fileName}
          routeConversationId={route.conversationId ?? null}
          config={config}
          agents={agents}
          skills={enabledFunctionalSkills}
          designTemplates={designTemplates}
          designSystems={designSystems}
          daemonLive={daemonLive}
          onModeChange={handleModeChange}
          onAgentChange={handleAgentChange}
          onAgentModelChange={handleAgentModelChange}
          onApiModelChange={handleApiModelChange}
          onRefreshAgents={refreshAgents}
          onOpenSettings={openSettings}
          onOpenMcpSettings={openMcpSettings}
          onBrowsePlugins={openPluginRegistry}
          onOpenConnectors={openConnectorIntegrations}
          onBack={handleBack}
          onClearPendingPrompt={handleClearPendingPrompt}
          onTouchProject={handleTouchProject}
          onProjectChange={handleProjectChange}
          onProjectRenameStarted={handleProjectRenameStarted}
          onProjectRenameSettled={handleProjectRenameSettled}
          onProjectsRefresh={refreshProjects}
          onDeleteProject={handleDeleteProject}
          onChangeDefaultDesignSystem={handleChangeDefaultDesignSystem}
          onDesignSystemsRefresh={refreshDesignSystems}
          onCreateProjectFromDesignSystem={handleCreateProjectFromDesignSystem}
          onCreateDesignSystemFromProject={handleCreateDesignSystemFromProject}
          onDuplicateProject={handleDuplicateProject}
          onRunActivityChange={handleProjectRunActivityChange}
        />
        </div>
      );
    }
  } else {
    appMain = (
      <EntryView
        skills={enabledSkills}
        designTemplates={enabledDesignTemplates}
        designSystems={enabledDS}
        projects={projects}
        templates={templates}
        onDeleteTemplate={handleDeleteTemplate}
        promptTemplates={promptTemplates}
        defaultDesignSystemId={config.designSystemId}
        agents={agents}
        agentsLoading={agentsLoading}
        config={config}
        providerModelsCache={providerModelsCache}
        onProviderModelsCacheChange={setProviderModelsCache}
        integrationInitialTab={integrationInitialTab}
        composioConfigLoading={composioConfigLoading}
        daemonLive={daemonLive}
        onModeChange={handleModeChange}
        onAgentChange={handleAgentChange}
        onAgentModelChange={handleAgentModelChange}
        onApiProtocolChange={handleApiProtocolChange}
        onApiModelChange={handleApiModelChange}
        onConfigPersist={handleConfigPersist}
        daemonAppConfigReady={daemonAppConfigReady}
        onSilentUpdatePreferenceChange={handleSilentUpdatePreferenceChange}
        onSkillsRefresh={refreshSkills}
        onSkillsChanged={handleSkillsChanged}
        onRefreshAgents={refreshAgents}
        skillsLoading={skillsLoading}
        designSystemsLoading={dsLoading}
        projectsLoading={projectsLoading}
        promptTemplatesLoading={promptTemplatesLoading}
        onCreateProject={handleCreateProject}
        onCreatePluginShareProject={handleCreatePluginShareProject}
        onImportClaudeDesign={handleImportClaudeDesign}
        onImportFolder={handleImportFolder}
        onImportFolderResponse={handleImportFolderResponse}
        onOpenProject={handleOpenProject}
        onOpenLiveArtifact={handleOpenLiveArtifact}
        onDeleteProject={handleDeleteProject}
        onDuplicateProject={handleDuplicateProject}
        onRenameProject={handleRenameProject}
        onProjectsRefresh={refreshProjects}
        onChangeDefaultDesignSystem={handleChangeDefaultDesignSystem}
        onCreateDesignSystem={() => {
          setPendingDesignSystemCreateEntry('design_systems_page');
          navigate({ kind: 'design-system-create' });
        }}
        onOpenDesignSystem={(id: string) => navigate({ kind: 'design-system-detail', designSystemId: id })}
        onDesignSystemsRefresh={refreshDesignSystems}
        onPersistComposioKey={handleConfigPersistComposioKey}
        onOpenSettings={openSettings}
        onCompleteOnboarding={handleCompleteOnboarding}
      />
    );
  }
  return (
    <>
      <div
        className={`workspace-shell workspace-shell--${clientType}`}
        data-client-type={clientType}
        data-host-platform={hostPlatform}
      >
        <WorkspaceTabsBar
          route={route}
          projects={projects}
          onboardingCompleted={config.onboardingCompleted === true}
        />
        <div className="workspace-shell__body">
          {appMain}
        </div>
      </div>
      <TooltipLayer />
      <UpdateDialog />
      {/* Mounted at shell level, outside the route views, so a survey armed by
          an export inside a project stays on screen when the user navigates
          back to home. */}
      <ExperienceSurvey
        metricsConsent={config.telemetry?.metrics === true}
        onExposure={() => trackExperienceSurveyShown(analytics.track)}
        onDismiss={() => trackExperienceSurveyDismissed(analytics.track)}
        onSubmit={(answers) => trackExperienceSurveySent(analytics.track, answers)}
      />
      <AnimatePresence>
      {settingsOpen ? (
        renderSettingsSurface('modal')
      ) : null}
      </AnimatePresence>
      <MemoryToast
        onOpenMemory={() => openSettings('memory')}
        subscriptionMode={memoryToastSubscriptionMode({
          routeKind: route.kind,
          projectRunActive:
            route.kind === 'project'
            && projectRunActivity.projectId === route.projectId
            && projectRunActivity.active,
          memorySurfaceOpen:
            settingsInitialSection === 'memory'
            && (
              settingsOpen
              || (route.kind === 'home' && route.view === 'settings')
            ),
        })}
      />
      {workingDirError ? (
        <Toast
          message={workingDirError}
          role="alert"
          onDismiss={() => setWorkingDirError(null)}
        />
      ) : null}
      {projectCreateError ? (
        <Toast
          message={projectCreateError}
          role="alert"
          tone="error"
          onDismiss={() => setProjectCreateError(null)}
        />
      ) : null}
      {projectOpenError ? (
        <Toast
          message={projectOpenError}
          role="alert"
          tone="error"
          onDismiss={() => setProjectOpenError(null)}
        />
      ) : null}
      {/* First-run privacy consent banner. It waits for daemon config
          hydration because privacyDecisionAt is daemon-owned and stripped
          from localStorage. It waits for `onboardingCompleted` so first-run
          users see the welcome panel before the disclosure (Skip and
          finish both flip the flag). Independent of Settings: z-index in
          index.css sits above modal backdrops so opening Settings does
          not hide the banner. */}
      <AnimatePresence>
      {showPrivacyConsent ? (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        >
        <PrivacyConsentModal
          onShare={() => {
            // The banner owns only the privacy decision; it does not drive
            // navigation. Choosing Share keeps the current anonymous identity
            // when one already exists and enables the telemetry surface.
            handlePrivacyConsentChoice(true);
          }}
          onDecline={() => {
            handlePrivacyConsentChoice(false);
          }}
        />
      </motion.div>
      ) : null}
      </AnimatePresence>
    </>
  );
}

function generateInstallationIdSafe(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
