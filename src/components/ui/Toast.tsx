import { useEffect } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';
import s from './ui.module.css';

interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action?: { label: string; onClick: () => void };
  ms: number;
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: number) => void;
}

let seq = 0;
const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (t) => set((st) => ({ items: [...st.items.slice(-3), { ...t, id: ++seq }] })),
  dismiss: (id) => set((st) => ({ items: st.items.filter((i) => i.id !== id) })),
}));

export const toast = {
  info: (message: string, action?: ToastItem['action']) =>
    useToasts.getState().push({ message, tone: 'info', action, ms: action ? 7000 : 4000 }),
  error: (message: string) => useToasts.getState().push({ message, tone: 'error', ms: 7000 }),
};

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToasts((st) => st.dismiss);
  useEffect(() => {
    const id = window.setTimeout(() => dismiss(item.id), item.ms);
    return () => window.clearTimeout(id);
  }, [item, dismiss]);
  return (
    <div className={[s.toast, item.tone === 'error' && s.toastError].filter(Boolean).join(' ')}>
      <span style={{ flex: 1 }}>{item.message}</span>
      {item.action && (
        <button
          type="button"
          className={s.toastAction}
          onClick={() => {
            item.action!.onClick();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className={s.toastAction} aria-label="Dismiss" onClick={() => dismiss(item.id)}>
        <X size={16} />
      </button>
    </div>
  );
}

export function ToastHost() {
  const items = useToasts((st) => st.items);
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      {items.map((i) => (
        <ToastView key={i.id} item={i} />
      ))}
    </div>
  );
}
