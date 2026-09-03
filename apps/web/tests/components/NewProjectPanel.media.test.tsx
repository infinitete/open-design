// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectPanel } from '../../src/components/NewProjectPanel';

describe('NewProjectPanel media provider badges', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('treats daemon-restored apiKeyConfigured providers as configured', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    // Model picker is now a combobox — open the popover so the
    // provider group + status badge become visible in the DOM.
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    const openaiGroup = screen.getByText('OpenAI').closest('.ds-picker-group');
    expect(openaiGroup?.textContent).toContain('Configured');
    expect(openaiGroup?.textContent).not.toContain('Integrated');
  });

  it('hides provider models until the provider has usable credentials', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.queryByTestId('model-picker-option-gpt-image-2')).toBeNull();
  });

  it('offers no hosted default image model without media API credentials', async () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    await waitFor(() => {
      // The retired hosted cloud models must not resurface as a credentials-free
      // default: without a configured provider the picker shows no image models.
      expect(screen.queryByTestId('model-picker-option-gpt-image-2')).toBeNull();
    });
    expect(screen.getByTestId('model-picker-trigger').textContent).not.toContain('(Cloud)');
  });

  it('does not treat OpenAI OAuth-only markers as usable image credentials', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '',
            source: 'oauth-codex',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.queryByTestId('model-picker-option-gpt-image-2')).toBeNull();
  });

  it('falls back to the configured provider first image model', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{
          volcengine: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '5678',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Configured provider image' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          imageModel: 'doubao-seedream-3-0-t2i-250415',
        }),
      }),
    );
  });
});
