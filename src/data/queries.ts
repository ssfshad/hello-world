/**
 * TanStack Query hooks per domain. Mutations invalidate the smallest set of
 * affected keys. Timer mutations push their ActiveState into timerStore.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type {
  ActiveState,
  AiProviderInput,
  AppSettings,
  CommandName,
  CommandResult,
  ConceptInput,
  ConceptUpdate,
  DayRange,
  DiarySaveInput,
  ImportInput,
  InsightRuleId,
  InsightTrigger,
  MoodKind,
  NodeStatus,
  OnboardingInput,
  PracticeConfig,
  ProblemFilter,
  ProblemInput,
  ProblemStatus,
  ProblemUpdate,
  ProfileUpdate,
  ReportInput,
  ResourceFilter,
  ReviewResult,
  RoadmapNodeInput,
  SearchFilters,
  SeriesMetric,
} from '@/core/types/api';
import { call } from './client';
import { useTimerStore } from '@/stores/timerStore';

export const qk = {
  app: ['app'] as const,
  day: (dayKey: string) => ['day', dayKey] as const,
  concepts: (range?: DayRange | null, lang?: string | null) =>
    ['concepts', range?.from ?? null, range?.to ?? null, lang ?? null] as const,
  conceptSearch: (prefix: string, lang?: string | null) =>
    ['concepts', 'search', prefix, lang ?? null] as const,
  categories: ['categories'] as const,
  problems: (filter: ProblemFilter) => ['problems', filter] as const,
  problem: (id: string) => ['problems', 'one', id] as const,
  feelings: ['feelings'] as const,
  moods: (range: DayRange) => ['moods', range.from, range.to] as const,
  stats: ['stats'] as const,
  insights: ['insights'] as const,
  review: ['review'] as const,
  resources: (f: ResourceFilter) => ['resources', f] as const,
  roadmaps: ['roadmaps'] as const,
  roadmap: (id: string) => ['roadmaps', id] as const,
  letters: ['letters'] as const,
  providers: ['providers'] as const,
  backups: ['backups'] as const,
  dataInfo: ['data-info'] as const,
  rulePrefs: ['insights', 'prefs'] as const,
  reliability: ['reliability'] as const,
  search: (q: string, f: SearchFilters) => ['search', q, f] as const,
};

type QOpts<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

// ───────────────────────── App ─────────────────────────
export function useAppState() {
  return useQuery({
    queryKey: qk.app,
    queryFn: async () => {
      const s = await call('app_state');
      useTimerStore.getState().setActive(s.active);
      return s;
    },
    staleTime: 30_000,
  });
}

export function useSettingsUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => call('settings_update', { patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.app }),
  });
}

export function useOnboardingComplete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OnboardingInput) => call('onboarding_complete', { input }),
    onSuccess: (state) => {
      qc.setQueryData(qk.app, state);
      qc.invalidateQueries();
    },
  });
}

export function useProfileUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProfileUpdate) => call('profile_update', { input }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useLanguageMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.app });
  return {
    add: useMutation({ mutationFn: (name: string) => call('language_add', { name }), onSuccess: done }),
    update: useMutation({
      mutationFn: (a: { id: string; name?: string | null; is_active?: boolean | null }) =>
        call('language_update', a),
      onSuccess: done,
    }),
    setPrimary: useMutation({
      mutationFn: (id: string) => call('language_set_primary', { id }),
      onSuccess: done,
    }),
  };
}

// ───────────────────────── Timers ─────────────────────────
function useTimerMutation<A>(fn: (a: A) => Promise<ActiveState>) {
  const qc = useQueryClient();
  const setActive = useTimerStore((s) => s.setActive);
  return useMutation({
    mutationFn: fn,
    onSuccess: (state) => {
      setActive(state);
      qc.invalidateQueries({ queryKey: ['day'] });
      qc.invalidateQueries({ queryKey: ['problems'] });
      qc.invalidateQueries({ queryKey: qk.stats });
    },
  });
}

export function useTimerActions() {
  const qc = useQueryClient();
  const setActive = useTimerStore((s) => s.setActive);
  return {
    start: useTimerMutation((language_id: string | null | undefined) =>
      call('session_start', { language_id: language_id ?? null }),
    ),
    pause: useTimerMutation(() => call('session_pause')),
    resume: useTimerMutation(() => call('session_resume')),
    end: useMutation({
      mutationFn: (a: { ended_at?: string | null; confirm_long?: boolean }) => call('session_end', a),
      onSuccess: (res) => {
        setActive(res.state);
        qc.invalidateQueries({ queryKey: ['day'] });
        qc.invalidateQueries({ queryKey: ['problems'] });
        qc.invalidateQueries({ queryKey: qk.stats });
      },
    }),
    resolveStale: useTimerMutation((a: { action: 'keep' | 'end'; ended_at?: string | null }) =>
      call('session_resolve_stale', a),
    ),
    attemptStart: useTimerMutation((problem_id: string) => call('attempt_start', { problem_id })),
    attemptPause: useTimerMutation(() => call('attempt_pause')),
    attemptResume: useTimerMutation(() => call('attempt_resume')),
    attemptEnd: useTimerMutation(() => call('attempt_end')),
  };
}

export function useSessionEdit() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ['day'] });
    qc.invalidateQueries({ queryKey: qk.stats });
  };
  return {
    update: useMutation({
      mutationFn: (a: CommandArgsOf<'session_update'>) => call('session_update', a),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => call('session_delete', { id }), onSuccess: inv }),
  };
}

type CommandArgsOf<K extends CommandName> = import('@/core/types/api').CommandArgs<K>;

// ───────────────────────── Day ─────────────────────────
export function useDay(dayKey: string | null | undefined) {
  return useQuery({
    queryKey: qk.day(dayKey ?? ''),
    queryFn: () => call('day_get', { day_key: dayKey! }),
    enabled: !!dayKey,
  });
}

function invalidateDayWide(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['day'] });
  qc.invalidateQueries({ queryKey: qk.stats });
}

export function useDayClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { day_key: string; self_usefulness?: number | null }) => call('day_close', a),
    onSuccess: () => {
      invalidateDayWide(qc);
      qc.invalidateQueries({ queryKey: qk.insights });
    },
  });
}

export function useSelfUsefulness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { day_key: string; value: number }) => call('day_set_self_usefulness', a),
    onSuccess: (view) => {
      qc.setQueryData(qk.day(view.day_key), view);
      qc.invalidateQueries({ queryKey: qk.stats });
    },
  });
}

// ───────────────────────── Concepts ─────────────────────────
export function useCategories() {
  return useQuery({ queryKey: qk.categories, queryFn: () => call('concept_category_list') });
}

export function useConcepts(range?: DayRange | null, languageId?: string | null) {
  return useQuery({
    queryKey: qk.concepts(range, languageId),
    queryFn: () => call('concept_list', { range: range ?? null, language_id: languageId ?? null }),
  });
}

export function useConceptSearch(prefix: string, languageId?: string | null) {
  return useQuery({
    queryKey: qk.conceptSearch(prefix, languageId),
    queryFn: () => call('concept_search', { prefix, language_id: languageId ?? null }),
    enabled: prefix.trim().length > 0,
    staleTime: 10_000,
  });
}

export function useConceptMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ['concepts'] });
    qc.invalidateQueries({ queryKey: qk.review });
    invalidateDayWide(qc);
  };
  return {
    add: useMutation({ mutationFn: (input: ConceptInput) => call('concept_add', { input }), onSuccess: inv }),
    update: useMutation({
      mutationFn: (input: ConceptUpdate) => call('concept_update', { input }),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => call('concept_delete', { id }), onSuccess: inv }),
    addCategory: useMutation({
      mutationFn: (name: string) => call('concept_category_add', { name }),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.categories }),
    }),
  };
}

// ───────────────────────── Problems ─────────────────────────
export function useProblems(filter: ProblemFilter, opts?: QOpts<CommandResult<'problem_list'>>) {
  return useQuery({
    queryKey: qk.problems(filter),
    queryFn: () => call('problem_list', { filter }),
    ...opts,
  });
}

export function useProblemMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ['problems'] });
    qc.invalidateQueries({ queryKey: qk.review });
    invalidateDayWide(qc);
  };
  return {
    add: useMutation({ mutationFn: (input: ProblemInput) => call('problem_add', { input }), onSuccess: inv }),
    update: useMutation({
      mutationFn: (input: ProblemUpdate) => call('problem_update', { input }),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => call('problem_delete', { id }), onSuccess: inv }),
    setStatus: useMutation({
      mutationFn: (a: { id: string; status: ProblemStatus }) => call('problem_set_status', a),
      onSuccess: inv,
    }),
    reveal: useMutation({
      mutationFn: (a: { id: string; what: 'hint' | 'answer' }) => call('problem_reveal', a),
      onSuccess: inv,
    }),
    flag: useMutation({
      mutationFn: (a: { id: string; flagged: boolean }) => call('problem_flag_bad', a),
      onSuccess: () => {
        inv();
        qc.invalidateQueries({ queryKey: qk.reliability });
      },
    }),
  };
}

// ───────────────────────── Mood / diary / feelings ─────────────────────────
export function useMoodCheckin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { value: number; kind: MoodKind; session_id?: string | null }) =>
      call('mood_checkin', a),
    onSuccess: () => {
      invalidateDayWide(qc);
      qc.invalidateQueries({ queryKey: qk.insights });
      qc.invalidateQueries({ queryKey: ['moods'] });
    },
  });
}

export function useMoodHistory(range: DayRange) {
  return useQuery({ queryKey: qk.moods(range), queryFn: () => call('mood_history', { range }) });
}

export function useFeelingTags() {
  return useQuery({ queryKey: qk.feelings, queryFn: () => call('feeling_tag_list'), staleTime: 60_000 });
}

export function useFeelingTagAdd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { name: string; valence: -1 | 0 | 1 }) => call('feeling_tag_add', a),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.feelings }),
  });
}

export function useDiarySave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DiarySaveInput) => call('diary_save', { input }),
    onSuccess: (entry) => {
      qc.setQueryData(qk.day(entry.day_key), (old: CommandResult<'day_get'> | undefined) =>
        old ? { ...old, diary: entry } : old,
      );
      qc.invalidateQueries({ queryKey: qk.stats });
    },
  });
}

export function useDiaryAiSuggest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (day_key: string) => call('diary_ai_suggest_links', { day_key }),
    onSuccess: (entry) => {
      qc.setQueryData(qk.day(entry.day_key), (old: CommandResult<'day_get'> | undefined) =>
        old ? { ...old, diary: entry } : old,
      );
    },
  });
}

export function useDiaryDismissLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { diary_id: string; concept_id: string }) => call('diary_dismiss_link', a),
    onSuccess: (entry) => qc.invalidateQueries({ queryKey: qk.day(entry.day_key) }),
  });
}

// ───────────────────────── Stats ─────────────────────────
export function useStatsOverview(languageId?: string | null) {
  return useQuery({
    queryKey: [...qk.stats, 'overview', languageId ?? null],
    queryFn: () => call('stats_overview', { language_id: languageId ?? null }),
  });
}

export function useStatsSeries(metric: SeriesMetric, range: DayRange, languageId?: string | null) {
  return useQuery({
    queryKey: [...qk.stats, 'series', metric, range.from, range.to, languageId ?? null],
    queryFn: () => call('stats_series', { metric, range, language_id: languageId ?? null }),
  });
}

export function useStatsDaily(range: DayRange, languageId?: string | null, enabled = true) {
  return useQuery({
    queryKey: [...qk.stats, 'daily', range.from, range.to, languageId ?? null],
    queryFn: () => call('stats_daily', { range, language_id: languageId ?? null }),
    enabled,
  });
}

export function useHeatmap(range: DayRange) {
  return useQuery({
    queryKey: [...qk.stats, 'heatmap', range.from, range.to],
    queryFn: () => call('stats_heatmap', { range }),
  });
}

export function useInsightCharts(range: DayRange, languageId?: string | null) {
  return useQuery({
    queryKey: [...qk.stats, 'charts', range.from, range.to, languageId ?? null],
    queryFn: () => call('stats_charts', { range, language_id: languageId ?? null }),
  });
}

// ───────────────────────── Insights ─────────────────────────
export function useInsights(includeDismissed = false) {
  return useQuery({
    queryKey: [...qk.insights, includeDismissed],
    queryFn: () => call('insights_list', { include_dismissed: includeDismissed }),
  });
}

export function useInsightActions() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.insights });
  return {
    evaluate: useMutation({
      mutationFn: (trigger: InsightTrigger) => call('insights_evaluate', { trigger }),
      onSuccess: inv,
    }),
    dismiss: useMutation({
      mutationFn: (a: { id: string; disable_rule?: boolean }) => call('insight_dismiss', a),
      onSuccess: inv,
    }),
    markSeen: useMutation({ mutationFn: (ids: string[]) => call('insight_mark_seen', { ids }) }),
    toggleRule: useMutation({
      mutationFn: (a: { rule_id: InsightRuleId; enabled: boolean }) => call('insight_rule_toggle', a),
      onSuccess: inv,
    }),
  };
}

export function useRulePrefs() {
  return useQuery({ queryKey: qk.rulePrefs, queryFn: () => call('insight_rule_prefs') });
}

// ───────────────────────── Review ─────────────────────────
export function useReviewDue(limit = 5) {
  return useQuery({ queryKey: [...qk.review, limit], queryFn: () => call('review_due', { limit }) });
}

export function useReviewRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { concept_id: string; result: ReviewResult }) => call('review_record', a),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.review });
      qc.invalidateQueries({ queryKey: ['concepts'] });
    },
  });
}

// ───────────────────────── Practice / AI ─────────────────────────
export function useBuiltPrompt(config: PracticeConfig | null) {
  return useQuery({
    queryKey: ['practice', 'prompt', config],
    queryFn: () => call('practice_build_prompt', { config: config! }),
    enabled: !!config && config.concept_ids.length > 0,
  });
}

export function usePracticeActions() {
  const qc = useQueryClient();
  return {
    generate: useMutation({ mutationFn: (config: PracticeConfig) => call('practice_generate', { config }) }),
    cancel: useMutation({ mutationFn: () => call('practice_cancel') }),
    validate: useMutation({
      mutationFn: (a: { raw_text: string; config: PracticeConfig }) => call('practice_validate_response', a),
    }),
    importResponse: useMutation({
      mutationFn: (input: ImportInput) => call('practice_import_response', { input }),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ['problems'] });
        qc.invalidateQueries({ queryKey: qk.reliability });
      },
    }),
    fixup: useMutation({ mutationFn: (raw_text: string) => call('practice_fixup_prompt', { raw_text }) }),
  };
}

export function useReliability() {
  return useQuery({ queryKey: qk.reliability, queryFn: () => call('practice_reliability') });
}

export function useProviders() {
  return useQuery({ queryKey: qk.providers, queryFn: () => call('ai_provider_list') });
}

export function useProviderMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.providers });
  return {
    save: useMutation({ mutationFn: (input: AiProviderInput) => call('ai_provider_save', { input }), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => call('ai_provider_delete', { id }), onSuccess: inv }),
    setKey: useMutation({
      mutationFn: (a: { id: string; key: string }) => call('ai_provider_set_key', a),
      onSuccess: inv,
    }),
    test: useMutation({ mutationFn: (id: string) => call('ai_provider_test', { id }) }),
  };
}

// ───────────────────────── Reports ─────────────────────────
export function useReportActions() {
  return {
    data: useMutation({ mutationFn: (input: ReportInput) => call('report_data', { input }) }),
    savePdf: useMutation({
      mutationFn: (a: { bytes: number[]; suggested_name: string }) => call('report_save_pdf', a),
    }),
    markdown: useMutation({ mutationFn: (input: ReportInput) => call('report_markdown', { input }) }),
    saveMarkdown: useMutation({
      mutationFn: (a: { input: ReportInput; suggested_name: string }) => call('report_save_markdown', a),
    }),
  };
}

// ───────────────────────── Library ─────────────────────────
export function useResources(filter: ResourceFilter) {
  return useQuery({ queryKey: qk.resources(filter), queryFn: () => call('resource_list', { filter }) });
}

export function useResourceMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ['resources'] });
  return {
    addLink: useMutation({
      mutationFn: (a: CommandArgsOf<'resource_add_link'>) => call('resource_add_link', a),
      onSuccess: inv,
    }),
    addFile: useMutation({
      mutationFn: (a: CommandArgsOf<'resource_add_file'>) => call('resource_add_file', a),
      onSuccess: inv,
    }),
    addNote: useMutation({
      mutationFn: (a: CommandArgsOf<'resource_add_note'>) => call('resource_add_note', a),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (a: CommandArgsOf<'resource_update'>) => call('resource_update', a),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => call('resource_delete', { id }), onSuccess: inv }),
    open: useMutation({ mutationFn: (id: string) => call('resource_open', { id }) }),
    fetchTitle: useMutation({ mutationFn: (url: string) => call('resource_fetch_title', { url }) }),
    openFolder: useMutation({ mutationFn: () => call('library_open_folder') }),
  };
}

// ───────────────────────── Roadmaps ─────────────────────────
export function useRoadmaps() {
  return useQuery({ queryKey: qk.roadmaps, queryFn: () => call('roadmap_list') });
}

export function useRoadmap(id: string | null) {
  return useQuery({
    queryKey: qk.roadmap(id ?? ''),
    queryFn: () => call('roadmap_get', { id: id! }),
    enabled: !!id,
  });
}

export function useRoadmapMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.roadmaps });
  return {
    create: useMutation({ mutationFn: (title: string) => call('roadmap_create', { title }), onSuccess: inv }),
    update: useMutation({
      mutationFn: (a: { id: string; title: string }) => call('roadmap_update', a),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => call('roadmap_delete', { id }), onSuccess: inv }),
    upsertNode: useMutation({
      mutationFn: (input: RoadmapNodeInput) => call('roadmap_node_upsert', { input }),
      onSuccess: inv,
    }),
    deleteNode: useMutation({ mutationFn: (id: string) => call('roadmap_node_delete', { id }), onSuccess: inv }),
    moveNode: useMutation({
      mutationFn: (a: { id: string; parent_id: string | null; position: number }) =>
        call('roadmap_node_move', a),
      onSuccess: inv,
    }),
    setStatus: useMutation({
      mutationFn: (a: { id: string; status: NodeStatus }) => call('roadmap_node_set_status', a),
      onSuccess: inv,
    }),
    importJson: useMutation({ mutationFn: (path: string) => call('roadmap_import_json', { path }), onSuccess: inv }),
    exportJson: useMutation({
      mutationFn: (a: { id: string; path: string }) => call('roadmap_export_json', a),
    }),
  };
}

// ───────────────────────── Letters ─────────────────────────
export function useLetters() {
  return useQuery({ queryKey: qk.letters, queryFn: () => call('letter_list') });
}

export function useLetterMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.letters });
  return {
    write: useMutation({
      mutationFn: (a: { body: string; open_after: string }) => call('letter_write', a),
      onSuccess: inv,
    }),
    open: useMutation({ mutationFn: (id: string) => call('letter_open', { id }), onSuccess: inv }),
  };
}

// ───────────────────────── Search ─────────────────────────
export function useSearch(query: string, filters: SearchFilters) {
  return useQuery({
    queryKey: qk.search(query, filters),
    queryFn: () => call('search', { query, filters }),
    enabled: query.trim().length >= 2,
  });
}

// ───────────────────────── Data ─────────────────────────
export function useBackups() {
  return useQuery({ queryKey: qk.backups, queryFn: () => call('backup_list') });
}

export function useDataInfo() {
  return useQuery({ queryKey: qk.dataInfo, queryFn: () => call('data_info') });
}

export function useDataActions() {
  const qc = useQueryClient();
  return {
    backupNow: useMutation({
      mutationFn: () => call('backup_now'),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.backups }),
    }),
    restore: useMutation({
      mutationFn: (id: string) => call('backup_restore', { id }),
      onSuccess: () => qc.invalidateQueries(),
    }),
    exportAll: useMutation({
      mutationFn: (a: { path: string; include_library: boolean }) => call('export_all_json', a),
    }),
    deleteAll: useMutation({
      mutationFn: (confirm_phrase: string) => call('delete_all_data', { confirm_phrase }),
      onSuccess: () => qc.invalidateQueries(),
    }),
    moveDir: useMutation({
      mutationFn: (path: string) => call('data_dir_move', { path }),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.dataInfo }),
    }),
    diagnostics: useMutation({ mutationFn: (path: string) => call('diagnostics_export', { path }) }),
  };
}
