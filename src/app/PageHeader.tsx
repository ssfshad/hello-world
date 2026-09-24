import type { ReactNode } from 'react';
import s from './layout.module.css';

export function PageHeader({
  context,
  title,
  actions,
}: {
  context?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={s.header}>
      <div>
        {context && <p className={s.context}>{context}</p>}
        <h1 className={s.title}>{title}</h1>
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </header>
  );
}
