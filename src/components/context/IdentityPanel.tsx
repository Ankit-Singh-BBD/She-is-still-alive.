// ===================================================================
// IDENTITY PANEL - Switch identity (slide-up sheet)
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import { UserPlus, Users, User, Check, Loader2, Trash2 } from 'lucide-react';
import { Identity } from '../../types.js';
import { useApi } from '../../hooks/useApi.js';
import { GlassSheet } from '../sheets/GlassSheet.js';
import { PanelSkeleton, PanelError, PanelEmpty } from './PanelShell.js';

interface IdentityPanelProps {
  isOpen: boolean;
  identity: Identity;
  onClose: () => void;
  onSelect: (target: { id: string; name: string; role: string }) => void;
  onRegister: (name: string) => void;
  onDelete?: (id: string) => void;
}

export function IdentityPanel({
  isOpen,
  identity,
  onClose,
  onSelect,
  onRegister,
  onDelete,
}: IdentityPanelProps) {
  const [newName, setNewName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [isSwitching, setIsSwitching] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useApi<any>(
    '/api/users',
    identity,
    undefined,
    { skip: !isOpen, refreshMs: 15000 },
  );

  const users: any[] = Array.isArray(data?.users) ? data.users : [];

  const handleRegister = async () => {
    if (!newName.trim() || isRegistering) return;
    setIsRegistering(true);
    try {
      await onRegister(newName.trim());
      setNewName('');
      refetch();
    } finally {
      setIsRegistering(false);
    }
  };

  const handleSelect = async (user: any) => {
    setIsSwitching(user.id);
    try {
      await onSelect({ id: user.id, name: user.name, role: user.role || 'user' });
      onClose();
    } finally {
      setIsSwitching(null);
    }
  };

  return (
    <GlassSheet
      isOpen={isOpen}
      onClose={onClose}
      title="Identity"
      subtitle="Switch profiles · context is isolated per identity"
      icon={<Users className="w-4 h-4" />}
    >
      {/* Current */}
      <div className="rounded-2xl border border-indigo-300/30 bg-indigo-500/10 p-3 mb-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-300/30 via-pink-400/30 to-violet-500/30 border border-white/20 flex items-center justify-center text-sm font-semibold text-white">
          {identity.name?.charAt(0)?.toUpperCase() || 'G'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] uppercase tracking-wider text-indigo-200 font-medium">
            Active
          </p>
          <p className="text-[14px] font-semibold text-white truncate">
            {identity.name}
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-400/20 text-indigo-100 border border-indigo-300/30">
          {identity.role}
        </span>
      </div>

      {/* All users */}
      {isLoading ? (
        <PanelSkeleton rows={3} />
      ) : error ? (
        <PanelError message={error} onRetry={refetch} />
      ) : users.length === 0 ? (
        <PanelEmpty
          title="No other identities"
          description="Add a name below to create a personal profile with isolated context."
          icon={<User className="w-7 h-7 text-indigo-300/60 mx-auto" />}
        />
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          <p className="text-[10.5px] uppercase tracking-[0.14em] text-white/45 font-medium px-1">
            Switch to
          </p>
          {users.map((user, i) => {
            const isActive = user.id === identity.id;
            const isOwner = user.role === 'owner';
            return (
              <motion.button
                key={user.id}
                type="button"
                onClick={() => !isActive && handleSelect(user)}
                disabled={isActive || isSwitching !== null}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                whileHover={!isActive ? { scale: 1.01, x: 2 } : undefined}
                className={`group flex items-center gap-3 rounded-2xl border p-3 text-left transition-colors press-scale ${
                  isActive
                    ? 'border-white/15 bg-white/[0.04] cursor-default'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08] cursor-pointer'
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-[12.5px] font-semibold border shrink-0 ${
                    isOwner
                      ? 'bg-amber-300/15 text-amber-100 border-amber-300/30'
                      : 'bg-white/[0.08] text-white/80 border-white/15'
                  }`}
                >
                  {user.name?.charAt(0)?.toUpperCase() || '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-white/90 truncate">
                    {user.name}
                  </p>
                  <p className="text-[10.5px] text-white/45 capitalize">
                    {user.role}
                    {user.createdAt && ` · added ${new Date(user.createdAt).toLocaleDateString()}`}
                  </p>
                </div>
                {isActive ? (
                  <Check className="w-4 h-4 text-emerald-300" />
                ) : isSwitching === user.id ? (
                  <Loader2 className="w-4 h-4 text-white/60 animate-spin" />
                ) : onDelete && !isOwner ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete ${user.name}?`)) onDelete(user.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-lg hover:bg-rose-500/20 text-white/50 hover:text-rose-200 flex items-center justify-center transition-all"
                    aria-label="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </motion.button>
            );
          })}
        </div>
      )}

      {/* Add new */}
      <div className="border-t border-white/10 pt-4">
        <p className="text-[10.5px] uppercase tracking-[0.14em] text-white/45 font-medium mb-2 px-1">
          Add new identity
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
            placeholder="Name…"
            className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-white/[0.05] border border-white/12 text-[13px] text-white placeholder-white/40 focus:outline-none focus:border-white/25 focus:bg-white/[0.08] transition-colors"
          />
          <button
            type="button"
            onClick={handleRegister}
            disabled={!newName.trim() || isRegistering}
            className="shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br from-orange-300 via-pink-400 to-violet-500 text-white flex items-center justify-center disabled:opacity-40 cursor-pointer press-scale"
            aria-label="Add"
          >
            {isRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          </button>
        </div>
        <p className="mt-2 text-[10.5px] text-white/40">
          Each identity has its own memories, tasks, and conversation history.
        </p>
      </div>
    </GlassSheet>
  );
}
