// ===================================================================
// MOBILE GRID LAUNCHER - 2x4 Stage App Drawer Menu
// ===================================================================

import React from 'react';
import { motion } from 'motion/react';
import {
  Brain,
  Search,
  CheckSquare,
  CalendarDays,
  Cpu,
  UserCircle2,
  Settings,
  Trash2,
  Sparkles,
  X,
} from 'lucide-react';
import { StageKey } from '../../utils/stage.js';

interface MobileGridLauncherProps {
  onNavigate: (stage: StageKey) => void;
  onClose: () => void;
}

const APPS: Array<{ key: StageKey; label: string; icon: any; color: string; desc: string }> = [
  { key: 'memory', label: 'Memory', icon: Brain, color: 'from-purple-500/30 to-indigo-500/30', desc: 'Recalls & facts' },
  { key: 'search', label: 'Search', icon: Search, color: 'from-sky-500/30 to-blue-500/30', desc: 'Unified query' },
  { key: 'tasks', label: 'Tasks', icon: CheckSquare, color: 'from-emerald-500/30 to-teal-500/30', desc: 'To-dos & plans' },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays, color: 'from-amber-500/30 to-orange-500/30', desc: 'Schedule & time' },
  { key: 'devices', label: 'Devices', icon: Cpu, color: 'from-slate-500/30 to-zinc-500/30', desc: 'Integrations' },
  { key: 'identity', label: 'Identity', icon: UserCircle2, color: 'from-rose-500/30 to-pink-500/30', desc: 'Profiles & auth' },
  { key: 'settings', label: 'Settings', icon: Settings, color: 'from-indigo-500/30 to-violet-500/30', desc: 'Voice & persona' },
  { key: 'bin', label: 'Bin', icon: Trash2, color: 'from-red-500/30 to-rose-500/30', desc: 'Recover items' },
];

export function MobileGridLauncher({ onNavigate, onClose }: MobileGridLauncherProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="fixed inset-0 z-50 glass-deep p-5 flex flex-col justify-between"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-orange-400/30 to-pink-500/30 flex items-center justify-center border border-white/20">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-white text-base">Madhurita Apps</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-8 h-8 rounded-full glass flex items-center justify-center text-white/80 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 2x4 Grid */}
      <div className="grid grid-cols-2 gap-3.5 my-auto">
        {APPS.map((app) => {
          const Icon = app.icon;
          return (
            <motion.button
              key={app.key}
              type="button"
              onClick={() => {
                onNavigate(app.key);
                onClose();
              }}
              whileTap={{ scale: 0.96 }}
              className="flex flex-col items-start p-4 rounded-3xl glass-panel border border-white/12 text-left cursor-pointer hover:border-white/25 transition-all shadow-lg"
            >
              <div
                className={`w-11 h-11 rounded-2xl bg-gradient-to-br ${app.color} border border-white/20 flex items-center justify-center mb-2.5 shadow-md`}
              >
                <Icon className="w-5 h-5 text-white" />
              </div>
              <span className="text-sm font-semibold text-white leading-tight mb-0.5">
                {app.label}
              </span>
              <span className="text-[10.5px] text-white/50 leading-tight">
                {app.desc}
              </span>
            </motion.button>
          );
        })}
      </div>

      {/* Footer Info */}
      <div className="text-center text-[11px] text-white/40">
        Tap any workspace to open its contextual glass view
      </div>
    </motion.div>
  );
}
