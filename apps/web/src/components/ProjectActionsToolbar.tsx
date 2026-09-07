// Project-level action bar mounted between the AppChromeHeader and
// the chat-and-workspace split (#451). Hosts the new project-scoped
// actions ("Finalize design package", "Continue in CLI"); per-file
// actions (Export PDF/PPTX/ZIP, Deploy) stay in the FileViewer share
// menu where they already live.
//
// The bar is intentionally thin: presentation, layout, and a couple
// of conditional flags. Behavior lives in ProjectView (handlers,
// hooks) and the per-button components.

import { ContinueInCliButton } from './ContinueInCliButton';
import { FinalizeDesignButton } from './FinalizeDesignButton';
import type { DesignMdState } from '../hooks/useDesignMdState';
import type { FinalizeStatus } from '../hooks/useFinalizeProject';
import type { ReactNode } from 'react';

export interface ProjectActionsToolbarProps {
  designMdState?: Pick<DesignMdState, 'exists' | 'isStale' | 'staleReason'>;
  finalizeStatus?: FinalizeStatus;
  onFinalize?: () => void;
  onCancelFinalize?: () => void;
  onContinueInCli?: () => void | Promise<void>;
  gitStatus?: ReactNode;
  hidden?: boolean;
}

export function ProjectActionsToolbar({
  designMdState,
  finalizeStatus,
  onFinalize,
  onCancelFinalize,
  onContinueInCli,
  gitStatus,
  hidden,
}: ProjectActionsToolbarProps) {
  if (hidden) return null;
  return (
    <div
      className="project-actions-toolbar"
      role="toolbar"
      aria-label="Project actions"
    >
      {gitStatus}
      {designMdState && finalizeStatus && onFinalize && onCancelFinalize ? <FinalizeDesignButton
        designMdState={designMdState}
        status={finalizeStatus}
        onFinalize={onFinalize}
        onCancel={onCancelFinalize}
      /> : null}
      {designMdState && onContinueInCli ? <ContinueInCliButton designMdState={designMdState} onClick={onContinueInCli} /> : null}
    </div>
  );
}
