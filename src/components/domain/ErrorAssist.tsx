import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookmarkPlus, History } from 'lucide-react';
import { Button, toast } from '@/components/ui';
import { useConcepts, useErrorNoteMutations, useErrorNotes } from '@/data/queries';
import { extractErrorLine, findErrorMatch } from '@/lib/errors';
import { ErrorNoteModal } from './ErrorNoteModal';
import s from './domain.module.css';

/**
 * Sits under pasted output. If the output shows an error the learner fixed
 * before, it shows their fix; if it's a new error, it offers to log it.
 * Renders nothing for normal output.
 */
export function ErrorAssist({ output, conceptId }: { output: string; conceptId?: string | null }) {
  const { t } = useTranslation();
  const { data: notes = [] } = useErrorNotes();
  const { data: concepts = [] } = useConcepts(null, null);
  const m = useErrorNoteMutations();
  const [logging, setLogging] = useState(false);
  const [counted, setCounted] = useState<string | null>(null);
  const line = useMemo(() => extractErrorLine(output), [output]);
  const match = useMemo(() => (line ? findErrorMatch(output, notes) : null), [line, output, notes]);
  if (!line) return null;

  if (match) {
    const n = match.note;
    return (
      <div className={s.assist} role="status">
        <div className={s.assistHead}>
          <History size={16} aria-hidden="true" />
          <strong>{t('errorAssist.seenBefore')}</strong>
          <span className="muted">{t('knowledge.hits', { count: n.hits })}</span>
        </div>
        {n.fix ? (
          <>
            <span className="muted">{t('errorAssist.lastFix')}</span>
            <p className={s.assistFix}>{n.fix}</p>
          </>
        ) : (
          <p className="muted">{t('errorAssist.noFixYet')}</p>
        )}
        <div className="row">
          {counted !== n.id && (
            <Button
              size="sm"
              variant="ghost"
              loading={m.hit.isPending}
              onClick={() =>
                m.hit.mutate(n.id, {
                  onSuccess: (u) => {
                    setCounted(n.id);
                    toast.info(t('errorAssist.counted', { count: u.hits }));
                  },
                })
              }
            >
              {t('errorAssist.sameAgain')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setLogging(true)}>
            {t('common.edit')}
          </Button>
        </div>
        {logging && (
          <ErrorNoteModal initial={n} concepts={concepts} onClose={() => setLogging(false)} />
        )}
      </div>
    );
  }

  return (
    <div className={s.assist} role="status">
      <div className={s.assistHead}>
        <BookmarkPlus size={16} aria-hidden="true" />
        <strong>{t('errorAssist.looksLikeError')}</strong>
      </div>
      <p className="muted">{t('errorAssist.logIt')}</p>
      <div>
        <Button size="sm" variant="secondary" onClick={() => setLogging(true)}>
          {t('errorAssist.logButton')}
        </Button>
      </div>
      {logging && (
        <ErrorNoteModal
          draft={{ message: line, concept_id: conceptId ?? null }}
          concepts={concepts}
          onClose={() => setLogging(false)}
        />
      )}
    </div>
  );
}
