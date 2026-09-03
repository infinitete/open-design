// EntryShell — the centered-hero entry layout.
//
// This component owns the entire JSX render and local UI state for
// the redesigned home view (left rail + sticky settings cog + hero +
// recent projects + plugins section + new-project modal). It is
// intentionally a sibling of `EntryView` so that upstream `main`
// changes to `EntryView` (props, connector lifecycle, helpers, exports)
// can be rebased without touching this file. `EntryView` becomes a
// thin wrapper that passes data and callbacks through to this shell.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  automaticStrategyTaskProfileForProjectMetadata,
  defaultScenarioPluginIdForProjectMetadata,
  type ChatSessionMode,
  type ConnectorDetail,
  type CreateProjectExampleReference,
  type InstalledPluginRecord,
  type RunContextSelection,
  type ProjectScenarioTaskProfile,
} from '@open-design/contracts';
import type { OpenDesignHostProjectImportSuccess } from '@open-design/host';
import { useAnalytics } from '../analytics/provider';
import {
  trackHomeNavClick,
  trackOnboardingClick,
  trackOnboardingCompleteResult,
  trackOnboardingRuntimeScanResult,
  trackPageView,
} from '../analytics/events';
import {
  clearOnboardingSessionId,
  getOrCreateOnboardingSessionId,
} from '../analytics/onboarding-session';
import type {
  TrackingOnboardingArea,
  TrackingOnboardingStepIndex,
  TrackingOnboardingStepName,
  TrackingOnboardingClickElement,
  TrackingOnboardingClickAction,
  TrackingOnboardingRuntimeType,
  TrackingOnboardingCompletionResult,
  TrackingOnboardingCompletionType,
  TrackingCliProviderId,
} from '@open-design/contracts/analytics';
import { agentIdToTracking } from '@open-design/contracts/analytics';
import { useI18n, useT } from '../i18n';
import { navigate, useRoute } from '../router';
import type {
  AgentInfo,
  ApiProtocol,
  ApiProtocolConfig,
  AppConfig,
  ConnectionTestResponse,
  DesignSystemSummary,
  ExecMode,
  Project,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  PromptTemplateSummary,
  ProviderModelOption,
  ProviderModelsResponse,
  SkillSummary,
} from '../types';
import { CenteredLoader } from './Loading';
import { DesignsTab } from './DesignsTab';
import { DesignSystemsTab } from './DesignSystemsTab';
import { BrandsTab } from './BrandsTab';
import { EntryNavRail, type EntryView as EntryViewKind } from './EntryNavRail';
import {
  buildProjectSearchCatalog,
  ProjectSearchModal,
} from './ProjectSearchModal';
import { LibrarySection } from './LibrarySection';
import { UpdaterPopup } from './UpdaterPopup';
import { WhatsNewPopup } from './WhatsNewPopup';
import { DeepSeekHarnessSetupDialog } from './DeepSeekHarnessSetupDialog';
import { installDeepSeekHarnessCompanion } from '../providers/agent-companion';
import { HomeView, seedHomeComposerPrompt } from './HomeView';
import { entryStrategyRoutingFields } from './entry-strategy-routing';
import { EntryBlankState } from './EntryBlankState';
import { RecentProjectsStrip } from './RecentProjectsStrip';
import {
  createPluginAuthoringHandoff,
  createPluginUseHandoff,
  createSkillUseHandoff,
  takeHomePromptHandoff,
  type HomePromptHandoff,
} from './home-hero/plugin-authoring';
import type { OnboardingEntry } from '../onboarding/onboarding-entry';
import type { PluginUseAction } from './plugins-home/useActions';
import { Icon } from './Icon';
import { Button } from '@open-design/components';
import {
  defaultAgentModelId,
  effectiveAgentModelChoice,
  effectiveAgentModelId,
} from './agentModelSelection';
import { AgentIcon } from './AgentIcon';
import { CommunityView } from './CommunityView';
import { TeamSlotPlaceholder } from './TeamSlotPlaceholder';
import { resolveDeepSeekV4FlashCampaignAudience } from '../campaigns/deepseek-v4-flash';
import { useDeepSeekV4FlashCampaignVisibility } from '../campaigns/use-deepseek-v4-flash-campaign';
import { WorkbenchCampaignBadge } from './WorkbenchCampaignBadge';
import type { ModelCapabilityTag } from './modelCapabilityTags';
import { LanguageMenu } from './LanguageMenu';
import { IntegrationsView, type IntegrationTab } from './IntegrationsView';
import { InlineModelSwitcher } from './InlineModelSwitcher';
import { type EntrySettingsSection } from './EntrySettingsMenu';
import { NewProjectModal } from './NewProjectModal';
import { ExtensionsMarketplace } from './PluginsView';
import type { CreateInput, CreateTab, ImportClaudeDesignOutcome } from './NewProjectPanel';
import type { PluginLoopSubmit } from './PluginLoopHome';
import {
  duplicatePluginAsProject,
  patchProject,
  ProjectCreateError,
  type PluginShareAction,
  type PluginShareProjectOutcome,
} from '../state/projects';
import { TasksView } from './TasksView';
import {
  API_KEY_PLACEHOLDERS,
  API_PROTOCOL_TABS,
  SUGGESTED_MODELS_BY_PROTOCOL,
} from '../state/apiProtocols';
import { defaultKnownProviderModel, KNOWN_PROVIDERS } from '../state/config';
import type { KnownProvider } from '../state/config';
import { testAgent, testApiProvider } from '../providers/connection-test';
import { fetchProviderModels } from '../providers/provider-models';
import { invalidateProjectFilesCache } from '../providers/registry';
import { isMacPlatform } from '../utils/platform';
import { smoothScrollToTop } from '../utils/smoothScrollToTop';
import { summarizeProjectNameFromPrompt } from '../utils/projectName';
import { deepSeekHarnessNeedsSetup } from '../utils/visibleAgents';
import { LIBRARY_UI_VISIBLE } from '../features/libraryUi';
import {
  providerModelsCacheKey,
  type ProviderModelsCache,
} from './providerModelsCache';
import {
  ENTRY_RAIL_STATE_EVENT,
  ENTRY_RAIL_TOGGLE_EVENT,
  RAIL_OPEN_STORAGE_KEY,
  readStoredRailOpen,
} from './entryRailBridge';
import { resolveByokModelPreference } from './byok/validation';
import onboardingSourceStyles from './OnboardingModelSource.module.css';

// Persist the entry nav-rail open/collapsed state so it survives both a
// home -> project -> home navigation (EntryShell unmounts on the project
// route) and a full reload. Without this the rail always reset to its
// collapsed default on return. The storage key, the rail toggle/state window
// events, and the seed reader live in `entryRailBridge` so the pinned Home
// tab's sidebar toggle (WorkspaceTabsBar, a sibling React tree) can share
// them without importing this module's graph.
export { ENTRY_RAIL_STATE_EVENT, ENTRY_RAIL_TOGGLE_EVENT };

function writeStoredRailOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    /* ignore quota / disabled storage */
  }
}

const ONBOARDING_DROPDOWN_OPEN_EVENT = 'open-design:onboarding-dropdown-open';

type OnboardingAgentTestState =
  | { status: 'idle' }
  | { status: 'running'; inputKey: string }
  | { status: 'done'; inputKey: string; result: ConnectionTestResponse };

// The topbar chips (GitHub star, model switcher, Use everywhere)
// collapse into the settings dropdown when the viewport gets
// narrow. The transition is driven entirely by CSS @media queries
// in `entry-layout.css` so server and client render identical
// markup — both surfaces are always present, and CSS toggles
// `display` based on `--compact-topbar` breakpoint (900px).

// Default scenario plugin for each project kind/intent. The mapping
// lives in `@open-design/contracts` so the daemon's `/api/projects`
// and `/api/runs` fallbacks resolve to the same plugin id when no
// `pluginId` is on the request body — plan §3.3 of
// `specs/current/plugin-driven-flow-plan.md`.
const ONBOARDING_BYOK_AUTO_FETCH_DELAY_MS = 300;
const ONBOARDING_BYOK_AUTO_TEST_DELAY_MS = 500;

type EntryCreateProjectInput = Omit<CreateInput, 'metadata'> & {
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
  /** Exact workspace/member authority checked by the Home AMR preflight. */
  requestId?: string;
  pendingFiles?: File[];
  userWorkingDirToken?: string;
  linkedDirs?: string[] | null;
  onboardingEntry?: OnboardingEntry;
};

function defaultPluginIdForMetadata(metadata: ProjectMetadata): string | null {
  return defaultScenarioPluginIdForProjectMetadata(metadata);
}

function defaultPluginInputsForCreate(
  input: CreateInput,
  pluginId: string | null,
): Record<string, unknown> | null {
  const kind = input.metadata.kind;
  const projectName = input.name.trim();

  if (pluginId === 'example-web-prototype') {
    return {
      artifactKind: input.metadata.includeLandingPage
        ? 'landing page'
        : 'web prototype',
      fidelity: input.metadata.fidelity ?? 'high-fidelity',
      audience: 'product evaluators',
      designSystem: 'the active project design system',
      template: input.metadata.templateLabel ?? 'the bundled web prototype seed',
    };
  }

  if (pluginId === 'example-simple-deck') {
    return {
      deckType: 'pitch deck',
      topic: projectName || 'the user brief',
      audience: 'decision makers',
      slideCount: '10-15 pages',
      speakerNotes: input.metadata.speakerNotes
        ? 'include speaker notes'
        : 'no speaker notes',
      designSystem: 'the active project design system',
    };
  }

  if (pluginId === 'od-new-generation') {
    const templateLabel = input.metadata.templateLabel?.trim();
    const artifactKind =
      kind === 'template'
        ? 'artifact based on a saved template'
        : kind === 'other'
          ? 'custom design artifact'
          : `${kind} artifact`;
    return {
      artifactKind,
      audience: 'product and design reviewers',
      topic: templateLabel || projectName || 'the user brief',
    };
  }

  if (pluginId !== 'od-media-generation') return null;
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return null;

  const promptTemplate = input.metadata.promptTemplate;
  const subject =
    promptTemplate?.prompt?.trim()
    || projectName
    || promptTemplate?.title?.trim()
    || `${kind} concept`;
  const style =
    promptTemplate?.summary?.trim()
    || 'cinematic, high-quality, on-brand';
  const aspect =
    kind === 'image'
      ? input.metadata.imageAspect
      : kind === 'video'
        ? input.metadata.videoAspect
        : undefined;

  return {
    mediaKind: kind,
    subject,
    style,
    ...(aspect ? { aspect } : {}),
  };
}

export interface ProjectTitleHint {
  name: string;
  /** Workspace whose catalog produced this hint; null for a local-only row. */
  workspaceId: string | null;
  /** Member authorization lifetime that produced the catalog row. */
  workspaceMemberId: string | null;
  /**
   * The team catalog is the title authority for a project shared by another
   * member. Own/private projects may still accept a newer local rename.
   */
  authoritative: boolean;
}

interface Props {
  skills: SkillSummary[];
  designTemplates: SkillSummary[];
  designSystems: DesignSystemSummary[];
  projects: Project[];
  templates: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  promptTemplates: PromptTemplateSummary[];
  defaultDesignSystemId: string | null;
  connectors: ConnectorDetail[];
  connectorsLoading: boolean;
  integrationInitialTab?: IntegrationTab;
  composioConfigLoading?: boolean;
  skillsLoading?: boolean;
  designSystemsLoading?: boolean;
  projectsLoading?: boolean;
  // Execution / model-switching context. Threaded down from `App` so the
  // top-bar `InlineModelSwitcher` can render the active mode/agent/model
  // and persist changes through the same callbacks the project view uses.
  config: AppConfig;
  providerModelsCache?: ProviderModelsCache;
  onProviderModelsCacheChange?: Dispatch<SetStateAction<ProviderModelsCache>>;
  agents: AgentInfo[];
  // True while the cold-start agent detection stream is still in flight
  // (`fetchAgentsStream` has not reached its terminal `done`). Onboarding
  // uses this to show the AMR cloud card in a detecting/skeleton state
  // instead of hiding it during the seconds AMR's probe takes to settle.
  agentsLoading?: boolean;
  // Local credential state is independent from the remote workspace read.
  // During a transient Cloud outage it prevents the rail from presenting a
  // still-signed-in user as signed out.
  amrLoggedIn?: boolean | null;
  amrSessionState?: string;
  /**
   * vela login-status account/user plan (ACCOUNT-scoped). Used for personal
   * workspaces so a confirmed free account is not stuck as campaign audience
   * `unknown` while billing summary leaves `membershipTier` empty.
   */
  amrAccountPlan?: string | null;
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string; serviceTier?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  onConfigPersist: (cfg: AppConfig) => Promise<void> | void;
  /** True only when GET /api/app-config returned a real config object. */
  daemonAppConfigReady?: boolean;
  /** Non-optimistic daemon write for the silent-update preference. */
  onSilentUpdatePreferenceChange?: (allowSilentUpdates: boolean) => Promise<void>;
  onSkillsRefresh?: () => Promise<void> | void;
  onSkillsChanged?: (affectedSkillId?: string) => void;
  onRefreshAgents: () => Promise<AgentInfo[]> | AgentInfo[];
  onCreateProject: (input: EntryCreateProjectInput) => Promise<boolean> | boolean | void;
  onCreatePluginShareProject: (
    pluginId: string,
    action: PluginShareAction,
    locale?: string,
  ) => Promise<PluginShareProjectOutcome>;
  onImportClaudeDesign: (
    file: File,
  ) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
  onOpenProject: (
    id: string,
    fileName?: string,
    projectTitleHint?: ProjectTitleHint,
  ) => Promise<boolean> | boolean | void;
  onOpenLiveArtifact: (projectId: string, artifactId: string) => void;
  onDeleteProject: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicateProject?: (id: string) => Promise<void> | void;
  onRenameProject: (id: string, name: string) => void;
  onProjectsRefresh?: () => Promise<void> | void;
  onTeamProjectContentReady?: (
    projectId: string,
    workspaceId: string,
    workspaceMemberId: string,
  ) => Promise<boolean> | boolean;
  onChangeDefaultDesignSystem: (id: string) => void;
  onCreateDesignSystem?: () => void;
  // First-run onboarding intentionally stops after model-source setup.
  // Guided design-system creation stays reachable from the standalone
  // `design-system-create` route and the Design Systems tab.
  onOpenDesignSystem?: (id: string) => void;
  onDesignSystemsRefresh?: () => Promise<void> | void;
  onPersistComposioKey: (composio: AppConfig['composio']) => Promise<void> | void;
  onOpenSettings: (section?: EntrySettingsSection) => void;
  onCompleteOnboarding: () => void;
  onSignedOut?: () => void | Promise<void>;
  artifactUpgradeSlot?: ReactNode;
}

// Map an EntryNavRail view id to the existing analytics `element` enum on
// `home/nav` ui_click. Keep this compatibility signal alongside the new
// Workspace navigation dimensions so established PostHog dashboards do not
// lose their historical series.
function navElementForView(
  next: EntryViewKind,
):
  | 'home'
  | 'projects'
  | 'automations'
  | 'plugins'
  | 'design_systems'
  | 'integrations'
  | null {
  switch (next) {
    case 'home':
      return 'home';
    case 'projects':
      return 'projects';
    case 'tasks':
      return 'automations';
    case 'plugins':
      return 'plugins';
    case 'design-systems':
      return 'design_systems';
    case 'brands':
      return 'design_systems';
    case 'integrations':
      return 'integrations';
    default:
      return null;
  }
}

// Tab views stay mounted (so previews/thumbnails survive a tab switch) but the
// inactive ones must leave layout, the accessibility tree, and tab order.
// `content-visibility: hidden` still reserves the hidden pane's block size,
// which pushes later sidebar destinations far below the sticky topbar.
function inactiveViewProps(active: boolean) {
  return {
    style: active ? undefined : ({ display: 'none' } as const),
    inert: !active,
    'aria-hidden': !active,
  };
}

export function EntryShell({
  skills,
  designTemplates,
  designSystems,
  projects,
  templates,
  onDeleteTemplate,
  promptTemplates,
  defaultDesignSystemId,
  connectors,
  connectorsLoading,
  integrationInitialTab = 'mcp',
  composioConfigLoading = false,
  skillsLoading = false,
  designSystemsLoading = false,
  projectsLoading = false,
  config,
  providerModelsCache: sharedProviderModelsCache,
  onProviderModelsCacheChange,
  agents,
  agentsLoading = false,
  amrLoggedIn = null,
  amrSessionState,
  amrAccountPlan = null,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onConfigPersist,
  daemonAppConfigReady = false,
  onSilentUpdatePreferenceChange,
  onSkillsRefresh,
  onSkillsChanged,
  onRefreshAgents,
  onCreateProject,
  onImportClaudeDesign,
  onImportFolder,
  onImportFolderResponse,
  onOpenProject,
  onOpenLiveArtifact,
  onDeleteProject,
  onDuplicateProject,
  onRenameProject,
  onProjectsRefresh,
  onTeamProjectContentReady,
  onChangeDefaultDesignSystem,
  onCreateDesignSystem,
  onOpenDesignSystem,
  onDesignSystemsRefresh,
  onPersistComposioKey,
  onOpenSettings,
  onCompleteOnboarding,
  onSignedOut,
  artifactUpgradeSlot,
}: Props) {
  const { t } = useI18n();
  // Each entry sub-view (home / projects / design-systems) is its own
  // URL now, so the browser back/forward buttons work and a deep link
  // to /design-systems lands on that section. We derive the active
  // view from the route rather than keeping it in component state.
  const route = useRoute();
  const view: EntryViewKind = route.kind === 'home' ? route.view : 'home';
  // The one shared workspace context. Any non-null context is a real workspace
  // (personal or team); workspace surfaces gate on B's permission bits, not on
  // workspaceType.
  // The whole state (not just `context`) so workspace-scoped WRITES can go
  // through `resolvedWorkspaceContextForWrite`, which refuses to collapse an
  // unresolved or unavailable authority into an anonymous, unbound create.
  const workspaceContext: null = null;
  const workspaceLoading = false;
  const accountFooterState = 'none' as const;
  const accountFooterNotice: ReactNode = null;
  const railWorkspaceContext = null;
  const usesOpenDesignCloud = false;
  const amrAuthRequired = false;
  const workspaceContextRef = useRef(workspaceContext);
  workspaceContextRef.current = workspaceContext;
  const [goPlanSunsetMessagePending, setGoPlanSunsetMessagePending] = useState(false);
  const deepSeekCampaignVisibility = useDeepSeekV4FlashCampaignVisibility();
  const resolvedDeepSeekV4FlashCampaignAudience = resolveDeepSeekV4FlashCampaignAudience({
    plan: null,
    loggedIn: false,
    now: deepSeekCampaignVisibility.now,
  });
  const deepSeekV4FlashCampaignAudience = goPlanSunsetMessagePending
    ? 'unknown'
    : resolvedDeepSeekV4FlashCampaignAudience;
  const topRightCampaignAudience =
    deepSeekV4FlashCampaignAudience === 'unknown'
      ? null
      : deepSeekV4FlashCampaignAudience;
  const draftProjectsList: Project[] = projects;
  const allProjectsList: Project[] = projects;
  const projectSearchProjects = buildProjectSearchCatalog(projects, projects);
  const homeProjectsList = projects;

  // Open handler for the "全部项目" grid. A project already in the member's local
  // list opens directly. A remote Team project first creates an authority-bound
  // placeholder, then ProjectView opens while the daemon materializes content in
  // the background. The placeholder stamp keeps every content writer fail-closed.
  const markProjectShared = (_p: unknown) => {};
  const markProjectShareFailed = (_id: string) => {};
  const markProjectUnshared = (_id: string) => {};
  const teamProjectOwnerMemberIds = new Map<string, string>();
  const [pullingProjectId, setPullingProjectId] = useState<string | null>(null);
  async function handleOpenAllProjects(id: string): Promise<boolean> {
    return Boolean(await onOpenProject(id));
  }

  // Workspace-only destinations. Personal and team workspaces both use these;
  // signed-out/local state falls back to home once the context has resolved.
  // `community` is allowed in both states, so it is not guarded.
  const isWorkspaceOnlyView =
    view === 'drafts' ||
    view === 'all-projects' ||
    view === 'members' ||
    view === 'board' ||
    view === 'workspace-settings';
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // The entry nav rail is collapsed by default (Manus-style) so the entry
  // view opens clean and full-width; the panel toggle in the topbar opens it
  // as an overlay that dismisses on selection / backdrop click / Escape.
  // Its open/collapsed state is persisted (localStorage) so it survives a
  // home -> project -> home round trip (EntryShell unmounts on the project
  // route) and a reload, instead of snapping back to collapsed.
  const [railOpen, setRailOpen] = useState<boolean>(readStoredRailOpen);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);

  // ⌘K / Ctrl+K opens the project search palette — same as clicking the rail
  // search box. ⌘B / Ctrl+B toggles the nav rail — same as the pinned Home
  // tab's sidebar toggle.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.isComposing
        || (
          target instanceof Element
          && target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          )
        )
      ) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        setProjectSearchOpen(true);
        return;
      }
      const primary = isMacPlatform()
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        primary &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'b' || event.key === 'B')
      ) {
        event.preventDefault();
        setRailOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    writeStoredRailOpen(railOpen);
    // Broadcast the state so chrome outside this tree (the pinned Home tab's
    // sidebar toggle) can mirror it via aria-expanded.
    window.dispatchEvent(
      new CustomEvent(ENTRY_RAIL_STATE_EVENT, { detail: { open: railOpen } }),
    );
  }, [railOpen]);

  // The pinned Home tab (WorkspaceTabsBar) carries a sidebar toggle; it lives
  // in a sibling tree, so the request arrives as a window event.
  useEffect(() => {
    const onToggle = () => setRailOpen((v) => !v);
    window.addEventListener(ENTRY_RAIL_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(ENTRY_RAIL_TOGGLE_EVENT, onToggle);
  }, []);
  const [localProviderModelsCache, setLocalProviderModelsCache] =
    useState<ProviderModelsCache>({});
  const hasSharedProviderModelsCache =
    Boolean(sharedProviderModelsCache) && Boolean(onProviderModelsCacheChange);
  const activeProviderModelsCache =
    hasSharedProviderModelsCache
      ? sharedProviderModelsCache!
      : localProviderModelsCache;
  const activeSetProviderModelsCache =
    hasSharedProviderModelsCache
      ? onProviderModelsCacheChange!
      : setLocalProviderModelsCache;
  const [newProjectInitialTab, setNewProjectInitialTab] =
    useState<CreateTab>('prototype');
  const [integrationTab, setIntegrationTab] = useState<IntegrationTab>(integrationInitialTab);
  // Lazy initializer, so a handoff published by a surface that then navigated
  // here — the `/marketplace/<id>` detail route, which `App` renders outside
  // this shell — is claimed on the very first render and reaches HomeView in
  // the same commit as the mount. The read is destructive, so it applies once.
  const [homePromptHandoff, setHomePromptHandoff] = useState<HomePromptHandoff | null>(
    () => takeHomePromptHandoff(),
  );
  const entryMainScrollRef = useRef<HTMLElement | null>(null);
  // Entry views share this element, so route changes must not inherit the previous view's offset.
  useLayoutEffect(() => {
    const scrollContainer = entryMainScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTop = 0;
  }, [view]);
  const analytics = useAnalytics();
  // 产品拍板 D5: the campaign modal's paid 立即使用 performs the REAL switch —
  // daemon execution mode + Cloud agent (amr) + DeepSeek V4 Flash — through
  // the same persistence callbacks the InlineModelSwitcher writes through.
  // Mode must flip first: a paid user still on BYOK (`mode === 'api'`) would
  // otherwise keep the BYOK provider even after agent/model ids change.
  const applyDeepSeekCampaignModel = useCallback(
    (agentId: string, modelId: string) => {
      onModeChange('daemon');
      onAgentChange(agentId);
      onAgentModelChange(agentId, { model: modelId });
    },
    [onAgentChange, onAgentModelChange, onModeChange],
  );
  function changeView(next: EntryViewKind) {
    const navElement = navElementForView(next);
    if (navElement) {
      trackHomeNavClick(analytics.track, {
        page_name: 'home',
        area: 'nav',
        element: navElement,
      });
    }
    navigate({ kind: 'home', view: next });
  }

  // Project collection surfaces have no legacy page-level tracker. Community
  // is conditionally mounted and tracks its own visit; always-mounted library
  // surfaces receive an explicit isActive prop below.
  useEffect(() => {
    if (view === 'drafts') trackPageView(analytics.track, { page_name: 'drafts' });
    else if (view === 'all-projects') trackPageView(analytics.track, { page_name: 'all_projects' });
  }, [analytics.track, view]);

  function startPluginAuthoring(goal?: string) {
    setHomePromptHandoff(
      createPluginAuthoringHandoff(Date.now(), goal),
    );
    changeView('home');
  }

  function usePluginFromLibrary(
    record: InstalledPluginRecord,
    action: PluginUseAction = 'use',
    homeType?: { chipId: string; projectKind: ProjectKind },
  ) {
    setHomePromptHandoff(
      createPluginUseHandoff(Date.now(), record.id, { action, ...homeType }),
    );
    changeView('home');
  }

  function useSkillFromLibrary(skill: SkillSummary) {
    setHomePromptHandoff(createSkillUseHandoff(Date.now(), skill));
    changeView('home');
  }

  useEffect(() => {
    if (view !== 'home' || !homePromptHandoff) return;
    const frame = window.requestAnimationFrame(() => {
      const scrollContainer = entryMainScrollRef.current;
      if (!scrollContainer) return;
      smoothScrollToTop(scrollContainer);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [homePromptHandoff?.id, view]);

  // The frosted top edge exists to melt content that scrolls UP under the tab
  // strip. At rest nothing is under it, but it blurred anyway — and because
  // `.entry-main__inner` starts its content at 12px, every page's h2 sat inside
  // that 32px band and read as a smudged dark block behind the title
  // (acceptance #28). Gate the blur on actually being scrolled.
  useEffect(() => {
    const scrollContainer = entryMainScrollRef.current;
    if (!scrollContainer) return;
    const sync = () => {
      scrollContainer.classList.toggle('is-scrolled', scrollContainer.scrollTop > 0);
    };
    sync();
    scrollContainer.addEventListener('scroll', sync, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', sync);
  }, [view]);

  useEffect(() => {
    setIntegrationTab(integrationInitialTab);
  }, [integrationInitialTab]);

  function openIntegrationTab(tab: IntegrationTab) {
    setIntegrationTab(tab);
    changeView('integrations');
  }

  function openNewProject(tab: CreateTab = 'prototype') {
    setNewProjectInitialTab(tab);
    setNewProjectOpen(true);
  }

  function startBlankProjectFromRail() {
    void Promise.resolve(
      onCreateProject({
        name: t('common.untitled'),
        skillId: null,
        designSystemId: null,
        // No user-typed name exists yet — mark it `generated` (the same tag
        // `handleCreateProjectFromDesignSystem` and the New Project panel's
        // blank/no-name path use) so `canAutoRenameProjectFromPrompt` stays
        // eligible once the user's first in-project prompt or the agent's
        // own generated title arrives. Without this the project is stuck at
        // "未命名" forever: this rail (the Drafts / All-projects empty-state
        // "创建" button) is the only reachable way to open a truly metadata-
        // less blank project, and every other create path already tags its
        // fallback name with a `nameSource` the rename gate recognizes.
        metadata: { kind: 'other', nameSource: 'generated' },
      }),
    ).catch((err) => {
      console.warn('Failed to create blank project from entry rail', err);
    });
  }

  function handleCreate(input: CreateInput) {
    // The NewProjectModal no longer asks the user to pick a plugin.
    // Each project kind is silently bound to its default scenario
    // pipeline at creation time so the user lands in a running flow
    // without having to reason about pipeline internals. The mapping
    // is intentionally explicit so future kind-specific scenarios
    // (e.g. a deck- or image-specialized pipeline) can take over a
    // single row without touching the form.
    const pluginId = defaultPluginIdForMetadata(input.metadata);
    const pluginInputs = defaultPluginInputsForCreate(input, pluginId);
    const { skillSelectionProvenance, ...projectInput } = input;
    const automaticStrategyRoute = skillSelectionProvenance === 'explicit-user'
      ? null
      : automaticStrategyTaskProfileForProjectMetadata(input.metadata);
    return onCreateProject({
      ...projectInput,
      // The modal's Blank card historically persisted a hidden default Skill
      // (for example agent-browser) even though the automatic scenario already
      // owns the task workflow. When OD Next replaces that scenario, carrying
      // the hidden Skill makes it look user-selected and can correctly trip
      // the planning-only validator. Keep explicit template/Skill picks exact;
      // omit only the UI's implicit default on the four automatic routes.
      ...(automaticStrategyRoute && skillSelectionProvenance === 'automatic-default'
        ? { skillId: null }
        : {}),
      ...(automaticStrategyRoute
        ? { automaticStrategyTaskProfile: automaticStrategyRoute }
        : pluginInputs
          ? { pluginInputs }
          : {}),
    });
  }

  // Plan §3.F5 — the home prompt-loop submit path. The user picks a
  // plugin (which calls /api/plugins/:id/apply and binds a snapshot),
  // edits the rendered example query if any, then presses Enter. We
  // derive a project name from the active plugin (or prompt head),
  // forward the pluginId so POST /api/projects pins the snapshot to
  // project + conversation, and request auto-send of the first
  // message so the user lands inside a running pipeline.
  //
  // Stage B of plugin-driven-flow-plan: the rail can stamp a
  // `projectKind` on the payload so the created project records the
  // chosen surface (image / video / audio, etc.). Free-form Home
  // submits now arrive with the hidden od-default router plugin and
  // projectKind='other', so the agent infers the task type and asks only
  // when the brief cannot be routed reliably.
  async function handlePluginLoopSubmit(payload: PluginLoopSubmit) {
    if (amrAuthRequired) {
      navigate({ kind: 'home', view: 'onboarding' }, { replace: true });
      return 'blocked' as const;
    }
    const summarizedName = summarizeProjectNameFromPrompt(payload.prompt);
    const head = payload.prompt.trim().split(/\s+/).slice(0, 8).join(' ');
    const firstAttachmentName = payload.attachments?.[0]?.name ?? '';
    const fallbackName =
      summarizedName || (head.length > 0 ? head : firstAttachmentName || 'Untitled');
    const name =
      payload.pluginTitle && payload.pluginTitle.trim().length > 0
        ? payload.pluginTitle.trim()
        : fallbackName;
    const linkedDirs = Array.from(
      new Set(
        [
          ...(payload.workingDir ? [payload.workingDir] : []),
          ...(payload.linkedDirs ?? []),
        ].map((dir) => dir.trim()).filter(Boolean),
      ),
    );
    const metadata: ProjectMetadata = {
      ...(payload.projectMetadata ?? {}),
      kind: payload.projectKind ?? payload.projectMetadata?.kind ?? 'prototype',
      nameSource: 'prompt',
      ...(payload.contextPlugins && payload.contextPlugins.length > 0
        ? { contextPlugins: payload.contextPlugins }
        : {}),
      ...(payload.contextMcpServers && payload.contextMcpServers.length > 0
        ? { contextMcpServers: payload.contextMcpServers }
        : {}),
      ...(payload.contextConnectors && payload.contextConnectors.length > 0
        ? { contextConnectors: payload.contextConnectors }
        : {}),
      // The Home working-directory picker grants the agent read-only
      // awareness of a local folder (via `--add-dir`), it does NOT import
      // that folder into Design Files. So the picked path becomes the new
      // project's `linkedDirs` rather than its `baseDir`/`userWorkingDir`:
      // Design Files stays the managed `.od/projects/<id>` artifact store,
      // independent of the user's local files.
      ...(linkedDirs.length > 0 ? { linkedDirs } : {}),
      ...(payload.examplePromptContext ? {
        examplePrompt: true,
        examplePromptTitle: payload.examplePromptContext.title,
        examplePromptBrief: payload.examplePromptContext.brief,
      } : {}),
    };
    const strategyRoutingFields = entryStrategyRoutingFields(payload, metadata);
    const createInput: EntryCreateProjectInput = {
      name,
      ...strategyRoutingFields,
      designSystemId: payload.designSystemId ?? null,
      metadata,
      pendingPrompt: payload.prompt,
      ...(payload.pluginId && !payload.pluginSelectionProvenance
        ? { pluginId: payload.pluginId }
        : {}),
      ...(payload.pluginSource && !payload.pluginSelectionProvenance
        ? { pluginSource: payload.pluginSource }
        : {}),
      ...(payload.pluginType && !payload.pluginSelectionProvenance
        ? { pluginType: payload.pluginType }
        : {}),
      ...(payload.appliedPluginSnapshotId && !payload.pluginSelectionProvenance
        ? { appliedPluginSnapshotId: payload.appliedPluginSnapshotId }
        : {}),
      ...(payload.initialRunContext ? { initialRunContext: payload.initialRunContext } : {}),
      ...(payload.conversationMode ? { conversationMode: payload.conversationMode } : {}),
      ...(payload.attachments && payload.attachments.length > 0
        ? { pendingFiles: payload.attachments }
        : {}),
      // No `userWorkingDirToken`: linkedDirs grant read-only `--add-dir`
      // access and are validated by the daemon at create time, so they do
      // not need the desktop main-process trust token that baseDir imports
      // require for write access.
      autoSendFirstMessage: true,
    };
    const create = () => Promise.resolve(onCreateProject(createInput));
    try {
      return await create();
    } catch (error) {
      if (
        error instanceof ProjectCreateError
        && error.code === 'AMR_AUTH_REQUIRED'
      ) {
        navigate({ kind: 'home', view: 'onboarding' }, { replace: true });
        return 'blocked' as const;
      }
      throw error;
    }
  }

  /**
   * Re-read every workspace surface because onboarding just ended.
   *
   * Onboarding is where a signed-out user signs IN, so the workspace context
   * the shell resolved before it is stale by definition. Without this the rail
   * came back in its signed-out shape — no workspace switcher, no 草稿 / 全部项目
   * / Workspace 设置, and the "sign in to OpenDesign Cloud" callout still in
   * the bottom-left corner (#140) — until a focus or the 30s poll happened to
   * re-read it. `CloudSignInTip` fires the same three after its own sign-in.
   *
   * EVERY exit from onboarding must call this. It used to live inline in
   * `finishOnboarding` only, so the "go build a design system" door left the
   * shell on the stale signed-out context.
   */

  function finishOnboarding() {
    onCompleteOnboarding();
    changeView('home');
  }

  // #5517: the GitHub/Discord/X/mail badges and the settings chip leave the
  // rail footer. Socials live in the account menu, while settings stays
  // reachable through either the account menu or the signed-out rail item.
  //
  // The updater host has no topbar to live in any more (the rail toggle is the
  // pinned Home tab in the workspace tabs bar), so the rail owns it: it rides
  // the floating account row immediately after the avatar chip, falling back
  // to the rail footer in the signed-out shell. `EntryNavRail` decides which —
  // the shell only supplies the host, which renders nothing until the real
  // updater reports a downloaded, unopened installer.
  const updaterSlot = (
    <UpdaterPopup
      allowSilentUpdates={config.allowSilentUpdates}
      silentUpdatePreferenceReady={daemonAppConfigReady}
      onAllowSilentUpdatesChange={
        onSilentUpdatePreferenceChange
          ?? ((allowSilentUpdates) => onConfigPersist({ ...config, allowSilentUpdates }))
      }
    />
  );

  // #5517 removes the entry top-bar settings cog: the nav-rail account menu owns
  // the settings entry (EntryNavRail onOpenSettings), so the top strip no longer
  // carries a redundant one.


  if (view === 'onboarding') {
    return (
      <div className="entry-shell entry-shell--no-header entry-shell--onboarding">
        <main className="entry-onboarding-modal" aria-label={t('settings.welcomeTitle')}>
          <OnboardingView
            config={config}
            agents={agents}
            agentsLoading={agentsLoading}
            providerModelsCache={activeProviderModelsCache}
            onProviderModelsCacheChange={activeSetProviderModelsCache}
            daemonLive={daemonLive}
            onModeChange={onModeChange}
            onAgentChange={onAgentChange}
            onAgentModelChange={onAgentModelChange}
            onApiProtocolChange={onApiProtocolChange}
            onApiModelChange={onApiModelChange}
            onConfigPersist={onConfigPersist}
            onRefreshAgents={onRefreshAgents}
            onFinish={finishOnboarding}
          />
        </main>
      </div>
    );
  }

  const homeExecutionSwitcher = (
    <InlineModelSwitcher
      compact
      config={config}
      agents={agents}
      providerModelsCache={activeProviderModelsCache}
      onProviderModelsCacheChange={activeSetProviderModelsCache}
      daemonLive={daemonLive}
      onModeChange={onModeChange}
      onAgentChange={onAgentChange}
      onAgentModelChange={onAgentModelChange}
      onApiProtocolChange={onApiProtocolChange}
      onApiModelChange={onApiModelChange}
      onOpenSettings={onOpenSettings}
    />
  );

  return (
    <div className="entry-shell entry-shell--no-header">
      <div
        className={`entry${railOpen ? ' entry--rail-open' : ''}`}
        // The team/local shell is a labeled Manus-style rail, so widen the rail
        // track (the base 56px icon-rail clips the labels + team affordances).
        style={{ ['--entry-rail-width' as string]: '236px' }}
      >
        <EntryNavRail
          view={view}
          onViewChange={changeView}
          onNewProject={() => {
            trackHomeNavClick(analytics.track, {
              page_name: 'home',
              area: 'nav',
              element: 'new_project_plus',
            });
            openNewProject();
          }}
          onOpenSearch={() => setProjectSearchOpen(true)}
          open={railOpen}
          topRightSlot={
            topRightCampaignAudience ? (
              <WorkbenchCampaignBadge
                audience={topRightCampaignAudience}
                page="home"
                metricsConsent={config.telemetry?.metrics === true}
                installationId={config.installationId}
                loggedIn={amrLoggedIn}
              />
            ) : null
          }
          onOpenSettings={onOpenSettings}
          onInvite={() => changeView('members')}
          onSignInCloud={() => navigate({ kind: 'home', view: 'onboarding' })}
          onSignedOut={onSignedOut}
          updaterSlot={updaterSlot}
          // A loading or unavailable workspace read is not proof of sign-out.
          // Keep the account slot neutral until Cloud answers successfully;
          // only a successful null context (or known local sign-out) may show
          // the sign-in card.
          footerNotice={accountFooterNotice}
          priorityAnnouncementActive={
            view === 'home'
            && goPlanSunsetMessagePending
          }
          onPriorityAnnouncementPendingChange={setGoPlanSunsetMessagePending}
          priorityAnnouncementCurrentPlanId={null}
          priorityAnnouncementMetricsConsent={config.telemetry?.metrics === true}
        />
        {projectSearchOpen ? (
          <ProjectSearchModal
            // Search spans personal drafts plus the shared workspace catalog.
            // The pull-first handler still opens not-yet-local shared projects.
            projects={projectSearchProjects}
            onOpenProject={handleOpenAllProjects}
            onClose={() => setProjectSearchOpen(false)}
          />
        ) : null}
        <main className="entry-main entry-main--scroll" ref={entryMainScrollRef}>
          {/* #5517: no entry topbar. The rail toggle is the pinned Home tab in
              the workspace tabs bar (entryRailBridge), the updater popup host
              lives in the rail footer, and everything below is fixed-position
              or portalled so it occupies no layout space here. */}
          <WhatsNewPopup active={view === 'home' && !goPlanSunsetMessagePending} />
          {/* The campaign badge lives in EntryNavRail's top-right cluster so it
              stays beside the account module across every entry tab. */}
          <div
            className={[
              'entry-main__inner',
              view === 'home' ? '' : 'entry-main__inner--wide',
            ].filter(Boolean).join(' ')}
          >
            <div className="entry-main__view-home" data-testid="entry-view-home" data-active={view === 'home' ? 'true' : 'false'} {...inactiveViewProps(view === 'home')}>
              <HomeView
                isActive={view === 'home'}
                projects={homeProjectsList}
                projectsLoading={projectsLoading}
                designSystems={designSystems}
                designSystemsLoading={designSystemsLoading}
                defaultDesignSystemId={defaultDesignSystemId}
                onSubmit={handlePluginLoopSubmit}
                onOpenProject={onOpenProject}
                onViewAllProjects={() => changeView('projects')}
                onDeleteProject={onDeleteProject}
                onDuplicateProject={onDuplicateProject}
                onRenameProject={onRenameProject}
                onBrowseRegistry={() => changeView('plugins')}
                onOpenIntegrations={() => openIntegrationTab('connectors')}
                onOpenMcp={() => openIntegrationTab('mcp')}
                onOpenNewProject={(tab) => {
                  openNewProject(tab);
                }}
                onStartBlankProject={startBlankProjectFromRail}
                {...(onImportFolder ? { onImportFolder } : {})}
                {...(onImportFolderResponse ? { onImportFolderResponse } : {})}
                promptHandoff={homePromptHandoff}
                onProjectShared={markProjectShared}
                onProjectShareFailed={markProjectShareFailed}
                onProjectUnshared={markProjectUnshared}
                projectOwnerMemberIds={teamProjectOwnerMemberIds}
                skills={skills}
                skillsLoading={skillsLoading}
                connectors={connectors}
                promptTemplates={promptTemplates}
                executionSwitcher={view === 'home' ? homeExecutionSwitcher : undefined}
                artifactUpgradeSlot={artifactUpgradeSlot}
                deepSeekV4FlashCampaignAudience={deepSeekV4FlashCampaignAudience}
                onDeepSeekV4FlashCampaignUseNow={applyDeepSeekCampaignModel}
                deepSeekV4FlashCampaignMetricsConsent={config.telemetry?.metrics === true}
                deepSeekV4FlashCampaignInstallationId={config.installationId ?? null}
              />
            </div>
            <div data-testid="entry-view-projects" data-active={view === 'projects' ? 'true' : 'false'} {...inactiveViewProps(view === 'projects')}>
              {projectsLoading || skillsLoading || designSystemsLoading ? (
                <CenteredLoader label={t('common.loading')} />
              ) : (
                <div className="entry-section">
                  <header className="entry-section__head">
                    <h1 className="entry-section__title">{t('entry.navProjects')}</h1>
                  </header>
                  <DesignsTab
                    projects={projects}
                    skills={skills}
                    designSystems={designSystems}
                    onOpen={onOpenProject}
                    onOpenLiveArtifact={onOpenLiveArtifact}
                    onDelete={onDeleteProject}
                    onDuplicate={onDuplicateProject}
                    onRename={onRenameProject}
                    onRefresh={onProjectsRefresh}
                    isActive={view === 'projects'}
                    onNewProject={() => {
                      openNewProject();
                    }}
                    {...(onImportFolder ? { onImportFolder } : {})}
                    {...(onImportFolderResponse ? { onImportFolderResponse } : {})}
                  />
                </div>
              )}
            </div>
            <div data-testid="entry-view-tasks" data-active={view === 'tasks' ? 'true' : 'false'} {...inactiveViewProps(view === 'tasks')}>
              <TasksView
                skills={skills}
                designTemplates={designTemplates}
                connectors={connectors}
                connectorsLoading={connectorsLoading}
                isActive={view === 'tasks'}
              />
            </div>
            <div data-testid="entry-view-plugins" data-active={view === 'plugins' ? 'true' : 'false'} {...inactiveViewProps(view === 'plugins')}>
              <ExtensionsMarketplace
                isActive={view === 'plugins'}
                onCreatePlugin={startPluginAuthoring}
                onUsePlugin={usePluginFromLibrary}
                onUseSkill={useSkillFromLibrary}
              />
            </div>
            <div data-testid="entry-view-design-systems" data-active={view === 'design-systems' ? 'true' : 'false'} {...inactiveViewProps(view === 'design-systems')}>
              {designSystemsLoading ? (
                <div className="entry-section">
                  <DesignSystemsTab
                    isActive={view === 'design-systems'}
                    loading
                    systems={[]}
                    templates={templates}
                    selectedId={defaultDesignSystemId}
                    onSelect={onChangeDefaultDesignSystem}
                    onCreate={onCreateDesignSystem}
                    onOpenSystem={onOpenDesignSystem}
                    onSystemsRefresh={onDesignSystemsRefresh}
                  />
                </div>
              ) : (
                <div className="entry-section">
                  <DesignSystemsTab
                    isActive={view === 'design-systems'}
                    systems={designSystems}
                    templates={templates}
                    selectedId={defaultDesignSystemId}
                    onSelect={onChangeDefaultDesignSystem}
                    onCreate={onCreateDesignSystem}
                    onOpenSystem={onOpenDesignSystem}
                    onSystemsRefresh={onDesignSystemsRefresh}
                  />
                </div>
              )}
            </div>
            {LIBRARY_UI_VISIBLE ? (
              <div data-testid="entry-view-library" data-active={view === 'library' ? 'true' : 'false'} {...inactiveViewProps(view === 'library')}>
                <LibrarySection
                  active={view === 'library'}
                  onOpenProject={(projectId, fileName) =>
                    navigate({ kind: 'project', projectId, conversationId: null, fileName: fileName ?? null })
                  }
                />
              </div>
            ) : null}
            <div data-testid="entry-view-brands" data-active={view === 'brands' ? 'true' : 'false'} {...inactiveViewProps(view === 'brands')}>
              <BrandsTab
                onApplyDesignSystem={onChangeDefaultDesignSystem}
                onOpenProject={onOpenProject}
                onDesignSystemsRefresh={onDesignSystemsRefresh}
              />
            </div>
            {view === 'integrations' ? (
              <IntegrationsView
                config={config}
                initialTab={integrationTab}
                composioConfigLoading={composioConfigLoading}
                onConfigPersist={onConfigPersist}
                onPersistComposioKey={onPersistComposioKey}
                onSkillsRefresh={onSkillsRefresh}
                onSkillsChanged={onSkillsChanged}
              />
            ) : null}
            {view === 'community' ? (
              <CommunityView
                onRemixTemplate={({ templateId, prompt }) => {
                  // Remix carries the template's PROJECT along, not just its
                  // prompt: duplicate the plugin's example artifact into a
                  // fresh project (the same daemon flow as the plugin
                  // gallery's 创建副本), seed the composer with the template
                  // prompt for review, then open it on the copied entry file.
                  // Templates without a duplicable artifact fall back to the
                  // old prompt-only project.
                  void (async () => {
                    const name =
                      summarizeProjectNameFromPrompt(prompt) || t('common.untitled');
                    try {
                      // One resolved authority for BOTH requests: the create
                      // binds the copied project to this workspace, and the
                      // seed patch is then authorized against that same
                      // binding. A headerless create is read by the daemon as a
                      // legacy caller and leaves the project bound to no
                      // workspace at all, which is what kept remixed projects
                      // out of the member's own 草稿 list.
                      const result = await duplicatePluginAsProject(
                        templateId,
                        { name },
                      );
                      const seeded = await patchProject(
                        result.projectId,
                        { pendingPrompt: prompt },
                      );
                      if (!seeded) {
                        // The project itself exists and is bound — only the
                        // prompt seed was refused. Keep the user on it
                        // (retrying through the catch below would leave the
                        // copy orphaned and create a second, empty project)
                        // and surface the dropped seed instead of discarding
                        // it silently.
                        console.error('Community remix: could not seed the template prompt.');
                      }
                      await Promise.resolve(onOpenProject(result.projectId, result.relPath));
                    } catch {
                      await onCreateProject({
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
                  // Seed the Home composer with the template's starting prompt,
                  // then switch to Home to review + send it (keep in sync with
                  // the standalone /community branch in App.tsx).
                  seedHomeComposerPrompt(target.prompt);
                  setHomePromptHandoff(createPluginUseHandoff(Date.now(), target.templateId, {
                    action: 'use',
                    chipId: target.chipId,
                    projectKind: target.projectKind,
                  }));
                  changeView('home');
                }}
                // The gallery card's full details modal routes Use through the
                // same Home hand-off the plugin library uses, so the plugin
                // becomes the composer's active driver instead of only seeding
                // prompt text.
                onUsePlugin={(record, action, target) => {
                  usePluginFromLibrary(record, action, {
                    chipId: target.chipId,
                    projectKind: target.projectKind,
                  });
                }}
              />
            ) : null}
            {/* Team destinations — the entry shell owns the nav frame only; each
                view is provided by another lane (B = members/board, D = team
                project spaces / workspace settings), rendered as a placeholder
                until those land. */}
            {view === 'drafts' ? (
              projectsLoading ? (
                <div className="entry-section">
                  <CenteredLoader label={t('common.loading')} />
                </div>
              ) : draftProjectsList.length === 0 ? (
                <EntryBlankState
                  heading={t('entry.navDrafts')}
                  description={t('entry.blankDraftsDescription')}
                  actionLabel={t('entry.blankCreate')}
                  onCreate={() => startBlankProjectFromRail()}
                />
              ) : (
                <div className="entry-section">
                  <RecentProjectsStrip
                    projects={draftProjectsList}
                    designSystems={designSystems}
                    limit={1000}
                    heading={t('entry.navDrafts')}
                    space="drafts"
                    onProjectShared={markProjectShared}
                    onProjectShareFailed={markProjectShareFailed}
                    onProjectUnshared={markProjectUnshared}
                    projectOwnerMemberIds={teamProjectOwnerMemberIds}
                    onOpen={(id) => onOpenProject(id)}
                    onViewAll={() => {}}
                    onDelete={onDeleteProject}
                    onRename={onRenameProject}
                  />
                </div>
              )
            ) : null}
            {view === 'all-projects' ? (
              // The all-projects grid is fed by `teamProjects`, which has its own
              // loading state and restarts from empty whenever the entry shell
              // remounts (e.g. returning from a project). Gating only on
              // `projectsLoading` flashed the "还没有团队项目" empty state during
              // that team read; wait for BOTH before deciding the grid is empty.
              projectsLoading ? (
                <div className="entry-section">
                  <CenteredLoader label={t('common.loading')} />
                </div>
              ) : allProjectsList.length === 0 ? (
                <EntryBlankState
                  heading={t('entry.navAllProjects')}
                  description={t('entry.blankAllProjectsDescription')}
                  actionLabel={t('entry.blankCreate')}
                  onCreate={() => startBlankProjectFromRail()}
                />
              ) : (
                <div className="entry-section">
                  <RecentProjectsStrip
                    projects={allProjectsList}
                    designSystems={designSystems}
                    limit={1000}
                    heading={t('entry.navAllProjects')}
                    space="team"
                    onProjectShared={markProjectShared}
                    onProjectShareFailed={markProjectShareFailed}
                    onProjectUnshared={markProjectUnshared}
                    projectOwnerMemberIds={teamProjectOwnerMemberIds}
                    openingProjectId={pullingProjectId}
                    onOpen={handleOpenAllProjects}
                    onViewAll={() => {}}
                    onDelete={onDeleteProject}
                    onRename={onRenameProject}
                  />
                </div>
              )
            ) : null}
            {view === 'members' ? (
              <TeamSlotPlaceholder icon="users" title={t('entry.navMembers')} />
            ) : null}
            {view === 'board' ? (
              <TeamSlotPlaceholder icon="kanban" title={t('entry.navBoard')} />
            ) : null}
            {view === 'workspace-settings' ? (
              <TeamSlotPlaceholder icon="settings" title={t('entry.navWorkspaceSettings')} />
            ) : null}
          </div>
        </main>
      </div>
      <NewProjectModal
        open={newProjectOpen}
        initialTab={newProjectInitialTab}
        skills={skills}
        designTemplates={designTemplates}
        designSystems={designSystems}
        defaultDesignSystemId={defaultDesignSystemId}
        templates={templates}
        {...(onDeleteTemplate ? { onDeleteTemplate } : {})}
        promptTemplates={promptTemplates}
        mediaProviders={config.mediaProviders}
        connectors={connectors}
        connectorsLoading={connectorsLoading}
        loading={skillsLoading}
        onCreate={handleCreate}
        onImportClaudeDesign={onImportClaudeDesign}
        {...(onImportFolder ? { onImportFolder } : {})}
        {...(onImportFolderResponse ? { onImportFolderResponse } : {})}
        onOpenConnectorsTab={() => {
          setNewProjectOpen(false);
          openIntegrationTab('connectors');
        }}
        onClose={() => setNewProjectOpen(false)}
      />
    </div>
  );
}

function OnboardingView({
  config,
  providerModelsCache: sharedProviderModelsCache,
  onProviderModelsCacheChange,
  agents,
  agentsLoading = false,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onConfigPersist,
  onRefreshAgents,
  onFinish,
}: {
  config: AppConfig;
  providerModelsCache?: ProviderModelsCache;
  onProviderModelsCacheChange?: Dispatch<SetStateAction<ProviderModelsCache>>;
  agents: AgentInfo[];
  agentsLoading?: boolean;
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string; serviceTier?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  onConfigPersist: (cfg: AppConfig) => Promise<void> | void;
  onRefreshAgents: () => Promise<AgentInfo[]> | AgentInfo[];
  onFinish: () => void;
}) {
  const t = useT();
  const analytics = useAnalytics();
  const [step, setStep] = useState(0);
  const [runtime, setRuntime] = useState<'amr' | 'local' | 'byok' | null>(null);
  const [modelSource, setModelSource] = useState<'amr' | 'local' | 'byok'>('amr');
  const modelSourceOptionRefs = useRef<
    Record<'amr' | 'local' | 'byok', HTMLButtonElement | null>
  >({ amr: null, local: null, byok: null });
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [cliScanStatus, setCliScanStatus] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [visibleAgentIds, setVisibleAgentIds] = useState<string[]>([]);
  const [dshSetup, setDshSetup] = useState<{ busy: boolean; error: string | null } | null>(null);
  const [providerTestState, setProviderTestState] = useState<
    | { status: 'idle' }
    | { status: 'running'; inputKey: string }
    | { status: 'done'; inputKey: string; result: ConnectionTestResponse }
  >({ status: 'idle' });
  const [agentTestState, setAgentTestState] = useState<OnboardingAgentTestState>({
    status: 'idle',
  });
  const [providerModelsState, setProviderModelsState] = useState<
    | { status: 'idle' }
    | { status: 'running'; inputKey: string }
    | { status: 'done'; inputKey: string; result: ProviderModelsResponse }
  >({ status: 'idle' });
  const [localProviderModelsCache, setLocalProviderModelsCache] =
    useState<ProviderModelsCache>({});
  const hasSharedProviderModelsCache =
    Boolean(sharedProviderModelsCache) && Boolean(onProviderModelsCacheChange);
  const activeProviderModelsCache =
    hasSharedProviderModelsCache
      ? sharedProviderModelsCache!
      : localProviderModelsCache;
  const activeSetProviderModelsCache =
    hasSharedProviderModelsCache
      ? onProviderModelsCacheChange!
      : setLocalProviderModelsCache;
  const agentRevealTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const cliScanTokenRef = useRef(0);
  const cliScanTelemetryRef = useRef<{
    token: number;
    startedAt: number;
    onboardingSessionId: string;
  } | null>(null);
  const cliRefreshPendingTokenRef = useRef<number | null>(null);
  const onboardingMountedRef = useRef(true);
  const providerModelsAutoFetchKeyRef = useRef<string | null>(null);
  const providerAutoTestKeyRef = useRef<string | null>(null);
  const providerModelAutoSelectRef = useRef({
    model: config.model,
    providerModelsInputKey: '',
    runtime,
    step,
  });
  const apiProtocol = config.apiProtocol ?? 'anthropic';
  const providerTestInputKey = [
    apiProtocol,
    config.baseUrl.trim(),
    config.model.trim(),
    config.apiKey.trim(),
    config.apiVersion?.trim() ?? '',
  ].join('\n');
  const providerModelsInputKey = providerModelsCacheKey(
    apiProtocol,
    config.baseUrl,
    config.apiKey,
    config.apiVersion ?? '',
  );
  providerModelAutoSelectRef.current = {
    model: config.model,
    providerModelsInputKey,
    runtime,
    step,
  };
  const canTestProvider =
    Boolean(config.apiKey.trim()) &&
    Boolean(config.baseUrl.trim()) &&
    Boolean(config.model.trim());
  const canFetchProviderModels =
    apiProtocol !== 'azure' &&
    apiProtocol !== 'ollama' &&
    Boolean(config.apiKey.trim()) &&
    Boolean(config.baseUrl.trim()) &&
    isLikelyHttpUrl(config.baseUrl);
  const visibleProviderTestState =
    providerTestState.status !== 'idle' &&
    providerTestState.inputKey === providerTestInputKey
      ? providerTestState
      : { status: 'idle' as const };
  const visibleProviderModelsState =
    providerModelsState.status !== 'idle' &&
    providerModelsState.inputKey === providerModelsInputKey
      ? providerModelsState
      : { status: 'idle' as const };
  const selectedProvider = KNOWN_PROVIDERS.find(
    (provider) =>
      provider.protocol === apiProtocol &&
      (
        provider.baseUrl === (config.apiProviderBaseUrl ?? config.baseUrl) ||
        (apiProtocol === 'azure' && provider.baseUrl === '' && Boolean(config.baseUrl?.trim()))
      ),
  ) ?? null;
  const candidateCliAgents = agents.filter(
    (agent) => agent.id !== 'amr' && (agent.available || deepSeekHarnessNeedsSetup(agent)),
  );
  const visibleAgents = candidateCliAgents.filter((agent) => visibleAgentIds.includes(agent.id));
  const selectedAgent = visibleAgents.find((agent) => agent.id === config.agentId) ?? null;
  const selectedAgentChoice = selectedAgent ? (config.agentModels?.[selectedAgent.id] ?? {}) : {};
  const normalizedSelectedAgentChoice = effectiveAgentModelChoice(selectedAgent, selectedAgentChoice) ?? selectedAgentChoice;
  const selectedAgentTestModel = normalizedSelectedAgentChoice.model ?? defaultAgentModelId(selectedAgent) ?? '';
  const selectedAgentTestReasoning = selectedAgentChoice.reasoning ?? '';
  const agentTestInputKey = [
    selectedAgent?.id ?? '',
    selectedAgentTestModel,
    selectedAgentTestReasoning,
    JSON.stringify(config.agentCliEnv ?? {}),
  ].join('\n');
  const visibleAgentTestState =
    agentTestState.status === 'running' ||
    (agentTestState.status !== 'idle' && agentTestState.inputKey === agentTestInputKey)
      ? agentTestState
      : { status: 'idle' as const };
  const canTestAgent = Boolean(selectedAgent) && daemonLive;
  const runtimeSetupStep = step === 1;
  const localRuntimeConfigured = selectedAgent?.available === true;
  const byokRuntimeConfigured = canTestProvider;
  const connectStepRuntimeReady =
    (runtime === 'local' && localRuntimeConfigured) ||
    (runtime === 'byok' && byokRuntimeConfigured);
  const connectStepTestRunning =
    (runtime === 'local' && visibleAgentTestState.status === 'running') ||
    (runtime === 'byok' && visibleProviderTestState.status === 'running');
  const connectStepBlocked = runtimeSetupStep && !connectStepRuntimeReady;
  // What the user is looking at RIGHT NOW. `handlePrimaryAction` awaits a
  // validation round trip before it persists anything, and its closure is
  // frozen at click time — so the continuation cannot ask this question of its
  // own variables. See `continueAttemptStillCurrent`.
  const onboardingIntentRef = useRef({
    step,
    runtime,
    agentTestInputKey,
    providerTestInputKey,
  });
  onboardingIntentRef.current = {
    step,
    runtime,
    agentTestInputKey,
    providerTestInputKey,
  };
  const connectGateReason: 'no_runtime' | 'local_agent_unavailable' | 'byok_unverified' | null =
    !runtimeSetupStep
      ? null
      : connectStepBlocked
        ? runtime === 'local'
          ? 'local_agent_unavailable'
          : runtime === 'byok'
            ? 'byok_unverified'
            : 'no_runtime'
        : null;
  const connectGateTooltip =
    connectGateReason === 'local_agent_unavailable'
      ? t('settings.onboardingGateTooltipLocal')
      : connectGateReason === 'byok_unverified'
        ? t('settings.onboardingGateTooltipByok')
        : connectGateReason === 'no_runtime'
          ? t('settings.onboardingGateTooltipNoRuntime')
          : null;

  useEffect(() => {
    onboardingMountedRef.current = true;
    return () => {
      onboardingMountedRef.current = false;
      agentRevealTimersRef.current.forEach((timer) => clearTimeout(timer));
      agentRevealTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (runtime !== 'local') return;
    const scanToken = cliScanTokenRef.current;
    if (cliRefreshPendingTokenRef.current === scanToken) return;
    const currentAvailableAgents = agents.filter(
      (agent) => agent.available && agent.id !== 'amr',
    );
    if (currentAvailableAgents.length > 0) {
      const selectedCliAgent = selectDefaultCliAgent(currentAvailableAgents);
      showCliAgents(scanToken, currentAvailableAgents, { stagger: false });
      setCliScanStatus('done');
      emitPendingCliScanResult(scanToken, {
        result: 'success',
        detected: agents.length,
        available: currentAvailableAgents.length,
        selectedCliId: selectedCliAgent ? agentIdToTracking(selectedCliAgent.id) : undefined,
      });
      return;
    }
    if (!agentsLoading && cliScanStatus === 'scanning') {
      setCliScanStatus('done');
      emitPendingCliScanResult(scanToken, {
        result: 'failed',
        detected: agents.length,
        available: 0,
        errorCode: 'NO_AVAILABLE_CLI',
      });
    }
  }, [agents, agentsLoading, cliScanStatus, config.agentId, runtime]);

  // Onboarding step exposure for identity, source choice, and optional setup.
  //
  // We do NOT clear on unmount: route changes can remount the shell
  // during first-run setup. Completion clears inline; abandoned sessions
  // clear on sessionStorage tab close.
  const onboardingSessionIdRef = useRef<string>('');
  if (!onboardingSessionIdRef.current && config.onboardingCompleted !== true) {
    onboardingSessionIdRef.current = getOrCreateOnboardingSessionId();
  }
  useEffect(() => {
    const onboardingSessionId = onboardingSessionIdRef.current;
    if (!onboardingSessionId) return;
    const info = stepInfo(step);
    trackPageView(analytics.track, {
      page_name: 'onboarding',
      area: info.area,
      step_index: info.stepIndex,
      step_name: info.stepName,
      onboarding_session_id: onboardingSessionId,
    });
  }, [analytics.track, step]);

  // Onboarding analytics helpers. Wall-clock start so the lifecycle
  // result event can carry `duration_ms`; `runtime` state is the user's
  // current pick at click time so `runtime_type` rides along on every
  // click. The lifecycle guard keeps rapid repeated completion actions from
  // double-firing the terminal event.
  const onboardingStartedAtRef = useRef<number>(Date.now());
  const lifecycleReportedRef = useRef(false);
  function currentRuntimeType(): TrackingOnboardingRuntimeType {
    if (runtime === 'amr') return 'amr_cloud';
    if (runtime === 'local') return 'local_cli';
    if (runtime === 'byok') return 'byok';
    return 'none';
  }
  function stepInfo(stepIdx: number): {
    area: TrackingOnboardingArea;
    stepIndex: TrackingOnboardingStepIndex;
    stepName: TrackingOnboardingStepName;
  } {
    if (stepIdx === 0) {
      return { area: 'model_source', stepIndex: '1', stepName: 'model_source' };
    }
    return { area: 'runtime_setup', stepIndex: '2', stepName: 'runtime_setup' };
  }
  function emitOnboardingClick(
    element: TrackingOnboardingClickElement,
    action: TrackingOnboardingClickAction,
    extra: Partial<Omit<
      Parameters<typeof trackOnboardingClick>[1],
      'page_name' | 'area' | 'element' | 'action' | 'step_index' | 'step_name' | 'onboarding_session_id'
    >> = {},
  ): void {
    const onboardingSessionId = onboardingSessionIdRef.current;
    if (!onboardingSessionId) return;
    const info = stepInfo(step);
    trackOnboardingClick(analytics.track, {
      page_name: 'onboarding',
      area: info.area,
      element,
      action,
      step_index: info.stepIndex,
      step_name: info.stepName,
      onboarding_session_id: onboardingSessionId,
      ...extra,
    });
  }
  function emitOnboardingComplete(
    result: TrackingOnboardingCompletionResult,
    completionType: TrackingOnboardingCompletionType,
    extra: {
      errorCode?: string;
      runtimeType?: TrackingOnboardingRuntimeType;
    } = {},
  ): void {
    if (lifecycleReportedRef.current) return;
    const onboardingSessionId = onboardingSessionIdRef.current;
    if (!onboardingSessionId) return;
    lifecycleReportedRef.current = true;
    const info = stepInfo(step);
    trackOnboardingCompleteResult(analytics.track, {
      page_name: 'onboarding',
      area: 'onboarding',
      result,
      exit_step_name: info.stepName,
      completion_type: completionType,
      runtime_type: extra.runtimeType ?? currentRuntimeType(),
      has_about_you: false,
      has_design_system_request: false,
      source_count: 0,
      ...(extra.errorCode ? { error_code: extra.errorCode } : {}),
      duration_ms: Math.max(0, Date.now() - onboardingStartedAtRef.current),
      onboarding_session_id: onboardingSessionId,
    });
  }
  const protocolProviders = KNOWN_PROVIDERS.filter((provider) => provider.protocol === apiProtocol);
  const hasProtocolOwnedEmptyProvider =
    apiProtocol === 'azure' && protocolProviders.some((provider) => provider.baseUrl === '');
  const byokProviderOptions = [
    ...(hasProtocolOwnedEmptyProvider
      ? []
      : [{ value: '', label: t('settings.customProvider') }]),
    ...protocolProviders.map((provider) => ({
      value: provider.baseUrl,
      label: provider.label,
    })),
  ];
  const agentModelOptions =
    selectedAgent?.models?.map((model) => ({
      value: model.id,
      label: model.label ?? model.id,
    })) ?? [];
  const fetchedProviderModels =
    activeProviderModelsCache[providerModelsInputKey] ?? [];
  const byokModelOptions = mergeOnboardingProviderModelOptions(
    fetchedProviderModels,
    selectedProvider?.preferredModels.length
      ? selectedProvider.preferredModels
      : SUGGESTED_MODELS_BY_PROTOCOL[apiProtocol],
    config.model,
  ).map((model) => ({
    value: model.id,
    label: onboardingProviderModelLabel(model),
  }));

  function updateApiConfig(patch: Partial<ApiProtocolConfig>) {
    const protocol = config.apiProtocol ?? 'anthropic';
    const currentConfig: ApiProtocolConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      apiVersion: config.apiVersion ?? '',
      apiProviderBaseUrl: config.apiProviderBaseUrl ?? null,
    };
    const nextProtocolConfig: ApiProtocolConfig = {
      ...currentConfig,
      ...patch,
    };
    const nextConfig: AppConfig = {
      ...config,
      mode: 'api',
      apiProtocol: protocol,
      apiKey: nextProtocolConfig.apiKey,
      baseUrl: nextProtocolConfig.baseUrl,
      model: nextProtocolConfig.model,
      apiVersion: protocol === 'azure' ? (nextProtocolConfig.apiVersion ?? '') : '',
      apiProviderBaseUrl: nextProtocolConfig.apiProviderBaseUrl ?? null,
      apiProtocolConfigs: {
        ...(config.apiProtocolConfigs ?? {}),
        [protocol]: nextProtocolConfig,
      },
    };
    void onConfigPersist(nextConfig);
  }

  function selectPreferredProviderModelWhenEmpty(
    models: readonly ProviderModelOption[],
    expectedInputKey: string,
  ) {
    const current = providerModelAutoSelectRef.current;
    if (
      current.runtime !== 'byok' ||
      current.step !== 2 ||
      current.providerModelsInputKey !== expectedInputKey ||
      current.model.trim()
    ) {
      return;
    }
    const preference = resolveByokModelPreference({
      currentModel: '',
      accountModels: models,
      providerPreferredModels: selectedProvider?.preferredModels ?? [],
    });
    if (!preference.model) return;
    onApiModelChange(preference.model);
    updateApiConfig({ model: preference.model });
  }

  function clearAgentRevealTimers() {
    agentRevealTimersRef.current.forEach((timer) => clearTimeout(timer));
    agentRevealTimersRef.current = [];
  }

  function selectDefaultCliAgent(availableAgents: AgentInfo[]): AgentInfo | null {
    const selectedAgent =
      availableAgents.find((agent) => agent.id === config.agentId) ?? availableAgents[0] ?? null;
    if (!selectedAgent) return null;
    if (selectedAgent.id !== config.agentId) {
      onAgentChange(selectedAgent.id);
    }
    return selectedAgent;
  }

  function emitPendingCliScanResult(
    token: number,
    args: {
      result: 'success' | 'failed';
      detected: number;
      available: number;
      selectedCliId?: TrackingCliProviderId;
      errorCode?: string;
    },
  ): void {
    const telemetry = cliScanTelemetryRef.current;
    if (!telemetry || telemetry.token !== token) return;
    cliScanTelemetryRef.current = null;
    trackOnboardingRuntimeScanResult(analytics.track, {
      page_name: 'onboarding',
      area: 'runtime',
      runtime_type: 'local_cli',
      result: args.result,
      detected_cli_count: args.detected,
      available_cli_count: args.available,
      ...(args.selectedCliId ? { selected_cli_id: args.selectedCliId } : {}),
      ...(args.errorCode ? { error_code: args.errorCode } : {}),
      duration_ms: Math.max(0, Date.now() - telemetry.startedAt),
      onboarding_session_id: telemetry.onboardingSessionId,
    });
  }

  function beginCliScan(options: { clearVisible: boolean }): number {
    const scanToken = cliScanTokenRef.current + 1;
    cliScanTokenRef.current = scanToken;
    clearAgentRevealTimers();
    setRuntime('local');
    onModeChange('daemon');
    setCliScanStatus('scanning');
    if (options.clearVisible) setVisibleAgentIds([]);
    const onboardingSessionId = onboardingSessionIdRef.current;
    cliScanTelemetryRef.current = onboardingSessionId
      ? {
          token: scanToken,
          startedAt: Date.now(),
          onboardingSessionId,
        }
      : null;
    return scanToken;
  }

  function showCliAgents(
    token: number,
    availableAgents: AgentInfo[],
    options: { stagger: boolean },
  ): void {
    if (!options.stagger) {
      const nextIds = availableAgents.map((agent) => agent.id);
      setVisibleAgentIds((current) =>
        current.length === nextIds.length && current.every((id, index) => id === nextIds[index])
          ? current
          : nextIds,
      );
      return;
    }
    availableAgents.forEach((agent, index) => {
      const timer = setTimeout(() => {
        if (cliScanTokenRef.current !== token) return;
        setVisibleAgentIds((current) =>
          current.includes(agent.id) ? current : [...current, agent.id],
        );
        if (index === availableAgents.length - 1) {
          setCliScanStatus('done');
        }
      }, 110 * (index + 1));
      agentRevealTimersRef.current.push(timer);
    });
  }

  function handleBackWithTracking(): void {
    emitOnboardingClick('back', 'back');
    clearAgentRevealTimers();
    setRuntime(null);
    setStep(0);
  }

  function completeStreamlinedOnboarding(
    runtimeType: TrackingOnboardingRuntimeType,
  ): void {
    emitOnboardingComplete('completed', 'completed_without_design_system', {
      runtimeType,
    });
    clearOnboardingSessionId();
    onFinish();
  }

  function handleModelSourceKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentSource: 'amr' | 'local' | 'byok',
  ): void {
    const sources = ['amr', 'local', 'byok'] as const;
    const currentIndex = sources.indexOf(currentSource);
    let nextIndex: number | null = null;

    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % sources.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + sources.length) % sources.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = sources.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextSource = sources[nextIndex];
    if (!nextSource) return;
    setModelSource(nextSource);
    modelSourceOptionRefs.current[nextSource]?.focus();
  }

  function continueWithModelSource(): void {
    if (modelSource === 'amr') {
      emitOnboardingClick('amr_cloud', 'select_runtime', {
        runtime_type: 'amr_cloud',
        is_recommended: true,
      });
      setRuntime('amr');
      onModeChange('daemon');
      onAgentChange('amr');
      completeStreamlinedOnboarding('amr_cloud');
      return;
    }

    if (modelSource === 'local') {
      emitOnboardingClick('local_coding_agent', 'select_runtime', {
        runtime_type: 'local_cli',
      });
      setRuntime('local');
      void scanCliAgents({ preferExisting: true });
      setStep(1);
      return;
    }

    emitOnboardingClick('byok', 'select_runtime', { runtime_type: 'byok' });
    setRuntime('byok');
    setStep(1);
  }
  /**
   * Whether the Continue attempt that started against `startedInputKey` still
   * describes what the user is looking at.
   *
   * A validation round trip can outlive the intent that started it: Back stays
   * enabled while the test is in flight, and the inputs being validated stay
   * editable. Persisting a late result regardless would write a configuration
   * the user already walked away from and finish onboarding under them — so
   * the attempt must still be on the runtime setup step, on the same runtime,
   * and against the same inputs it validated.
   *
   * `inputKey` already guards what gets DISPLAYED (`visibleAgentTestState` /
   * `visibleProviderTestState` fall back to idle once it drifts); this applies
   * the same rule to what gets PERSISTED.
   */
  function continueAttemptStillCurrent(
    startedRuntime: 'local' | 'byok',
    startedInputKey: string,
  ): boolean {
    const now = onboardingIntentRef.current;
    if (now.step !== 1 || now.runtime !== startedRuntime) return false;
    return startedRuntime === 'local'
      ? now.agentTestInputKey === startedInputKey
      : now.providerTestInputKey === startedInputKey;
  }

  async function handlePrimaryAction() {
    if (connectStepBlocked || connectStepTestRunning) return;
    if (runtime === 'local' && selectedAgent) {
      const startedInputKey = agentTestInputKey;
      const testResult =
        visibleAgentTestState.status === 'done' && visibleAgentTestState.result.ok
          ? visibleAgentTestState.result
          : await testAgentInline();
      if (!testResult?.ok) return;
      if (!continueAttemptStillCurrent('local', startedInputKey)) return;
      await onConfigPersist({
        ...config,
        mode: 'daemon',
        agentId: selectedAgent.id,
      });
      emitOnboardingClick('continue', 'continue', { runtime_type: 'local_cli' });
      completeStreamlinedOnboarding('local_cli');
      return;
    }
    if (runtime === 'byok') {
      const startedInputKey = providerTestInputKey;
      const testResult =
        visibleProviderTestState.status === 'done' && visibleProviderTestState.result.ok
          ? visibleProviderTestState.result
          : await testProviderInline();
      if (!testResult?.ok) return;
      if (!continueAttemptStillCurrent('byok', startedInputKey)) return;
      await onConfigPersist({ ...config, mode: 'api' });
      emitOnboardingClick('continue', 'continue', { runtime_type: 'byok' });
      completeStreamlinedOnboarding('byok');
      return;
    }
  }


  async function scanCliAgents(options: { preferExisting?: boolean } = {}) {
    const scanToken = beginCliScan({ clearVisible: !options.preferExisting });
    const currentCandidateAgents = agents.filter(
      (agent) => agent.id !== 'amr' && (agent.available || deepSeekHarnessNeedsSetup(agent)),
    );
    const currentAvailableAgents = currentCandidateAgents.filter((agent) => agent.available);
    if (options.preferExisting && currentCandidateAgents.length > 0) {
      const selectedCliAgent = selectDefaultCliAgent(currentAvailableAgents);
      showCliAgents(scanToken, currentCandidateAgents, { stagger: false });
      setCliScanStatus('done');
      emitPendingCliScanResult(scanToken, {
        result: 'success',
        detected: agents.length,
        available: currentAvailableAgents.length,
        selectedCliId: selectedCliAgent ? agentIdToTracking(selectedCliAgent.id) : undefined,
      });
      return currentAvailableAgents;
    }
    if (options.preferExisting && agentsLoading) {
      showCliAgents(scanToken, currentCandidateAgents, { stagger: false });
      return currentCandidateAgents;
    }
    cliRefreshPendingTokenRef.current = scanToken;
    try {
      const nextAgents = await onRefreshAgents();
      if (cliScanTokenRef.current !== scanToken) return;
      cliRefreshPendingTokenRef.current = null;
      const availableAgents = nextAgents.filter((agent) => agent.available && agent.id !== 'amr');
      const candidateAgents = nextAgents.filter(
        (agent) => agent.id !== 'amr' && (agent.available || deepSeekHarnessNeedsSetup(agent)),
      );
      const selectedCliAgent = selectDefaultCliAgent(availableAgents);
      // Scan-result semantics: zero available CLIs is a `failed` outcome
      // because the user's runtime path is blocked, even though the
      // detect call itself returned successfully. `detected_cli_count`
      // separately reports the raw catalog so the dashboard can split
      // "user has no CLI installed" from "detect crashed".

      if (candidateAgents.length === 0) {
        setCliScanStatus('done');
        emitPendingCliScanResult(scanToken, {
          result: 'failed',
          detected: nextAgents.length,
          available: 0,
          errorCode: 'NO_AVAILABLE_CLI',
        });
        return;
      }
      emitPendingCliScanResult(scanToken, {
        result: 'success',
        detected: nextAgents.length,
        available: availableAgents.length,
        ...(selectedCliAgent
          ? { selectedCliId: agentIdToTracking(selectedCliAgent.id) }
          : {}),
      });
      showCliAgents(scanToken, candidateAgents, { stagger: true });
    } catch (err) {
      if (cliScanTokenRef.current === scanToken) {
        cliRefreshPendingTokenRef.current = null;
        setCliScanStatus('done');
        emitPendingCliScanResult(scanToken, {
          result: 'failed',
          detected: 0,
          available: 0,
          errorCode: err instanceof Error ? err.message : 'AGENT_REFRESH_THREW',
        });
      }
    }
  }

  async function testProviderInline(): Promise<ConnectionTestResponse | null> {
    if (!canTestProvider || providerTestState.status === 'running') return null;
    const inputKey = providerTestInputKey;
    providerAutoTestKeyRef.current = inputKey;
    setProviderTestState({ status: 'running', inputKey });
    try {
      const result = await testApiProvider({
        protocol: apiProtocol,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        apiVersion:
          apiProtocol === 'azure'
            ? config.apiVersion?.trim() || undefined
            : undefined,
      });
      setProviderTestState({ status: 'done', inputKey, result });
      return result;
    } catch (error) {
      const result: ConnectionTestResponse = {
        ok: false,
        kind: 'unknown',
        latencyMs: 0,
        model: config.model,
        detail: error instanceof Error ? error.message : 'Test request failed',
      };
      setProviderTestState({ status: 'done', inputKey, result });
      return result;
    }
  }

  async function testAgentInline(): Promise<ConnectionTestResponse | null> {
    if (!selectedAgent || !canTestAgent || agentTestState.status === 'running') return null;
    const inputKey = agentTestInputKey;
    const agent = selectedAgent;
    const model = selectedAgentTestModel;
    const reasoning = selectedAgentTestReasoning;
    setAgentTestState({ status: 'running', inputKey });
    try {
      const result = await testAgent({
        agentId: agent.id,
        model: model || undefined,
        reasoning: reasoning || undefined,
        agentCliEnv: config.agentCliEnv ?? {},
      });
      setAgentTestState({ status: 'done', inputKey, result });
      return result;
    } catch (error) {
      const result: ConnectionTestResponse = {
        ok: false,
        kind: 'unknown',
        latencyMs: 0,
        model: model || 'default',
        agentName: agent.name,
        detail: error instanceof Error ? error.message : 'Test request failed',
      };
      setAgentTestState({ status: 'done', inputKey, result });
      return result;
    }
  }

  async function confirmDshSetup() {
    if (dshSetup?.busy) return;
    setDshSetup({ busy: true, error: null });
    try {
      await installDeepSeekHarnessCompanion();
      const nextAgents = await onRefreshAgents();
      const installed = nextAgents.find(
        (agent) => agent.id === 'deepseek-harness' && agent.available,
      );
      if (!installed) throw new Error(t('settings.dshSetupRequired'));
      showCliAgents(
        cliScanTokenRef.current,
        nextAgents.filter(
          (agent) => agent.id !== 'amr' && (agent.available || deepSeekHarnessNeedsSetup(agent)),
        ),
        { stagger: false },
      );
      onModeChange('daemon');
      onAgentChange(installed.id);
      setDshSetup(null);

      const choice = config.agentModels?.[installed.id] ?? {};
      const effectiveChoice = effectiveAgentModelChoice(installed, choice) ?? choice;
      const model = effectiveChoice.model ?? defaultAgentModelId(installed) ?? '';
      const reasoning = choice.reasoning ?? '';
      const inputKey = [installed.id, model, reasoning, JSON.stringify(config.agentCliEnv ?? {})].join('\n');
      setAgentTestState({ status: 'running', inputKey });
      const result = await testAgent({
        agentId: installed.id,
        model: model || undefined,
        reasoning: reasoning || undefined,
        agentCliEnv: config.agentCliEnv ?? {},
      });
      setAgentTestState({ status: 'done', inputKey, result });
    } catch (error) {
      setDshSetup({
        busy: false,
        error: error instanceof Error ? error.message : t('settings.dshSetupRequired'),
      });
    }
  }

  async function fetchProviderModelsInline() {
    if (!canFetchProviderModels || providerModelsState.status === 'running') return;
    const inputKey = providerModelsInputKey;
    providerModelsAutoFetchKeyRef.current = inputKey;
    const cachedModels = activeProviderModelsCache[inputKey];
    if (cachedModels) {
      selectPreferredProviderModelWhenEmpty(cachedModels, inputKey);
      setProviderModelsState({
        status: 'done',
        inputKey,
        result: {
          ok: true,
          kind: 'success',
          latencyMs: 0,
          models: cachedModels,
        },
      });
      return;
    }
    setProviderModelsState({ status: 'running', inputKey });
    try {
      const result = await fetchProviderModels({
        protocol: apiProtocol,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
      if (result.ok && result.models?.length) {
        selectPreferredProviderModelWhenEmpty(result.models, inputKey);
        activeSetProviderModelsCache((current) => ({
          ...current,
          [inputKey]: result.models ?? [],
        }));
      }
      setProviderModelsState({ status: 'done', inputKey, result });
    } catch (error) {
      setProviderModelsState({
        status: 'done',
        inputKey,
        result: {
          ok: false,
          kind: 'unknown',
          latencyMs: 0,
          detail: error instanceof Error ? error.message : 'Model list request failed',
        },
      });
    }
  }

  useEffect(() => {
    if (runtime !== 'byok' || !runtimeSetupStep) return;
    if (!canFetchProviderModels) return;
    if (providerModelsState.status === 'running') return;
    if (providerModelsAutoFetchKeyRef.current === providerModelsInputKey) return;
    const timer = window.setTimeout(() => {
      void fetchProviderModelsInline();
    }, ONBOARDING_BYOK_AUTO_FETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    canFetchProviderModels,
    providerModelsInputKey,
    providerModelsState.status,
    runtime,
    step,
  ]);

  useEffect(() => {
    if (runtime !== 'byok' || !runtimeSetupStep) return;
    if (!canTestProvider) return;
    if (providerTestState.status === 'running') return;
    if (providerAutoTestKeyRef.current === providerTestInputKey) return;
    const timer = window.setTimeout(() => {
      void testProviderInline();
    }, ONBOARDING_BYOK_AUTO_TEST_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    canTestProvider,
    providerTestInputKey,
    providerTestState.status,
    runtime,
    step,
  ]);

  const primaryActionLabel = t('settings.onboardingContinue');

  if (step === 0) {
    return (
      <section
        className="onboarding-view onboarding-view--cloud"
        aria-label={t('settings.onboardingExecutionTitle')}
      >
        <div className={`onboarding-cloud__pane ${onboardingSourceStyles.pane}`}>
          <div className={`onboarding-cloud__center ${onboardingSourceStyles.center}`}>
            <h1 className="onboarding-cloud__title">
              {t('settings.onboardingExecutionTitle')}
            </h1>
            <p className="onboarding-cloud__body">
              {t('settings.onboardingExecutionBody')}
            </p>
            <div
              className={onboardingSourceStyles.options}
              role="radiogroup"
              aria-label={t('settings.onboardingExecutionTitle')}
            >
              <Button
                ref={(node) => {
                  modelSourceOptionRefs.current.amr = node;
                }}
                variant="subtle"
                role="radio"
                aria-checked={modelSource === 'amr'}
                tabIndex={modelSource === 'amr' ? 0 : -1}
                className={`${onboardingSourceStyles.option} ${
                  onboardingSourceStyles.hostedOption
                } ${modelSource === 'amr' ? onboardingSourceStyles.optionActive : ''}`}
                onClick={() => setModelSource('amr')}
                onKeyDown={(event) => handleModelSourceKeyDown(event, 'amr')}
              >
                <span className={onboardingSourceStyles.optionIcon}>
                  <Icon name="sparkles" size={17} />
                </span>
                <span className={onboardingSourceStyles.optionCopy}>
                  <span className={onboardingSourceStyles.optionHeading}>
                    <strong className={onboardingSourceStyles.optionTitle}>
                      {t('settings.onboardingAmrModelSourceLabel')}
                    </strong>
                    <span className={onboardingSourceStyles.recommendedBadge}>
                      {t('settings.onboardingRecommended')}
                    </span>
                  </span>
                  <span className={onboardingSourceStyles.optionBody}>
                    {t('settings.onboardingAmrCloudBenefitModels')}
                  </span>
                </span>
                <span className={onboardingSourceStyles.radio} aria-hidden="true" />
              </Button>
              <Button
                ref={(node) => {
                  modelSourceOptionRefs.current.local = node;
                }}
                variant="subtle"
                role="radio"
                aria-checked={modelSource === 'local'}
                tabIndex={modelSource === 'local' ? 0 : -1}
                className={`${onboardingSourceStyles.option} ${
                  modelSource === 'local' ? onboardingSourceStyles.optionActive : ''
                }`}
                onClick={() => setModelSource('local')}
                onKeyDown={(event) => handleModelSourceKeyDown(event, 'local')}
              >
                <span className={onboardingSourceStyles.optionIcon}>
                  <Icon name="robot" size={17} />
                </span>
                <span className={onboardingSourceStyles.optionCopy}>
                  <strong className={onboardingSourceStyles.optionTitle}>
                    {t('settings.onboardingLocalTitle')}
                  </strong>
                  <span className={onboardingSourceStyles.optionBody}>
                    {t('settings.onboardingLocalBody')}
                  </span>
                </span>
                <span className={onboardingSourceStyles.radio} aria-hidden="true" />
              </Button>
              <Button
                ref={(node) => {
                  modelSourceOptionRefs.current.byok = node;
                }}
                variant="subtle"
                role="radio"
                aria-checked={modelSource === 'byok'}
                tabIndex={modelSource === 'byok' ? 0 : -1}
                className={`${onboardingSourceStyles.option} ${
                  modelSource === 'byok' ? onboardingSourceStyles.optionActive : ''
                }`}
                onClick={() => setModelSource('byok')}
                onKeyDown={(event) => handleModelSourceKeyDown(event, 'byok')}
              >
                <span className={onboardingSourceStyles.optionIcon}>
                  <Icon name="key" size={17} />
                </span>
                <span className={onboardingSourceStyles.optionCopy}>
                  <strong className={onboardingSourceStyles.optionTitle}>
                    {t('settings.onboardingByokTitle')}
                  </strong>
                  <span className={onboardingSourceStyles.optionBody}>
                    {t('settings.onboardingByokBody')}
                  </span>
                </span>
                <span className={onboardingSourceStyles.radio} aria-hidden="true" />
              </Button>
            </div>
            <button
              type="button"
              className="onboarding-cloud__primary"
              onClick={continueWithModelSource}
            >
              {t('settings.onboardingContinue')}
            </button>
          </div>
          <footer className="onboarding-cloud__footer">
            <LanguageMenu placement="up" align="start" />
            <span>
              © {new Date().getFullYear()} OpenDesign ·{' '}
              {t('settings.onboardingCloudRights')}
            </span>
          </footer>
        </div>
        <div className="onboarding-cloud__art" aria-hidden="true">
          <img src="/onboarding/onboarding-cloud-art.webp" alt="" />
        </div>
      </section>
    );
  }

  return (
    <section className="onboarding-view" aria-label={t('settings.welcomeTitle')}>
      <div className="onboarding-view__body">
        <div className="onboarding-view__content">
          <div className="onboarding-view__panel">
            <button
              type="button"
              className="onboarding-view__back-to-cloud"
              onClick={handleBackWithTracking}
            >
              <Icon name="chevron-left" size={14} />
              <span>{t('settings.onboardingBack')}</span>
            </button>
            <OnboardingPanelHeader
              title={
                runtime === 'byok'
                  ? t('settings.onboardingByokTitle')
                  : t('settings.onboardingLocalTitle')
              }
              body={
                runtime === 'byok'
                  ? t('settings.onboardingByokBody')
                  : t('settings.onboardingLocalBody')
              }
            />
            <div className="onboarding-view__runtime-stack">
              {runtime === 'local' ? (
                <OnboardingCliSetupPanel
                  agents={visibleAgents}
                  daemonLive={daemonLive}
                  selectedAgentId={config.agentId}
                  selectedAgent={selectedAgent}
                  selectedModel={
                    normalizedSelectedAgentChoice.model
                    ?? defaultAgentModelId(selectedAgent)
                    ?? ''
                  }
                  modelOptions={agentModelOptions}
                  scanStatus={cliScanStatus}
                  onRefresh={() => void scanCliAgents()}
                  onSelectAgent={(agentId) => {
                    const agent = visibleAgents.find((candidate) => candidate.id === agentId);
                    if (agent && deepSeekHarnessNeedsSetup(agent)) {
                      setDshSetup({ busy: false, error: null });
                      return;
                    }
                    onModeChange('daemon');
                    onAgentChange(agentId);
                  }}
                  onSelectModel={(model) => {
                    if (!selectedAgent) return;
                    onAgentModelChange(selectedAgent.id, {
                      model,
                      serviceTier: undefined,
                    });
                  }}
                  testState={visibleAgentTestState}
                  canTest={canTestAgent}
                  onTest={() => void testAgentInline()}
                />
              ) : null}
              {runtime === 'byok' ? (
                <OnboardingByokSetupPanel
                  apiProtocol={apiProtocol}
                  apiKey={config.apiKey}
                  baseUrl={config.baseUrl}
                  model={config.model}
                  selectedProvider={selectedProvider}
                  providerOptions={byokProviderOptions}
                  apiKeyVisible={apiKeyVisible}
                  onToggleApiKey={() => setApiKeyVisible((current) => !current)}
                  onProtocolChange={onApiProtocolChange}
                  onProviderChange={(baseUrl) => {
                    const provider = KNOWN_PROVIDERS.find(
                      (item) => item.protocol === apiProtocol && item.baseUrl === baseUrl,
                    );
                    updateApiConfig({
                      baseUrl: provider?.baseUrl ?? '',
                      model: defaultKnownProviderModel(provider),
                      apiProviderBaseUrl: provider?.baseUrl ?? null,
                    });
                  }}
                  onApiKeyChange={(apiKey) => updateApiConfig({ apiKey })}
                  onModelChange={(model) => {
                    onApiModelChange(model);
                    updateApiConfig({ model });
                  }}
                  onBaseUrlChange={(baseUrl) =>
                    updateApiConfig({
                      baseUrl,
                      apiProviderBaseUrl: apiProtocol === 'azure' ? '' : null,
                    })
                  }
                  modelOptions={byokModelOptions}
                  testState={visibleProviderTestState}
                  canTest={canTestProvider}
                  onTest={() => void testProviderInline()}
                  modelsState={visibleProviderModelsState}
                  canFetchModels={canFetchProviderModels}
                  onFetchModels={() => void fetchProviderModelsInline()}
                />
              ) : null}
            </div>
          </div>
          <div className="onboarding-view__actions">
            <button
              type="button"
              className={`onboarding-view__primary${connectGateTooltip ? ' od-tooltip' : ''}`}
              onClick={handlePrimaryAction}
              disabled={connectStepTestRunning}
              aria-disabled={connectStepBlocked || undefined}
              data-tooltip={connectGateTooltip ?? undefined}
              data-tooltip-placement="top"
            >
              <span>{primaryActionLabel}</span>
            </button>
          </div>
        </div>
      </div>
      {dshSetup ? (
        <DeepSeekHarnessSetupDialog
          busy={dshSetup.busy}
          error={dshSetup.error}
          onCancel={() => {
            if (!dshSetup.busy) setDshSetup(null);
          }}
          onConfirm={() => void confirmDshSetup()}
        />
      ) : null}
    </section>
  );
}

function OnboardingCliSetupPanel({
  agents,
  daemonLive,
  selectedAgentId,
  selectedAgent,
  selectedModel,
  modelOptions,
  scanStatus,
  onRefresh,
  onSelectAgent,
  onSelectModel,
  testState,
  canTest,
  onTest,
}: {
  agents: AgentInfo[];
  daemonLive: boolean;
  selectedAgentId: string | null;
  selectedAgent: AgentInfo | null;
  selectedModel: string;
  modelOptions: Array<{ value: string; label: string }>;
  scanStatus: 'idle' | 'scanning' | 'done';
  onRefresh: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectModel: (model: string) => void;
  testState: OnboardingAgentTestState;
  canTest: boolean;
  onTest: () => void;
}) {
  const t = useT();
  const scanning = scanStatus === 'scanning';
  const running = testState.status === 'running';
  const showEmpty = scanStatus === 'done' && agents.length === 0;
  return (
    <div className="onboarding-view__setup-panel">
      <div className="onboarding-view__setup-head">
        <div>
          <strong>{t('settings.localCli')}</strong>
          <p>{daemonLive ? t('settings.codeAgentHint') : t('settings.modeDaemonOffline')}</p>
        </div>
        <div className="onboarding-view__setup-head-actions">
          <button
            type="button"
            className={`onboarding-view__mini-button${scanning ? ' is-loading' : ''}`}
            onClick={onRefresh}
            disabled={scanning}
          >
            {scanning ? t('settings.rescanRunning') : t('settings.rescan')}
          </button>
          <button
            type="button"
            className={`onboarding-view__mini-button${running ? ' is-loading' : ''}`}
            onClick={onTest}
            disabled={running || !canTest}
            title={t('settings.testTitle')}
          >
            {running ? t('settings.testRunning') : t('settings.test')}
          </button>
        </div>
      </div>
      {scanning ? (
        <div className="onboarding-view__scan-copy" role="status">
          <p className="onboarding-view__scan-status">
            <Icon name="spinner" size={13} className="icon-spin" />
            <span>{t('settings.rescanRunning')}</span>
          </p>
          <p className="onboarding-view__scan-hint">
            {t('settings.onboardingCliScanHint')}
          </p>
        </div>
      ) : null}
      {agents.length > 0 ? (
        <div className="onboarding-view__agent-strip">
          {agents.map((agent, index) => (
            <button
              key={agent.id}
              type="button"
              className={`onboarding-view__agent-chip${
                selectedAgentId === agent.id ? ' is-selected' : ''
              }`}
              style={{ animationDelay: `${index * 45}ms` }}
              onClick={() => onSelectAgent(agent.id)}
              aria-pressed={selectedAgentId === agent.id}
            >
              <AgentIcon id={agent.id} size={22} />
              <span>
                <strong>{agent.name}</strong>
                <small>
                  {agent.available
                    ? agent.version ?? t('common.installed')
                    : t('settings.dshSetupRequired')}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {showEmpty ? (
        <div className="onboarding-view__empty-slice">
          {t('settings.noAgentsDetected')}
        </div>
      ) : null}
      {selectedAgent && modelOptions.length > 0 ? (
        <OnboardingDropdown
          label={`${t('settings.modelPicker')} · ${selectedAgent.name}`}
          placeholder={t('settings.modelSourceFallback')}
          value={selectedModel}
          options={modelOptions}
          onChange={onSelectModel}
          searchable
          searchPlaceholder={t('newproj.modelSearch')}
        />
      ) : null}
      {testState.status === 'running' ? (
        <p className="onboarding-view__test-status is-running" role="status">
          {t('settings.testRunning')}
        </p>
      ) : testState.status === 'done' ? (
        <p
          className={`onboarding-view__test-status is-${onboardingTestVariant(
            testState.result,
          )}`}
          role={testState.result.ok ? 'status' : 'alert'}
        >
          {renderOnboardingAgentTestMessage(
            t,
            testState.result,
            selectedAgent?.name ?? '',
          )}
        </p>
      ) : null}
    </div>
  );
}

function OnboardingByokSetupPanel({
  apiProtocol,
  apiKey,
  baseUrl,
  model,
  selectedProvider,
  providerOptions,
  apiKeyVisible,
  onToggleApiKey,
  onProtocolChange,
  onProviderChange,
  onApiKeyChange,
  onModelChange,
  onBaseUrlChange,
  modelOptions,
  testState,
  canTest,
  onTest,
  modelsState,
  canFetchModels,
  onFetchModels,
}: {
  apiProtocol: ApiProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
  selectedProvider: KnownProvider | null;
  providerOptions: Array<{ value: string; label: string }>;
  modelOptions: Array<{ value: string; label: string }>;
  apiKeyVisible: boolean;
  onToggleApiKey: () => void;
  onProtocolChange: (protocol: ApiProtocol) => void;
  onProviderChange: (baseUrl: string) => void;
  onApiKeyChange: (apiKey: string) => void;
  onModelChange: (model: string) => void;
  onBaseUrlChange: (baseUrl: string) => void;
  testState:
    | { status: 'idle' }
    | { status: 'running'; inputKey: string }
    | { status: 'done'; inputKey: string; result: ConnectionTestResponse };
  canTest: boolean;
  onTest: () => void;
  modelsState:
    | { status: 'idle' }
    | { status: 'running'; inputKey: string }
    | { status: 'done'; inputKey: string; result: ProviderModelsResponse };
  canFetchModels: boolean;
  onFetchModels: () => void;
}) {
  const t = useT();
  const running = testState.status === 'running';
  const fetchingModels = modelsState.status === 'running';
  const useDeploymentInput = apiProtocol === 'azure';
  return (
    <div className="onboarding-view__setup-panel">
      <div className="onboarding-view__setup-head">
        <div>
          <strong>{t('settings.modeApiMeta')}</strong>
          <p>{t('settings.modeApi')}</p>
        </div>
        <div className="onboarding-view__setup-head-actions">
          <button
            type="button"
            className={`onboarding-view__mini-button${fetchingModels ? ' is-loading' : ''}`}
            onClick={onFetchModels}
            disabled={fetchingModels || !canFetchModels}
            title={t('settings.fetchModelsTitle')}
          >
            {fetchingModels ? t('settings.fetchModelsRunning') : t('settings.fetchModels')}
          </button>
          <button
            type="button"
            className={`onboarding-view__mini-button${running ? ' is-loading' : ''}`}
            onClick={onTest}
            disabled={running || !canTest}
            title={t('settings.testTitle')}
          >
            {running ? t('settings.testRunning') : t('settings.test')}
          </button>
        </div>
      </div>
      <div
        className="onboarding-view__protocol-strip"
        role="tablist"
        aria-label={t('settings.protocolAria')}
      >
        {API_PROTOCOL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={apiProtocol === tab.id}
            className={apiProtocol === tab.id ? 'is-selected' : ''}
            onClick={() => onProtocolChange(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <OnboardingDropdown
        label={t('settings.quickFillProvider')}
        placeholder={t('settings.customProvider')}
        value={selectedProvider?.baseUrl ?? ''}
        options={providerOptions}
        onChange={onProviderChange}
        allowEmptyValue={apiProtocol === 'azure'}
        searchable
        searchPlaceholder={t('settings.quickFillProvider')}
      />
      <label className="onboarding-view__inline-field">
        <span>{t('settings.apiKey')}</span>
        <span className="onboarding-view__field-row">
          <input
            type={apiKeyVisible ? 'text' : 'password'}
            placeholder={API_KEY_PLACEHOLDERS[apiProtocol]}
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
          />
          <button type="button" onClick={onToggleApiKey}>
            {apiKeyVisible ? t('settings.hide') : t('settings.show')}
          </button>
        </span>
      </label>
      <div className="onboarding-view__compact-fields">
        <label className="onboarding-view__inline-field">
          <span>{t('settings.baseUrl')}</span>
          <input
            type="url"
            inputMode="url"
            value={baseUrl}
            placeholder={selectedProvider?.baseUrl ?? 'https://api.anthropic.com'}
            onChange={(event) => onBaseUrlChange(event.target.value)}
          />
        </label>
        {modelOptions.length > 0 && !useDeploymentInput ? (
          <OnboardingDropdown
            label={t('settings.model')}
            placeholder={defaultKnownProviderModel(selectedProvider) || 'claude-sonnet-4-5'}
            value={model}
            options={modelOptions}
            onChange={onModelChange}
            placement="top"
            searchable
            searchPlaceholder={t('newproj.modelSearch')}
          />
        ) : (
          <label className="onboarding-view__inline-field">
            <span>
              {useDeploymentInput
                ? t('settings.azureDeploymentModel')
                : t('settings.model')}
            </span>
            <input
              type="text"
              value={model}
              placeholder={
                useDeploymentInput
                  ? t('settings.azureDeploymentModel')
                  : defaultKnownProviderModel(selectedProvider) || 'claude-sonnet-4-5'
              }
              onChange={(event) => onModelChange(event.target.value.trim())}
            />
          </label>
        )}
      </div>
      {modelsState.status === 'running' ? (
        <p className="onboarding-view__test-status is-running" role="status">
          {t('settings.fetchModelsRunning')}
        </p>
      ) : modelsState.status === 'done' ? (
        <p
          className={`onboarding-view__test-status is-${onboardingProviderModelsVariant(
            modelsState.result,
          )}`}
          role={modelsState.result.ok ? 'status' : 'alert'}
        >
          {renderOnboardingProviderModelsMessage(t, modelsState.result)}
        </p>
      ) : null}
      {testState.status === 'running' ? (
        <p className="onboarding-view__test-status is-running" role="status">
          {t('settings.testRunning')}
        </p>
      ) : testState.status === 'done' ? (
        <p
          className={`onboarding-view__test-status is-${onboardingTestVariant(
            testState.result,
          )}`}
          role={testState.result.ok ? 'status' : 'alert'}
        >
          {renderOnboardingProviderTestMessage(t, testState.result, model)}
        </p>
      ) : null}
    </div>
  );
}

function onboardingTestVariant(
  result: ConnectionTestResponse,
): 'success' | 'warn' | 'error' {
  if (result.ok) return 'success';
  if (result.kind === 'rate_limited') return 'warn';
  return 'error';
}

function onboardingProviderModelsVariant(
  result: ProviderModelsResponse,
): 'success' | 'warn' | 'error' {
  if (result.ok) return 'success';
  if (result.kind === 'rate_limited' || result.kind === 'no_models') return 'warn';
  return 'error';
}

function isLikelyHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function mergeOnboardingProviderModelOptions(
  fetchedModels: readonly ProviderModelOption[],
  suggestedModelIds: readonly string[],
  currentModel: string,
): ProviderModelOption[] {
  const seen = new Set<string>();
  const out: ProviderModelOption[] = [];
  const add = (model: ProviderModelOption) => {
    const id = model.id.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: model.label.trim() || id });
  };
  for (const model of fetchedModels) add(model);
  for (const id of suggestedModelIds) add({ id, label: id });
  if (currentModel.trim()) add({ id: currentModel.trim(), label: currentModel.trim() });
  return out;
}

function onboardingProviderModelLabel(model: ProviderModelOption): string {
  return model.label && model.label !== model.id
    ? `${model.label} (${model.id})`
    : model.id;
}

function renderOnboardingProviderTestMessage(
  t: ReturnType<typeof useT>,
  result: ConnectionTestResponse,
  fallbackModel: string,
): string {
  const ms = Math.max(0, Math.round(result.latencyMs));
  const sample = result.sample ?? '';
  const testedModel = result.model ?? fallbackModel;
  if (result.ok) {
    const baseMessage = t('settings.testSuccessApi', { ms, sample });
    return result.detail ? `${baseMessage} ${result.detail}` : baseMessage;
  }
  switch (result.kind) {
    case 'auth_failed':
      return t('settings.testAuthFailed');
    case 'forbidden':
      return t('settings.testForbidden');
    case 'not_found_model':
      return t('settings.testNotFoundModel', { model: testedModel });
    case 'invalid_model_id':
      return t('settings.testInvalidModelId', { model: testedModel });
    case 'invalid_base_url':
      return t('settings.testInvalidBaseUrl');
    case 'rate_limited':
      return t('settings.testRateLimited');
    case 'upstream_unavailable': {
      const baseMessage = t('settings.testUpstream', {
        status: result.status ?? 0,
      });
      return result.detail ? `${baseMessage} ${result.detail}` : baseMessage;
    }
    case 'timeout':
      return t('settings.testTimeout', { ms });
    default:
      return t('settings.testUnknown', { detail: result.detail ?? '' });
  }
}

function renderOnboardingAgentTestMessage(
  t: ReturnType<typeof useT>,
  result: ConnectionTestResponse,
  fallbackAgentName: string,
): string {
  const ms = Math.max(0, Math.round(result.latencyMs));
  const sample = result.sample ?? '';
  const agentName = result.agentName ?? fallbackAgentName;
  if (result.ok) {
    const baseMessage = t('settings.testSuccessCli', { agentName, ms, sample });
    return result.detail ? `${baseMessage} ${result.detail}` : baseMessage;
  }
  switch (result.kind) {
    case 'agent_not_installed':
      return t('settings.testAgentMissing', { agentName });
    case 'agent_auth_required':
      return result.detail || 'Agent authentication is required.';
    case 'agent_spawn_failed':
      return t('settings.testAgentSpawn', {
        agentName,
        detail: result.detail ?? '',
      });
    case 'rate_limited':
      return t('settings.testRateLimited');
    case 'timeout':
      return t('settings.testTimeout', { ms });
    default:
      return t('settings.testUnknown', { detail: result.detail ?? '' });
  }
}

function renderOnboardingProviderModelsMessage(
  t: ReturnType<typeof useT>,
  result: ProviderModelsResponse,
): string {
  if (result.ok) {
    return t('settings.fetchModelsSuccess', {
      count: result.models?.length ?? 0,
    });
  }
  switch (result.kind) {
    case 'auth_failed':
      return t('settings.testAuthFailed');
    case 'forbidden':
      return t('settings.testForbidden');
    case 'invalid_base_url':
      return t('settings.testInvalidBaseUrl');
    case 'rate_limited':
      return t('settings.testRateLimited');
    case 'upstream_unavailable': {
      const baseMessage = t('settings.testUpstream', {
        status: result.status ?? 0,
      });
      return result.detail ? `${baseMessage} ${result.detail}` : baseMessage;
    }
    case 'timeout':
      return t('settings.testTimeout', {
        ms: Math.max(0, Math.round(result.latencyMs)),
      });
    case 'no_models':
      return t('settings.fetchModelsEmpty');
    case 'unsupported_protocol':
      return t('settings.fetchModelsUnsupported');
    default:
      return t('settings.fetchModelsFailed', { detail: result.detail ?? '' });
  }
}

function OnboardingPanelHeader({ title, body }: { title: string; body: string }) {
  return (
    <div className="onboarding-view__panel-head">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

type OnboardingDropdownOption = {
  value: string;
  label: string;
  tag?: string;
  tagKind?: ModelCapabilityTag;
  meta?: string;
};

type OnboardingDropdownBaseProps = {
  label: string;
  placeholder: string;
  options: OnboardingDropdownOption[];
  placement?: 'bottom' | 'top';
  searchable?: boolean;
  searchPlaceholder?: string;
  sourceTone?: string;
  allowEmptyValue?: boolean;
};

type OnboardingDropdownProps =
  | (OnboardingDropdownBaseProps & {
      value: string;
      onChange: (value: string) => void;
      multiple?: false;
    })
  | (OnboardingDropdownBaseProps & {
      value: string[];
      onChange: (value: string[]) => void;
      multiple: true;
    });

export function OnboardingDropdown(props: OnboardingDropdownProps) {
  const t = useT();
  const {
    label,
    placeholder,
    value,
    options,
    placement = 'bottom',
    multiple = false,
    searchable = false,
    searchPlaceholder,
    sourceTone,
    allowEmptyValue = false,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [resolvedPlacement, setResolvedPlacement] = useState(placement);
  const [menuMaxHeight, setMenuMaxHeight] = useState(240);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dropdownIdRef = useRef(`onboarding-dropdown-${Math.random().toString(36).slice(2)}`);
  const selectedValues = Array.isArray(value)
    ? value
    : value || allowEmptyValue
      ? [value]
      : [];
  const selectedOptions = options.filter((option) => selectedValues.includes(option.value));
  const selectedOption = selectedOptions[0];
  const hasValue = selectedOptions.length > 0;
  const selectedLabel = multiple
    ? selectedOptions.map((option) => option.label).join(', ')
    : selectedOption?.label;
  const selectedTag = multiple ? undefined : selectedOption?.tag;
  const selectedTagKind = multiple ? undefined : selectedOption?.tagKind;
  const selectedTagDescriptionId = selectedTag
    ? `${dropdownIdRef.current}-selected-tag`
    : undefined;
  const triggerLabel = selectedLabel || placeholder;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions =
    searchable && normalizedQuery
      ? options.filter((option) =>
          `${option.label} ${option.value}`.toLowerCase().includes(normalizedQuery),
        )
      : options;
  const emptyMessage = searchable ? t('homeHero.footer.noMatches') : t('settings.fetchModelsEmpty');

  useLayoutEffect(() => {
    if (!open) return;

    function measureMenu() {
      const root = rootRef.current;
      if (!root) return;

      const rect = root.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;
      const nextPlacement =
        placement === 'top' || (spaceBelow < 260 && spaceAbove > spaceBelow)
          ? 'top'
          : 'bottom';
      const availableSpace = nextPlacement === 'top' ? spaceAbove : spaceBelow;
      setResolvedPlacement(nextPlacement);
      setMenuMaxHeight(Math.max(48, Math.min(240, availableSpace - 16)));
    }

    measureMenu();
    window.addEventListener('resize', measureMenu);
    window.addEventListener('scroll', measureMenu, true);
    return () => {
      window.removeEventListener('resize', measureMenu);
      window.removeEventListener('scroll', measureMenu, true);
    };
  }, [open, placement, options.length]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    function handlePeerOpen(event: Event) {
      if ((event as CustomEvent<string>).detail !== dropdownIdRef.current) {
        setOpen(false);
      }
    }

    window.addEventListener(ONBOARDING_DROPDOWN_OPEN_EVENT, handlePeerOpen);
    return () => {
      window.removeEventListener(ONBOARDING_DROPDOWN_OPEN_EVENT, handlePeerOpen);
    };
  }, []);

  function toggleOpen() {
    setOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        window.dispatchEvent(
          new CustomEvent(ONBOARDING_DROPDOWN_OPEN_EVENT, {
            detail: dropdownIdRef.current,
          }),
        );
      }
      return nextOpen;
    });
  }

  return (
    <div
      className="onboarding-view__select-field"
      data-placement={resolvedPlacement}
      data-open={open || undefined}
      ref={rootRef}
    >
      <span
        className="onboarding-view__select-label"
        data-source-tone={sourceTone || undefined}
      >
        {label}
      </span>
      <button
        type="button"
        className={`onboarding-view__select-trigger${open ? ' is-open' : ''}${
          hasValue ? ' has-value' : ''
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerLabel}
        aria-describedby={selectedTagDescriptionId}
        title={triggerLabel}
        onClick={toggleOpen}
      >
        <span className="onboarding-view__select-trigger-value">
          <span>{triggerLabel}</span>
          {selectedTag ? (
            <span
              className="onboarding-view__select-badge"
              data-tag={selectedTagKind}
              id={selectedTagDescriptionId}
            >
              {selectedTag}
            </span>
          ) : null}
        </span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div
          className="onboarding-view__select-menu"
          data-searchable={searchable || undefined}
          style={{ '--onboarding-select-menu-max-height': `${menuMaxHeight}px` } as CSSProperties}
        >
          {searchable ? (
            <label
              className="onboarding-view__select-search"
              onClick={(event) => event.stopPropagation()}
            >
              <Icon name="search" size={14} />
              <input
                type="search"
                value={query}
                placeholder={searchPlaceholder || placeholder}
                aria-label={searchPlaceholder || label}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') {
                    event.stopPropagation();
                  }
                }}
              />
            </label>
          ) : null}
          <div
            className="onboarding-view__select-options"
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple || undefined}
          >
            {visibleOptions.map((option, index) => {
              const selected = selectedValues.includes(option.value);
              const optionId = `${dropdownIdRef.current}-option-${index}`;
              const optionLabelId = `${optionId}-label`;
              const optionMetaId = option.meta ? `${optionId}-meta` : undefined;
              const optionTagId = option.tag ? `${optionId}-tag` : undefined;
              const optionDescriptionIds = [optionMetaId, optionTagId]
                .filter(Boolean)
                .join(' ') || undefined;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`onboarding-view__select-option${selected ? ' is-selected' : ''}`}
                  role="option"
                  aria-selected={selected}
                  aria-labelledby={optionLabelId}
                  aria-describedby={optionDescriptionIds}
                  onClick={() => {
                    if (props.multiple) {
                      props.onChange(
                        selected
                          ? selectedValues.filter((selectedValue) => selectedValue !== option.value)
                          : [...selectedValues, option.value],
                      );
                      return;
                    }
                    props.onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="onboarding-view__select-option-content">
                    <span className="onboarding-view__select-option-copy">
                      <span id={optionLabelId}>{option.label}</span>
                      {option.meta ? (
                        <span
                          className="onboarding-view__select-option-meta"
                          id={optionMetaId}
                        >
                          {option.meta}
                        </span>
                      ) : null}
                    </span>
                    {option.tag ? (
                      <span
                        className="onboarding-view__select-badge"
                        data-tag={option.tagKind}
                        id={optionTagId}
                      >
                        {option.tag}
                      </span>
                    ) : null}
                  </span>
                  {selected ? <Icon name="check" size={15} /> : null}
                </button>
              );
            })}
            {visibleOptions.length === 0 ? (
              <div className="onboarding-view__select-empty">{emptyMessage}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
