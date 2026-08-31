// ===================================================================
// SETTINGS PANEL - Persona, voice, preferences
// ===================================================================

import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Settings2, Volume2, Globe, MessageSquare, Database, Sparkles, Save, Loader2 } from 'lucide-react';
import { Identity } from '../../types.js';
import { sanitizeAuthToken } from '../../utils/auth.js';
import { PanelError, PanelEmpty, PanelSection } from './PanelShell.js';

interface SettingsPanelProps {
  identity: Identity;
  authToken?: string;
  onOpenOnboarding?: () => void;
}

const VOICE_OPTIONS = ['Callirrhoe', 'Aoede', 'Kore', 'Leda', 'Despina'];
const STYLE_OPTIONS = [
  { key: 'warm_conversational', label: 'Warm' },
  { key: 'expressive_witty', label: 'Witty' },
  { key: 'calm_thoughtful', label: 'Calm' },
  { key: 'concise_direct', label: 'Concise' },
];
const LANG_OPTIONS = [
  { key: 'Hinglish', label: 'Hinglish' },
  { key: 'English', label: 'English' },
  { key: 'Hindi', label: 'Hindi' },
];
const LENGTH_OPTIONS = [
  { key: 'concise', label: 'Brief' },
  { key: 'balanced', label: 'Balanced' },
  { key: 'detailed', label: 'Detailed' },
];

export function SettingsPanel({ identity, authToken, onOpenOnboarding }: SettingsPanelProps) {
  const [voiceName, setVoiceName] = useState('Aoede');
  const [style, setStyle] = useState('warm_conversational');
  const [lang, setLang] = useState('Hinglish');
  const [length, setLength] = useState('balanced');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Load current settings
  useEffect(() => {
    if (!identity || identity.id === 'UNKNOWN') return;
    setIsLoading(true);
    setError(null);
    const headers: Record<string, string> = {};
    const cleanToken = sanitizeAuthToken(authToken);
    if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
    if (identity.id) headers['X-User-Id'] = identity.id;
    fetch('/api/persona-voice', { headers, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.config) {
          if (data.config.voiceName) setVoiceName(data.config.voiceName);
          if (data.config.speakingStyle) setStyle(data.config.speakingStyle);
          if (data.config.preferredLanguage) setLang(data.config.preferredLanguage);
          if (data.config.responseLength) setLength(data.config.responseLength);
        }
      })
      .catch((e) => setError(e?.message || 'Failed to load settings'))
      .finally(() => setIsLoading(false));
  }, [identity?.id, authToken]);

  const save = async () => {
    if (!identity || identity.id === 'UNKNOWN') return;
    setIsSaving(true);
    setError(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const cleanToken = sanitizeAuthToken(authToken);
      if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
      if (identity.id) headers['X-User-Id'] = identity.id;
      const res = await fetch('/api/persona-voice', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          voiceName,
          speakingStyle: style,
          preferredLanguage: lang,
          responseLength: length,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const isOwner = identity?.role === 'owner';

  return (
    <div>
      {/* Voice & Persona */}
      <PanelSection title="Voice & Persona" count={isOwner ? undefined : 'owner'}>
        {isLoading ? (
          <div className="h-20 rounded-2xl bg-white/[0.04] animate-shimmer border border-white/10" />
        ) : !isOwner ? (
          <PanelEmpty
            title="Owner only"
            description="Voice and persona settings are configurable in Owner Mode."
            icon={<Sparkles className="w-6 h-6 text-amber-300/60 mx-auto" />}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {/* Voice */}
            <div>
              <p className="text-[10.5px] uppercase tracking-wider text-white/45 font-medium mb-1.5 flex items-center gap-1.5">
                <Volume2 className="w-3 h-3" /> Voice
              </p>
              <div className="flex flex-wrap gap-1.5">
                {VOICE_OPTIONS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVoiceName(v)}
                    className={`px-2.5 py-1.5 rounded-full text-[11px] font-medium cursor-pointer press-scale transition-colors ${
                      voiceName === v
                        ? 'bg-white/15 text-white border border-white/25'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/65'
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Style */}
            <div>
              <p className="text-[10.5px] uppercase tracking-wider text-white/45 font-medium mb-1.5 flex items-center gap-1.5">
                <MessageSquare className="w-3 h-3" /> Style
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {STYLE_OPTIONS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setStyle(s.key)}
                    className={`px-3 py-2 rounded-xl text-[12px] font-medium cursor-pointer press-scale text-left transition-colors ${
                      style === s.key
                        ? 'bg-white/15 text-white border border-white/25'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/70'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Language */}
            <div>
              <p className="text-[10.5px] uppercase tracking-wider text-white/45 font-medium mb-1.5 flex items-center gap-1.5">
                <Globe className="w-3 h-3" /> Language
              </p>
              <div className="flex gap-1.5">
                {LANG_OPTIONS.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => setLang(l.key)}
                    className={`flex-1 px-2 py-1.5 rounded-full text-[11px] font-medium cursor-pointer press-scale transition-colors ${
                      lang === l.key
                        ? 'bg-white/15 text-white border border-white/25'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/65'
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Length */}
            <div>
              <p className="text-[10.5px] uppercase tracking-wider text-white/45 font-medium mb-1.5 flex items-center gap-1.5">
                <Settings2 className="w-3 h-3" /> Response length
              </p>
              <div className="flex gap-1.5">
                {LENGTH_OPTIONS.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => setLength(l.key)}
                    className={`flex-1 px-2 py-1.5 rounded-full text-[11px] font-medium cursor-pointer press-scale transition-colors ${
                      length === l.key
                        ? 'bg-white/15 text-white border border-white/25'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/65'
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Save button */}
            <button
              type="button"
              onClick={save}
              disabled={isSaving}
              className="mt-2 w-full px-4 py-2.5 rounded-xl bg-gradient-to-br from-orange-300 via-pink-400 to-violet-500 text-white font-medium text-[13px] flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer press-scale"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save settings
            </button>
            {error && <PanelError message={error} />}
            {savedAt && !error && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-[10.5px] text-emerald-200 text-center -mt-2"
              >
                Saved · Madhurita will adapt on next reply
              </motion.p>
            )}
          </div>
        )}
      </PanelSection>

      {/* Data & Backup */}
      <PanelSection title="Data & Backup">
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] p-3 text-left cursor-pointer press-scale transition-colors flex items-center gap-2.5"
            onClick={async () => {
              const headers: Record<string, string> = {};
              const cleanToken = sanitizeAuthToken(authToken);
              if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
              if (identity?.id) headers['X-User-Id'] = identity.id;
              const res = await fetch('/api/backup/export', { headers });
              if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `madhurita-backup-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }
            }}
          >
            <Database className="w-4 h-4 text-indigo-200" />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-white/90">Export data</p>
              <p className="text-[10.5px] text-white/45">All memories, tasks, conversations</p>
            </div>
          </button>

          {onOpenOnboarding && (
            <button
              type="button"
              onClick={onOpenOnboarding}
              className="w-full rounded-2xl border border-amber-300/25 bg-amber-500/[0.06] hover:bg-amber-500/[0.1] p-3 text-left cursor-pointer press-scale transition-colors flex items-center gap-2.5"
            >
              <Sparkles className="w-4 h-4 text-amber-200" />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-amber-100">Owner setup</p>
                <p className="text-[10.5px] text-amber-200/70">Configure owner profile</p>
              </div>
            </button>
          )}
        </div>
      </PanelSection>
    </div>
  );
}
