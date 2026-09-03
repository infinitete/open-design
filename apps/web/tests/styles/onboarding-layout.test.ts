import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entryLayoutCss = readFileSync(
  new URL('../../src/styles/home/entry-layout.css', import.meta.url),
  'utf8',
);

// Comments are stripped first so a doc comment above a rule cannot glue
// itself onto the selector and hide the block from the matcher.
const entryLayoutRules = entryLayoutCss.replace(/\/\*[\s\S]*?\*\//g, '');

function cssDeclarations(selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(entryLayoutRules)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

describe('onboarding layout styles', () => {
  // Acceptance #138 — the About-you step's Back link must hug the content
  // column's left edge, above the panel title. The onboarding panel is a grid
  // whose items stretch, and the global button primitive centers button
  // content, so without an explicit inline-axis `start` the stretched link
  // floats its label mid-column.
  it('pins the onboarding back link to the content column start', () => {
    const backBlock = cssDeclarations('.onboarding-view__back-to-cloud');

    expect(backBlock).toMatch(/(?:^|[;\n])\s*justify-self:\s*start\s*;/);
    expect(backBlock).toMatch(/(?:^|[;\n])\s*align-self:\s*start\s*;/);
  });
});
