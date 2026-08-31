// ===================================================================
// MOBILE SCHEDULE VIEW - Daily Agenda & Task Management
// ===================================================================

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckSquare, Clock, Plus, Trash2, CheckCircle2, Circle, ArrowLeft, Calendar } from 'lucide-react';
import { TaskItem, Identity } from '../../types.js';
import { sanitizeAuthToken } from '../../utils/auth.js';

interface MobileScheduleViewProps {
  identity: Identity;
  authToken?: string;
  onClose?: () => void;
}

export function MobileScheduleView({ identity, authToken, onClose }: MobileScheduleViewProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed'>('pending');

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const headers: Record<string, string> = {};
      const token = sanitizeAuthToken(authToken);
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (identity.id && identity.id !== 'UNKNOWN') headers['X-User-Id'] = identity.id;

      const res = await fetch('/api/tasks', { headers, cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch (err) {
      console.warn('Tasks fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, [identity.id, authToken]);

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = sanitizeAuthToken(authToken);
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (identity.id && identity.id !== 'UNKNOWN') headers['X-User-Id'] = identity.id;

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: newTaskTitle.trim(),
          identityId: identity.id,
        }),
      });

      if (res.ok) {
        setNewTaskTitle('');
        fetchTasks();
      }
    } catch (err) {
      console.warn('Add task error:', err);
    }
  };

  const handleToggleTask = async (task: TaskItem) => {
    const nextStatus = task.status === 'completed' ? 'pending' : 'completed';
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = sanitizeAuthToken(authToken);
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (identity.id && identity.id !== 'UNKNOWN') headers['X-User-Id'] = identity.id;

      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: nextStatus }),
      });

      if (res.ok) {
        setTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t))
        );
      }
    } catch (err) {
      console.warn('Update task error:', err);
    }
  };

  const filteredTasks = tasks.filter((t) => {
    if (filter === 'pending') return t.status === 'pending';
    if (filter === 'completed') return t.status === 'completed';
    return true;
  });

  return (
    <div className="w-full h-full flex flex-col p-4 overflow-y-auto custom-scrollbar">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full glass flex items-center justify-center text-white/80 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white/90">
          <Calendar className="w-3.5 h-3.5 text-amber-300" />
          <span>Daily Schedule & Tasks</span>
        </div>
        <div className="w-8" />
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 p-1 rounded-2xl glass mb-4">
        {(['pending', 'completed', 'all'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setFilter(tab)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-xl capitalize transition-all cursor-pointer ${
              filter === tab ? 'bg-white/20 text-white shadow-sm' : 'text-white/50 hover:text-white'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Task Input */}
      <form onSubmit={handleAddTask} className="flex gap-2 mb-4">
        <input
          type="text"
          value={newTaskTitle}
          onChange={(e) => setNewTaskTitle(e.target.value)}
          placeholder="Add a new task..."
          className="flex-1 px-4 py-2.5 rounded-2xl glass text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-amber-300/50"
        />
        <button
          type="submit"
          disabled={!newTaskTitle.trim()}
          className="px-4 py-2.5 rounded-2xl bg-amber-400/20 hover:bg-amber-400/30 text-amber-200 border border-amber-300/30 font-medium text-xs flex items-center gap-1 cursor-pointer disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </form>

      {/* Task List */}
      <div className="flex-1 flex flex-col gap-2">
        <AnimatePresence>
          {filteredTasks.map((task) => {
            const isDone = task.status === 'completed';
            return (
              <motion.div
                key={task.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -10 }}
                onClick={() => handleToggleTask(task)}
                className={`p-3.5 rounded-2xl glass flex items-center gap-3 cursor-pointer transition-all border ${
                  isDone ? 'border-white/5 opacity-60' : 'border-white/12 hover:border-white/25'
                }`}
              >
                <button type="button" className="shrink-0 text-white/70">
                  {isDone ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  ) : (
                    <Circle className="w-5 h-5 text-white/40" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-xs font-medium leading-tight truncate ${
                      isDone ? 'line-through text-white/45' : 'text-white/90'
                    }`}
                  >
                    {task.title}
                  </p>
                  {task.description && (
                    <p className="text-[10px] text-white/40 truncate mt-0.5">
                      {task.description}
                    </p>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {filteredTasks.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <CheckSquare className="w-8 h-8 text-white/20 mb-2" />
            <p className="text-xs text-white/40">No tasks in this list</p>
          </div>
        )}
      </div>
    </div>
  );
}
