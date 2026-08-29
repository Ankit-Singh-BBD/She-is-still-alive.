import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { Shield, KeyRound, User, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';

interface OwnerSetupModalProps {
  isOpen: boolean;
  onSuccess: (owner: { id: string; name: string; role: 'owner' }, token: string) => void;
  onClose: () => void;
}

export function OwnerSetupModal({ isOpen, onSuccess, onClose }: OwnerSetupModalProps) {
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [confirmPasscode, setConfirmPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  if (!isOpen) return null;

  const handleSetup = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (passcode.length < 4) {
      setError('Owner passcode must be at least 4 characters.');
      return;
    }
    if (passcode !== confirmPasscode) {
      setError('Passcodes do not match.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/setup-owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), passcode }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to complete Owner setup');
        setIsLoading(false);
        return;
      }

      onSuccess(data.owner, data.token);
    } catch (err: any) {
      setError(err.message || 'Network error during setup');
      setIsLoading(false);
    }
  };

  return (
    <div
      id="owner-setup-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#030712]/80 backdrop-blur-xl"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-md bg-[#030712]/95 border border-white/15 rounded-3xl p-6 sm:p-8 shadow-[0_0_60px_rgba(245,158,11,0.2)] text-white relative"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-amber-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-amber-500/25">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Owner First-Time Setup</h3>
            <p className="text-xs text-white/50">Initialize Authoritative Master Profile</p>
          </div>
        </div>

        <p className="text-xs text-white/70 mb-5 leading-relaxed bg-white/5 p-3.5 rounded-2xl border border-white/10">
          Madhurita is an identity-aware assistant. Establish your Owner profile and secure passcode. Passcodes are hashed with PBKDF2 and never stored as plaintext.
        </p>

        {error && (
          <div className="flex items-center gap-2 p-3 mb-4 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSetup} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-purple-400" />
              Owner Display Name
            </label>
            <input
              id="input-owner-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ankit"
              className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-white placeholder-white/30 text-sm focus:outline-none focus:border-amber-400/50"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-purple-400" />
              Secret Owner Passcode
            </label>
            <input
              id="input-owner-passcode"
              type="password"
              required
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Enter secure passcode (min 4 chars)"
              className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-white placeholder-white/30 text-sm focus:outline-none focus:border-amber-400/50"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              Confirm Passcode
            </label>
            <input
              id="input-owner-confirm-passcode"
              type="password"
              required
              value={confirmPasscode}
              onChange={(e) => setConfirmPasscode(e.target.value)}
              placeholder="Re-enter passcode"
              className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-white placeholder-white/30 text-sm focus:outline-none focus:border-amber-400/50"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-full bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-all cursor-pointer"
            >
              Skip for Now (Guest Mode)
            </button>
            <button
              id="btn-submit-owner-setup"
              type="submit"
              disabled={isLoading}
              className="px-5 py-2.5 rounded-full bg-gradient-to-r from-amber-500 via-purple-500 to-pink-500 text-white font-medium text-xs shadow-[0_0_20px_rgba(245,158,11,0.3)] hover:shadow-[0_0_25px_rgba(245,158,11,0.5)] transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isLoading ? 'Initializing...' : 'Initialize Owner'}</span>
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
