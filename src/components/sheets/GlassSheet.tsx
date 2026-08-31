// ===================================================================
// GLASS SHEET - Base sheet component (full-screen on mobile, panel on desktop)
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { ReactNode, useEffect } from 'react';

interface GlassSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  subtitle?: string;
  /** Max width on desktop (px) */
  maxWidth?: number;
  /** Whether to show a close button (X) in top-right */
  showClose?: boolean;
  /** Optional left-side accent icon (in title) */
  icon?: ReactNode;
}

export function GlassSheet({
  isOpen,
  onClose,
  children,
  title,
  subtitle,
  maxWidth = 480,
  showClose = true,
  icon,
}: GlassSheetProps) {
  // Esc to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
          />

          {/* Sheet container — mobile: bottom sheet, desktop: centered modal */}
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center pointer-events-none">
            <motion.div
              initial={{ y: '100%', opacity: 0, scale: 0.95 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: '100%', opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-auto w-full sm:w-auto sm:max-w-md md:max-w-lg glass-deep rounded-t-3xl sm:rounded-3xl shadow-2xl shadow-black/50 overflow-hidden flex flex-col"
              style={{ maxHeight: 'min(90vh, 720px)' }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Drag handle (mobile) */}
              <div className="sm:hidden flex justify-center pt-2.5 pb-1">
                <span className="w-9 h-1 rounded-full bg-white/20" />
              </div>

              {/* Header */}
              {(title || showClose) && (
                <div className="flex items-start justify-between gap-3 px-5 sm:px-6 pt-4 sm:pt-5 pb-3">
                  <div className="min-w-0 flex-1 flex items-center gap-2.5">
                    {icon && (
                      <span className="shrink-0 w-8 h-8 rounded-xl glass flex items-center justify-center text-indigo-200">
                        {icon}
                      </span>
                    )}
                    <div className="min-w-0">
                      {title && (
                        <h2 className="text-[16px] font-semibold text-white truncate">
                          {title}
                        </h2>
                      )}
                      {subtitle && (
                        <p className="text-[11.5px] text-white/55 mt-0.5 truncate">
                          {subtitle}
                        </p>
                      )}
                    </div>
                  </div>
                  {showClose && (
                    <button
                      type="button"
                      onClick={onClose}
                      className="shrink-0 w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.14] border border-white/12 text-white/70 hover:text-white flex items-center justify-center cursor-pointer press-scale transition-colors"
                      aria-label="Close"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}

              {/* Content (scrollable) */}
              <div className="flex-1 overflow-y-auto custom-scrollbar px-5 sm:px-6 pb-5 sm:pb-6">
                {children}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
