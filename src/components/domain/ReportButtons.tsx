import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, FileText } from 'lucide-react';
import type { DayRange } from '@/core/types/api';
import { Button, toast } from '@/components/ui';
import { toAppError } from '@/data/client';

export function ReportButtons({ range, languageId }: { range: DayRange; languageId?: string | null }) {
  const { t } = useTranslation();
  const [includeDiary, setIncludeDiary] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'md' | null>(null);

  const run = async (kind: 'pdf' | 'md') => {
    setBusy(kind);
    try {
      const mod = await import('@/reports/export');
      const input = { range, language_id: languageId ?? null, include_diary: includeDiary };
      const path = kind === 'pdf' ? await mod.exportPdfReport(input, t) : await mod.exportMarkdownReport(input);
      if (path) toast.info(t('report.saved', { path }));
    } catch (e) {
      toast.error(t('errors.generic', { message: toAppError(e).message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row-wrap">
        <Button icon={<FileDown size={16} />} loading={busy === 'pdf'} onClick={() => run('pdf')}>
          {t('practice.exportPdf')}
        </Button>
        <Button icon={<FileText size={16} />} loading={busy === 'md'} onClick={() => run('md')}>
          {t('practice.exportMd')}
        </Button>
      </div>
      <label className="row" style={{ fontSize: '0.87rem', color: 'var(--muted)', cursor: 'pointer' }}>
        <input type="checkbox" checked={includeDiary} onChange={(e) => setIncludeDiary(e.target.checked)} style={{ accentColor: 'var(--progress)' }} />
        {t('report.includeDiary')}
      </label>
    </div>
  );
}
