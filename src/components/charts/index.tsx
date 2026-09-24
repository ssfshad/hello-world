/**
 * Chart components. Colors come from tokens only: progress = teal solid,
 * feelings = orange dashed (meaning never relies on color alone).
 */
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type TooltipContentProps,
} from 'recharts';
import type { DailyPoint, HeatCell, InsightCharts } from '@/core/types/api';
import { formatMinutes, formatShortDay, formatDay, formatNumber } from '@/lib/format';
import { ChartFrame } from './ChartFrame';
import { useTokens, seriesColors } from './useTokens';
import {
  countDataPoints,
  heatGrid,
  moodDelta,
  moodUsefulnessSummary,
  pivotSpeed,
  shadowDays,
  stackFeelings,
  timeSummary,
} from './transforms';
import s from './charts.module.css';

export { ChartFrame } from './ChartFrame';

const axisTick = (color: string) => ({ fill: color, fontSize: 12, fontFamily: 'IBM Plex Sans' });

// ───────────────────────── Mood & usefulness (dual axis) ─────────────────────────
function MoodTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as DailyPoint;
  return (
    <div className={s.tooltip}>
      <div className={s.tooltipTitle}>{formatDay(String(label), { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      <div>
        {t('charts.usefulness')}: <strong>{p.usefulness ?? '–'}</strong>
      </div>
      <div>
        {t('charts.mood')}: <strong>{p.mood_avg ?? '–'}</strong>
      </div>
      {p.comeback && <div>{t('charts.comebackPoint')}</div>}
      {p.diary_snippet && <div className={s.tooltipQuote}>“{p.diary_snippet}”</div>}
    </div>
  );
}

export function MoodUsefulnessChart({
  points,
  actions,
  height = 260,
  title,
}: {
  points: DailyPoint[];
  actions?: React.ReactNode;
  height?: number;
  title?: string;
}) {
  const { t } = useTranslation();
  const tok = useTokens();
  const sum = moodUsefulnessSummary(points);
  const n = countDataPoints(points, (p) => p.usefulness != null || p.mood_avg != null);
  return (
    <ChartFrame
      title={title ?? t('dashboard.moodUseful')}
      summary={t('charts.moodUsefulSummary', {
        moodFrom: sum.moodFrom ?? '–',
        moodTo: sum.moodTo ?? '–',
        useFrom: sum.useFrom ?? '–',
        useTo: sum.useTo ?? '–',
        days: sum.days,
      })}
      points={n}
      height={height}
      actions={actions}
      table={{
        columns: [t('charts.day'), t('charts.mood'), t('charts.usefulness')],
        rows: points.map((p) => [p.day_key, p.mood_avg, p.usefulness]),
      }}
    >
      <div className={s.legend} aria-hidden="true">
        <span className={s.legendItem}>
          <span className={s.swatchLine} style={{ borderTopStyle: 'solid', borderTopColor: tok.progress }} />
          {t('charts.usefulness')}
        </span>
        <span className={s.legendItem}>
          <span className={s.swatchLine} style={{ borderTopStyle: 'dashed', borderTopColor: tok.feeling }} />
          {t('charts.mood')}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={height - 28}>
        <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={tok['line-soft']} vertical={false} />
          <XAxis
            dataKey="day_key"
            tickFormatter={(d: string) => formatShortDay(d)}
            tick={axisTick(tok.muted)}
            stroke={tok.line}
            minTickGap={24}
          />
          <YAxis
            yAxisId="use"
            domain={[0, 100]}
            tick={axisTick(tok.muted)}
            stroke={tok.line}
            label={{ value: '0–100', angle: -90, position: 'insideLeft', fill: tok.muted, fontSize: 11 }}
          />
          <YAxis
            yAxisId="mood"
            orientation="right"
            domain={[1, 5]}
            ticks={[1, 2, 3, 4, 5]}
            tick={axisTick(tok.muted)}
            stroke={tok.line}
            label={{ value: '1–5', angle: 90, position: 'insideRight', fill: tok.muted, fontSize: 11 }}
          />
          <Tooltip content={<MoodTooltip />} />
          <Line
            yAxisId="use"
            type="monotone"
            dataKey="usefulness"
            name={t('charts.usefulness')}
            stroke={tok.progress}
            strokeWidth={2.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            yAxisId="mood"
            type="monotone"
            dataKey="mood_avg"
            name={t('charts.mood')}
            stroke={tok.feeling}
            strokeWidth={2}
            strokeDasharray="6 4"
            connectNulls
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; payload?: DailyPoint; index?: number }) => {
              const { cx, cy, payload, index } = props;
              if (cx == null || cy == null || !payload?.comeback) return <g key={index} />;
              return <circle key={index} cx={cx} cy={cy} r={5} fill={tok.surface} stroke={tok.feeling} strokeWidth={2} />;
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ───────────────────────── Time per day (bar) ─────────────────────────
export function TimeBarChart({ points, title }: { points: { day_key: string; minutes: number }[]; title?: string }) {
  const { t } = useTranslation();
  const tok = useTokens();
  const sum = timeSummary(points);
  return (
    <ChartFrame
      title={title ?? t('dashboard.timePerDay')}
      summary={t('charts.timeSummary', {
        total: formatMinutes(sum.total),
        days: sum.days,
        best: sum.best ? formatShortDay(sum.best.day_key) : '–',
      })}
      points={countDataPoints(points, () => true)}
      height={200}
      table={{
        columns: [t('charts.day'), t('charts.minutes')],
        rows: points.map((p) => [p.day_key, p.minutes]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={tok['line-soft']} vertical={false} />
          <XAxis
            dataKey="day_key"
            tickFormatter={(d: string) => formatDay(d, { weekday: 'short' })}
            tick={axisTick(tok.muted)}
            stroke={tok.line}
          />
          <YAxis tick={axisTick(tok.muted)} stroke={tok.line} label={{ value: 'min', angle: -90, position: 'insideLeft', fill: tok.muted, fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: tok['progress-tint'] }}
            formatter={(v) => [formatMinutes(Number(v)), t('charts.minutes')]}
            labelFormatter={(d) => formatShortDay(String(d))}
          />
          <Bar dataKey="minutes" fill={tok.progress} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ───────────────────────── Heatmap (custom grid) ─────────────────────────
export function Heatmap({ cells, actions }: { cells: HeatCell[]; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  const tok = useTokens();
  const weeks = heatGrid(cells);
  const total = cells.reduce((a, c) => a + c.minutes, 0);
  const active = cells.filter((c) => c.minutes > 0).length;
  const colors = [tok['heat-0'], tok['heat-1'], tok['heat-2'], tok['heat-3'], tok['heat-4']];
  const days = t('charts.weekdays', { returnObjects: true }) as string[];
  return (
    <ChartFrame
      title={t('dashboard.activity')}
      summary={t('charts.heatmapSummary', { active, days: cells.length, total: formatMinutes(total) })}
      points={cells.length}
      height={150}
      actions={actions}
      table={{ columns: [t('charts.day'), t('charts.minutes')], rows: cells.filter((c) => c.minutes > 0).map((c) => [c.day_key, c.minutes]) }}
    >
      <div className={s.heat}>
        <div className={s.heatDays} aria-hidden="true">
          {days.map((d, i) => (
            <span key={d}>{i % 2 === 0 ? d : ''}</span>
          ))}
        </div>
        {weeks.map((col, i) => (
          <div key={i} className={s.heatCol}>
            {col.map((c, j) =>
              c ? (
                <span
                  key={c.day_key}
                  className={s.heatCell}
                  style={{ background: colors[c.bucket] }}
                  title={t('charts.heatCell', { day: formatShortDay(c.day_key), time: formatMinutes(c.minutes) })}
                />
              ) : (
                <span key={j} />
              ),
            )}
          </div>
        ))}
      </div>
      <div className={s.heatLegend} aria-hidden="true">
        {t('charts.heatLegendLess')}
        {colors.map((c) => (
          <span key={c} className={s.heatCell} style={{ background: c, display: 'inline-block' }} />
        ))}
        {t('charts.heatLegendMore')}
      </div>
    </ChartFrame>
  );
}

// ───────────────────────── Insights charts ─────────────────────────
export function MoodBeforeAfterChart({ rows }: { rows: InsightCharts['mood_before_after_weekly'] }) {
  const { t } = useTranslation();
  const tok = useTokens();
  const delta = moodDelta(rows);
  return (
    <ChartFrame
      title={t('charts.moodBeforeAfter')}
      summary={t('charts.moodBeforeAfterSummary', { delta: delta ?? 0 })}
      points={rows.length}
      table={{ columns: [t('charts.week'), t('charts.before'), t('charts.after')], rows: rows.map((r) => [r.week_start, r.before, r.after]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={tok['line-soft']} vertical={false} />
          <XAxis dataKey="week_start" tickFormatter={(d: string) => formatShortDay(d)} tick={axisTick(tok.muted)} stroke={tok.line} />
          <YAxis domain={[0, 5]} ticks={[1, 2, 3, 4, 5]} tick={axisTick(tok.muted)} stroke={tok.line} />
          <Tooltip labelFormatter={(d) => formatShortDay(String(d))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="before" name={t('charts.before')} fill={tok['feeling-tint']} stroke={tok.feeling} strokeDasharray="4 3" isAnimationActive={false} />
          <Bar dataKey="after" name={t('charts.after')} fill={tok.feeling} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function UsefulnessByHourChart({ rows }: { rows: InsightCharts['usefulness_by_hour'] }) {
  const { t } = useTranslation();
  const tok = useTokens();
  const top = [...rows].sort((a, b) => b.avg - a.avg)[0];
  return (
    <ChartFrame
      title={t('charts.usefulByHour')}
      summary={t('charts.usefulByHourSummary', { hour: top?.hour ?? '–', avg: top?.avg ?? '–' })}
      points={rows.length}
      table={{ columns: [t('charts.hour'), t('charts.usefulness'), t('charts.count')], rows: rows.map((r) => [`${r.hour}:00`, r.avg, r.sessions]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={tok['line-soft']} vertical={false} />
          <XAxis dataKey="hour" tickFormatter={(h: number) => `${h}:00`} tick={axisTick(tok.muted)} stroke={tok.line} />
          <YAxis domain={[0, 100]} tick={axisTick(tok.muted)} stroke={tok.line} />
          <Tooltip labelFormatter={(h) => `${h}:00`} />
          <Bar dataKey="avg" name={t('charts.usefulness')} fill={tok.progress} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function UsefulnessByWeekdayChart({ rows }: { rows: InsightCharts['usefulness_by_weekday'] }) {
  const { t } = useTranslation();
  const tok = useTokens();
  const names = t('charts.weekdays', { returnObjects: true }) as string[];
  const data = rows.map((r) => ({ ...r, name: names[r.weekday] }));
  const top = [...data].sort((a, b) => b.avg - a.avg)[0];
  return (
    <ChartFrame
      title={t('charts.usefulByWeekday')}
      summary={t('charts.usefulByWeekdaySummary', { day: top?.name ?? '–', avg: top?.avg ?? '–' })}
      points={rows.length}
      table={{ columns: [t('charts.weekday'), t('charts.usefulness')], rows: data.map((r) => [r.name, r.avg]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={tok['line-soft']} vertical={false} />
          <XAxis dataKey="name" tick={axisTick(tok.muted)} stroke={tok.line} />
          <YAxis domain={[0, 100]} tick={axisTick(tok.muted)} stroke={tok.line} />
          <Tooltip />
          <Bar dataKey="avg" name={t('charts.usefulness')} fill={tok.progress} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function SpeedChart({ rows }: { rows: InsightCharts['speed_by_difficulty'] }) {
  const { t } = useTranslation();
  const tok = useTokens();
  const { levels, data } = pivotSpeed(rows);
  const colors = seriesColors(tok);
  const dashes = ['', '6 4', '2 3', '10 3', '1 2'];
  return (
    <ChartFrame
      title={t('charts.speed')}
      summary={t('charts.speedSummary', { levels: levels.length, weeks: data.length })}
      points={rows.length}
      table={{
        columns: [t('charts.week'), ...levels.map((l) => t('common.level', { n: l }))],
        rows: data.map((r) => [String(r.week_start), ...levels.map((l) => r[`L${l}`] as number | null)]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={tok['line-soft']} vertical={false} />
          <XAxis dataKey="week_start" tickFormatter={(d: string) => formatShortDay(d)} tick={axisTick(tok.muted)} stroke={tok.line} />
          <YAxis tick={axisTick(tok.muted)} stroke={tok.line} label={{ value: 'min', angle: -90, position: 'insideLeft', fill: tok.muted, fontSize: 11 }} />
          <Tooltip labelFormatter={(d) => formatShortDay(String(d))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {levels.map((l, i) => (
            <Line
              key={l}
              dataKey={`L${l}`}
              name={t('common.level', { n: l })}
              stroke={colors[i % colors.length]}
              strokeDasharray={dashes[i % dashes.length]}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function FeelingsPerConceptChart({ rows }: { rows: InsightCharts['feelings_per_concept'] }) {
  const { t } = useTranslation();
  const tok = useTokens();
  const { keys, data } = stackFeelings(rows);
  const colors = seriesColors(tok);
  const top = rows[0];
  const topCount = top ? Object.values(top.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <ChartFrame
      title={t('charts.feelings')}
      summary={t('charts.feelingsSummary', { concept: top?.concept ?? '–', count: topCount })}
      points={rows.length}
      height={Math.max(220, rows.length * 30 + 60)}
      table={{ columns: ['Concept', ...keys], rows: data.map((r) => [String(r.concept), ...keys.map((k) => r[k] as number)]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 6, right: 8, bottom: 0, left: 24 }}>
          <CartesianGrid stroke={tok['line-soft']} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={axisTick(tok.muted)} stroke={tok.line} />
          <YAxis type="category" dataKey="concept" width={110} tick={axisTick(tok.muted)} stroke={tok.line} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {keys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="f" fill={colors[i % colors.length]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function TimeVsAttemptsChart({ rows }: { rows: InsightCharts['time_vs_attempts'] }) {
  const { t } = useTranslation();
  const tok = useTokens();
  return (
    <ChartFrame
      title={t('charts.timeVsAttempts')}
      summary={t('charts.timeVsAttemptsSummary', { shadow: shadowDays(rows), days: rows.length })}
      points={rows.length}
      table={{ columns: [t('charts.day'), t('charts.minutes'), t('charts.problemsAttempted')], rows: rows.map((r) => [r.day_key, r.minutes, r.attempted]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 6, right: 8, bottom: 8, left: -8 }}>
          <CartesianGrid stroke={tok['line-soft']} />
          <XAxis type="number" dataKey="minutes" name={t('charts.minutes')} tick={axisTick(tok.muted)} stroke={tok.line} label={{ value: 'min', position: 'insideBottomRight', fill: tok.muted, fontSize: 11 }} />
          <YAxis type="number" dataKey="attempted" name={t('charts.problemsAttempted')} allowDecimals={false} tick={axisTick(tok.muted)} stroke={tok.line} />
          <ZAxis range={[60, 60]} />
          <Tooltip formatter={(v, n) => [formatNumber(Number(v)), n]} />
          <Scatter data={rows} fill={tok.progress} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
