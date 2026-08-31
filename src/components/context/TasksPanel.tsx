// ===================================================================
// TASKS PANEL - Today / Upcoming / Completed tabs + Open Loops
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import { Plus, Check, Circle, Loader2, Trash2, ListTodo, Link2 } from 'lucide-react';
import { Identity } from '../../types.js';
import { useApi } from '../../hooks/useApi.js';
import { PanelSkeleton, PanelError, PanelEmpty, PanelSection } from './PanelShell.js';
import { formatRelative, truncate } from '../../utils/format.js';
import { sanitizeAuthToken } from '../../utils/auth.js';

interface TasksPanelProps {
  identity: Identity;
  authToken?: string;
}

type Tab = 'today' | 'upcoming' | 'completed' | 'loops';

export function TasksPanel({ identity, authToken }: TasksPanelProps) {
  const [tab, setTab] = useState<Tab>('today');
  const [newTask, setNewTask] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const { data, isLoading, error, refetch } = useApi<any>(
    identity?.id ? `/api/tasks` : null,
    identity,
    authToken,
    { refreshMs: 30000 },
  );

  const { data: loopsData, refetch: refetchLoops } = useApi<any>(
    identity?.id ? `/api/open-loops` : null,
    identity,
    authToken,
    { refreshMs: 30000 },
  );

  const tasks: any[] = Array.isArray(data?.tasks) ? data.tasks : [];
  const today = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  const upcoming = tasks.filter(
    (t) => t.status !== 'completed' && t.status !== 'cancelled' && t.dueAt,
  );
  const completed = tasks.filter((t) => t.status === 'completed');

  const loops: any[] = Array.isArray(loopsData?.loops) ? loopsData.loops : [];

  const handleCreate = async () => {
    if (!newTask.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const cleanToken = sanitizeAuthToken(authToken);
      if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
      if (identity?.id) headers['X-User-Id'] = identity.id;
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: newTask.trim() }),
      });
      if (res.ok) {
        setNewTask('');
        refetch();
      }
    } catch {
      // ignore
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggle = async (taskId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'completed' ? 'pending' : 'completed';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const cleanToken = sanitizeAuthToken(authToken);
    if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
    if (identity?.id) headers['X-User-Id'] = identity.id;
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ status: newStatus }),
      });
      refetch();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (taskId: string) => {
    const headers: Record<string, string> = {};
    const cleanToken = sanitizeAuthToken(authToken);
    if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
    if (identity?.id) headers['X-User-Id'] = identity.id;
    try {
      await fetch(`/api/tasks/${taskId}`, { method: 'DELETE', headers });
      refetch();
    } catch {
      // ignore
    }
  };

  const currentList =
    tab === 'today' ? today : tab === 'upcoming' ? upcoming : tab === 'completed' ? completed : [];

  return (
    <div>
      {/* Quick add */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={newTask}
          onChange={(e) => setNewTask(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="Add a task…"
          className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-white/[0.05] border border-white/12 text-[12.5px] text-white placeholder-white/40 focus:outline-none focus:border-white/25 focus:bg-white/[0.08] transition-colors"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={!newTask.trim() || isCreating}
          className="shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br from-orange-300 via-pink-400 to-violet-500 text-white flex items-center justify-center disabled:opacity-40 cursor-pointer press-scale"
          aria-label="Add task"
        >
          {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 p-1 rounded-xl bg-white/[0.04] border border-white/10">
        {(
          [
            { key: 'today', label: 'Today', count: today.length },
            { key: 'upcoming', label: 'Upcoming', count: upcoming.length },
            { key: 'completed', label: 'Done', count: completed.length },
            { key: 'loops', label: 'Loops', count: loops.length },
          ] as { key: Tab; label: string; count: number }[]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`relative flex-1 px-2 py-1.5 rounded-lg text-[11px] font-medium cursor-pointer press-scale transition-colors ${
              tab === t.key
                ? 'bg-white/10 text-white'
                : 'text-white/55 hover:text-white/85'
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span
                className={`ml-1 text-[9.5px] tabular-nums px-1 rounded-full ${
                  tab === t.key ? 'bg-white/20' : 'bg-white/[0.06]'
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <PanelSkeleton rows={3} />
          </motion.div>
        ) : error ? (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <PanelError message={error} onRetry={refetch} />
          </motion.div>
        ) : tab === 'loops' ? (
          <motion.div
            key="loops"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {loops.length === 0 ? (
              <PanelEmpty
                title="No open loops"
                description="Open loops are things you've committed to but haven't completed yet."
                icon={<Link2 className="w-7 h-7 text-indigo-300/60 mx-auto" />}
              />
            ) : (
              <div className="flex flex-col gap-2">
                {loops.map((loop, i) => (
                  <motion.div
                    key={loop.id || i}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.02 }}
                    className="rounded-2xl border border-white/10 bg-white/[0.04] p-3"
                  >
                    <p className="text-[12.5px] text-white/90 leading-relaxed">
                      {truncate(loop.description || loop.name, 200)}
                    </p>
                    {loop.createdAtIST && (
                      <p className="mt-1 text-[10px] text-white/45">
                        Opened {formatRelative(loop.createdAtIST || loop.createdAt)}
                      </p>
                    )}
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        ) : currentList.length === 0 ? (
          <motion.div
            key={`empty-${tab}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <PanelEmpty
              title={
                tab === 'today'
                  ? 'Nothing for today'
                  : tab === 'upcoming'
                  ? 'No upcoming tasks'
                  : 'No completed tasks yet'
              }
              description={
                tab === 'today'
                  ? 'Add a task above or ask Madhurita to plan your day.'
                  : tab === 'upcoming'
                  ? 'Schedule tasks with a due date to see them here.'
                  : 'Complete tasks to see them here.'
              }
              icon={<ListTodo className="w-7 h-7 text-indigo-300/60 mx-auto" />}
            />
          </motion.div>
        ) : (
          <motion.div
            key={`list-${tab}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-1.5"
          >
            {currentList.slice(0, 50).map((task, i) => {
              const done = task.status === 'completed';
              return (
                <motion.div
                  key={task.id || i}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.015 }}
                  className={`group flex items-center gap-2.5 rounded-2xl border p-3 transition-colors ${
                    done
                      ? 'border-white/8 bg-white/[0.02]'
                      : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.07]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleToggle(task.id, task.status)}
                    className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center cursor-pointer press-scale transition-all ${
                      done
                        ? 'bg-emerald-400/30 border-emerald-300/60'
                        : 'border-white/30 hover:border-white/55'
                    }`}
                    aria-label={done ? 'Mark incomplete' : 'Mark complete'}
                  >
                    {done && <Check className="w-3 h-3 text-emerald-100" strokeWidth={3} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-[12.5px] leading-relaxed ${
                        done ? 'line-through text-white/40' : 'text-white/90'
                      }`}
                    >
                      {truncate(task.title, 200)}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/40">
                      {task.dueAt && <span>Due {formatRelative(task.dueAt)}</span>}
                      {task.createdAt && !task.dueAt && (
                        <span>Created {formatRelative(task.createdAt)}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(task.id)}
                    className="shrink-0 w-7 h-7 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-rose-500/20 text-white/50 hover:text-rose-200 flex items-center justify-center transition-all cursor-pointer"
                    aria-label="Delete task"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
