import { useState, useMemo, type FormEvent, type MouseEvent } from 'react';
import { motion } from 'motion/react';
import { Users, UserPlus, UserX, Check, X, Trash2, Crown, Search } from 'lucide-react';
import { Identity } from '../types.js';

interface IdentitySwitchModalProps {
  isOpen: boolean;
  currentIdentity: Identity;
  users: Array<{ id: string; name: string; createdAt: string }>;
  onSelectIdentity: (identity: Identity) => void;
  onRegisterUser: (name: string) => Promise<void>;
  onDeleteUser?: (userId: string) => Promise<void>;
  onClose: () => void;
}

export function IdentitySwitchModal({
  isOpen,
  currentIdentity,
  users,
  onSelectIdentity,
  onRegisterUser,
  onDeleteUser,
  onClose,
}: IdentitySwitchModalProps) {
  const [newUserName, setNewUserName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q));
  }, [users, searchQuery]);

  if (!isOpen) return null;

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (!newUserName.trim()) return;

    setIsSubmitting(true);
    try {
      await onRegisterUser(newUserName.trim());
      setNewUserName('');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (e: MouseEvent, userId: string) => {
    e.stopPropagation();
    if (!onDeleteUser) return;
    setDeletingId(userId);
    try {
      await onDeleteUser(userId);
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div
      id="identity-switch-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#030712]/80 backdrop-blur-xl"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-md bg-[#030712]/95 border border-white/15 rounded-3xl p-6 shadow-[0_0_60px_rgba(168,85,247,0.15)] text-white relative max-h-[90vh] flex flex-col"
      >
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-1.5 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-all cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
            <Users className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-white">Owner User Management</h3>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-semibold flex items-center gap-1 border border-amber-500/30">
                <Crown className="w-2.5 h-2.5" /> Owner Only
              </span>
            </div>
            <p className="text-xs text-white/50">Manage registered profiles & switch active context</p>
          </div>
        </div>

        {/* Search Filter for Fast Identity Switch */}
        {users.length > 3 && (
          <div className="relative mb-3">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Quick search registered identities..."
              className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 text-xs focus:outline-none focus:border-purple-400/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white text-xs"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}

        {/* Existing Users List */}
        <div className="flex-1 max-h-72 overflow-y-auto space-y-2 mb-4 pr-1.5 custom-scrollbar">
          <div className="text-[11px] font-medium text-white/40 uppercase tracking-[0.15em] mb-1 flex items-center justify-between">
            <span>Registered Identities ({filteredUsers.length})</span>
            {searchQuery && <span className="text-pink-400 font-normal">Filtered</span>}
          </div>

          {filteredUsers.length === 0 ? (
            <div className="p-4 rounded-2xl bg-white/5 border border-white/5 text-center text-xs text-white/40">
              {searchQuery ? `No identities matching "${searchQuery}"` : 'No registered user profiles in database yet.'}
            </div>
          ) : (
            filteredUsers.map((u) => {
              const isSelected = currentIdentity.id === u.id;
              return (
                <div
                  key={u.id}
                  onClick={() => onSelectIdentity({ id: u.id, name: u.name, role: 'user' })}
                  className={`w-full flex items-center justify-between p-3.5 rounded-2xl border transition-all text-left cursor-pointer group ${
                    isSelected
                      ? 'bg-gradient-to-r from-blue-500/15 via-purple-500/15 to-transparent border-purple-500/40 text-purple-200 shadow-[0_0_15px_rgba(168,85,247,0.15)]'
                      : 'bg-white/5 border-white/5 hover:bg-white/10 text-white/70'
                  }`}
                >
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-white">{u.name}</div>
                    <div className="text-[10px] text-white/40">{u.id} • Registered User</div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isSelected && <Check className="w-4 h-4 text-purple-400" />}
                    {onDeleteUser && u.id !== 'OWNER_001' && (
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, u.id)}
                        disabled={deletingId === u.id}
                        className="p-1.5 rounded-lg hover:bg-rose-500/20 text-white/30 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                        title={`Delete ${u.name}'s profile and memories`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {/* Guest / Unknown Option */}
          <button
            onClick={() => onSelectIdentity({ id: 'UNKNOWN', name: 'Guest', role: 'unknown' })}
            className={`w-full flex items-center justify-between p-3.5 rounded-2xl border transition-all text-left cursor-pointer ${
              currentIdentity.role === 'unknown'
                ? 'bg-white/10 border-white/20 text-white'
                : 'bg-white/5 border-white/5 hover:bg-white/10 text-white/50'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <UserX className="w-4 h-4 text-white/50" />
              <div>
                <div className="text-sm font-medium text-white/90">Guest (Unknown Person)</div>
                <div className="text-[10px] text-white/40">No persistent private memory</div>
              </div>
            </div>
            {currentIdentity.role === 'unknown' && <Check className="w-4 h-4 text-white" />}
          </button>
        </div>

        {/* Register New User Section */}
        <form onSubmit={handleRegister} className="border-t border-white/10 pt-4">
          <div className="text-[11px] font-medium text-white/40 uppercase tracking-[0.15em] mb-2 flex items-center gap-1.5">
            <UserPlus className="w-3.5 h-3.5 text-pink-400" />
            Introduce New Identity
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newUserName}
              onChange={(e) => setNewUserName(e.target.value)}
              placeholder="e.g. Rahul, Priya, Alex..."
              className="flex-1 px-3.5 py-2.5 rounded-full bg-white/5 border border-white/10 text-white placeholder-white/30 text-xs focus:outline-none focus:border-purple-400/50"
            />
            <button
              id="btn-register-user"
              type="submit"
              disabled={isSubmitting || !newUserName.trim()}
              className="px-5 py-2.5 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-400 hover:to-purple-500 text-white text-xs font-medium transition-all disabled:opacity-50 cursor-pointer shadow-md shadow-purple-500/20"
            >
              {isSubmitting ? 'Adding...' : 'Add & Switch'}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
