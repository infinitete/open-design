import type { ProjectGitDependency } from '@open-design/contracts';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n';

export function useGitDialog(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button, input, select, [tabindex="0"]') ?? [])
      .filter(element => !element.hasAttribute('disabled'));
    if (!elements?.length) return;
    const first = elements[0]; const last = elements[elements.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return { ref, onKeyDown };
}

export function ProjectGitDependencies({ dependencies }: { dependencies: ProjectGitDependency[] }) {
  const { t } = useI18n();
  return <>
    {dependencies.some(dependency => dependency.kind === 'identity' || dependency.kind === 'git') ? <p>{t('projectGit.editableNotice')}</p> : null}
    {([true, false] as const).map(required => {
      const group = dependencies.filter(dependency => dependency.requiredForContent === required);
      return group.length ? <div key={String(required)}><h3>{t(required ? 'projectGit.contentDependencies' : 'projectGit.runtimeDependencies')}</h3><ul>{group.map((dependency, index) => <li key={`${dependency.kind}-${index}`}>{dependency.label}</li>)}</ul></div> : null;
    })}
  </>;
}
