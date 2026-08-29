import { Crown, User, UserX, Database, Lock, RefreshCw, CheckSquare, Sliders, MapPin } from 'lucide-react';
import { Identity, LiveState } from '../types.js';
import { HeaderIcon } from './HeaderIcon.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

interface HUDHeaderProps {
  identity: Identity;
  state: LiveState;
  streamer?: AudioStreamer | null;
  player?: AudioPlayer | null;
  onOpenOwnerAuth: () => void;
  onOpenIdentitySwitch: () => void;
  onOpenMemoryViewer: () => void;
  onOpenTasks: () => void;
  onOpenVoice: () => void;
  onOpenIoT: () => void;
}

export function HUDHeader({
  identity,
  state,
  streamer,
  player,
  onOpenOwnerAuth,
  onOpenIdentitySwitch,
  onOpenMemoryViewer,
  onOpenTasks,
  onOpenVoice,
  onOpenIoT,
}: HUDHeaderProps) {
  const isOwner = identity.role === 'owner';
  const isUser = identity.role === 'user';

  return (
    <header
      id="hud-header"
      className="w-full z-30 flex items-center justify-between px-6 sm:px-12 py-5 bg-[#030712]/60 backdrop-blur-xl border-b border-white/5"
    >
      {/* Brand & State Pill */}
      <div className="flex items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-3">
          <HeaderIcon state={state} streamer={streamer} player={player} />
          <span className="text-xl sm:text-2xl font-semibold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400">
            Madhurita
          </span>
        </div>

        {/* Live Audio Status Indicator Pill */}
        <div
          className={`px-3.5 sm:px-4 py-1.5 rounded-full border backdrop-blur-md flex items-center gap-2 text-[11px] sm:text-xs font-medium uppercase tracking-[0.15em] transition-all ${
            state === 'speaking'
              ? 'border-pink-500/30 bg-pink-500/10 text-pink-200 shadow-[0_0_15px_rgba(236,72,153,0.2)]'
              : state === 'listening'
              ? 'border-blue-500/30 bg-blue-500/10 text-blue-200 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
              : state === 'connecting'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              : 'border-white/10 bg-white/5 text-white/60'
          }`}
        >
          <div
            className={`w-2 h-2 rounded-full ${
              state === 'speaking'
                ? 'bg-pink-400 animate-pulse'
                : state === 'listening'
                ? 'bg-blue-400 animate-ping'
                : state === 'connecting'
                ? 'bg-amber-400 animate-spin'
                : 'bg-emerald-400'
            }`}
          />
          <span className="hidden xs:inline">
            {state === 'disconnected' ? 'Ready' : state}
          </span>
        </div>
      </div>

      {/* Right Controls: Identity & Modals */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* If Owner: Clickable Switcher & User Management */}
        {isOwner ? (
          <button
            id="btn-identity-badge"
            onClick={onOpenIdentitySwitch}
            className="flex items-center gap-2 px-3.5 py-2 rounded-full border text-xs font-medium backdrop-blur-xl transition-all cursor-pointer bg-gradient-to-r from-amber-500/10 to-purple-500/10 border-amber-500/30 text-amber-200 hover:border-amber-400/50 shadow-[0_0_20px_rgba(245,158,11,0.15)]"
            title="Owner User & Context Manager"
          >
            <Crown className="w-3.5 h-3.5 text-amber-400" />
            <span className="truncate max-w-[100px] sm:max-w-[130px]">
              Owner: {identity.name}
            </span>
            <RefreshCw className="w-2.5 h-2.5 opacity-50 ml-0.5" />
          </button>
        ) : (
          /* Normal User / Guest: Display-only badge (no switching permission) */
          <div
            id="badge-identity-display"
            className={`flex items-center gap-2 px-3.5 py-2 rounded-full border text-xs font-medium backdrop-blur-xl ${
              isUser
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-200'
                : 'bg-white/5 border-white/10 text-white/70'
            }`}
          >
            {isUser ? (
              <User className="w-3.5 h-3.5 text-blue-400" />
            ) : (
              <UserX className="w-3.5 h-3.5 text-slate-400" />
            )}
            <span className="truncate max-w-[100px] sm:max-w-[130px]">
              {identity.name}
            </span>
          </div>
        )}

        {/* Owner Passcode Unlock Button (if not already authenticated as owner) */}
        {!isOwner && (
          <button
            id="btn-owner-unlock"
            onClick={onOpenOwnerAuth}
            className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-purple-600/10 hover:bg-purple-600/20 border border-purple-500/30 text-purple-200 text-xs font-medium backdrop-blur-xl transition-all cursor-pointer hover:shadow-[0_0_15px_rgba(168,85,247,0.2)]"
            title="Enter Owner Passcode"
          >
            <Lock className="w-3.5 h-3.5 text-purple-400" />
            <span className="hidden sm:inline">Owner Passcode</span>
          </button>
        )}

        {/* Feature Navigation (Tasks, Voice, IoT) */}
        {(isOwner || isUser) && (
          <>
            <button
              onClick={onOpenTasks}
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white backdrop-blur-xl flex items-center justify-center transition-all cursor-pointer"
              title="Tasks & Open Loops"
            >
              <CheckSquare className="w-4 h-4 text-amber-400" />
            </button>
            <button
              onClick={onOpenVoice}
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white backdrop-blur-xl flex items-center justify-center transition-all cursor-pointer"
              title="Persona & Voice Settings"
            >
              <Sliders className="w-4 h-4 text-purple-400" />
            </button>
            <button
              onClick={onOpenIoT}
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white backdrop-blur-xl flex items-center justify-center transition-all cursor-pointer"
              title="Home Context & Telemetry (IoT)"
            >
              <MapPin className="w-4 h-4 text-blue-400" />
            </button>
          </>
        )}

        {/* Owner-Only Memory Inspector */}
        {isOwner && (
          <button
            id="btn-memory-viewer"
            onClick={onOpenMemoryViewer}
            className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white backdrop-blur-xl flex items-center justify-center transition-all cursor-pointer"
            title="View Authorized Memories"
          >
            <Database className="w-4 h-4 text-pink-400" />
          </button>
        )}
      </div>
    </header>
  );
}
