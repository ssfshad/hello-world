import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Concept, ErrorNote } from '@/core/types/api';
import { Button, Modal, Select, TextArea, toast } from '@/components/ui';
import { useErrorNoteMutations } from '@/data/queries';

export interface ErrorDraft {
  message: string;
  concept_id?: string | null;
  language_id?: string | null;
  problem_id?: string | null;
}

/** Add or edit an entry in the error journal: the error, its cause and the fix. */
export function ErrorNoteModal({
  initial,
  draft,
  concepts,
  onClose,
  onSaved,
}: {
  /** editing an existing note */
  initial?: ErrorNote | null;
  /** prefill for a new note (e.g. the error line from pasted output) */
  draft?: ErrorDraft | null;
  concepts: Concept[];
  onClose: () => void;
  onSaved?: (note: ErrorNote) => void;
}) {
  const { t } = useTranslation();
  const m = useErrorNoteMutations();
  const [message, setMessage] = useState(initial?.message ?? draft?.message ?? '');
  const [cause, setCause] = useState(initial?.cause ?? '');
  const [fix, setFix] = useState(initial?.fix ?? '');
  const [conceptId, setConceptId] = useState(initial?.concept_id ?? draft?.concept_id ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (!message.trim()) {
      setError(t('errors.required'));
      return;
    }
    m.save.mutate(
      {
        id: initial?.id ?? null,
        message,
        cause,
        fix,
        concept_id: conceptId || null,
        language_id: initial?.language_id ?? draft?.language_id ?? null,
        problem_id: initial?.problem_id ?? draft?.problem_id ?? null,
      },
      {
        onSuccess: (note) => {
          toast.info(t('errorNote.saved'));
          onSaved?.(note);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? t('errorNote.titleEdit') : t('errorNote.titleNew')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} loading={m.save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextArea
        label={t('errorNote.message')}
        hint={t('errorNote.messageHint')}
        placeholder={t('errorNote.messagePlaceholder')}
        value={message}
        error={error}
        rows={3}
        maxLength={4000}
        className="mono"
        spellCheck={false}
        onChange={(e) => {
          setMessage(e.target.value);
          setError(null);
        }}
      />
      <TextArea
        label={t('errorNote.cause')}
        placeholder={t('errorNote.causePlaceholder')}
        value={cause}
        rows={2}
        maxLength={2000}
        onChange={(e) => setCause(e.target.value)}
        data-autofocus={message ? true : undefined}
      />
      <TextArea
        label={t('errorNote.fix')}
        placeholder={t('errorNote.fixPlaceholder')}
        value={fix}
        rows={3}
        maxLength={4000}
        onChange={(e) => setFix(e.target.value)}
      />
      {concepts.length > 0 && (
        <Select
          label={t('errorNote.concept')}
          value={conceptId}
          onChange={(e) => setConceptId(e.target.value)}
          options={[
            { value: '', label: t('common.none') },
            ...concepts.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      )}
    </Modal>
  );
}
