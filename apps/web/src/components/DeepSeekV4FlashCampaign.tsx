import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog } from '@open-design/components';
import {
  DEEPSEEK_V4_FLASH_CAMPAIGN as campaign,
  formatDeepSeekV4FlashCampaignCountdown,
  type DeepSeekV4FlashCampaignAudience,
} from '../campaigns/deepseek-v4-flash';
import { goPlanPricingUrl } from '../campaigns/go-plan';
import { useAnalytics } from '../analytics/provider';
import {
  trackDeepSeekCampaignModalClick,
  trackDeepSeekCampaignModalSurfaceView,
} from '../analytics/events';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { modelProviderIconSrc } from './modelProviderIcon';
import styles from './DeepSeekV4FlashCampaign.module.css';

interface Props {
  /**
   * paid = an active personal/team subscription; unpaid = no active
   * subscription (including users who previously recharged their wallet).
   */
  audience: DeepSeekV4FlashCampaignAudience;
  /**
   * Whether the home view is the ACTIVE entry view. EntryShell keeps HomeView
   * permanently mounted behind `display:none` while this dialog portals to
   * `document.body`, so without this gate the campaign would escape the home
   * view and interrupt projects/tasks/plugins/... routes. The requirement is
   * explicit: the modal shows on #/home only.
   */
  active?: boolean;
}

function CampaignProviderMark({
  providerId,
  label,
  fallback,
  src: preferredSrc,
  className = styles.modelMark,
  fallbackClassName = styles.modelMarkFallback,
  decorative = false,
}: {
  providerId: string;
  label: string;
  fallback: string;
  src?: string;
  className?: string;
  fallbackClassName?: string;
  decorative?: boolean;
}) {
  const src = preferredSrc ?? modelProviderIconSrc(providerId);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showLogo = src !== null && failedSrc !== src;

  return (
    <span
      className={className}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      title={decorative ? undefined : label}
    >
      {showLogo ? (
        <img
          src={src}
          alt=""
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span className={fallbackClassName} aria-hidden="true">
          {fallback}
        </span>
      )}
    </span>
  );
}

function hasSeenCampaign(campaignId: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(`open-design:campaign-seen:${campaignId}`) === '1';
  } catch {
    // Fail closed: when the store is unreadable (private mode, disabled
    // localStorage) `markCampaignSeen` cannot persist either, so answering
    // "unseen" would re-open the modal on every mount. The campaign promise
    // is one appearance per window — suppress instead of spamming.
    return true;
  }
}

function markCampaignSeen(campaignId: string): void {
  try {
    window.localStorage.setItem(`open-design:campaign-seen:${campaignId}`, '1');
  } catch {
    // Campaign frequency control is advisory; storage failures must not block Home.
  }
}

export function DeepSeekV4FlashCampaign({
  audience,
  active = true,
}: Props) {
  const { locale, t } = useI18n();
  const analytics = useAnalytics();
  const [modalOpen, setModalOpen] = useState(false);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const dialogId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const paid = audience === 'paid';
  const activeCampaignId = campaign.id;

  useEffect(() => {
    if (!active) {
      // Leaving home is NOT a dismissal: close without marking the campaign
      // seen, so the next return to home within the window re-opens it.
      // (Also releases the body scroll lock the open effect installed.)
      setModalOpen(false);
      return;
    }
    if (audience === 'unknown') {
      // A higher-priority Home announcement temporarily owns the modal slot.
      // Close without spending this campaign so it can resume afterwards.
      setModalOpen(false);
      return;
    }
    if (!hasSeenCampaign(activeCampaignId)) setModalOpen(true);
  }, [active, activeCampaignId, audience]);

  useEffect(() => {
    if (!modalOpen) return;
    trackDeepSeekCampaignModalSurfaceView(analytics.track, {
      page_name: 'home',
      area: 'deepseek_campaign_modal',
      element: 'modal',
      campaign_id: 'deepseek_v4_pro',
      user_state: paid ? 'paid' : 'unpaid',
    });
    const panel = document.getElementById(dialogId);
    if (!panel) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [analytics.track, audience, dialogId, modalOpen, paid]);

  useEffect(() => {
    if (!modalOpen) return;
    // The countdown always runs against the real `window.endAtExclusive`
    // boundary (via formatDeepSeekV4FlashCampaignCountdown) — there is no
    // synthetic per-open countdown.
    setCountdownNow(Date.now());
    const countdownTimer = window.setInterval(() => setCountdownNow(Date.now()), 1_000);
    return () => window.clearInterval(countdownTimer);
  }, [modalOpen]);

  const dismissModal = () => {
    markCampaignSeen(activeCampaignId);
    setModalOpen(false);
  };

  const presentation = paid
    ? {
        eyebrow: t('campaign.deepseekV4Flash.paid.eyebrow'),
        status: t('campaign.deepseekV4Flash.paid.status'),
        cta: t('campaign.deepseekV4Flash.paid.cta'),
      }
    : {
        eyebrow: t('campaign.deepseekV4Flash.unpaid.eyebrow'),
        status: t('campaign.deepseekV4Flash.unpaid.status'),
        cta: t('campaign.deepseekV4Flash.unpaid.cta'),
      };
  const trackModalClick = (element: 'close' | 'later' | 'use_now' | 'upgrade') => {
    trackDeepSeekCampaignModalClick(analytics.track, {
      page_name: 'home',
      area: 'deepseek_campaign_modal',
      element,
      campaign_id: 'deepseek_v4_pro',
      user_state: paid ? 'paid' : 'unpaid',
    });
  };
  const closeModal = () => {
    trackModalClick('close');
    dismissModal();
  };
  const postponeModal = () => {
    trackModalClick('later');
    dismissModal();
  };
  const takeAction = () => {
    trackModalClick(paid ? 'use_now' : 'upgrade');
    dismissModal();
    if (paid) {
      // The campaign's hosted runtime is retired, so the paid CTA no longer
      // selects an agent; it only confirms and dismisses.
      return;
    }
    window.open(
      goPlanPricingUrl(locale),
      '_blank',
      'noopener,noreferrer',
    );
  };

  if (!active || !modalOpen || audience === 'unknown' || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <Dialog
      id={dialogId}
      ariaLabelledBy={titleId}
      ariaDescribedBy={descriptionId}
      onClose={closeModal}
      closeOnEscape
      className={styles.panel}
      backdropClassName={styles.backdrop}
      data-testid="deepseek-v4-flash-campaign-dialog"
    >
      <Button
        variant="ghost"
        size="icon"
        className={styles.close}
        aria-label={t('campaign.deepseekV4Flash.closeAria')}
        onClick={closeModal}
      >
        <Icon name="close" size={17} strokeWidth={1.8} />
      </Button>

      <p className={styles.eyebrow}>{presentation.eyebrow}</p>
      <h2 id={titleId} className={styles.title}>{t('campaign.deepseekV4Flash.headline')}</h2>
      <p id={descriptionId} className={styles.lead}>{t('campaign.deepseekV4Flash.description')}</p>

      <div className={styles.modelCard}>
        <CampaignProviderMark
          providerId={campaign.modelId}
          label="DeepSeek"
          fallback="DS"
        />
        <span className={styles.modelCopy}>
          <strong>{t('campaign.deepseekV4Flash.benefit')}</strong>
          <small>{presentation.status}</small>
        </span>
        <span className={paid ? styles.available : styles.locked}>
          {paid
            ? t('campaign.deepseekV4Flash.unlocked')
            : t('campaign.deepseekV4Flash.locked')}
        </span>
      </div>

      <div className={styles.countdown} aria-label={t('campaign.deepseekV4Flash.countdownLabel')}>
        <span className={styles.countdownLabel}>{t('campaign.deepseekV4Flash.countdownLabel')}</span>
        <strong data-testid="deepseek-v4-flash-campaign-countdown">
          {formatDeepSeekV4FlashCampaignCountdown(countdownNow, t)}
        </strong>
        <small>
          {t('campaign.deepseekV4Flash.windowLabel')}
          {' · '}
          {t('campaign.deepseekV4Flash.weekFreeSuffix')}
        </small>
      </div>
      <p className={styles.boundary}>{t('campaign.deepseekV4Flash.boundary')}</p>
      <div className={styles.actions}>
        {paid ? (
          <Button variant="ghost" className={styles.laterAction} onClick={postponeModal}>
            {t('campaign.deepseekV4Flash.later')}
          </Button>
        ) : null}
        <Button className={styles.primaryAction} onClick={takeAction}>
          {presentation.cta}
        </Button>
      </div>
    </Dialog>,
    document.body,
  );
}
