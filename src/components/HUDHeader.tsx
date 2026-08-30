import { useState, useRef, useEffect } from 'react';
import {
  Crown,
  User,
  UserX,
  Database,
  Lock,
  RefreshCw,
  CheckSquare,
  Sliders,
  MapPin,
  MoreHorizontal,
} from 'lucide-react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const modeLabel = isOwner ? 'Owner Mode' : isUser ? 'Personal Mode' : 'Personal Mode';

  const runAndClose = (fn: () => void) => {
    fn();
    setMenuOpen(false);
  };

  return (
    <header
      id="hud-header"
      className="w-full z-30 flex items-center justify-between gap-4 pl-5 pr-4 py-3.5 border-b border-white/10"
    >
      {/* Left: traffic lights + brand */}
      <div className="flex items-center gap-4 min-w-0">
        <div className="hidden sm:flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57] shadow-inner" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e] shadow-inner" />
          <span className="w-3 h-3 rounded-full bg-[#28c840] shadow-inner" />
        </div>

        <div className="flex items-center gap-2.5 min-w-0">
          <HeaderIcon state={state} streamer={streamer} player={player} />
          <span className="text-lg font-semibold tracking-tight text-white truncate">
            Madhurita
          </span>
        </div>
      </div>

      {/* Right: quick tools + identity chip + menu */}
      <div className="flex items-center gap-2">
        {/* Feature tools (owner/user only) */}
        {(isOwner || isUser) && (
          <div className="hidden lg:flex items-center gap-1.5 mr-1">
            <button
              onClick={onOpenTasks}
              className="w-9 h-9 rounded-full glass glass-hover text-white/70 hover:text-white flex items-center justify-center cursor-pointer"
              title="Tasks & Open Loops"
            >
              <CheckSquare className="w-[17px] h-[17px] text-amber-200/90" />
            </button>
            <button
              onClick={onOpenVoice}
              className="w-9 h-9 rounded-full glass glass-hover text-white/70 hover:text-white flex items-center justify-center cursor-pointer"
              title="Persona & Voice Settings"
            >
              <Sliders className="w-[17px] h-[17px] text-violet-200/90" />
            </button>
            <button
              onClick={onOpenIoT}
              className="w-9 h-9 rounded-full glass glass-hover text-white/70 hover:text-white flex items-center justify-center cursor-pointer"
              title="Home Context & Telemetry (IoT)"
            >
              <MapPin className="w-[17px] h-[17px] text-sky-200/90" />
            </button>
            {isOwner && (
              <button
                id="btn-memory-viewer"
                onClick={onOpenMemoryViewer}
                className="w-9 h-9 rounded-full glass glass-hover text-white/70 hover:text-white flex items-center justify-center cursor-pointer"
                title="View Authorized Memories"
              >
                <Database className="w-[17px] h-[17px] text-fuchsia-200/90" />
              </button>
            )}
          </div>
        )}

        {/* Identity chip */}
        {isOwner ? (
          <button
            id="btn-identity-badge"
            onClick={onOpenIdentitySwitch}
            className="glass glass-hover flex items-center gap-2.5 pl-2 pr-3.5 py-1.5 rounded-full cursor-pointer"
            title="Owner User & Context Manager"
          >
            <span className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-300/30 to-violet-400/30 border border-white/20 flex items-center justify-center shrink-0">
              <Crown className="w-4 h-4 text-amber-200" />
            </span>
            <span className="text-left leading-tight hidden sm:block">
              <span className="block text-[13px] font-semibold text-white truncate max-w-[110px]">
                {identity.name}
              </span>
              <span className="block text-[11px] text-white/55">{modeLabel}</span>
            </span>
            <RefreshCw className="w-3 h-3 text-white/40 ml-0.5" />
          </button>
        ) : (
          <div
            id="badge-identity-display"
            className="glass flex items-center gap-2.5 pl-2 pr-3.5 py-1.5 rounded-full"
          >
            <span className="w-8 h-8 rounded-full bg-white/10 border border-white/20 flex items-center justify-center shrink-0">
              {isUser ? (
                <User className="w-4 h-4 text-sky-200" />
              ) : (
                <UserX className="w-4 h-4 text-slate-300" />
              )}
            </span>
            <span className="text-left leading-tight hidden sm:block">
              <span className="block text-[13px] font-semibold text-white truncate max-w-[110px]">
                {identity.name}
              </span>
              <span className="block text-[11px] text-white/55">{modeLabel}</span>
            </span>
          </div>
        )}

        {/* Overflow menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="w-9 h-9 rounded-full glass glass-hover text-white/70 hover:text-white flex items-center justify-center cursor-pointer"
            title="More"
          >
            <MoreHorizontal className="w-[18px] h-[18px]" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-11 w-56 glass-panel rounded-2xl p-1.5 shadow-2xl shadow-black/40 z-50">
              {!isOwner && (
                <button
                  id="btn-owner-unlock"
                  onClick={() => runAndClose(onOpenOwnerAuth)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/80 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <Lock className="w-4 h-4 text-violet-200" />
                  Owner Passcode
                </button>
              )}
              {(isOwner || isUser) && (
                <>
                  <button
                    onClick={() => runAndClose(onOpenTasks)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/80 hover:bg-white/10 transition-colors cursor-pointer lg:hidden"
                  >
                    <CheckSquare className="w-4 h-4 text-amber-200" />
                    Tasks & Open Loops
                  </button>
                  <button
                    onClick={() => runAndClose(onOpenVoice)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/80 hover:bg-white/10 transition-colors cursor-pointer lg:hidden"
                  >
                    <Sliders className="w-4 h-4 text-violet-200" />
                    Persona & Voice
                  </button>
                  <button
                    onClick={() => runAndClose(onOpenIoT)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/80 hover:bg-white/10 transition-colors cursor-pointer lg:hidden"
                  >
                    <MapPin className="w-4 h-4 text-sky-200" />
                    Home Context
                  </button>
                </>
              )}
              {isOwner && (
                <>
                  <button
                    onClick={() => runAndClose(onOpenMemoryViewer)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/80 hover:bg-white/10 transition-colors cursor-pointer lg:hidden"
                  >
                    <Database className="w-4 h-4 text-fuchsia-200" />
                    Authorized Memories
                  </button>
                  <button
                    onClick={() => runAndClose(onOpenIdentitySwitch)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/80 hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4 text-white/70" />
                    Switch Identity
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
