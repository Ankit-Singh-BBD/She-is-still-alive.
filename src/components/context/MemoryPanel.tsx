// ===================================================================
// MEMORY PANEL - What Madhurita remembers (search + categories + recent)
// ===================================================================

import { motion } from 'motion/react';
import { useState } from 'react';
import { Search, Brain, Sparkles, Filter, Plus, Trash2 } from 'lucide-react';
import { Identity } from '../../types.js';
import { useApi } from '../../hooks/useApi.js';
import { useStage } from '../../hooks/useStage.js';
import { PanelSkeleton, PanelError, PanelEmpty, PanelSection } from './PanelShell.js';
import { truncate, formatRelative } from '../../utils/format.js';

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'preference', label: 'Preferences' },
  { key: 'fact', label: 'Facts' },
  { key: 'project', label: 'Projects' },
  { key: 'goal', label: 'Goals' },
  { key: 'personal', label: 'Personal' },
];

const CATEGORY_EMOJI: Record<string, string> = {
  preference: '💜',
  fact: '📌',
  project: '🚀',
  goal: '🎯',
  personal: '💫',
};

interface MemoryPanelProps {
  identity: Identity;
  authToken?: string;
  /**
   * Optional callback invoked when the user clicks the trash icon on a
   * memory. Receives the memory id + preview. The host drives the
   * TARGET → SCOPE → SAFETY → CONFIRMATION → BIN flow; this panel
   * never deletes anything directly.
   */
  onRequestDelete?: (memoryId: string, preview: string) => void;
}

export function MemoryPanel({ identity, authToken, onRequestDelete }: MemoryPanelProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const { setStage } = useStage();

  const { data, isLoading, error, refetch } = useApi<any>(
    identity?.id && identity.id !== 'UNKNOWN'
      ? `/api/owner/memories-grouped`
      : null,
    identity,
    authToken,
    { refreshMs: 30000 },
  );

  // Flatten grouped memories
  const allMemories: any[] = [];
  if (data?.grouped && Array.isArray(data.grouped)) {
    for (const group of data.grouped) {
      for (const mem of group.memories || []) {
        allMemories.push({ ...mem, ownerName: group.user?.name });
      }
    }
  } else if (Array.isArray(data?.memories)) {
    allMemories.push(...data.memories);
  }

  const filtered = allMemories.filter((m) => {
    if (category !== 'all' && m.category !== category) return false;
    if (search.trim() && !m.content.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div>
      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memories…"
          className="w-full pl-9 pr-3 py-2 rounded-xl bg-white/[0.05] border border-white/12 text-[13px] text-white placeholder-white/40 focus:outline-none focus:border-white/25 focus:bg-white/[0.08] transition-colors"
        />
      </div>

      {/* Category chips */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCategory(c.key)}
            className={`px-2.5 py-1 rounded-full text-[10.5px] font-medium cursor-pointer press-scale transition-colors ${
              category === c.key
                ? 'bg-white/15 text-white border border-white/25'
                : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/65'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <PanelSkeleton rows={4} />
      ) : error ? (
        <PanelError message={error} onRetry={refetch} />
      ) : allMemories.length === 0 ? (
        <PanelEmpty
          title="No memories yet"
          description="As you talk with Madhurita, she'll remember your preferences, projects, and personal details."
          icon={<Brain className="w-7 h-7 text-indigo-300/60 mx-auto" />}
        />
      ) : (
        <PanelSection
          title="Recent Memories"
          count={filtered.length}
          action={
            <button
              type="button"
              onClick={() => {
                // Real action: navigate back to home and focus the
                // composer so the user can type a memory they want
                // Madhurita to remember. The cognitive engine
                // extracts and stores memories on the next reply.
                setStage('home');
                // Focus the input on the next frame so the home
                // stage has time to mount.
                requestAnimationFrame(() => {
                  const el = document.getElementById('composer-input');
                  if (el) (el as HTMLInputElement).focus();
                });
              }}
              className="text-[10.5px] text-indigo-200 hover:text-indigo-100 flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          }
        >
          <div className="flex flex-col gap-2">
            {filtered.slice(0, 30).map((mem, i) => (
              <motion.div
                key={mem.memoryId || i}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02 }}
                className="rounded-2xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] p-3 transition-colors cursor-default group"
              >
                <div className="flex items-start gap-2">
                  <span className="text-base leading-none mt-0.5 shrink-0">
                    {CATEGORY_EMOJI[mem.category] || '💭'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-white/90 leading-relaxed">
                      {truncate(mem.content, 200)}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2 text-[10px] text-white/45">
                      <span className="capitalize">{mem.category}</span>
                      {mem.confidence !== undefined && (
                        <>
                          <span>·</span>
                          <span className="tabular-nums">
                            {Math.round((mem.confidence || 0) * 100)}% confident
                          </span>
                        </>
                      )}
                      {mem.createdAt && (
                        <>
                          <span>·</span>
                          <span>{formatRelative(mem.createdAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {onRequestDelete && mem.memoryId && (
                    <button
                      type="button"
                      onClick={() => onRequestDelete(mem.memoryId, mem.content || '')}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0 w-7 h-7 rounded-lg text-white/45 hover:text-rose-300 hover:bg-rose-500/10 flex items-center justify-center cursor-pointer press-scale"
                      aria-label="Move to Bin"
                      title="Move to Bin"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </PanelSection>
      )}
    </div>
  );
}
