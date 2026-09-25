import { useId, useMemo, useState } from 'react';
import type { GlossaryTerm } from '@/core/types/api';
import { useGlossary } from '@/data/queries';
import { glossaryMatcher } from '@/lib/glossary';
import s from './domain.module.css';

/** Splits text into plain parts and glossary terms; the matcher is built once per glossary. */
export function useGlossarySplit() {
  const { data: terms } = useGlossary();
  return useMemo(() => glossaryMatcher<GlossaryTerm>(terms ?? []), [terms]);
}

/**
 * Plain text with glossary terms underlined. Hover or keyboard focus shows the
 * definition. Text is rendered as text, never HTML.
 */
export function GlossaryText({ text, className }: { text: string; className?: string }) {
  const split = useGlossarySplit();
  const parts = useMemo(() => split(text), [split, text]);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        typeof p === 'string' ? p : <Term key={i} text={p.text} term={p.term} />,
      )}
    </span>
  );
}

function Term({ text, term }: { text: string; term: GlossaryTerm }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <span
      className={s.gloss}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && show) {
          e.stopPropagation();
          setShow(false);
        }
      }}
    >
      {text}
      <span id={id} role="tooltip" className={show ? s.glossTip : 'sr-only'}>
        <strong>{term.term}</strong>: {term.definition}
      </span>
    </span>
  );
}
