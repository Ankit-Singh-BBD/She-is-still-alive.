// ===================================================================
// GLASS NAV RAIL — Smoked-glass slab floating over the photograph
// ===================================================================
//
// A single slab of cold, thick glass (`.cine-rail`) that visibly refracts
// the landscape behind it. Active items get a bevelled glass pill, a
// gradient edge indicator and a soft coloured bloom, so the rail reads as
// a physical object lit by the scene rather than a flat panel.

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
  Trash2,
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
  bin: Trash2,
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
      {/* ============ Desktop nav rail (>=1024px) ==================== */}
      <aside className="hidden lg:flex flex-col w-[248px] shrink-0 my-3 ml-3 rounded-3xl cine-rail relative z-10 overflow-hidden">
        {/* Light catching the inner left edge of the slab */}
        <div
          className="absolute inset-y-0 left-0 w-16 pointer-events-none"
          style={{
            background:
              'linear-gradient(90deg, rgba(255,255,255,0.07) 0%, transparent 100%)',
            mixBlendMode: 'screen',
          }}
        />
        {/* Warm bounce from the horizon at the bottom of the rail */}
        <div
          className="absolute inset-x-0 bottom-0 h-40 pointer-events-none"
          style={{
            background:
              'linear-gradient(0deg, rgba(255,168,120,0.07) 0%, transparent 100%)',
            mixBlendMode: 'screen',
          }}
        />

        <div className="relative flex flex-col h-full px-3 pt-4 pb-4">
          {/* ---- Brand ------------------------------------------------ */}
          <div className="px-2.5 mb-4 flex items-center gap-2.5">
            <div className="relative w-9 h-9 rounded-2xl cine-chip flex items-center justify-center overflow-hidden">
              <div
                className="absolute inset-0"
                style={{
                  background:
                    'linear-gradient(140deg, rgba(255,138,101,0.4), rgba(244,114,182,0.32) 48%, rgba(139,92,246,0.4))',
                  mixBlendMode: 'screen',
                }}
              />
              <Sparkles className="relative w-4 h-4 text-white drop-shadow" />
              <motion.span
                className="absolute inset-0 rounded-2xl"
                animate={{
                  boxShadow: [
                    '0 0 0 0 rgba(255,138,101,0)',
                    '0 0 20px 3px rgba(255,138,101,0.22)',
                    '0 0 0 0 rgba(255,138,101,0)',
                  ],
                }}
                transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-white tracking-tight leading-tight text-cine">
                Madhurita
              </p>
              <p className="text-[10px] text-white/45 leading-tight mt-0.5">
                Your cognitive companion
              </p>
            </div>
          </div>

          <div className="cine-hairline mb-3.5" />

          {/* ---- Nav groups ------------------------------------------ */}
          <nav className="flex-1 overflow-y-auto custom-scrollbar -mx-1 px-1">
            {groups.map((group) => {
              const items = STAGES.filter((s) => s.group === group.key);
              if (items.length === 0) return null;
              return (
                <div key={group.key} className="mb-5">
                  <p className="px-3 mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.2em] text-white/32">
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
                            className={`group relative w-full flex items-center gap-2.5 pl-3.5 pr-3 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 cursor-pointer press-scale overflow-hidden ${
                              active
                                ? 'cine-chip cine-bevel text-white'
                                : 'text-white/62 hover:text-white hover:bg-white/[0.05] border border-transparent'
                            }`}
                          >
                            {/* Coloured bloom behind the active pill */}
                            {active && (
                              <motion.span
                                layoutId="nav-active-bloom"
                                className="absolute inset-0 pointer-events-none"
                                transition={{ type: 'spring', stiffness: 340, damping: 32 }}
                                style={{
                                  background:
                                    'linear-gradient(100deg, rgba(255,138,101,0.20) 0%, rgba(244,114,182,0.12) 46%, rgba(139,92,246,0.18) 100%)',
                                  mixBlendMode: 'screen',
                                }}
                              />
                            )}
                            {active && (
                              <motion.span
                                layoutId="nav-active-indicator"
                                className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-gradient-to-b from-orange-300 via-pink-300 to-violet-300"
                                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                                style={{ boxShadow: '0 0 12px rgba(255,150,110,0.6)' }}
                              />
                            )}
                            <Icon
                              className={`relative w-[16px] h-[16px] shrink-0 transition-colors ${
                                active
                                  ? 'text-orange-200'
                                  : 'text-white/42 group-hover:text-white/75'
                              }`}
                              style={
                                active
                                  ? { filter: 'drop-shadow(0 0 6px rgba(255,170,120,0.55))' }
                                  : undefined
                              }
                            />
                            <span className="relative truncate">{item.label}</span>
                            {showBadge && (
                              <span className="relative ml-auto text-[9.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-indigo-400/25 text-indigo-100 border border-indigo-300/30">
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

          {/* ---- Active identity badge (Section 1 Exact Mirror) ---------------- */}
          <div className="mt-auto">
            <div className="cine-hairline mb-3" />

            <div className="w-full cine-chip rounded-2xl px-3 py-2.5 flex items-center justify-between gap-2.5 transition-all">
              <button
                type="button"
                onClick={onOpenIdentitySwitch}
                className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer hover:opacity-90 transition-opacity"
              >
                <span className="relative w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-semibold text-white shrink-0 overflow-hidden border border-white/20">
                  <span
                    className="absolute inset-0"
                    style={{
                      background:
                        'linear-gradient(140deg, rgba(253,186,116,0.45), rgba(244,114,182,0.4) 50%, rgba(139,92,246,0.45))',
                    }}
                  />
                  <span className="relative">
                    {identity.name?.charAt(0)?.toUpperCase() || 'M'}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold text-white truncate leading-tight">
                    {identity.name || 'Madhurita'}
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] text-white/55 truncate leading-tight mt-0.5">
                    <span>Online</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)] animate-pulse" />
                  </span>
                </span>
              </button>

              {/* Right side interactive waveform trigger button (-|||-) */}
              <button
                type="button"
                onClick={onVoiceTrigger}
                className={`w-7 h-7 rounded-xl flex items-center justify-center border transition-all cursor-pointer press-scale shrink-0 ${
                  isVoiceActive
                    ? 'bg-orange-500/20 border-orange-400/40 text-orange-300 shadow-[0_0_12px_rgba(251,146,60,0.4)]'
                    : 'bg-white/[0.05] border-white/10 text-white/60 hover:text-white hover:bg-white/[0.1]'
                }`}
                aria-label="Toggle voice"
                title="Toggle Voice"
              >
                <div className="flex items-center gap-0.5 h-2.5">
                  <span className="w-0.5 h-1.5 rounded-full bg-current" />
                  <span className="w-0.5 h-2.5 rounded-full bg-current" />
                  <span className="w-0.5 h-1.5 rounded-full bg-current" />
                </div>
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* ============ Mobile bottom tab bar (<1024px) ================ */}
      <nav className="lg:hidden fixed bottom-3 left-3 right-3 z-30 cine-glass rounded-2xl px-2 py-2 flex items-center justify-around overflow-hidden">
        {/* Top bevel highlight across the bar */}
        <div
          className="absolute inset-x-0 top-0 h-px pointer-events-none"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(255,255,255,0.28) 40%, rgba(255,255,255,0.28) 60%, transparent)',
          }}
        />
        {MOBILE_TABS.map((tab) => {
          if (tab.center) {
            // Center voice mic trigger
            return (
              <button
                key="voice-center"
                type="button"
                onClick={onVoiceTrigger}
                className="relative w-12 h-12 rounded-full flex items-center justify-center cursor-pointer press-scale transition-all overflow-hidden"
                style={{
                  background: isVoiceActive
                    ? 'radial-gradient(circle at 36% 30%, rgba(199,210,254,0.95) 0%, #6366f1 45%, #4c1d95 100%)'
                    : 'radial-gradient(circle at 36% 30%, rgba(255,237,213,0.95) 0%, #fb923c 40%, #a21caf 100%)',
                  boxShadow: isVoiceActive
                    ? '0 0 26px rgba(99,102,241,0.6), inset 0 1px 0 rgba(255,255,255,0.5), 0 10px 26px -10px rgba(0,0,0,0.8)'
                    : '0 0 22px rgba(255,138,101,0.5), inset 0 1px 0 rgba(255,255,255,0.5), 0 10px 26px -10px rgba(0,0,0,0.8)',
                }}
                aria-label="Voice"
              >
                <Mic className="relative w-5 h-5 text-white drop-shadow" />
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
              className={`relative flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-xl cursor-pointer press-scale transition-colors ${
                active ? 'text-white' : 'text-white/55 hover:text-white/85'
              }`}
            >
              <Icon
                className="w-[18px] h-[18px]"
                style={
                  active
                    ? { filter: 'drop-shadow(0 0 7px rgba(255,170,120,0.6))' }
                    : undefined
                }
              />
              <span className="text-[9.5px] font-medium uppercase tracking-wider">
                {tab.label}
              </span>
              {active && (
                <motion.span
                  layoutId="mobile-tab-indicator"
                  className="absolute -top-0.5 w-1 h-1 rounded-full bg-gradient-to-r from-orange-300 to-violet-300"
                  style={{ boxShadow: '0 0 8px rgba(255,150,110,0.8)' }}
                />
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}
