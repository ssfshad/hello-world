import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Concept } from '@/core/types/api';
import { Button, Chip, ChipGroup, CodeCanvas, Modal, TextArea, TextField } from '@/components/ui';
import { useCategories, useConceptMutations } from '@/data/queries';

export function ConceptEditModal({ concept, onClose }: { concept: Concept; onClose: () => void }) {
  const { t } = useTranslation();
  const m = useConceptMutations();
  const { data: categories = [] } = useCategories();
  const [name, setName] = useState(concept.name);
  const [note, setNote] = useState(concept.note ?? '');
  const [code, setCode] = useState(concept.example_code ?? '');
  const [output, setOutput] = useState(concept.example_output ?? '');
  const [cat, setCat] = useState(concept.category_id);
  return (
    <Modal
      open
      title={concept.name}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            style={{ marginRight: 'auto' }}
            onClick={() => {
              m.remove.mutate(concept.id);
              onClose();
            }}
          >
            {t('common.delete')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() => {
              m.update.mutate({
                id: concept.id,
                name: name.trim(),
                note: note.trim() || null,
                example_code: code.trim() ? code : null,
                example_output: output.trim() ? output : null,
                category_id: cat,
              });
              onClose();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextField label={t('quickLog.concept')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <TextArea label={t('today.noteLabel')} value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
      <CodeCanvas label={t('today.codeLabel')} hint={t('today.codeHint')} value={code} onChange={setCode} maxLength={20000} />
      <CodeCanvas
        variant="output"
        label={t('today.outputLabel')}
        hint={t('today.outputHint')}
        placeholder={t('today.outputPlaceholder')}
        value={output}
        onChange={setOutput}
        maxLength={20000}
        minRows={3}
      />
      <ChipGroup label={t('today.categoryLabel')}>
        {categories.map((c) => (
          <Chip key={c.id} pressed={cat === c.id} onToggle={() => setCat(cat === c.id ? null : c.id)}>
            {c.name}
          </Chip>
        ))}
      </ChipGroup>
    </Modal>
  );
}
