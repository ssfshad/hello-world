import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { Concept, FeelingTag, Problem, ProblemStatus } from '@/core/types/api';
import { problemFormSchema, type ProblemForm } from '@/core/schemas';
import { Button, Chip, ChipGroup, DifficultyPicker, Modal, TextArea, TextField } from '@/components/ui';

const STATUSES: ProblemStatus[] = ['solved', 'solved_with_help', 'gave_up', 'revisit', 'in_progress', 'queued'];

/** "Log a problem" / edit modal (frontend.md §5.2). */
export function ProblemModal({
  open,
  onClose,
  concepts,
  feelings,
  initial,
  onSubmit,
  onDelete,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  concepts: Concept[];
  feelings: FeelingTag[];
  initial?: Problem | null;
  onSubmit: (v: ProblemForm) => Promise<unknown> | void;
  onDelete?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const defaults: ProblemForm = {
    title: initial?.title ?? '',
    url: initial?.url ?? '',
    concept_ids: initial?.concept_ids ?? [],
    difficulty: initial?.difficulty ?? null,
    status: initial?.status ?? 'solved',
    feeling_tag_id: initial?.feeling_tag_id ?? null,
    solution_text: initial?.solution_text ?? '',
    solution_path: initial?.solution_path ?? '',
  };
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<ProblemForm>({ resolver: zodResolver(problemFormSchema), defaultValues: defaults });

  useEffect(() => {
    if (open) reset(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={initial ? t('problem.editTitle') : t('problem.modalTitle')}
      footer={
        <>
          {onDelete && (
            <Button variant="ghost" onClick={onDelete} style={{ marginRight: 'auto' }}>
              {t('problem.delete')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="problem-form" loading={busy}>
            {t('problem.save')}
          </Button>
        </>
      }
    >
      <form
        id="problem-form"
        className="stack"
        style={{ gap: 16 }}
        onSubmit={handleSubmit(async (v) => {
          await onSubmit(v);
        })}
        noValidate
      >
        <TextField label={t('problem.title')} placeholder={t('problem.titlePlaceholder')} maxLength={120} error={errors.title?.message} {...register('title')} />
        <TextField label={`${t('problem.link')} (${t('common.optional')})`} placeholder="https://" error={errors.url?.message} {...register('url')} />
        <Controller
          control={control}
          name="concept_ids"
          render={({ field }) => (
            <ChipGroup label={t('problem.concepts')}>
              {concepts.map((c) => {
                const on = field.value.includes(c.id);
                return (
                  <Chip key={c.id} pressed={on} onToggle={() => field.onChange(on ? field.value.filter((x) => x !== c.id) : [...field.value, c.id])}>
                    {c.name}
                  </Chip>
                );
              })}
            </ChipGroup>
          )}
        />
        <Controller
          control={control}
          name="difficulty"
          render={({ field }) => <DifficultyPicker value={field.value} onChange={field.onChange} />}
        />
        <Controller
          control={control}
          name="status"
          render={({ field }) => (
            <ChipGroup label={t('problem.status')}>
              {STATUSES.map((st) => (
                <Chip key={st} pressed={field.value === st} onToggle={() => field.onChange(st)}>
                  {t(`status.${st}`)}
                </Chip>
              ))}
            </ChipGroup>
          )}
        />
        <Controller
          control={control}
          name="feeling_tag_id"
          render={({ field }) => (
            <ChipGroup label={t('problem.feeling')}>
              {feelings.map((f) => (
                <Chip key={f.id} tone="feeling" pressed={field.value === f.id} onToggle={() => field.onChange(field.value === f.id ? null : f.id)}>
                  {f.name}
                </Chip>
              ))}
            </ChipGroup>
          )}
        />
        <TextArea
          label={`${t('problem.solution')} (${t('common.optional')})`}
          placeholder={t('problem.solutionPlaceholder')}
          className="mono"
          rows={4}
          {...register('solution_text')}
        />
        <TextField label={t('problem.solutionPath')} {...register('solution_path')} />
      </form>
    </Modal>
  );
}
