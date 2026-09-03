/**
 * @module analytics/events/workspace
 * Incremental analytics contract for entry navigation, project collections,
 * account menu links and comment creation outcomes.
 *
 * Project titles, prompt/comment content and raw URLs/errors are deliberately
 * absent.
 */

export type TrackingWorkspacePage =
  | 'home'
  | 'community'
  | 'drafts'
  | 'all_projects'
  | 'design_systems'
  | 'plugins'
  | 'project';

export interface EntryNavigationClickProps {
  page_name: TrackingWorkspacePage;
  area: 'entry_nav';
  element:
    | 'nav_item'
    | 'search'
    | 'account_menu_trigger';
  target?: TrackingWorkspacePage | 'search' | 'account_menu';
  entry_from?: 'sidebar';
}

export interface AccountMenuClickProps {
  page_name: TrackingWorkspacePage;
  area: 'account_menu';
  element:
    | 'settings'
    | 'message_center'
    | 'github_help'
    | 'feature_request'
    | 'github'
    | 'discord'
    | 'twitter'
    | 'email';
}

export type TrackingProjectCollectionPage = 'home' | 'drafts' | 'all_projects';
export type TrackingCountBucket = '0' | '1' | '2_5' | '6_10' | '11_plus';
export type TrackingProjectRelation = 'self' | 'other' | 'unknown';

export interface ProjectCollectionClickProps {
  page_name: TrackingProjectCollectionPage;
  area: 'project_collection';
  element: 'tab' | 'search' | 'sort' | 'filter' | 'card_menu';
  target?: TrackingProjectCollectionPage;
  project_count_bucket?: TrackingCountBucket;
  project_relation?: TrackingProjectRelation;
}

export interface CommunityTemplateClickProps {
  page_name: TrackingWorkspacePage;
  area: 'community_templates';
  element: 'template_card' | 'use_template';
  template_kind?: string;
}

export interface ExtensionMarketplaceClickProps {
  page_name: TrackingWorkspacePage;
  area: 'extension_marketplace';
  element: 'extension_card' | 'install' | 'uninstall';
  extension_kind?: string;
}

export interface ProjectCommentCreateResultProps {
  outcome: 'created' | 'failed' | 'rejected';
  failure_reason?: string;
}
