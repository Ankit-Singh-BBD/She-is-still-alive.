import { motion, AnimatePresence } from 'motion/react';
import { ExternalLink, BookmarkPlus, ShieldCheck, UserCheck, Clock, CheckCircle2 } from 'lucide-react';
import { ToolActionItem } from '../types.js';

interface ToolActionToastProps {
  actions: ToolActionItem[];
  onDismiss: (id: string) => void;
}

export function ToolActionToast({ actions, onDismiss }: ToolActionToastProps) {
  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-4 sm:px-0">
      <AnimatePresence>
        {actions.map((act) => {
          let icon = <CheckCircle2 className="w-4 h-4 text-pink-400" />;
          let title = 'Action Executed';
          let desc = '';

          if (act.tool === 'openWebsite') {
            icon = <ExternalLink className="w-4 h-4 text-cyan-400" />;
            title = 'Browser Tool';
            desc = `Opened: ${act.data?.title || act.data?.url}`;
          } else if (act.tool === 'rememberFact') {
            icon = <BookmarkPlus className="w-4 h-4 text-pink-400" />;
            title = 'Memory Engine';
            desc = `Remembered: "${act.data?.fact}"`;
          } else if (act.tool === 'identifyUser') {
            icon = <UserCheck className="w-4 h-4 text-indigo-400" />;
            title = 'Identity Engine';
            desc = `Switched to: ${act.data?.name || 'User'}`;
          } else if (act.tool === 'ownerAuthenticate') {
            icon = <ShieldCheck className="w-4 h-4 text-amber-400" />;
            title = 'Owner Auth';
            desc = 'Owner Passcode Authenticated';
          } else if (act.tool === 'getTimeAndStatus') {
            icon = <Clock className="w-4 h-4 text-emerald-400" />;
            title = 'System Query';
            desc = 'Status check optimal';
          }

          return (
            <motion.div
              key={act.id}
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.9 }}
              transition={{ duration: 0.3 }}
              className="pointer-events-auto p-3.5 rounded-2xl bg-[#030712]/90 border border-white/15 backdrop-blur-2xl shadow-[0_0_40px_rgba(168,85,247,0.25)] flex items-center justify-between gap-3 text-white"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center shrink-0 shadow-inner">
                  {icon}
                </div>
                <div>
                  <div className="text-xs font-semibold text-white">{title}</div>
                  <div className="text-[11px] text-white/70 truncate max-w-[210px]">{desc}</div>
                </div>
              </div>
              <button
                onClick={() => onDismiss(act.id)}
                className="text-[10px] text-white/50 hover:text-white px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 transition-all cursor-pointer"
              >
                Dismiss
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
