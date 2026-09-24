import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface UiState {
  /** user preference; null = automatic (collapse below 1200px) */
  sidebarCollapsed: boolean | null;
  lastPage: string;
  coachMarkSeen: boolean;
  quickLogOpen: boolean;
  setSidebarCollapsed: (v: boolean | null) => void;
  setLastPage: (p: string) => void;
  setCoachMarkSeen: () => void;
  setQuickLogOpen: (v: boolean) => void;
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
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      setLastPage: (p) => set({ lastPage: p }),
      setCoachMarkSeen: () => set({ coachMarkSeen: true }),
      setQuickLogOpen: (v) => set({ quickLogOpen: v }),
    }),
    {
      name: 'hello-world-ui',
      storage: createJSONStorage(safeStorage),
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        lastPage: s.lastPage,
        coachMarkSeen: s.coachMarkSeen,
      }),
    },
  ),
);
