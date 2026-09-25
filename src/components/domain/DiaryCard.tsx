import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Sparkles, X } from 'lucide-react';
import type { Concept, DiaryEntry, FeelingTag } from '@/core/types/api';
import { Button, Card, Chip, ChipGroup, TextArea, TextField } from '@/components/ui';
import { AUTOSAVE_MS, useDraftStore } from '@/stores/draftStore';
import { useAppState, useDiaryAiSuggest, useDiaryDismissLink, useDiarySave, useFeelingTagAdd } from '@/data/queries';
import s from './domain.module.css';

/** Free-text diary with 2 s draft autosave, concept chips and feeling tags. */
export function DiaryCard({
  dayKey,
  diary,
  concepts,
  feelings,
}: {
  dayKey: string;
  diary: DiaryEntry | null;
  concepts: Concept[];
  feelings: FeelingTag[];
}) {
  const { t } = useTranslation();
  const draft = useDraftStore((st) => st.diary[dayKey]);
  const setDiary = useDraftStore((st) => st.setDiary);
  const markSaved = useDraftStore((st) => st.markSaved);
  const save = useDiarySave();
  const dismiss = useDiaryDismissLink();
  const addFeeling = useFeelingTagAdd();
  const aiSuggest = useDiaryAiSuggest();
  const { data: app } = useAppState();
  const allowAi = !!app?.settings.allow_diary_to_ai;
  const [newTag, setNewTag] = useState<string | null>(null);
  const savingRef = useRef(false);

  const body = draft?.body ?? diary?.body ?? '';
  const userTagged = draft?.concept_ids ?? diary?.concept_links.filter((l) => l.source === 'user_tag').map((l) => l.concept_id) ?? [];
  const feelingIds = draft?.feeling_tag_ids ?? diary?.feeling_tag_ids ?? [];
  const suggested = diary?.concept_links.filter((l) => l.source !== 'user_tag' && !userTagged.includes(l.concept_id)) ?? [];

  const update = (patch: { body?: string; concept_ids?: string[]; feeling_tag_ids?: string[] }) =>
    setDiary(dayKey, { body, concept_ids: userTagged, feeling_tag_ids: feelingIds, ...patch });

  // Autosave every 2 s after the last change.
  useEffect(() => {
    if (!draft?.dirty) return;
    const id = window.setTimeout(() => {
      if (savingRef.current) return;
      savingRef.current = true;
      save.mutate(
        { day_key: dayKey, body: draft.body, concept_ids: draft.concept_ids, feeling_tag_ids: draft.feeling_tag_ids },
        {
          onSuccess: () => markSaved(dayKey),
          onSettled: () => {
            savingRef.current = false;
          },
        },
      );
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(id);
  }, [draft, dayKey, save, markSaved]);

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const status = save.isPending ? t('today.draftSaving') : draft && !draft.dirty ? t('today.draftSaved') : '';

  return (
    <Card tone="warm" id="diary-card" headline={t('today.diaryTitle')} actions={<span className={s.saveState} aria-live="polite">{status}</span>}>
      <div className="stack" style={{ gap: 16 }}>
        <TextArea
          label={t('today.diaryTitle')}
          hideLabel
          className={s.diaryText}
          placeholder={t('today.diaryPlaceholder')}
          value={body}
          maxLength={10_000}
          onChange={(e) => update({ body: e.target.value })}
        />
        {concepts.length > 0 && (
          <ChipGroup label={t('today.diaryAbout')}>
            {concepts.map((c) => (
              <Chip key={c.id} pressed={userTagged.includes(c.id)} onToggle={() => update({ concept_ids: toggle(userTagged, c.id) })}>
                {c.name}
              </Chip>
            ))}
          </ChipGroup>
        )}
        {allowAi && diary && body.trim().length > 0 && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              icon={<Sparkles size={14} />}
              loading={aiSuggest.isPending}
              disabled={!!draft?.dirty}
              onClick={() => aiSuggest.mutate(dayKey)}
            >
              {t('today.aiSuggestLinks')}
            </Button>
          </div>
        )}
        {suggested.length > 0 && diary && (
          <div className="row-wrap">
            {suggested.map((l) => (
              <span key={l.concept_id} className="row" style={{ gap: 2 }}>
                <Chip dashed pressed={false} onToggle={() => update({ concept_ids: [...userTagged, l.concept_id] })} aria-label={`${l.name}: confirm link`}>
                  {l.name}
                </Chip>
                <button
                  type="button"
                  aria-label={t('today.suggestedLink', { name: l.name })}
                  onClick={() => dismiss.mutate({ diary_id: diary.id, concept_id: l.concept_id })}
                  style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--muted)', padding: 4 }}
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <ChipGroup label={t('today.diaryFeelings')}>
          {feelings.map((f) => (
            <Chip key={f.id} tone="feeling" pressed={feelingIds.includes(f.id)} onToggle={() => update({ feeling_tag_ids: toggle(feelingIds, f.id) })}>
              {f.name}
            </Chip>
          ))}
          {newTag === null ? (
            <Chip dashed tone="feeling" pressed={false} onToggle={() => setNewTag('')} aria-label={t('today.addFeeling')}>
              <Plus size={14} /> {t('today.addFeeling')}
            </Chip>
          ) : (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newTag.trim();
                if (!name) return setNewTag(null);
                addFeeling.mutate(
                  { name, valence: 0 },
                  {
                    onSuccess: (f) => {
                      update({ feeling_tag_ids: [...feelingIds, f.id] });
                      setNewTag(null);
                    },
                  },
                );
              }}
            >
              <TextField label={t('today.addFeeling')} hideLabel placeholder={t('today.newFeelingPlaceholder')} value={newTag} maxLength={30} autoFocus onChange={(e) => setNewTag(e.target.value)} />
              <Button size="sm" type="submit">
                {t('common.add')}
              </Button>
            </form>
          )}
        </ChipGroup>
      </div>
    </Card>
  );
}
