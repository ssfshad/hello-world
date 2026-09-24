import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Flag, Play } from 'lucide-react';
import type { FeelingTag, Problem, ProblemStatus } from '@/core/types/api';
import { Badge, Button, Chip, ChipGroup, Modal } from '@/components/ui';
import { formatDuration } from '@/lib/format';
import s from './domain.module.css';

/**
 * Generated problem detail: statement, formats, samples, hint behind "Show hint"
 * (recorded), and reference solution behind "I'm done / I give up" (revealing
 * before solving → Solved with help). Rendered as plain text — AI output is
 * untrusted and never interpreted as HTML.
 */
export function ProblemDetail({
  problem,
  feelings,
  onClose,
  onReveal,
  onStatus,
  onFeeling,
  onFlag,
  onStart,
  onDone,
}: {
  problem: Problem | null;
  feelings: FeelingTag[];
  onClose: () => void;
  onReveal: (what: 'hint' | 'answer') => void;
  onStatus: (s: ProblemStatus) => void;
  onFeeling: (id: string | null) => void;
  onFlag: (flagged: boolean) => void;
  onStart?: () => void;
  /** "I'm done": mark solved (if not already), then reveal the answer */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [confirmReveal, setConfirmReveal] = useState(false);
  if (!problem) return null;
  const st = problem.statement;
  const solved = problem.status === 'solved' || problem.status === 'solved_with_help';
  return (
    <Modal open onClose={onClose} wide title={problem.title}>
      <div className="row-wrap">
        {problem.difficulty && <Badge>{t('common.level', { n: problem.difficulty })} · {t(`difficulty.${problem.difficulty}`)}</Badge>}
        <Badge tone="muted">{t(`status.${problem.status}`)}</Badge>
        {problem.concept_names.map((c) => (
          <Badge key={c} tone="muted">
            {c}
          </Badge>
        ))}
        {problem.total_seconds > 0 && <Badge tone="muted">{formatDuration(problem.total_seconds)}</Badge>}
      </div>
      {st ? (
        <>
          <section className={s.section}>
            <h3>{t('problem.statement')}</h3>
            <p>{st.statement}</p>
          </section>
          <div className={s.samples}>
            <section className={s.section}>
              <h3>{t('problem.inputFormat')}</h3>
              <p>{st.input_format}</p>
            </section>
            <section className={s.section}>
              <h3>{t('problem.outputFormat')}</h3>
              <p>{st.output_format}</p>
            </section>
          </div>
          {st.constraints && (
            <section className={s.section}>
              <h3>{t('problem.constraints')}</h3>
              <p>{st.constraints}</p>
            </section>
          )}
          <section className={s.section}>
            <h3>{t('problem.samples')}</h3>
            <div className="stack">
              {st.samples.map((smp, i) => (
                <div key={i} className="stack" style={{ gap: 6 }}>
                  <strong style={{ fontSize: '0.87rem' }}>{t('problem.sampleN', { n: i + 1 })}</strong>
                  <div className={s.samples}>
                    <div>
                      <span className="muted" style={{ fontSize: '0.8rem' }}>
                        {t('problem.sampleInput')}
                      </span>
                      <pre className={s.pre}>{smp.input}</pre>
                    </div>
                    <div>
                      <span className="muted" style={{ fontSize: '0.8rem' }}>
                        {t('problem.sampleOutput')}
                      </span>
                      <pre className={s.pre}>{smp.output}</pre>
                    </div>
                  </div>
                  {smp.explanation && <p className="muted">{smp.explanation}</p>}
                </div>
              ))}
            </div>
          </section>
          <div className={s.reveal}>
            <h3 style={{ fontSize: '0.93rem' }}>{t('problem.hint')}</h3>
            {problem.hint_revealed ? (
              <p>{st.hint}</p>
            ) : (
              <>
                <p className="muted">{t('problem.hintRecorded')}</p>
                <div>
                  <Button icon={<Eye size={16} />} onClick={() => onReveal('hint')}>
                    {t('problem.showHint')}
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className={s.reveal}>
            <h3 style={{ fontSize: '0.93rem' }}>{t('problem.reference')}</h3>
            {problem.answer_revealed ? (
              <pre className={s.pre}>{st.reference_solution}</pre>
            ) : confirmReveal && !solved ? (
              <>
                <p className="muted">{t('problem.revealWarning')}</p>
                <div className="row">
                  <Button variant="ghost" onClick={() => setConfirmReveal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button variant="primary" onClick={() => onReveal('answer')}>
                    {t('problem.giveUp')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="row">
                <Button onClick={onDone}>
                  {t('problem.imDone')}
                </Button>
                {!solved && (
                  <Button variant="ghost" onClick={() => setConfirmReveal(true)}>
                    {t('problem.giveUp')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="muted">{problem.url ?? ''}</p>
      )}
      <ChipGroup label={t('problem.markStatus')}>
        {(['solved', 'solved_with_help', 'gave_up', 'revisit'] as const).map((x) => (
          <Chip key={x} pressed={problem.status === x} onToggle={() => onStatus(x)}>
            {t(`status.${x}`)}
          </Chip>
        ))}
      </ChipGroup>
      <ChipGroup label={t('problem.feeling')}>
        {feelings.map((f) => (
          <Chip key={f.id} tone="feeling" pressed={problem.feeling_tag_id === f.id} onToggle={() => onFeeling(problem.feeling_tag_id === f.id ? null : f.id)}>
            {f.name}
          </Chip>
        ))}
      </ChipGroup>
      <div className="row">
        {onStart && !solved && (
          <Button variant="primary" icon={<Play size={16} />} onClick={onStart}>
            {t('practice.startTimer')}
          </Button>
        )}
        <span className="spacer" />
        {problem.origin === 'generated' && (
          <Button variant="ghost" icon={<Flag size={16} />} onClick={() => onFlag(!problem.flagged_bad)}>
            {problem.flagged_bad ? t('problem.unreport') : t('problem.reportBad')}
          </Button>
        )}
      </div>
    </Modal>
  );
}
