import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import type { ImportPreview, PracticeConfig } from '@/core/types/api';
import { Badge, Button, Modal, TextArea, toast } from '@/components/ui';
import { copyText } from '@/data/platform';
import s from './domain.module.css';

/**
 * Paste → validate → preview → add. Invalid responses show a friendly error
 * and a "Copy fix-up prompt" button (frontend.md §5.5, backend §8.5).
 */
export function PasteResponseModal({
  open,
  onClose,
  config,
  validate,
  fixupPrompt,
  onImport,
  initialRaw,
  initialPreview,
}: {
  open: boolean;
  onClose: () => void;
  config: PracticeConfig;
  validate: (raw: string, config: PracticeConfig) => Promise<ImportPreview>;
  fixupPrompt: (raw: string) => Promise<string>;
  onImport: (raw: string) => Promise<unknown>;
  /** API mode: the model's answer, already validated */
  initialRaw?: string;
  initialPreview?: ImportPreview;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(initialRaw ?? '');
  const [preview, setPreview] = useState<ImportPreview | null>(initialPreview ?? null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setRaw('');
    setPreview(null);
    onClose();
  };

  const check = async () => {
    setBusy(true);
    try {
      setPreview(await validate(raw, config));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      await onImport(raw);
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={t('practice.pasteTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          {preview?.ok ? (
            <Button variant="primary" onClick={add} loading={busy}>
              {t('practice.addToQueue')}
            </Button>
          ) : (
            <Button variant="primary" onClick={check} loading={busy} disabled={!raw.trim()}>
              {t('practice.check')}
            </Button>
          )}
        </>
      }
    >
      <TextArea
        label={t('practice.pasteTitle')}
        hideLabel
        hint={t('practice.pasteHint')}
        className="mono"
        rows={10}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          setPreview(null);
        }}
        placeholder='{ "problems": [ … ] }'
      />
      {preview && !preview.ok && (
        <div role="alert" className="stack">
          <p>{t('practice.invalid')}</p>
          <ul className={s.errorList}>
            {preview.errors.slice(0, 8).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <div>
            <Button
              icon={<Copy size={16} />}
              onClick={async () => {
                await copyText(await fixupPrompt(raw));
                toast.info(t('practice.fixupCopied'));
              }}
            >
              {t('practice.copyFixup')}
            </Button>
          </div>
        </div>
      )}
      {preview?.ok && (
        <div className="stack">
          <h3 className="serif" style={{ fontWeight: 500, fontSize: '1.15rem' }}>
            {t('practice.previewTitle', { count: preview.problems.length })}
          </h3>
          {preview.warnings.length > 0 && (
            <div>
              <strong style={{ fontSize: '0.87rem' }}>{t('practice.warnings')}</strong>
              <ul className={s.warnList}>
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <ul className={s.list}>
            {preview.problems.map((p, i) => (
              <li key={i} className={s.previewItem}>
                <div className="row">
                  <strong>{p.title}</strong>
                  <Badge>{t('common.level', { n: p.difficulty })}</Badge>
                  {p.concepts.map((c) => (
                    <Badge key={c} tone="muted">
                      {c}
                    </Badge>
                  ))}
                </div>
                <p className="muted" style={{ marginTop: 4 }}>
                  {p.statement.length > 180 ? `${p.statement.slice(0, 179)}…` : p.statement}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
