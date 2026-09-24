import { create } from 'zustand';

/**
 * Unsaved diary text and form drafts. Diary drafts are flushed to the local DB
 * (diary_save) every 2 s by `useDiaryAutosave`; this store just holds the text
 * between keystrokes and across page switches.
 */
interface DiaryDraft {
  body: string;
  concept_ids: string[];
  feeling_tag_ids: string[];
  dirty: boolean;
}

interface DraftState {
  diary: Record<string, DiaryDraft>;
  forms: Record<string, unknown>;
  setDiary: (dayKey: string, patch: Partial<DiaryDraft>) => void;
  markSaved: (dayKey: string) => void;
  clearDiary: (dayKey: string) => void;
  setForm: (key: string, value: unknown) => void;
  clearForm: (key: string) => void;
}

const empty: DiaryDraft = { body: '', concept_ids: [], feeling_tag_ids: [], dirty: false };

export const useDraftStore = create<DraftState>((set) => ({
  diary: {},
  forms: {},
  setDiary: (dayKey, patch) =>
    set((s) => ({
      diary: { ...s.diary, [dayKey]: { ...(s.diary[dayKey] ?? empty), ...patch, dirty: true } },
    })),
  markSaved: (dayKey) =>
    set((s) =>
      s.diary[dayKey] ? { diary: { ...s.diary, [dayKey]: { ...s.diary[dayKey], dirty: false } } } : s,
    ),
  clearDiary: (dayKey) =>
    set((s) => {
      const next = { ...s.diary };
      delete next[dayKey];
      return { diary: next };
    }),
  setForm: (key, value) => set((s) => ({ forms: { ...s.forms, [key]: value } })),
  clearForm: (key) =>
    set((s) => {
      const next = { ...s.forms };
      delete next[key];
      return { forms: next };
    }),
}));

export const AUTOSAVE_MS = 2000;
