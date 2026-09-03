export interface WorkspaceCollabContext {
  workspaceId: string;
  workspaceType: 'team' | 'personal';
  workspaceMemberId: string;
  role: string;
  memberStatus?: string;
  lifecycleState?: string;
  billingState?: string;
  planId?: string;
  providerMode?: string;
  workspaceName?: string;
  teamName?: string;
  seatSummary?: {
    seatLimit: number;
    usedSeats: number;
    availableSeats: number;
    isSeatFull: boolean;
  };
  permissions?: {
    canManageMembers: boolean;
    canManageBilling: boolean;
    canInviteMembers: boolean;
    canManageAutoRecharge: boolean;
    canShareProjects: boolean;
    canWriteSyncedFiles: boolean;
    canViewWorkspaceSettings: boolean;
    canManageSharedResources: boolean;
  };
}

export function workspaceContextFixture(
  overrides: Partial<WorkspaceCollabContext> &
    Pick<WorkspaceCollabContext, 'workspaceId' | 'workspaceMemberId'>,
): WorkspaceCollabContext {
  return {
    workspaceType: 'team',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_pro',
    providerMode: 'platform_credits',
    seatSummary: {
      seatLimit: 5,
      usedSeats: 2,
      availableSeats: 3,
      isSeatFull: false,
    },
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canInviteMembers: false,
      canManageAutoRecharge: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: false,
    },
    ...overrides,
  };
}

export function workspaceDirectoryItemFixture(
  context: Pick<
    WorkspaceCollabContext,
    | 'workspaceId'
    | 'workspaceType'
    | 'workspaceMemberId'
    | 'role'
    | 'memberStatus'
    | 'lifecycleState'
  > & Partial<Pick<WorkspaceCollabContext, 'workspaceName' | 'teamName'>>,
) {
  return {
    workspaceId: context.workspaceId,
    workspaceName:
      context.workspaceName?.trim()
      || context.teamName?.trim()
      || context.workspaceId,
    workspaceType: context.workspaceType,
    workspaceMemberId: context.workspaceMemberId,
    role: context.role,
    memberStatus: context.memberStatus,
    lifecycleState: context.lifecycleState,
  };
}

export function workspaceDirectoryFixture(
  contexts: Array<Parameters<typeof workspaceDirectoryItemFixture>[0]>,
) {
  return {
    items: contexts.map(workspaceDirectoryItemFixture),
    activeWorkspaceId: null,
  };
}

export function buildWorkspacePermissions(_ctx: WorkspaceCollabContext) {
  return {
    canManageMembers: false,
    canManageBilling: false,
    canInviteMembers: false,
    canManageAutoRecharge: false,
    canShareProjects: true,
    canWriteSyncedFiles: true,
    canViewWorkspaceSettings: true,
    canManageSharedResources: false,
  };
}

export function buildWorkspaceSeatSummary(_ctx: WorkspaceCollabContext) {
  return {
    seatLimit: 5,
    usedSeats: 2,
    availableSeats: 3,
    isSeatFull: false,
  };
}
