import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Code2, Terminal } from 'lucide-react';
import { Button, CodeCanvas, Modal, uiStyles } from '@/components/ui';
import { ErrorAssist } from './ErrorAssist';
import s from './domain.module.css';

/**
 * Compact "Example" field for a concept form: a button (plus a short preview
 * once something is written) that opens a full-size editor with the code on
 * the left and the pasted output on the right. Edits go straight to the
 * parent's state, so closing the editor in any way keeps the work.
 */
export function ExampleField({
  name,
  conceptId,
  code,
  output,
  onCodeChange,
  onOutputChange,
  defaultOpen = false,
}: {
  /** concept name, shown in the editor title */
  name: string;
  /** set when editing a saved concept, so a logged error can link to it */
  conceptId?: string | null;
  code: string;
  output: string;
  onCodeChange: (v: string) => void;
  onOutputChange: (v: string) => void;
  /** open the editor straight away (the getting-started guide's "Write one") */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const hasCode = code.trim().length > 0;
  const hasAny = hasCode || output.trim().length > 0;
  const preview = code.split('\n').slice(0, 4).join('\n');
  const lineCount = code.split('\n').length;

  return (
    <div className={s.exampleField}>
      <div className="row">
        <span className={uiStyles.label}>{t('today.codeLabel')}</span>
        <span className="spacer" />
        <Button
          size="sm"
          variant="secondary"
          icon={<Code2 size={16} />}
          onClick={() => setOpen(true)}
        >
          {hasAny ? t('today.exampleEdit') : t('today.exampleOpen')}
        </Button>
      </div>
      {hasAny ? (
        <button type="button" className={s.examplePreview} onClick={() => setOpen(true)}>
          {hasCode && <pre className={uiStyles.codeBlock}>{preview}</pre>}
          <span className="muted">
            {hasCode && t('today.exampleLines', { count: lineCount })}
            {hasCode && ' · '}
            {output.trim() ? t('today.outputLabel') : t('today.exampleNoOutput')}
          </span>
        </button>
      ) : (
        <span className="muted" style={{ fontSize: '0.87rem' }}>
          {t('today.exampleEmpty')}
        </span>
      )}
      <ExampleEditor
        open={open}
        onClose={() => setOpen(false)}
        name={name}
        conceptId={conceptId}
        code={code}
        output={output}
        onCodeChange={onCodeChange}
        onOutputChange={onOutputChange}
      />
    </div>
  );
}

/** Split-pane editor in the style of an online compiler: code left, output right. */
export function ExampleEditor({
  open,
  onClose,
  name,
  conceptId,
  code,
  output,
  onCodeChange,
  onOutputChange,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  conceptId?: string | null;
  code: string;
  output: string;
  onCodeChange: (v: string) => void;
  onOutputChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      full
      onClose={onClose}
      title={t('today.exampleEditorTitle', { name: name.trim() || t('today.exampleToggle') })}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto', fontSize: '0.85rem' }}>
            {t('today.exampleEditorHint')}
          </span>
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      <div className={s.ide}>
        <section className={s.idePane}>
          <header className={s.ideBar}>
            <span className={s.ideTab}>
              <Code2 size={14} aria-hidden="true" /> {t('today.exampleFile')}
            </span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => onCodeChange('')} disabled={!code}>
              {t('today.exampleClear')}
            </Button>
          </header>
          <CodeCanvas
            fill
            hideLabel
            label={t('today.codeLabel')}
            placeholder={t('today.codePlaceholder')}
            value={code}
            onChange={onCodeChange}
            maxLength={20000}
            minRows={60}
          />
        </section>
        <section className={s.idePane}>
          <header className={s.ideBar}>
            <span className={s.ideTab}>
              <Terminal size={14} aria-hidden="true" /> {t('today.outputLabel')}
            </span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => onOutputChange('')} disabled={!output}>
              {t('today.exampleClear')}
            </Button>
          </header>
          <CodeCanvas
            fill
            variant="output"
            hideLabel
            label={t('today.outputLabel')}
            hint={t('today.outputHint')}
            placeholder={t('today.outputPlaceholder')}
            value={output}
            onChange={onOutputChange}
            maxLength={20000}
          />
          <ErrorAssist output={output} conceptId={conceptId} />
        </section>
      </div>
    </Modal>
  );
}
