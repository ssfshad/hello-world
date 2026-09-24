import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Table2, LineChart as LineIcon } from 'lucide-react';
import { Card, EmptyState, IconButton } from '@/components/ui';
import s from './charts.module.css';

export interface TableSpec {
  columns: string[];
  rows: (string | number | null)[][];
}

/**
 * Every chart: a text title, an aria-label summary sentence, a "View as table"
 * toggle and an empty state for fewer than 3 data points (frontend.md §6).
 */
export function ChartFrame({
  title,
  summary,
  table,
  points,
  actions,
  children,
  height = 240,
  bare,
}: {
  title: string;
  summary: string;
  table: TableSpec;
  points: number;
  actions?: ReactNode;
  children: ReactNode;
  height?: number;
  bare?: boolean;
}) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  const sid = useId();
  const enough = points >= 3;
  const toggle = enough && (
    <IconButton aria-label={asTable ? t('common.viewAsChart') : t('common.viewAsTable')} onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
      {asTable ? <LineIcon size={16} /> : <Table2 size={16} />}
    </IconButton>
  );
  const body = !enough ? (
    <EmptyState>{t('charts.notEnough')}</EmptyState>
  ) : asTable ? (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j}>{v ?? '–'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <figure className={s.figure} role="img" aria-label={summary} aria-describedby={sid} style={{ height }}>
      {children}
    </figure>
  );
  const inner = (
    <>
      {enough && (
        <p id={sid} className="sr-only">
          {summary}
        </p>
      )}
      {body}
    </>
  );
  if (bare) return inner;
  return (
    <Card
      title={title}
      actions={
        <div className="row">
          {actions}
          {toggle}
        </div>
      }
    >
      {inner}
    </Card>
  );
}
