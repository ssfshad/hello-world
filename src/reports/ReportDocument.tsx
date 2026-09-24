/**
 * PDF report template (@react-pdf/renderer). Uses the built-in PDF fonts
 * (Helvetica/Times/Courier) so rendering needs no network or font files.
 */
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ReportData } from '@/core/types/api';
import { formatDuration } from '@/lib/format';

const teal = '#1F6F78';
const orange = '#B2501A';
const ink = '#1E1D1A';
const muted = '#5E5A52';
const line = '#E4DFD3';

const st = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Helvetica', fontSize: 10, color: ink, lineHeight: 1.4 },
  title: { fontFamily: 'Times-Roman', fontSize: 26, marginBottom: 4 },
  sub: { color: muted, marginBottom: 18 },
  h2: { fontFamily: 'Times-Roman', fontSize: 15, marginTop: 16, marginBottom: 6, color: teal },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { width: '23%', padding: 8, borderWidth: 1, borderColor: line, borderRadius: 6 },
  statLabel: { color: muted, fontSize: 8 },
  statValue: { fontFamily: 'Courier', fontSize: 14, marginTop: 2 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: line, paddingVertical: 3 },
  cell: { flex: 1 },
  cellWide: { flex: 3 },
  head: { fontFamily: 'Helvetica-Bold', color: muted, fontSize: 8 },
  note: { color: muted, fontFamily: 'Times-Italic' },
  diary: { fontFamily: 'Times-Roman', fontSize: 11, marginBottom: 6 },
  footer: { position: 'absolute', bottom: 24, left: 40, right: 40, color: muted, fontSize: 8, textAlign: 'center' },
  feel: { color: orange },
});

export interface ReportLabels {
  title: string;
  range: string;
  journeyDay: string;
  totals: string;
  focused: string;
  activeDays: string;
  concepts: string;
  solved: string;
  attempted: string;
  avgMood: string;
  avgUseful: string;
  streak: string;
  conceptsList: string;
  problemsList: string;
  daily: string;
  insights: string;
  diary: string;
  footer: string;
  status: Record<string, string>;
  insightText: (id: string) => string;
}

export function ReportDocument({ data, labels }: { data: ReportData; labels: ReportLabels }) {
  const tot = data.totals;
  const stats: [string, string][] = [
    [labels.focused, formatDuration(tot.focused_seconds)],
    [labels.activeDays, String(tot.days_active)],
    [labels.concepts, String(tot.concepts)],
    [labels.solved, String(tot.problems_solved)],
    [labels.attempted, String(tot.problems_attempted)],
    [labels.avgMood, tot.avg_mood != null ? `${tot.avg_mood} / 5` : '–'],
    [labels.avgUseful, tot.avg_usefulness != null ? `${tot.avg_usefulness} / 100` : '–'],
    [labels.streak, String(tot.current_streak)],
  ];
  return (
    <Document title={`${labels.title} — ${data.profile.display_name}`} author="Hello World">
      <Page size="A4" style={st.page}>
        <Text style={st.title}>
          {labels.title} — {data.profile.display_name}
        </Text>
        <Text style={st.sub}>
          {labels.range}
          {data.language ? ` · ${data.language}` : ''} · {labels.journeyDay}
        </Text>

        <Text style={st.h2}>{labels.totals}</Text>
        <View style={st.grid}>
          {stats.map(([l, v]) => (
            <View key={l} style={st.stat}>
              <Text style={st.statLabel}>{l}</Text>
              <Text style={st.statValue}>{v}</Text>
            </View>
          ))}
        </View>

        {data.insights.length > 0 && (
          <>
            <Text style={st.h2}>{labels.insights}</Text>
            {data.insights.map((i) => (
              <Text key={i.id} style={{ marginBottom: 4 }}>
                • {labels.insightText(i.id)}
              </Text>
            ))}
          </>
        )}

        <Text style={st.h2}>{labels.conceptsList}</Text>
        <View style={[st.row, st.head]}>
          <Text style={st.cell}>Concept</Text>
          <Text style={st.cellWide}>Note</Text>
          <Text style={st.cell}>Learned</Text>
          <Text style={st.cell}>Practiced</Text>
        </View>
        {data.concepts.map((c) => (
          <View key={c.name + c.learned_day_key} style={st.row} wrap={false}>
            <Text style={st.cell}>
              {c.name}
              {c.felt_stuck ? ' *' : ''}
            </Text>
            <Text style={[st.cellWide, st.note]}>{c.note ?? ''}</Text>
            <Text style={st.cell}>{c.learned_day_key}</Text>
            <Text style={st.cell}>{c.practiced_count}×</Text>
          </View>
        ))}

        <Text style={st.h2}>{labels.problemsList}</Text>
        <View style={[st.row, st.head]}>
          <Text style={st.cellWide}>Problem</Text>
          <Text style={st.cell}>Level</Text>
          <Text style={st.cell}>Status</Text>
          <Text style={st.cell}>Time</Text>
          <Text style={st.cell}>Feeling</Text>
        </View>
        {data.problems.map((p, i) => (
          <View key={i} style={st.row} wrap={false}>
            <Text style={st.cellWide}>{p.title}</Text>
            <Text style={st.cell}>{p.difficulty ?? '–'}</Text>
            <Text style={st.cell}>{labels.status[p.status] ?? p.status}</Text>
            <Text style={st.cell}>{formatDuration(p.seconds)}</Text>
            <Text style={[st.cell, st.feel]}>{p.feeling ?? ''}</Text>
          </View>
        ))}

        <Text style={st.h2}>{labels.daily}</Text>
        <View style={[st.row, st.head]}>
          <Text style={st.cell}>Day</Text>
          <Text style={st.cell}>Minutes</Text>
          <Text style={st.cell}>Mood</Text>
          <Text style={st.cell}>Usefulness</Text>
          <Text style={st.cell}>Concepts</Text>
          <Text style={st.cell}>Solved</Text>
        </View>
        {data.days
          .filter((d) => d.minutes > 0 || d.concepts > 0 || d.solved > 0)
          .map((d) => (
            <View key={d.day_key} style={st.row} wrap={false}>
              <Text style={st.cell}>{d.day_key}</Text>
              <Text style={st.cell}>{d.minutes}</Text>
              <Text style={[st.cell, st.feel]}>{d.mood_avg ?? '–'}</Text>
              <Text style={st.cell}>{d.usefulness ?? '–'}</Text>
              <Text style={st.cell}>{d.concepts}</Text>
              <Text style={st.cell}>{d.solved}</Text>
            </View>
          ))}

        {data.diary && data.diary.length > 0 && (
          <>
            <Text style={st.h2}>{labels.diary}</Text>
            {data.diary.map((d) => (
              <View key={d.day_key} wrap={false}>
                <Text style={st.statLabel}>{d.day_key}</Text>
                <Text style={st.diary}>{d.body}</Text>
              </View>
            ))}
          </>
        )}

        <Text style={st.footer} fixed render={({ pageNumber, totalPages }) => `${labels.footer} · ${pageNumber}/${totalPages}`} />
      </Page>
    </Document>
  );
}
