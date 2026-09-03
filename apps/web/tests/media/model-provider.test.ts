import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  mediaModelProviderId,
} from '../../src/media/models';

// mediaModelProviderId is the decision core of ProjectView's BYOK seed guard
// (byokModelSeedForProtocol): the project's creation-time model is only carried
// into the conversation when its provider matches the active protocol. These
// cases mirror that gate's outcomes against the real registry.
describe('mediaModelProviderId', () => {
  it('resolves AIHubMix live-catalogue ids by prefix without the static registry', () => {
    // The live catalogue (50+ ids) is not seeded into IMAGE_MODELS, so the
    // `aihubmix-` namespace must resolve synchronously — this is what lets the
    // AIHubMix seed survive before the async catalogue fetch resolves.
    expect(mediaModelProviderId('aihubmix-qwen-image-2-pro')).toBe('aihubmix');
    expect(mediaModelProviderId('aihubmix-doubao-seedance-2-0-260128')).toBe('aihubmix');
  });

  it('resolves seeded AIHubMix ids to aihubmix', () => {
    expect(mediaModelProviderId('aihubmix-gpt-image-1')).toBe('aihubmix');
  });

  it('resolves static models to their registry provider', () => {
    expect(mediaModelProviderId('gpt-image-2')).toBe('openai');
    expect(mediaModelProviderId('senseaudio-image-2.0-260319')).toBe('senseaudio');
    expect(mediaModelProviderId('senseaudio-tts')).toBe('senseaudio');
  });

  it('returns undefined for unknown ids', () => {
    expect(mediaModelProviderId('totally-made-up-model')).toBeUndefined();
    expect(mediaModelProviderId('')).toBeUndefined();
  });

  // The guard itself is `mediaModelProviderId(picked) === protocol`. Spell out
  // the seed-guard scenarios from the design discussion so the decision is
  // pinned.
  it('drives the seed guard: carry only when provider matches the active protocol', () => {
    const carries = (modelId: string, protocol: string) =>
      mediaModelProviderId(modelId) === protocol;

    // AIHubMix run + AIHubMix pick → carried.
    expect(carries('aihubmix-qwen-image-2-pro', 'aihubmix')).toBe(true);
    // SenseAudio run + SenseAudio pick → carried.
    expect(carries('senseaudio-image-2.0-260319', 'senseaudio')).toBe(true);
  });
});

describe('media registry has no hosted cloud models', () => {
  it('keeps every image model free of the retired hosted provider namespace', () => {
    expect(IMAGE_MODELS.some((model) => model.id.startsWith('vela/'))).toBe(false);
    expect(IMAGE_MODELS.some((model) => String(model.provider) === 'vela')).toBe(false);
  });

  it('keeps every video model free of the retired hosted provider namespace', () => {
    expect(VIDEO_MODELS.some((model) => model.id.startsWith('vela/'))).toBe(false);
    expect(VIDEO_MODELS.some((model) => String(model.provider) === 'vela')).toBe(false);
  });

  it('keeps representative BYOK media options selectable', () => {
    // BYOK providers and their seeded models must remain available now that
    // the hosted cloud models are gone.
    expect(mediaModelProviderId('gpt-image-2')).toBe('openai');
    expect(mediaModelProviderId('aihubmix-gpt-image-1')).toBe('aihubmix');
    expect(mediaModelProviderId('senseaudio-image-2.0-260319')).toBe('senseaudio');
    expect(
      VIDEO_MODELS.some((model) => model.provider === 'volcengine'),
    ).toBe(true);
  });
});
