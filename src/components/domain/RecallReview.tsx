import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Eye } from 'lucide-react';
import type { Concept, ReviewItem, ReviewResult } from '@/core/types/api';
import { Button, Modal, ProgressBar, TextArea, uiStyles } from '@/components/ui';
import { useConcepts, useReviewRecord } from '@/data/queries';
import { ConceptEditModal } from './ConceptEditModal';
import { GlossaryText } from './GlossaryText';
import s from './domain.module.css';

const RATINGS: {
  key: '1' | '2' | '3';
  result: ReviewResult;
  label: 'forgot' | 'fuzzy' | 'gotIt';
}[] = [
  { key: '1', result: 'hard', label: 'forgot' },
  { key: '2', result: 'ok', label: 'fuzzy' },
  { key: '3', result: 'easy', label: 'gotIt' },
];

/**
 * Active recall: show only the concept's name, let the learner remember it
 * first, then reveal their own note and example and rate how it went. The
 * rating feeds the spaced-review schedule (Forgot → back a step, Fuzzy → one
 * step on, Got it → two steps on).
 */
export function RecallReview({ items, onClose }: { items: ReviewItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: concepts = [] } = useConcepts(null, null);
  const record = useReviewRecord();
  // Freeze the queue so recording (which refetches "due") doesn't reshuffle it.
  const [queue] = useState(items);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [scratch, setScratch] = useState('');
  const [editing, setEditing] = useState<Concept | null>(null);
  const revealRef = useRef<HTMLButtonElement>(null);

  const item = queue[index];
  const concept = useMemo(() => concepts.find((c) => c.id === item?.concept_id), [concepts, item]);
  const finished = index >= queue.length;

  const rate = (result: ReviewResult) => {
    if (!item || record.isPending) return;
    record.mutate(
      { concept_id: item.concept_id, result },
      {
        onSuccess: () => {
          setIndex((i) => i + 1);
          setRevealed(false);
          setScratch('');
        },
      },
    );
  };

  // Each new card starts on "Show my note", so Space reveals it.
  useEffect(() => {
    if (index > 0 && !revealed) revealRef.current?.focus();
  }, [index, revealed]);

  useEffect(() => {
    if (finished || editing) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'TEXTAREA' || tag === 'INPUT' || (e.key === ' ' && tag === 'BUTTON');
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!revealed && e.key === ' ') {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed) {
        const r = RATINGS.find((x) => x.key === e.key);
        if (r) {
          e.preventDefault();
          rate(r.result);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (queue.length === 0) {
    return (
      <Modal
        open
        onClose={onClose}
        title={t('recall.title')}
        footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      >
        <p>{t('recall.nothingDue')}</p>
      </Modal>
    );
  }

  if (finished) {
    return (
      <Modal
        open
        onClose={onClose}
        title={t('recall.doneTitle')}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        }
      >
        <div className={s.recallDone}>
          <CheckCircle2 size={36} aria-hidden="true" color="var(--progress)" />
          <p>{t('recall.doneBody', { count: queue.length })}</p>
        </div>
      </Modal>
    );
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        wide
        title={t('recall.title')}
        footer={
          revealed ? (
            <div className={s.recallRate} role="group" aria-label={t('recall.howWasIt')}>
              <span className="muted">{t('recall.howWasIt')}</span>
              <span className="spacer" />
              {RATINGS.map((r) => (
                <Button
                  key={r.key}
                  variant={
                    r.result === 'easy' ? 'primary' : r.result === 'hard' ? 'feeling' : 'secondary'
                  }
                  onClick={() => rate(r.result)}
                  disabled={record.isPending}
                >
                  {t(`recall.${r.label}`)} <kbd className="mono">{r.key}</kbd>
                </Button>
              ))}
            </div>
          ) : (
            <>
              <span className="muted" style={{ marginRight: 'auto', fontSize: '0.85rem' }}>
                {t('recall.keys')}
              </span>
              <Button
                ref={revealRef}
                variant="primary"
                icon={<Eye size={16} />}
                onClick={() => setRevealed(true)}
                data-autofocus
              >
                {t('recall.reveal')} <kbd className="mono">Space</kbd>
              </Button>
            </>
          )
        }
      >
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {t('recall.progress', { n: index + 1, total: queue.length })}
          </span>
          <ProgressBar
            value={index}
            max={queue.length}
            label={t('recall.progress', { n: index + 1, total: queue.length })}
          />
        </div>
        <div className={s.recallCard}>
          <span className="muted">{concept?.category_name ?? ''}</span>
          <h3 className={s.recallName}>{item.concept_name}</h3>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {t('recall.learnedAgo', { count: item.days_since_learned })}
          </span>
        </div>
        {!revealed ? (
          <TextArea
            label={t('recall.prompt')}
            placeholder={t('recall.scratch')}
            value={scratch}
            rows={4}
            onChange={(e) => setScratch(e.target.value)}
          />
        ) : (
          <div className="stack" aria-live="polite">
            {scratch.trim() && <p className={s.recallScratch}>{scratch}</p>}
            <h4 className={s.recallLabel}>{t('recall.yourNote')}</h4>
            {concept?.note ? (
              <p className={s.recallNote}>
                <GlossaryText text={concept.note} />
              </p>
            ) : (
              <div className="row">
                <span className="muted">{t('recall.noNote')}</span>
                {concept && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(concept)}>
                    {t('recall.addNote')}
                  </Button>
                )}
              </div>
            )}
            {concept?.example_code && (
              <div className={s.recallExample}>
                <pre className={uiStyles.codeBlock}>
                  <code>{concept.example_code}</code>
                </pre>
                {concept.example_output && (
                  <pre className={`${uiStyles.codeBlock} ${uiStyles.codeBlockOutput}`}>
                    {concept.example_output}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
      {editing && <ConceptEditModal concept={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
