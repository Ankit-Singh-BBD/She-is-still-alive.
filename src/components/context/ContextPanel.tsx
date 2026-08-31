// ===================================================================
// CONTEXT PANEL - Right-side contextual overlay for Memory / Search / Tasks
// / Calendar / Devices / Settings. Slides in from the right on desktop,
// becomes a full-screen sheet on mobile.
// ===================================================================

import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { ReactNode } from 'react';
import { useUIState } from '../../hooks/useUIState.js';
import { useStage } from '../../hooks/useStage.js';
import { MemoryPanel } from './MemoryPanel.js';
import { SearchPanel } from './SearchPanel.js';
import { TasksPanel } from './TasksPanel.js';
import { CalendarPanel } from './CalendarPanel.js';
import { DevicesPanel } from './DevicesPanel.js';
import { IdentityPanel } from './IdentityPanel.js';
import { SettingsPanel } from './SettingsPanel.js';

interface ContextPanelProps {
  identity: any;
  authToken?: string;
  onSwitchIdentity: (target: { id: string; name: string; role: string }) => void;
  onRegisterUser: (name: string) => void;
  onDeleteUser?: (id: string) => void;
  onOpenOnboarding?: () => void;
}

export function ContextPanel({
  identity,
  authToken,
  onSwitchIdentity,
  onRegisterUser,
  onDeleteUser,
  onOpenOnboarding,
}: ContextPanelProps) {
  const { activePanel, activeStage, setStage } = useStage();
  const { state } = useUIState();

  const handleClose = () => setStage('home');

  // For identity, the "panel" is a sheet overlay (always available)
  if (activeStage === 'identity') {
    return (
      <IdentityPanel
        isOpen
        identity={identity}
        onClose={handleClose}
        onSelect={onSwitchIdentity}
        onRegister={onRegisterUser}
        onDelete={onDeleteUser}
      />
    );
  }

  if (!activePanel) return null;

  return (
    <AnimatePresence mode="wait">
      <motion.div key={activePanel}>
        <PanelContainer
          onClose={handleClose}
          title={TITLE[activePanel]}
        >
          {activePanel === 'memory' && <MemoryPanel identity={identity} authToken={authToken} />}
          {activePanel === 'search' && <SearchPanel identity={identity} authToken={authToken} />}
          {activePanel === 'tasks' && <TasksPanel identity={identity} authToken={authToken} />}
          {activePanel === 'calendar' && <CalendarPanel identity={identity} authToken={authToken} />}
          {activePanel === 'devices' && <DevicesPanel identity={identity} authToken={authToken} />}
          {activePanel === 'settings' && (
            <SettingsPanel
              identity={identity}
              authToken={authToken}
              onOpenOnboarding={onOpenOnboarding}
            />
          )}
        </PanelContainer>
      </motion.div>
    </AnimatePresence>
  );
}

const TITLE: Record<string, string> = {
  memory: 'Memory',
  search: 'Search',
  tasks: 'Tasks',
  calendar: 'Calendar',
  devices: 'Devices',
  settings: 'Settings',
};

interface PanelContainerProps {
  children: ReactNode;
  onClose: () => void;
  title: string;
}

function PanelContainer({ children, onClose, title }: PanelContainerProps) {
  return (
    <>
      {/* Backdrop on mobile only */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
        className="lg:hidden fixed inset-0 z-30 bg-black/40 backdrop-blur-sm"
      />

      {/* Panel — desktop: slide in from right; mobile: bottom sheet */}
      <motion.aside
        initial={{ x: '100%', opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: '100%', opacity: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="fixed lg:relative lg:translate-x-0 inset-0 lg:inset-auto z-40 lg:z-auto lg:w-[380px] xl:w-[420px] shrink-0 h-full lg:h-auto lg:my-4 lg:mr-4 lg:ml-2"
      >
        <div
          className="h-full lg:h-full glass-deep lg:rounded-3xl border-white/12 lg:border flex flex-col overflow-hidden shadow-2xl shadow-black/30"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-white/10">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-white tracking-tight truncate">
                {title}
              </h2>
              <p className="text-[10.5px] text-white/50 mt-0.5">
                Press <kbd className="px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-white/55 text-[9.5px] font-mono">Esc</kbd> to close
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.14] border border-white/12 text-white/70 hover:text-white flex items-center justify-center cursor-pointer press-scale transition-colors"
              aria-label="Close panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
            {children}
          </div>
        </div>
      </motion.aside>
    </>
  );
}
