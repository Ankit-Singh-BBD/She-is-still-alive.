// ===================================================================
// GLASS NAV RAIL - Left-side navigation rail + mobile bottom tab bar
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import {
  Home,
  Brain,
  Search,
  CheckSquare,
  CalendarDays,
  Cpu,
  UserCircle2,
  Settings,
  AudioLines,
  Sparkles,
  Mic,
  ChevronRight,
} from 'lucide-react';
import { Identity, LiveState } from '../types.js';
import { STAGES, StageKey, MOBILE_TABS } from '../utils/stage.js';
import { useHomeMetrics } from '../hooks/useUIState.js';

export type NavKey = StageKey;

interface SidebarProps {
  identity: Identity;
  state: LiveState;
  activeNav: NavKey;
  onNavigate: (key: NavKey) => void;
  onOpenIdentitySwitch: () => void;
  onVoiceTrigger?: () => void;
}

const ICONS: Record<StageKey, typeof Home> = {
  home: Home,
  memory: Brain,
  search: Search,
  tasks: CheckSquare,
  calendar: CalendarDays,
  devices: Cpu,
  identity: UserCircle2,
  settings: Settings,
};

export function Sidebar({
  identity,
  state,
  activeNav,
  onNavigate,
  onOpenIdentitySwitch,
  onVoiceTrigger,
}: SidebarProps) {
  const isVoiceActive = state === 'listening' || state === 'speaking';
  const metrics = useHomeMetrics();

  const roleLabel =
    identity.role === 'owner'
      ? 'Owner'
      : identity.role === 'user'
      ? 'Verified'
      : 'Guest';

  // Group stages for sectioned nav
  const groups: { key: 'primary' | 'library' | 'system'; label: string }[] = [
    { key: 'primary', label: 'Workspace' },
    { key: 'library', label: 'Library' },
    { key: 'system', label: 'System' },
  ];

  return (
    <>
      {/* Desktop nav rail (≥1024px) */}
      <aside className="hidden lg:flex flex-col w-[244px] shrink-0 h-full px-3 pt-4 pb-4 border-r border-white/10">
        {/* Brand */}
        <div className="px-3 mb-5 flex items-center gap-2.5">
          <div className="relative w-8 h-8 rounded-xl bg-gradient-to-br from-orange-400/30 via-pink-400/30 to-violet-500/30 border border-white/15 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
            <motion.span
              className="absolute inset-0 rounded-xl"
              animate={{
                boxShadow: [
                  '0 0 0 0 rgba(255,138,101,0)',
                  '0 0 16px 2px rgba(255,138,101,0.18)',
                  '0 0 0 0 rgba(255,138,101,0)',
                ],
              }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-white tracking-tight leading-tight">
              Madhurita
            </p>
            <p className="text-[10px] text-white/45 leading-tight mt-0.5">
              Your cognitive companion
            </p>
          </div>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto custom-scrollbar -mx-1 px-1">
          {groups.map((group) => {
            const items = STAGES.filter((s) => s.group === group.key);
            if (items.length === 0) return null;
            return (
              <div key={group.key} className="mb-5">
                <p className="px-3 mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
                  {group.label}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {items.map((item) => {
                    const Icon = ICONS[item.key];
                    const active = activeNav === item.key;

                    // Show badge for tasks if there are pending tasks
                    const showBadge = item.key === 'tasks' && metrics.activeTasks > 0;
                    const badgeCount = item.key === 'tasks' ? metrics.activeTasks : 0;

                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          onClick={() => onNavigate(item.key)}
                          className={`group relative w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-all cursor-pointer press-scale ${
                            active
                              ? 'glass text-white border-white/20 shadow-[0_0_20px_rgba(255,255,255,0.05)]'
                              : 'text-white/65 hover:text-white hover:bg-white/[0.04] border border-transparent'
                          }`}
                        >
                          {active && (
                            <motion.span
                              layoutId="nav-active-indicator"
                              className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-gradient-to-b from-orange-300 via-pink-300 to-violet-300"
                              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                            />
                          )}
                          <Icon
                            className={`w-[16px] h-[16px] shrink-0 transition-colors ${
                              active
                                ? 'text-orange-200'
                                : 'text-white/45 group-hover:text-white/75'
                            }`}
                          />
                          <span className="truncate">{item.label}</span>
                          {showBadge && (
                            <span className="ml-auto text-[9.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-indigo-400/25 text-indigo-100 border border-indigo-300/30">
                              {badgeCount}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        {/* Active identity card */}
        <div className="mt-auto">
          <button
            type="button"
            onClick={onOpenIdentitySwitch}
            className="w-full glass glass-hover rounded-2xl px-3 py-2.5 flex items-center gap-2.5 text-left cursor-pointer press-scale"
          >
            <span className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-300/30 via-pink-400/30 to-violet-500/30 border border-white/20 flex items-center justify-center text-[13px] font-semibold text-white shrink-0">
              {identity.name?.charAt(0)?.toUpperCase() || 'G'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-semibold text-white truncate leading-tight">
                {identity.name}
              </span>
              <span className="block text-[10px] text-white/50 truncate leading-tight mt-0.5">
                {roleLabel} · Switch
              </span>
            </span>
            <ChevronRight className="w-3.5 h-3.5 text-white/40 shrink-0" />
          </button>

          {/* Voice status mini pill */}
          <div
            className={`mt-2.5 rounded-xl px-3 py-1.5 flex items-center gap-2 text-[11px] transition-colors ${
              isVoiceActive
                ? 'glass text-white border-indigo-300/30'
                : 'bg-white/[0.04] border border-white/10 text-white/50'
            }`}
          >
            <AudioLines
              className={`w-3.5 h-3.5 ${
                isVoiceActive ? 'text-indigo-200 animate-soft-glow' : 'text-white/40'
              }`}
            />
            <span className="truncate">
              {state === 'connecting'
                ? 'Connecting…'
                : state === 'listening'
                ? 'Listening…'
                : state === 'speaking'
                ? 'Speaking…'
                : 'Voice idle'}
            </span>
            <span
              className={`ml-auto w-1.5 h-1.5 rounded-full ${
                isVoiceActive
                  ? 'bg-emerald-300 shadow-[0_0_6px_rgba(52,211,153,0.7)]'
                  : 'bg-slate-400'
              }`}
            />
          </div>
        </div>
      </aside>

      {/* Mobile bottom tab bar (<1024px) */}
      <nav className="lg:hidden fixed bottom-3 left-3 right-3 z-30 glass-deep rounded-2xl border border-white/12 shadow-2xl shadow-black/40 px-2 py-2 flex items-center justify-around">
        {MOBILE_TABS.map((tab) => {
          if (tab.center) {
            // Center voice mic trigger
            return (
              <button
                key="voice-center"
                type="button"
                onClick={onVoiceTrigger}
                className={`relative w-12 h-12 rounded-full flex items-center justify-center cursor-pointer press-scale transition-all ${
                  isVoiceActive
                    ? 'bg-gradient-to-br from-indigo-400 to-violet-500 text-white shadow-[0_0_22px_rgba(99,102,241,0.55)]'
                    : 'bg-gradient-to-br from-orange-300 via-pink-400 to-violet-500 text-white shadow-[0_0_18px_rgba(255,138,101,0.45)]'
                }`}
                aria-label="Voice"
              >
                <Mic className="w-5 h-5" />
                {isVoiceActive && (
                  <motion.span
                    className="absolute inset-0 rounded-full border-2 border-white/40"
                    animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0, 0.6] }}
                    transition={{ duration: 1.4, repeat: Infinity }}
                  />
                )}
              </button>
            );
          }

          const Icon = ICONS[tab.key as StageKey];
          const active = activeNav === tab.key;

          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onNavigate(tab.key as StageKey)}
              className={`flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-xl cursor-pointer press-scale transition-colors ${
                active ? 'text-white' : 'text-white/55 hover:text-white/85'
              }`}
            >
              <Icon className="w-[18px] h-[18px]" />
              <span className="text-[9.5px] font-medium uppercase tracking-wider">
                {tab.label}
              </span>
              {active && (
                <motion.span
                  layoutId="mobile-tab-indicator"
                  className="absolute -top-0.5 w-1 h-1 rounded-full bg-gradient-to-r from-orange-300 to-violet-300"
                />
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}
