import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Flag, Play } from 'lucide-react';
import type { FeelingTag, GeneratedProblem, Problem, ProblemStatus } from '@/core/types/api';
import { Badge, Button, Chip, ChipGroup, Modal } from '@/components/ui';
import { formatDuration } from '@/lib/format';
import { GlossaryText } from './GlossaryText';
import { HintButton } from './HintButton';
import s from './domain.module.css';

/** The answer of a non-write-code problem, shown once revealed. */
function TypeAnswer({ problem: st }: { problem: GeneratedProblem }) {
  const { t } = useTranslation();
  const type = st.type ?? 'write_code';
  return (
    <div className="stack" style={{ gap: 8 }}>
      {type === 'predict_output' && <pre className={s.pre}>{st.expected_output}</pre>}
      {type === 'find_bug' && (
        <>
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {t('problem.fixedCode')}
          </span>
          <pre className={s.pre}>{st.reference_solution}</pre>
        </>
      )}
      {type === 'fill_blank' && (
        <ol className={s.options}>
          {(st.blanks ?? []).map((b, i) => (
            <li key={i}>
              <code>{b}</code>
            </li>
          ))}
        </ol>
      )}
      {type === 'multiple_choice' && st.correct_option != null && (
        <p>
          <strong>{String.fromCharCode(65 + st.correct_option)}.</strong> {st.options?.[st.correct_option]}
        </p>
      )}
      {st.explanation && <p className="muted">{st.explanation}</p>}
    </div>
  );
}

/**
 * Generated problem detail: statement, formats, samples, hint behind "Show hint"
 * (recorded), and reference solution behind "I'm done / I give up" (revealing
 * before solving → Solved with help). Other problem types (predict the output,
 * find the bug, fill in the blanks, multiple choice) show their code or options
 * and reveal their answer the same way. Rendered as plain text — AI output is
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
  const type = st?.type ?? 'write_code';
  const solved = problem.status === 'solved' || problem.status === 'solved_with_help';
  return (
    <Modal open onClose={onClose} wide title={problem.title}>
      <div className="row-wrap">
        {st && <Badge>{t(`problem.types.${type}`)}</Badge>}
        {problem.difficulty &&<Badge>{t('common.level', { n: problem.difficulty })} · {t(`difficulty.${problem.difficulty}`)}</Badge>}
        <Badge tone="muted">{t(`status.${problem.status}`)}</Badge>
        {problem.concept_names.map((c) => (
          <Badge key={c} tone="muted">
            {c}
          </Badge>
        ))}
        {problem.total_seconds > 0 && <Badge tone="muted">{formatDuration(problem.total_seconds)}</Badge>}
      </div>
      {st && type !== 'write_code' ? (
        <>
          <section className={s.section}>
            <h3>{t(`problem.types.${type}`)}</h3>
            <p>
              <GlossaryText text={st.statement} />
            </p>
          </section>
          {st.code && (
            <section className={s.section}>
              <h3>{t('problem.code')}</h3>
              <pre className={s.pre}>{st.code}</pre>
            </section>
          )}
          {type === 'multiple_choice' && (
            <ol className={s.options} type="A">
              {(st.options ?? []).map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ol>
          )}
          {st.hint && (
            <div className={s.reveal}>
              <h3 style={{ fontSize: '0.93rem' }}>{t('problem.hint')}</h3>
              {problem.hint_revealed ? (
                <p>{st.hint}</p>
              ) : (
                <div>
                  <Button icon={<Eye size={16} />} onClick={() => onReveal('hint')}>
                    {t('problem.showHint')}
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className={s.reveal}>
            <h3 style={{ fontSize: '0.93rem' }}>{t('problem.answer')}</h3>
            {problem.answer_revealed ? (
              <TypeAnswer problem={st} />
            ) : confirmReveal && !solved ? (
              <>
                <p className="muted">{t('problem.revealWarning')}</p>
                <div className="row">
                  <Button variant="ghost" onClick={() => setConfirmReveal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button variant="primary" onClick={() => onReveal('answer')}>
                    {t('problem.giveUpAnswer')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="row">
                <Button onClick={onDone}>{t('problem.imDoneAnswer')}</Button>
                {!solved && (
                  <Button variant="ghost" onClick={() => setConfirmReveal(true)}>
                    {t('problem.giveUpAnswer')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      ) : st ? (
        <>
          <section className={s.section}>
            <h3>{t('problem.statement')}</h3>
            <p>
              <GlossaryText text={st.statement} />
            </p>
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
              {(st.samples ?? []).map((smp, i) => (
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
              <>
                <pre className={s.pre}>{st.reference_solution}</pre>
                {st.explanation && <p className="muted">{st.explanation}</p>}
              </>
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
        {!solved && <HintButton problemId={problem.id} size="md" />}
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
