// ===================================================================
// PANEL SHELL - Skeleton/empty/error states for context panels
// ===================================================================

import { motion } from 'motion/react';
import { ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';

export function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 animate-shimmer h-20"
        />
      ))}
    </div>
  );
}

export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-rose-300/25 bg-rose-500/[0.08] p-4 flex items-start gap-2.5"
    >
      <AlertCircle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-[12.5px] text-rose-100 font-medium">Couldn't load</p>
        <p className="text-[11px] text-rose-200/80 mt-0.5">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-[11px] text-rose-200 underline hover:text-rose-100"
          >
            Try again
          </button>
        )}
      </div>
    </motion.div>
  );
}

export function PanelEmpty({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-dashed border-white/12 p-6 text-center"
    >
      {icon || <Inbox className="w-7 h-7 text-white/30 mx-auto" />}
      <p className="mt-2.5 text-[13px] font-medium text-white/80">{title}</p>
      {description && (
        <p className="mt-1 text-[11.5px] text-white/50 max-w-[26ch] mx-auto leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </motion.div>
  );
}

export function PanelSection({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count?: number | string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="mb-5">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white/45 flex items-center gap-2">
          {title}
          {count !== undefined && (
            <span className="px-1.5 py-0.5 rounded-full bg-white/[0.06] border border-white/10 text-white/55 text-[9.5px] tabular-nums">
              {count}
            </span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PanelChipButton({
  children,
  onClick,
  active,
  icon,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-[11.5px] font-medium flex items-center gap-1.5 cursor-pointer press-scale transition-colors ${
        active
          ? 'bg-white/15 text-white border border-white/25'
          : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/70'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
