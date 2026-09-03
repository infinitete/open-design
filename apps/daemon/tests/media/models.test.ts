import { describe, expect, it } from 'vitest';

import {
  AUDIO_MODELS_BY_KIND,
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  VIDEO_MODELS,
} from '../../src/media/models.js';

const ALL_MODEL_LISTS: ReadonlyArray<readonly { id: string; provider: string }[]> = [
  IMAGE_MODELS,
  VIDEO_MODELS,
  AUDIO_MODELS_BY_KIND.music,
  AUDIO_MODELS_BY_KIND.speech,
  AUDIO_MODELS_BY_KIND.sfx,
];

describe('media model catalogue', () => {
  it('ships no retired managed-cloud provider or model entries', () => {
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'vela')).toBe(false);
    for (const models of ALL_MODEL_LISTS) {
      expect(models.some((model) => model.id.startsWith('vela/'))).toBe(false);
      expect(models.some((model) => model.provider === 'vela')).toBe(false);
    }
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'codex')).toBe(false);
    expect(IMAGE_MODELS.some((model) => model.provider === 'codex')).toBe(false);
  });

  it('keeps representative non-managed image, video, and audio models registered', () => {
    const imageIds = IMAGE_MODELS.map((model) => model.id);
    expect(imageIds).toContain('gpt-image-2');
    expect(imageIds).toContain('flux-pro-ultra');
    expect(imageIds).toContain('openrouter/black-forest-labs/flux-1.1-pro');

    const videoIds = VIDEO_MODELS.map((model) => model.id);
    expect(videoIds).toContain('doubao-seedance-2-0-260128');
    expect(videoIds).toContain('veo-3-fal');
    expect(videoIds).toContain('hyperframes-html');

    expect(AUDIO_MODELS_BY_KIND.music.map((model) => model.id)).toContain('suno-v5');
    expect(AUDIO_MODELS_BY_KIND.speech.map((model) => model.id)).toContain('elevenlabs-v3');
    expect(AUDIO_MODELS_BY_KIND.sfx.map((model) => model.id)).toContain('elevenlabs-sfx');

    // Every catalogue model still resolves to a registered provider entry.
    for (const models of ALL_MODEL_LISTS) {
      for (const model of models) {
        expect(
          MEDIA_PROVIDERS.some((provider) => provider.id === model.provider),
          `provider ${model.provider} for ${model.id}`,
        ).toBe(true);
      }
    }
  });
});
