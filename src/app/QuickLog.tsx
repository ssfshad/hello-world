import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '@/stores/uiStore';
import { Button, Modal, Select, Tabs, TextField, toast } from '@/components/ui';
import { useAppState, useConceptMutations, useProblemMutations, qk } from '@/data/queries';
import { call } from '@/data/client';
import type { ProblemStatus } from '@/core/types/api';

type Kind = 'concept' | 'problem' | 'diary';

/** Ctrl/Cmd+K: log a concept, problem or diary line from anywhere. */
export function QuickLog() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.quickLogOpen);
  const setOpen = useUiStore((s) => s.setQuickLogOpen);
  const { data: app } = useAppState();
  const concepts = useConceptMutations();
  const problems = useProblemMutations();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('concept');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<ProblemStatus>('solved');
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setText('');
  };
  const lang = app?.languages.find((l) => l.is_primary)?.id ?? app?.languages[0]?.id;

  const submit = async () => {
    const value = text.trim();
    if (!value || !app) return;
    setBusy(true);
    try {
      if (kind === 'concept' && lang) {
        await concepts.add.mutateAsync({ language_id: lang, name: value });
      } else if (kind === 'problem') {
        await problems.add.mutateAsync({ title: value, status, concept_ids: [], language_id: lang ?? null });
      } else if (kind === 'diary') {
        const existing = await call('diary_get', { day_key: app.today });
        await call('diary_save', {
          input: {
            day_key: app.today,
            body: existing?.body ? `${existing.body}\n${value}` : value,
            concept_ids: existing?.concept_links.filter((l) => l.source === 'user_tag').map((l) => l.concept_id) ?? [],
            feeling_tag_ids: existing?.feeling_tag_ids ?? [],
          },
        });
        qc.invalidateQueries({ queryKey: qk.day(app.today) });
      }
      toast.info(t('quickLog.logged'));
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('quickLog.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!text.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Tabs<Kind>
        label={t('quickLog.title')}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'concept', label: t('quickLog.concept') },
          { value: 'problem', label: t('quickLog.problem') },
          { value: 'diary', label: t('quickLog.diary') },
        ]}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="stack"
      >
        <TextField
          label={t(`quickLog.${kind}`)}
          hideLabel
          placeholder={t(`quickLog.${kind}Placeholder`)}
          value={text}
          maxLength={kind === 'concept' ? 60 : kind === 'problem' ? 120 : 1000}
          onChange={(e) => setText(e.target.value)}
        />
        {kind === 'problem' && (
          <Select
            label={t('problem.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value as ProblemStatus)}
            options={(['solved', 'solved_with_help', 'gave_up', 'revisit', 'queued'] as const).map((v) => ({
              value: v,
              label: t(`status.${v}`),
            }))}
          />
        )}
      </form>
    </Modal>
  );
}
