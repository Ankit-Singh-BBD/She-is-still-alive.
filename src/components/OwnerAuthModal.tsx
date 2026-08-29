import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { Lock, KeyRound, AlertCircle, X, ShieldCheck } from 'lucide-react';

interface OwnerAuthModalProps {
  isOpen: boolean;
  onSuccess: (owner: { id: string; name: string; role: 'owner' }, token: string) => void;
  onClose: () => void;
}

export function OwnerAuthModal({ isOpen, onSuccess, onClose }: OwnerAuthModalProps) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!passcode) {
      setError('Please enter the owner passcode.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || 'Authentication failed: Incorrect passcode');
        setIsLoading(false);
        return;
      }

      onSuccess(data.owner, data.token);
      setPasscode('');
    } catch (err: any) {
      setError(err.message || 'Authentication request failed');
      setIsLoading(false);
    }
  };

  return (
    <div
      id="owner-auth-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#030712]/80 backdrop-blur-xl"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-sm bg-[#030712]/95 border border-white/15 rounded-3xl p-6 shadow-[0_0_60px_rgba(168,85,247,0.2)] text-white relative"
      >
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-1.5 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-all cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-purple-500/25">
            <Lock className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Owner Authorization</h3>
            <p className="text-xs text-white/50">Authoritative Passcode Check</p>
          </div>
        </div>

        <p className="text-xs text-white/70 mb-4 leading-relaxed bg-white/5 p-3 rounded-2xl border border-white/10">
          Owner privileges require cryptographic passcode verification. Self-declared names do not grant owner access.
        </p>

        {error && (
          <div className="flex items-center gap-2 p-3 mb-4 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-purple-400" />
              Owner Passcode
            </label>
            <input
              id="input-auth-passcode"
              type="password"
              autoFocus
              required
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Enter passcode"
              className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-400/50"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              id="btn-verify-owner-passcode"
              type="submit"
              disabled={isLoading}
              className="px-5 py-2 rounded-full bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 text-white font-medium text-xs shadow-[0_0_20px_rgba(168,85,247,0.3)] hover:shadow-[0_0_25px_rgba(168,85,247,0.5)] transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>{isLoading ? 'Verifying...' : 'Unlock Owner'}</span>
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
