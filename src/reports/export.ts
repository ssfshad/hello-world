/**
 * Report export: data from `report_data`, PDF rendered in the frontend, bytes
 * handed to `report_save_pdf` (which opens a save dialog). The PDF library is
 * loaded only when a report is exported.
 */
import { createElement } from 'react';
import type { TFunction } from 'i18next';
import type { ReportInput } from '@/core/types/api';
import { call } from '@/data/client';
import { insightMessage } from '@/components/domain/insightText';
import { formatDay } from '@/lib/format';

export async function exportPdfReport(input: ReportInput, t: TFunction): Promise<string | null> {
  const data = await call('report_data', { input });
  const [{ pdf }, { ReportDocument }] = await Promise.all([import('@react-pdf/renderer'), import('./ReportDocument')]);
  const byId = new Map(data.insights.map((i) => [i.id, i]));
  const labels = {
    title: t('report.title'),
    range: t('report.range', { from: formatDay(data.range.from, { dateStyle: 'medium' }), to: formatDay(data.range.to, { dateStyle: 'medium' }) }),
    journeyDay: t('report.journeyDay', { n: data.journey_day }),
    totals: t('report.totals'),
    focused: t('report.focused'),
    activeDays: t('report.activeDays'),
    concepts: t('report.concepts'),
    solved: t('report.solved'),
    attempted: t('report.attempted'),
    avgMood: t('report.avgMood'),
    avgUseful: t('report.avgUseful'),
    streak: t('report.streak'),
    conceptsList: t('report.conceptsList'),
    problemsList: t('report.problemsList'),
    daily: t('report.daily'),
    insights: t('report.insights'),
    diary: t('report.diary'),
    footer: t('report.footer'),
    status: Object.fromEntries(
      ['queued', 'in_progress', 'solved', 'solved_with_help', 'gave_up', 'revisit'].map((k) => [k, t(`status.${k}`)]),
    ),
    insightText: (id: string) => {
      const i = byId.get(id);
      return i ? insightMessage(t, i) : '';
    },
  };
  // ReportDocument returns a <Document>; pdf() accepts that element.
  const doc = createElement(ReportDocument, { data, labels }) as unknown as Parameters<typeof pdf>[0];
  const blob = await pdf(doc).toBlob();
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  return call('report_save_pdf', { bytes, suggested_name: `hello-world-report-${data.range.to}.pdf` });
}

export async function exportMarkdownReport(input: ReportInput): Promise<string | null> {
  return call('report_save_markdown', { input, suggested_name: `hello-world-llm-report-${input.range.to}.md` });
}
