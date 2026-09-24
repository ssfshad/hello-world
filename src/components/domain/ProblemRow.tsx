import { useTranslation } from 'react-i18next';
import { ExternalLink, Pause, Play, Square } from 'lucide-react';
import type { FeelingTag, Problem } from '@/core/types/api';
import { Badge, IconButton, Timer } from '@/components/ui';
import { useTimerStore } from '@/stores/timerStore';
import { formatDuration } from '@/lib/format';
import { openUrl } from '@/data/platform';
import s from './domain.module.css';

export function ProblemRow({
  problem,
  feelings,
  onOpen,
  onStart,
  onPause,
  onResume,
  onStop,
}: {
  problem: Problem;
  feelings: FeelingTag[];
  onOpen?: () => void;
  onStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  const attempt = useTimerStore((st) => st.attempt);
  const running = !!attempt && attempt.problem_id === problem.id && !attempt.ended_at;
  const feeling = feelings.find((f) => f.id === problem.feeling_tag_id);
  const finished = ['solved', 'solved_with_help', 'gave_up'].includes(problem.status);

  return (
    <li className={[s.row, problem.flagged_bad && s.flagged].filter(Boolean).join(' ')}>
      <span className={[s.dot, s[`dot_${problem.status}`]].join(' ')} title={t(`status.${problem.status}`)} aria-hidden="true" />
      <div className={s.rowMain}>
        <button
          type="button"
          onClick={onOpen}
          className={s.rowTitle}
          style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: onOpen ? 'pointer' : 'default', color: 'inherit' }}
        >
          {problem.title}
        </button>
        <div className={s.rowMeta}>
          <span className="sr-only">{t(`status.${problem.status}`)}.</span>
          <span aria-hidden="true">{t(`status.${problem.status}`)}</span>
          {problem.concept_names.length > 0 && <span>· {problem.concept_names.join(', ')}</span>}
          {problem.difficulty && <Badge tone="muted">{t('common.level', { n: problem.difficulty })}</Badge>}
          <Badge tone="muted">{t(`problem.source.${problem.origin}`)}</Badge>
          {feeling && <Badge tone="feeling">{feeling.name}</Badge>}
          {problem.url && (
            <IconButton aria-label={problem.url} onClick={() => void openUrl(problem.url!)}>
              <ExternalLink size={14} />
            </IconButton>
          )}
        </div>
      </div>
      <span className={s.rowTime}>
        {running ? <Timer timer={attempt} small /> : problem.total_seconds > 0 ? formatDuration(problem.total_seconds) : ''}
      </span>
      {!finished && onStart && !running && (
        <IconButton aria-label={t('today.startProblemTimer', { title: problem.title })} onClick={onStart}>
          <Play size={16} />
        </IconButton>
      )}
      {running && !attempt.paused_at && onPause && (
        <IconButton aria-label={t('today.pauseProblemTimer', { title: problem.title })} onClick={onPause}>
          <Pause size={16} />
        </IconButton>
      )}
      {running && attempt.paused_at && onResume && (
        <IconButton aria-label={t('today.resumeProblemTimer', { title: problem.title })} onClick={onResume}>
          <Play size={16} />
        </IconButton>
      )}
      {running && onStop && (
        <IconButton aria-label={t('today.stopProblemTimer', { title: problem.title })} onClick={onStop}>
          <Square size={14} />
        </IconButton>
      )}
    </li>
  );
}
