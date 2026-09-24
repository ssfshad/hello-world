import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Mail, MailOpen, PenLine } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import { Button, Card, EmptyState, Modal, Tabs, TextArea, TextField, toast } from '@/components/ui';
import {
  FeelingsPerConceptChart,
  MoodBeforeAfterChart,
  MoodUsefulnessChart,
  SpeedChart,
  TimeVsAttemptsChart,
  UsefulnessByHourChart,
  UsefulnessByWeekdayChart,
} from '@/components/charts';
import { InsightCard } from '@/components/domain/InsightCard';
import {
  useAppState,
  useInsightActions,
  useInsightCharts,
  useInsights,
  useLetterMutations,
  useLetters,
  useRulePrefs,
  useStatsDaily,
} from '@/data/queries';
import { addDays } from '@/lib/day';
import { formatDay } from '@/lib/format';
import s from '../pages.module.css';

export default function InsightsPage() {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const today = app?.today ?? '';
  const [range, setRange] = useState<'30' | '90' | 'all'>('30');
  const from = range === 'all' ? (app?.profile?.journey_start ?? addDays(today, -365)) : addDays(today, -(Number(range) - 1));
  const { data: daily = [] } = useStatsDaily({ from, to: today }, null, !!today);
  const { data: charts } = useInsightCharts({ from: addDays(today, -89), to: today });
  const { data: insights = [] } = useInsights();
  const { data: prefs = [] } = useRulePrefs();
  const actions = useInsightActions();
  const hidden = prefs.filter((p) => !p.enabled);

  if (!app) return null;

  return (
    <>
      <PageHeader context={t('insights.context')} title={t('insights.title')} />
      <div className={s.insightsGrid}>
        <div className="stack" style={{ gap: 20 }}>
          <MoodUsefulnessChart
            title={t('insights.timeline')}
            points={daily}
            height={280}
            actions={
              <Tabs
                label={t('common.range')}
                value={range}
                onChange={setRange}
                options={[
                  { value: '30', label: t('common.lastNDays', { n: 30 }) },
                  { value: '90', label: t('common.lastNDays', { n: 90 }) },
                  { value: 'all', label: t('common.all') },
                ]}
              />
            }
          />
          {charts && (
            <>
              <div className={s.charts2}>
                <MoodBeforeAfterChart rows={charts.mood_before_after_weekly} />
                <TimeVsAttemptsChart rows={charts.time_vs_attempts} />
              </div>
              <div className={s.charts2}>
                <UsefulnessByHourChart rows={charts.usefulness_by_hour} />
                <UsefulnessByWeekdayChart rows={charts.usefulness_by_weekday} />
              </div>
              <div className={s.charts2}>
                <SpeedChart rows={charts.speed_by_difficulty} />
                <FeelingsPerConceptChart rows={charts.feelings_per_concept} />
              </div>
            </>
          )}
        </div>

        <div className="stack" style={{ gap: 20 }}>
          <section aria-labelledby="active-insights" className="stack" style={{ gap: 12 }}>
            <h2 id="active-insights" className="serif" style={{ fontWeight: 500, fontSize: '1.4rem' }}>
              {t('insights.active')}
            </h2>
            {insights.length === 0 ? (
              <EmptyState>{t('insights.none')}</EmptyState>
            ) : (
              insights.map((i) => (
                <InsightCard
                  key={i.id}
                  insight={i}
                  onDismiss={() => actions.dismiss.mutate({ id: i.id })}
                  onDisableRule={() => actions.dismiss.mutate({ id: i.id, disable_rule: true })}
                />
              ))
            )}
            {hidden.length > 0 && (
              <Card title={t('insights.hiddenTypes')}>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack">
                  {hidden.map((h) => (
                    <li key={h.rule_id} className="row">
                      <span style={{ flex: 1 }}>{t(`insights.rules.${h.rule_id}`)}</span>
                      <Button size="sm" onClick={() => actions.toggleRule.mutate({ rule_id: h.rule_id, enabled: true })}>
                        {t('insights.showAgain')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
          <Letters today={today} />
        </div>
      </div>
    </>
  );
}

function Letters({ today }: { today: string }) {
  const { t } = useTranslation();
  const { data: letters = [] } = useLetters();
  const m = useLetterMutations();
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState('');
  const [openAfter, setOpenAfter] = useState(() => addDays(today, 30));

  return (
    <Card
      title={t('insights.letters')}
      actions={
        <Button size="sm" icon={<PenLine size={14} />} onClick={() => setWriting(true)}>
          {t('insights.writeLetter')}
        </Button>
      }
    >
      {letters.length === 0 ? (
        <EmptyState icon={<Mail size={20} />}>{t('insights.noLetters')}</EmptyState>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack">
          {letters.map((l) => (
            <li key={l.id} className={s.letter}>
              <div className="row">
                {l.body ? <MailOpen size={16} aria-hidden="true" /> : l.can_open ? <Mail size={16} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
                <span className="muted" style={{ fontSize: '0.83rem', flex: 1 }}>
                  {t('insights.writtenOn', { date: formatDay(l.written_at.slice(0, 10), { dateStyle: 'medium' }) })}
                </span>
                {!l.body &&
                  (l.can_open ? (
                    <Button size="sm" variant="primary" onClick={() => m.open.mutate(l.id)}>
                      {t('insights.openLetter')}
                    </Button>
                  ) : (
                    <span className="muted" style={{ fontSize: '0.83rem' }}>
                      {t('insights.sealed', { date: formatDay(l.open_after, { dateStyle: 'medium' }) })}
                    </span>
                  ))}
              </div>
              {l.body && <p className={s.letterBody}>{l.body}</p>}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={writing}
        onClose={() => setWriting(false)}
        title={t('insights.writeLetter')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setWriting(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!body.trim()}
              loading={m.write.isPending}
              onClick={() =>
                m.write.mutate(
                  { body: body.trim(), open_after: openAfter },
                  {
                    onSuccess: () => {
                      setWriting(false);
                      setBody('');
                      toast.info(t('insights.sealed', { date: formatDay(openAfter, { dateStyle: 'medium' }) }));
                    },
                  },
                )
              }
            >
              {t('insights.seal')}
            </Button>
          </>
        }
      >
        <TextArea label={t('insights.letterBody')} value={body} rows={8} maxLength={10_000} onChange={(e) => setBody(e.target.value)} placeholder={t('onboarding.letterPlaceholder')} />
        <TextField label={t('insights.openAfter')} type="date" value={openAfter} min={addDays(today, 1)} onChange={(e) => setOpenAfter(e.target.value)} />
      </Modal>
    </Card>
  );
}
