import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Concept } from '@/core/types/api';
import { Button, Chip, ChipGroup, Modal, TextArea, TextField } from '@/components/ui';
import { useCategories, useConceptMutations } from '@/data/queries';
import { ExampleField } from './ExampleEditor';

export function ConceptEditModal({
  concept,
  onClose,
  openExample = false,
}: {
  concept: Concept;
  onClose: () => void;
  /** open the example editor right away */
  openExample?: boolean;
}) {
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
      <ExampleField
        name={name}
        conceptId={concept.id}
        code={code}
        output={output}
        onCodeChange={setCode}
        onOutputChange={setOutput}
        defaultOpen={openExample}
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
