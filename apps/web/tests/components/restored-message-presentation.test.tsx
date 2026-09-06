// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@open-design/contracts';
import { RestoredHistoricalMessage } from '../../src/components/AssistantMessage';
import { buildChatRenderItems } from '../../src/components/ChatPane';

const historicalMarkup = '<question-form id="historic">old question</question-form>';
const message: ChatMessage = {
  id: 'message-1',
  role: 'assistant',
  content: historicalMarkup,
  restoredPresentation: {
    portableId: 'portable-1',
    turnId: 'turn-1',
    terminal: 'succeeded',
    displayEvents: [
      { kind: 'thinking', text: 'Old reasoning' },
      { kind: 'result', text: 'Old result', resources: [{ name: 'result.png', url: '/raw/result.png' }] },
    ],
    contextItems: [{ kind: 'skill', label: 'Historic skill', unavailable: true }],
    attachments: [{ kind: 'image', name: 'reference.png', url: '/raw/reference.png' }],
    commentSelections: [{
      order: 0, label: 'Hero title', comment: 'Make it stronger', currentText: 'Old title',
      screenshotUrl: '/raw/comment.png',
      imageAttachments: [{ name: 'comment-ref.png', url: '/raw/comment-ref.png' }],
    }],
    feedback: { rating: 'negative', customReason: 'Historic feedback', createdAt: 2 },
  },
};

describe('restored historical message presentation', () => {
  it('shows historical markup and adjuncts without restoring any live controls', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<RestoredHistoricalMessage message={message} />);

    expect(screen.getByText(historicalMarkup)).toBeTruthy();
    expect(screen.getByText('Old reasoning')).toBeTruthy();
    expect(screen.getByText(/Historic skill/)).toBeTruthy();
    expect(screen.getByText('reference.png')).toBeTruthy();
    expect(screen.getByText('Make it stronger')).toBeTruthy();
    expect(screen.getByText('Historic feedback')).toBeTruthy();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('does not hide restored form-answer source text', () => {
    const restoredAnswer = { ...message, id: 'answer', role: 'user' as const, content: '[form answers id=old] Exact historical answer' };
    expect(buildChatRenderItems([restoredAnswer]).map(item => item.message.content))
      .toEqual(['[form answers id=old] Exact historical answer']);
  });
});
