// ===================================================================
// CALENDAR PANEL - Today's date + real upcoming tasks (due-date scheduled)
// ===================================================================

import { motion } from 'motion/react';
import { CalendarDays, Clock, ChevronRight } from 'lucide-react';
import { Identity } from '../../types.js';
import { useApi } from '../../hooks/useApi.js';
import { useStage } from '../../hooks/useStage.js';
import { useHomeMetrics } from '../../hooks/useUIState.js';
import { formatDateLong, formatTime, truncate, formatRelative } from '../../utils/format.js';
import { PanelSkeleton, PanelError, PanelEmpty, PanelSection } from './PanelShell.js';

interface CalendarPanelProps {
  identity: Identity;
  authToken?: string;
}

export function CalendarPanel({ identity, authToken }: CalendarPanelProps) {
  const { setStage } = useStage();
  const metrics = useHomeMetrics();
  const now = new Date();
  const istHour = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false,
  });

  // Real upcoming tasks: pending tasks with a dueAt. If the backend
  // already returns only "upcoming" tasks, this is a no-op filter.
  const { data, isLoading, error, refetch } = useApi<any>(
    identity?.id ? `/api/tasks` : null,
    identity,
    authToken,
    { refreshMs: 30000 },
  );

  const allTasks: any[] = Array.isArray(data?.tasks) ? data.tasks : [];
  const scheduled: any[] = allTasks
    .filter((t) => t.status !== 'completed' && t.status !== 'cancelled' && t.dueAt)
    .sort((a, b) => {
      const at = new Date(a.dueAt).getTime() || 0;
      const bt = new Date(b.dueAt).getTime() || 0;
      return at - bt;
    })
    .slice(0, 6);

  return (
    <div>
      {/* Date display */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 mb-4">
        <p className="text-[10.5px] uppercase tracking-[0.14em] text-white/45 font-medium">
          Today
        </p>
        <p className="mt-1 text-[18px] font-semibold text-white tracking-tight">
          {formatDateLong(now)}
        </p>
        <p className="mt-0.5 text-[12px] text-white/55 tabular-nums">
          {formatTime(parseInt(istHour))} IST
        </p>
      </div>

      {/* Scheduled — REAL upcoming tasks with dueAt */}
      <PanelSection title="Scheduled" count={scheduled.length}>
        {isLoading ? (
          <PanelSkeleton rows={3} />
        ) : error ? (
          <PanelError message={error} onRetry={refetch} />
        ) : scheduled.length === 0 ? (
          <PanelEmpty
            title="Nothing scheduled"
            description="Tasks with due dates will appear here. Ask Madhurita to plan your day."
            icon={<CalendarDays className="w-7 h-7 text-indigo-300/60 mx-auto" />}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {scheduled.map((task, i) => (
              <motion.button
                key={task.id || i}
                type="button"
                onClick={() => setStage('tasks')}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                whileHover={{ scale: 1.01, x: 2 }}
                className="group flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] p-2.5 text-left cursor-pointer press-scale transition-colors"
              >
                <Clock className="w-3.5 h-3.5 text-white/40 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-white/90 truncate">
                    {truncate(task.title, 100)}
                  </p>
                  <p className="text-[10px] text-white/45 mt-0.5">
                    {formatRelative(task.dueAt)}
                  </p>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-white/30 group-hover:text-white/60 shrink-0" />
              </motion.button>
            ))}
          </div>
        )}
      </PanelSection>

      {/* Quick view: time of day */}
      <PanelSection title="Day Arc">
        <div className="grid grid-cols-4 gap-1.5">
          {(
            [
              { key: 'morning', label: 'Morning', emoji: '🌅' },
              { key: 'afternoon', label: 'Afternoon', emoji: '☀️' },
              { key: 'evening', label: 'Evening', emoji: '🌆' },
              { key: 'night', label: 'Night', emoji: '🌙' },
            ] as const
          ).map((p, i) => {
            const active = metrics.timeOfDay === p.key;
            return (
              <motion.div
                key={p.key}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className={`rounded-xl border p-2.5 text-center transition-colors ${
                  active
                    ? 'border-indigo-300/35 bg-indigo-500/10'
                    : 'border-white/10 bg-white/[0.03]'
                }`}
              >
                <div className="text-xl leading-none">{p.emoji}</div>
                <div
                  className={`mt-1.5 text-[10px] font-medium uppercase tracking-wider ${
                    active ? 'text-indigo-100' : 'text-white/55'
                  }`}
                >
                  {p.label}
                </div>
              </motion.div>
            );
          })}
        </div>
      </PanelSection>
    </div>
  );
}
