import { useCallback } from 'react';
import type { DeepSeekV4FlashCampaignAudience } from '../campaigns/deepseek-v4-flash';
import { goPlanPricingUrl } from '../campaigns/go-plan';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

/**
 * The campaign badge is a signed-in-only surface.
 *
 * It sits inside the top-right account cluster and its click hands off to
 * Pricing. None of that means anything to a client that is not signed in,
 * so a signed-out (or not-yet-resolved) login state renders nothing and
 * burns no campaign impression. `loggedIn` is deliberately REQUIRED: the
 * badge is mounted from the entry rail and from the project-detail cluster,
 * which between them cover nearly every page, and a future third mount point
 * must fail typecheck rather than quietly greet signed-out users.
 *
 * This gate is about the badge alone. The in-app campaign dialog keeps its own
 * audience rules and still greets signed-out users.
 */
export function WorkbenchCampaignBadge({
  audience,
  page,
  loggedIn,
}: {
  audience: Exclude<DeepSeekV4FlashCampaignAudience, 'unknown'>;
  page: 'home' | 'project';
  loggedIn: boolean | null | undefined;
}) {
  const { locale, t } = useI18n();


  const openCampaignPricing = useCallback(() => {
    const pricingUrl = goPlanPricingUrl(locale);
    window.open(
      pricingUrl,
      '_blank',
      'noopener,noreferrer',
    );
  }, [audience, locale, page]);

  if (loggedIn !== true) return null;

  return (
    <button
      type="button"
      className="entry-deepseek-campaign-badge"
      onClick={openCampaignPricing}
      aria-label={t('campaign.deepseekV4Flash.workbenchBadgeAria')}
      data-testid="deepseek-campaign-pricing-badge"
    >
      <span>{t('campaign.deepseekV4Flash.workbenchBadge')}</span>
      <Icon name="arrow-right" size={13} />
    </button>
  );
}
