// ===================================================================
// SEARCH PANEL - Search across memories, tasks, conversations
// ===================================================================

import { motion } from 'motion/react';
import { useState, useEffect } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { Identity } from '../../types.js';
import { useApi } from '../../hooks/useApi.js';
import { sanitizeAuthToken } from '../../utils/auth.js';
import { PanelEmpty } from './PanelShell.js';
import { truncate, formatRelative } from '../../utils/format.js';

interface SearchPanelProps {
  identity: Identity;
  authToken?: string;
}

export function SearchPanel({ identity, authToken }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const t = setTimeout(async () => {
      try {
        const headers: Record<string, string> = {};
        const cleanToken = sanitizeAuthToken(authToken);
        if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
        if (identity?.id) headers['X-User-Id'] = identity.id;
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}`,
          { headers, cache: 'no-store' },
        );
        if (res.ok) {
          const data = await res.json();
          setResults(data.results || data.matches || []);
        } else {
          setResults([]);
        }
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, identity?.id, authToken]);

  return (
    <div>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search across everything…"
          autoFocus
          className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-white/[0.05] border border-white/12 text-[13.5px] text-white placeholder-white/40 focus:outline-none focus:border-white/25 focus:bg-white/[0.08] transition-colors"
        />
        {isSearching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 animate-spin" />
        )}
      </div>

      {!query.trim() ? (
        <PanelEmpty
          title="Search Madhurita"
          description="Type a keyword to search across memories, tasks, open loops, and conversations."
        />
      ) : results.length === 0 && !isSearching ? (
        <PanelEmpty
          title={`No results for "${truncate(query, 30)}"`}
          description="Try a different keyword or check the spelling."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {results.map((r, i) => (
            <motion.div
              key={r.id || i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.02 }}
              className="rounded-2xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] p-3 transition-colors cursor-pointer"
            >
              <div className="flex items-start gap-2">
                <span className="text-[10px] uppercase tracking-wider text-indigo-200 font-medium shrink-0 mt-0.5">
                  {r.type || r.kind || 'match'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-white/90 leading-relaxed">
                    {truncate(r.content || r.text || r.title || JSON.stringify(r), 180)}
                  </p>
                  {r.createdAt && (
                    <p className="mt-1 text-[10px] text-white/45">
                      {formatRelative(r.createdAt)}
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
