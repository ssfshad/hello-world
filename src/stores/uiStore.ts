import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface LessonFilters {
  /** '' = all courses, '__none' = lessons without a course */
  course: string;
  when: 'any' | '7' | '30' | '90' | '365';
  /** '' = any concept */
  concept: string;
  has: 'any' | 'pictures' | 'concepts' | 'empty';
  sort: 'course' | 'newest' | 'oldest' | 'edited' | 'az';
}
export const DEFAULT_LESSON_FILTERS: LessonFilters = { course: '', when: 'any', concept: '', has: 'any', sort: 'course' };

interface UiState {
  /** user preference; null = automatic (collapse below 1200px) */
  sidebarCollapsed: boolean | null;
  lastPage: string;
  coachMarkSeen: boolean;
  quickLogOpen: boolean;
  /** the getting-started guide was hidden by the learner */
  guideHidden: boolean;
  /** day_key the welcome-back card was dismissed on */
  welcomeDismissed: string | null;
  /** week_start whose "week in review" card was put off */
  weekCardDismissed: string | null;
  /** Notebook shelf filters, remembered between visits */
  lessonFilters: LessonFilters;
  setLessonFilters: (f: Partial<LessonFilters> | null) => void;
  setSidebarCollapsed: (v: boolean | null) => void;
  setLastPage: (p: string) => void;
  setCoachMarkSeen: () => void;
  setQuickLogOpen: (v: boolean) => void;
  setGuideHidden: (v: boolean) => void;
  setWelcomeDismissed: (day: string) => void;
  setWeekCardDismissed: (week: string) => void;
}

function safeStorage() {
  try {
    const k = '__hw_probe';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: null,
      lastPage: '/today',
      coachMarkSeen: false,
      quickLogOpen: false,
      guideHidden: false,
      welcomeDismissed: null,
      weekCardDismissed: null,
      lessonFilters: DEFAULT_LESSON_FILTERS,
      setLessonFilters: (f) =>
        set((st) => ({ lessonFilters: f ? { ...st.lessonFilters, ...f } : DEFAULT_LESSON_FILTERS })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      setLastPage: (p) => set({ lastPage: p }),
      setCoachMarkSeen: () => set({ coachMarkSeen: true }),
      setQuickLogOpen: (v) => set({ quickLogOpen: v }),
      setGuideHidden: (v) => set({ guideHidden: v }),
      setWelcomeDismissed: (day) => set({ welcomeDismissed: day }),
      setWeekCardDismissed: (week) => set({ weekCardDismissed: week }),
    }),
    {
      name: 'hello-world-ui',
      storage: createJSONStorage(safeStorage),
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        lastPage: s.lastPage,
        coachMarkSeen: s.coachMarkSeen,
        guideHidden: s.guideHidden,
        welcomeDismissed: s.welcomeDismissed,
        weekCardDismissed: s.weekCardDismissed,
        lessonFilters: s.lessonFilters,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        return { ...current, ...p, lessonFilters: { ...DEFAULT_LESSON_FILTERS, ...(p.lessonFilters ?? {}) } };
      },
    },
  ),
);
