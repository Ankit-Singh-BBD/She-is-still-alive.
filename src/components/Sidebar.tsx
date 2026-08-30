import { motion } from 'motion/react';
import {
  MessageCircle,
  BrainCircuit,
  Radar,
  CheckSquare,
  BookOpen,
  MonitorSmartphone,
  Settings2,
  AudioLines,
} from 'lucide-react';
import { Identity, LiveState } from '../types.js';

export type NavKey = 'chat' | 'memory' | 'recall' | 'tasks' | 'knowledge' | 'devices' | 'settings';

interface NavItem {
  key: NavKey;
  label: string;
  icon: typeof MessageCircle;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'chat', label: 'Chat', icon: MessageCircle },
  { key: 'memory', label: 'Memory', icon: BrainCircuit },
  { key: 'recall', label: 'Recall', icon: Radar },
  { key: 'tasks', label: 'Tasks', icon: CheckSquare },
  { key: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { key: 'devices', label: 'Devices', icon: MonitorSmartphone },
  { key: 'settings', label: 'Settings', icon: Settings2 },
];

interface SidebarProps {
  identity: Identity;
  state: LiveState;
  activeNav: NavKey;
  onNavigate: (key: NavKey) => void;
  onOpenIdentitySwitch: () => void;
}

export function Sidebar({ identity, state, activeNav, onNavigate, onOpenIdentitySwitch }: SidebarProps) {
  const isActive = state === 'listening' || state === 'speaking';
  const roleLabel =
    identity.role === 'owner' ? 'Owner' : identity.role === 'user' ? 'Verified' : 'Unknown';

  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 h-full px-3 pt-2 pb-4 border-r border-white/10">
      <nav className="flex flex-col gap-1 mt-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeNav === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.key)}
              className={`group relative flex items-center gap-3 px-3.5 py-2.5 rounded-2xl text-sm font-medium transition-all cursor-pointer ${
                active
                  ? 'glass glass-inset text-white shadow-lg shadow-black/20'
                  : 'text-white/60 hover:text-white hover:bg-white/[0.06]'
              }`}
            >
              <Icon
                className={`w-[18px] h-[18px] shrink-0 ${
                  active ? 'text-indigo-200' : 'text-white/50 group-hover:text-white/80'
                }`}
              />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-4">
        {/* Active Identity card */}
        <div>
          <p className="px-1 mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
            Active Identity
          </p>
          <button
            type="button"
            onClick={onOpenIdentitySwitch}
            className="w-full glass glass-hover rounded-2xl px-3 py-2.5 flex items-center gap-3 text-left cursor-pointer"
          >
            <span className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-200/20 to-slate-500/20 border border-white/15 flex items-center justify-center text-sm font-semibold text-white shrink-0">
              {identity.name?.charAt(0)?.toUpperCase() || 'G'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-white truncate">{identity.name}</span>
              <span className="block text-[11px] text-white/50 truncate">{roleLabel}</span>
            </span>
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                identity.role === 'unknown' ? 'bg-slate-400' : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
              }`}
            />
          </button>
        </div>

        {/* Listening status pill */}
        <motion.div
          animate={isActive ? { scale: [1, 1.015, 1] } : { scale: 1 }}
          transition={{ duration: 2, repeat: Infinity }}
          className={`rounded-2xl px-4 py-3 flex items-center gap-2.5 text-sm font-semibold transition-colors ${
            isActive
              ? 'glass text-white shadow-[0_0_24px_rgba(99,102,241,0.28)]'
              : 'bg-white/[0.05] border border-white/10 text-white/55'
          }`}
        >
          <AudioLines
            className={`w-[18px] h-[18px] ${isActive ? 'text-indigo-200 animate-soft-glow' : 'text-white/45'}`}
          />
          <span>
            {state === 'connecting'
              ? 'Connecting…'
              : state === 'listening'
              ? 'Listening…'
              : state === 'speaking'
              ? 'Speaking…'
              : 'Idle'}
          </span>
        </motion.div>
      </div>
    </aside>
  );
}
