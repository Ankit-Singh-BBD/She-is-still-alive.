import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense, FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { LiveClient } from './services/liveClient.js';
import { Identity, LiveState, SystemStatus, ToolActionItem, RuntimeContext } from './types.js';
import { ExperienceIntro } from './components/ExperienceIntro.js';
import { HUDHeader } from './components/HUDHeader.js';
import { VoiceCore } from './components/VoiceCore.js';
import { ToolActionToast } from './components/ToolActionToast.js';
import { Sidebar, NavKey } from './components/Sidebar.js';
import { GreetingHero } from './components/GreetingHero.js';
import { Composer } from './components/Composer.js';
import {
  Shield,
  AlertTriangle,
  Lock,
  AudioLines,
  X,
  Bot,
  User,
} from 'lucide-react';

// Lazy-loaded Modal Components for Code-Splitting & Minimal Initial Bundle Size
const OwnerSetupModal = lazy(() =>
  import('./components/OwnerSetupModal.js').then((m) => ({ default: m.OwnerSetupModal }))
);
const OwnerAuthModal = lazy(() =>
  import('./components/OwnerAuthModal.js').then((m) => ({ default: m.OwnerAuthModal }))
);
const IdentitySwitchModal = lazy(() =>
  import('./components/IdentitySwitchModal.js').then((m) => ({ default: m.IdentitySwitchModal }))
);
const MemoryViewerModal = lazy(() =>
  import('./components/MemoryViewerModal.js').then((m) => ({ default: m.MemoryViewerModal }))
);

import { sanitizeAuthToken } from './utils/auth.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export default function App() {
  // Deterministic clean boot: every page load starts on Intro and with UNKNOWN Guest identity
  const [hasEnteredExperience, setHasEnteredExperience] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [liveState, setLiveState] = useState<LiveState>('disconnected');

  // Single Authoritative Identity State: Initialized strictly to UNKNOWN Guest
  const [identity, setIdentity] = useState<Identity>({
    id: 'UNKNOWN',
    name: 'Guest',
    role: 'unknown',
  });

  // Authoritative Backend Runtime Context
  const [runtimeContext, setRuntimeContext] = useState<RuntimeContext | null>(null);

  // In-memory Auth Token only (never restored from persistent storage on fresh boot)
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);

  // State synchronization refs and monotonic version counter to prevent async race conditions
  const identityRef = useRef<Identity>(identity);
  const authTokenRef = useRef<string | undefined>(authToken);
  const stateSeqRef = useRef<number>(0);

  identityRef.current = identity;
  authTokenRef.current = authToken;

  // On initial mount: purge any stale legacy tokens from storage so fresh boot is guaranteed
  useEffect(() => {
    try {
      localStorage.removeItem('madhurita_auth_token');
      sessionStorage.removeItem('madhurita_auth_token');
      localStorage.removeItem('madhurita_entered');
      localStorage.removeItem('madhurita_active_identity');
    } catch {
      // ignore
    }
  }, []);

  // Central Single Identity State Applier
  const applyAuthoritativeState = useCallback((state: RuntimeContext, tokenOverride?: string) => {
    if (!state || !state.activeIdentity) return;
    const resolvedIdentity = state.activeIdentity;
    setIdentity((prev) => {
      if (prev.id === resolvedIdentity.id && prev.name === resolvedIdentity.name && prev.role === resolvedIdentity.role) {
        return prev;
      }
      return resolvedIdentity;
    });
    identityRef.current = resolvedIdentity;
    setRuntimeContext(state);

    if (tokenOverride !== undefined) {
      setAuthToken(tokenOverride);
      authTokenRef.current = tokenOverride;
    }
  }, []);

  // Modal States
  const [isOwnerSetupOpen, setIsOwnerSetupOpen] = useState(false);
  const [isOwnerAuthOpen, setIsOwnerAuthOpen] = useState(false);
  const [isIdentitySwitchOpen, setIsIdentitySwitchOpen] = useState(false);
  const [activeModalMode, setActiveModalMode] = useState<'database' | 'tasks' | 'voice' | 'iot' | null>(null);

  // Toast actions
  const [toolActions, setToolActions] = useState<ToolActionItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Text Chat & Cognitive Interaction Console State
  const [isChatConsoleOpen, setIsChatConsoleOpen] = useState(false);
  const [activeNav, setActiveNav] = useState<NavKey>('chat');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isProcessingChat, setIsProcessingChat] = useState(false);

  // LiveClient instance
  const liveClientRef = useRef<LiveClient | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  // Generate a temporary session ID for text chat continuity
  const [chatSessionId] = useState(() => `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);

  // Fetch status from backend without caching
  const fetchStatus = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      const token = authTokenRef.current;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const activeId = identityRef.current.id;
      if (activeId && activeId !== 'UNKNOWN') {
        headers['X-User-Id'] = activeId;
      }
      const res = await fetch('/api/status', { headers, cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setSystemStatus(data);
      return data;
    } catch (err: any) {
      console.warn('Status fetch info:', err?.message || err);
      return null;
    }
  }, []);

  // Fetch Authoritative RuntimeContext from Backend with monotonic sequence validation
  const fetchRuntimeState = useCallback(async (overrideToken?: string, overrideUserId?: string) => {
    const currentSeq = ++stateSeqRef.current;
    const token = overrideToken !== undefined ? overrideToken : authTokenRef.current;
    const userId = overrideUserId !== undefined ? overrideUserId : identityRef.current.id;

    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      if (userId && userId !== 'UNKNOWN') {
        headers['X-User-Id'] = userId;
      }
      const res = await fetch('/api/runtime-state', { headers, cache: 'no-store' });
      if (!res.ok) return null;
      const data: RuntimeContext = await res.json();

      // Discard stale in-flight response if a newer action occurred
      if (currentSeq !== stateSeqRef.current) {
        return null;
      }

      applyAuthoritativeState(data);
      return data;
    } catch (err) {
      console.warn('Runtime state fetch info:', err);
      return null;
    }
  }, [applyAuthoritativeState]);

  // Initial single boot fetch
  useEffect(() => {
    fetchStatus();
    fetchRuntimeState();
  }, [fetchStatus, fetchRuntimeState]);

  // Initialize LiveClient
  useEffect(() => {
    const client = new LiveClient({
      onStateChange: (state) => {
        setLiveState(state);
        if (state === 'listening' || state === 'speaking') {
          setErrorMessage(null);
        }
      },
      onIdentityChange: (newIdentity, token) => {
        stateSeqRef.current++;
        setIdentity(newIdentity);
        identityRef.current = newIdentity;
        if (token !== undefined) {
          setAuthToken(token);
          authTokenRef.current = token;
        }
        setChatMessages([]);
        fetchRuntimeState(token || authTokenRef.current, newIdentity.id);
      },
      onRuntimeState: (state) => {
        if (state && state.activeIdentity) {
          setRuntimeContext(state);
          setIdentity((prev) => {
            if (prev.id !== state.activeIdentity.id || prev.role !== state.activeIdentity.role || prev.name !== state.activeIdentity.name) {
              identityRef.current = state.activeIdentity;
              return state.activeIdentity;
            }
            return prev;
          });
          loadHistory();
        }
      },
      onToolAction: (action) => {
        setToolActions((prev) => [action, ...prev].slice(0, 5));
        fetchRuntimeState();
        loadHistory();
      },
      onUserTranscript: (transcript, isFinal) => {
        if (isFinal && transcript) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: `usr_live_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              role: 'user',
              text: transcript,
              timestamp: Date.now(),
            },
          ]);
        }
      },
      onAssistantTranscript: (transcript) => {
        if (transcript) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: `ast_live_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              role: 'assistant',
              text: transcript,
              timestamp: Date.now(),
            },
          ]);
        }
      },
      onError: (msg) => {
        setErrorMessage(msg);
        setTimeout(() => setErrorMessage((prev) => (prev === msg ? null : prev)), 7000);
      },
    });

    liveClientRef.current = client;

    return () => {
      client.disconnect();
    };
  }, [fetchRuntimeState]);

  // Auto-scroll chat console
  useEffect(() => {
    if (isChatConsoleOpen && chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatConsoleOpen]);

  const handleSidebarNavigate = useCallback(
    (key: NavKey) => {
      setActiveNav(key);
      switch (key) {
        case 'chat':
          setIsChatConsoleOpen(true);
          break;
        case 'memory':
        case 'knowledge':
          setActiveModalMode('database');
          break;
        case 'recall':
          setIsChatConsoleOpen(true);
          setChatInput('What did we talk about?');
          break;
        case 'tasks':
          setActiveModalMode('tasks');
          break;
        case 'devices':
          setActiveModalMode('iot');
          break;
        case 'settings':
          setActiveModalMode('voice');
          break;
        default:
          break;
      }
    },
    [],
  );

  const handleEnterExperience = useCallback(async () => {
    const status = await fetchStatus();
    setHasEnteredExperience(true);

    if (liveClientRef.current) {
      try {
        await liveClientRef.current.connect(identityRef.current, authTokenRef.current);
      } catch (e) {
        // Handled in liveClient callbacks
      }
    }

    if (status && !status.hasOwner) {
      setIsOwnerSetupOpen(true);
    }
  }, [fetchStatus]);

  const handleToggleVoice = useCallback(async () => {
    if (!liveClientRef.current) return;

    if (liveState === 'disconnected') {
      try {
        await liveClientRef.current.connect(identityRef.current, authTokenRef.current);
      } catch (e) {
        // Handled in liveClient callbacks
      }
    } else {
      liveClientRef.current.disconnect();
    }
  }, [liveState]);

  const handleOwnerSetupSuccess = useCallback((
    owner: { id: string; name: string; role: 'owner' },
    token: string
  ) => {
    stateSeqRef.current++;
    setIdentity(owner);
    identityRef.current = owner;
    setAuthToken(token);
    authTokenRef.current = token;
    setIsOwnerSetupOpen(false);

    fetchStatus();
    fetchRuntimeState(token, owner.id);

    if (liveClientRef.current) {
      liveClientRef.current.updateAuth(token, owner.id);
    }
  }, [fetchStatus, fetchRuntimeState]);

  const handleOwnerAuthSuccess = useCallback((
    owner: { id: string; name: string; role: 'owner' },
    token: string
  ) => {
    stateSeqRef.current++;
    setIdentity(owner);
    identityRef.current = owner;
    setAuthToken(token);
    authTokenRef.current = token;
    setIsOwnerAuthOpen(false);

    fetchStatus();
    fetchRuntimeState(token, owner.id);

    setActiveModalMode('database');

    if (liveClientRef.current) {
      liveClientRef.current.updateAuth(token, owner.id);
    }
  }, [fetchStatus, fetchRuntimeState]);

  // Atomic Backend-Driven Profile Switch
  const handleSelectIdentity = useCallback(async (target: Identity) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = authTokenRef.current;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch('/api/identity/switch', {
        method: 'POST',
        headers,
        body: JSON.stringify({ targetId: target.id, targetName: target.name }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Switch failed' }));
        setErrorMessage(err.message || err.error || 'Failed to switch identity');
        return;
      }

      const data = await res.json();
      if (data.success && data.identity) {
        stateSeqRef.current++;
        setIdentity(data.identity);
        identityRef.current = data.identity;
        if (data.token !== undefined) {
          setAuthToken(data.token);
          authTokenRef.current = data.token;
        }
        if (data.runtimeState) {
          setRuntimeContext(data.runtimeState);
        }
        setIsIdentitySwitchOpen(false);
        setChatMessages([]);

        if (liveClientRef.current) {
          liveClientRef.current.updateAuth(data.token || token, data.identity.id);
        }
      }
    } catch (err: any) {
      console.error('Profile switch error:', err);
      setErrorMessage(err.message || 'Error switching profile');
    }
  }, []);

  const handleRegisterUser = useCallback(async (name: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = authTokenRef.current;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch('/api/users/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.success && data.user) {
      await handleSelectIdentity(data.user);
      fetchStatus();
    }
  }, [handleSelectIdentity, fetchStatus]);

  const handleDeleteUser = useCallback(async (userId: string) => {
    const token = authTokenRef.current;
    if (!token) return;
    const res = await fetch(`/api/users/${userId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await res.json();
    if (data.success) {
      if (identityRef.current.id === userId) {
        const ownerName = systemStatus?.ownerName || 'Ankit';
        await handleSelectIdentity({ id: 'OWNER_001', name: ownerName, role: 'owner' });
      }
      fetchStatus();
    } else {
      setErrorMessage(data.error || 'Failed to delete user');
    }
  }, [systemStatus?.ownerName, fetchStatus, handleSelectIdentity]);

  const handleDismissToast = useCallback((id: string) => {
    setToolActions((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Load existing conversation history for active profile on identity change
  const loadHistory = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      const token = authTokenRef.current;
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (identity?.id) headers['X-User-Id'] = identity.id;
      const url = identity.id && identity.id !== 'UNKNOWN'
        ? `/api/conversations?userId=${encodeURIComponent(identity.id)}&limit=500`
        : `/api/conversations?sessionId=${encodeURIComponent(chatSessionId)}&limit=500`;

      const res = await fetch(url, { headers, cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.turns && Array.isArray(data.turns)) {
          const formatted: ChatMessage[] = data.turns.map((t: any) => ({
            id: t.turnId || `turn_${t.timestamp}`,
            role: t.role === 'assistant' ? 'assistant' : 'user',
            text: t.content,
            timestamp: new Date(t.timestamp).getTime() || Date.now(),
          }));
          setChatMessages((prev) => {
            if (prev.length === formatted.length && prev.every((m, i) => m.id === formatted[i].id && m.text === formatted[i].text)) {
              return prev;
            }
            return formatted;
          });
        } else {
          setChatMessages((prev) => (prev.length === 0 ? prev : []));
        }
      }
    } catch (e) {
      console.warn('Could not load conversation history:', e);
    }
  }, [identity.id, chatSessionId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Send Text Message through Cognitive Process Pipeline
  const handleSendChatMessage = async (e?: FormEvent, presetText?: string) => {
    if (e) e.preventDefault();
    const textToSend = (presetText || chatInput).trim();
    if (!textToSend || isProcessingChat) return;

    const userMsgId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      text: textToSend,
      timestamp: Date.now(),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setIsProcessingChat(true);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const cleanToken = sanitizeAuthToken(authToken);
      if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
      if (identity?.id) headers['X-User-Id'] = identity.id;

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: identity.id,
          message: textToSend,
          sessionId: chatSessionId,
        }),
      });

      if (!res.ok) {
        let errText = 'Failed to send message to cognitive engine';
        try {
          const errData = await res.json();
          if (errData.error) errText = errData.error;
        } catch {
          // ignore non-json response
        }
        setChatMessages((prev) => prev.filter((m) => m.id !== userMsgId));
        setErrorMessage(errText);
        return;
      }

      const data = await res.json();
      if (data.reply) {
        const assistantMsg: ChatMessage = {
          id: `ast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          role: 'assistant',
          text: data.reply,
          timestamp: Date.now(),
        };
        setChatMessages((prev) => [...prev, assistantMsg]);
        fetchRuntimeState();
        loadHistory();
      } else if (data.error) {
        setChatMessages((prev) => prev.filter((m) => m.id !== userMsgId));
        setErrorMessage(data.error);
      }
    } catch (err: any) {
      console.error('Chat error:', err);
      setChatMessages((prev) => prev.filter((m) => m.id !== userMsgId));
      setErrorMessage(err.message || 'Failed to send message to cognitive engine');
    } finally {
      setIsProcessingChat(false);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden text-white font-sans select-none p-0 sm:p-4 md:p-6 lg:p-8">
      {/* Intro Experience Splash */}
      <AnimatePresence>
        {!hasEnteredExperience && (
          <ExperienceIntro
            onEnter={handleEnterExperience}
            hasOwner={Boolean(systemStatus?.hasOwner)}
            ownerName={systemStatus?.ownerName || null}
          />
        )}
      </AnimatePresence>

      {/* Main Experience Layout — macOS Liquid Glass window */}
      {hasEnteredExperience && (
        <div className="glass-panel w-full h-full sm:rounded-[1.75rem] overflow-hidden flex flex-col shadow-[0_40px_120px_-20px_rgba(0,0,0,0.7)]">
          {/* Top toolbar */}
          <HUDHeader
            identity={identity}
            state={liveState}
            streamer={liveClientRef.current?.getStreamer()}
            player={liveClientRef.current?.getPlayer()}
            onOpenOwnerAuth={() => setIsOwnerAuthOpen(true)}
            onOpenIdentitySwitch={() => setIsIdentitySwitchOpen(true)}
            onOpenMemoryViewer={() => setActiveModalMode('database')}
            onOpenTasks={() => setActiveModalMode('tasks')}
            onOpenVoice={() => setActiveModalMode('voice')}
            onOpenIoT={() => setActiveModalMode('iot')}
          />

          {/* Body: sidebar + content */}
          <div className="flex-1 flex min-h-0">
            <Sidebar
              identity={identity}
              state={liveState}
              activeNav={activeNav}
              onNavigate={handleSidebarNavigate}
              onOpenIdentitySwitch={() => setIsIdentitySwitchOpen(true)}
            />

            {/* Main content column */}
            <div className="flex-1 flex flex-col min-w-0 relative">
              {/* Error Banner */}
              <AnimatePresence>
                {errorMessage && (
                  <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="absolute top-4 left-1/2 -translate-x-1/2 z-40 max-w-lg w-[90%] p-3.5 rounded-2xl glass-panel border border-rose-500/40 text-rose-200 text-xs flex items-center justify-between gap-3 shadow-xl"
                  >
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                      <span className="leading-tight">{errorMessage}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={handleToggleVoice}
                        className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-100 font-medium text-[11px] transition-colors border border-rose-500/30 cursor-pointer"
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => setErrorMessage(null)}
                        className="w-6 h-6 rounded-lg text-rose-300 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer"
                        aria-label="Dismiss error"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Center stage */}
              <main className="flex-1 flex items-stretch justify-center min-h-0 overflow-hidden">
                {/* Conversation-first hero / chat area */}
                <div className="flex-1 flex flex-col min-w-0 px-4 sm:px-8 pt-6 pb-4">
                  {chatMessages.length === 0 && !isChatConsoleOpen ? (
                    <div className="flex-1 flex items-center justify-center">
                      <GreetingHero
                        identityName={identity.name}
                        onQuickAction={(text) => handleSendChatMessage(undefined, text)}
                      />
                    </div>
                  ) : (
                    <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0 pr-1">
                      <div className="max-w-2xl mx-auto w-full space-y-3 py-2">
                        {chatMessages.length === 0 && (
                          <div className="text-center py-10 text-white/45 text-sm">
                            Send a message or try recall questions like{' '}
                            <span className="text-indigo-200 font-medium">"What did we talk about?"</span>
                          </div>
                        )}
                        {chatMessages.map((msg) => (
                          <div
                            key={msg.id}
                            className={`flex items-start gap-2.5 ${
                              msg.role === 'user' ? 'justify-end' : 'justify-start'
                            }`}
                          >
                            {msg.role === 'assistant' && (
                              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-400/40 to-fuchsia-400/40 border border-white/15 text-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
                                <Bot className="w-4 h-4" />
                              </div>
                            )}
                            <div
                              className={`px-4 py-2.5 rounded-2xl max-w-[80%] text-sm leading-relaxed ${
                                msg.role === 'user'
                                  ? 'glass text-white'
                                  : 'bg-white/[0.06] border border-white/10 text-white/90'
                              }`}
                            >
                              <p className="whitespace-pre-wrap">{msg.text}</p>
                            </div>
                            {msg.role === 'user' && (
                              <div className="w-7 h-7 rounded-full bg-white/10 border border-white/15 text-white/80 flex items-center justify-center shrink-0 mt-0.5">
                                <User className="w-4 h-4" />
                              </div>
                            )}
                          </div>
                        ))}
                        {isProcessingChat && (
                          <div className="flex items-center gap-2 text-sm text-white/50 py-1 pl-1">
                            <span className="w-2 h-2 rounded-full bg-indigo-300 animate-ping" />
                            <span>Madhurita is thinking…</span>
                          </div>
                        )}
                        <div ref={chatBottomRef} />
                      </div>
                    </div>
                  )}

                  {/* Recall suggestion chips (only when in conversation view) */}
                  {(chatMessages.length > 0 || isChatConsoleOpen) && (
                    <div className="max-w-2xl mx-auto w-full flex items-center gap-2 overflow-x-auto pb-2 pt-1 custom-scrollbar text-[11px]">
                      {[
                        'What did we talk about?',
                        'What do you remember about me?',
                        'My project deadline is this Friday',
                      ].map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => handleSendChatMessage(undefined, s)}
                          className="px-3 py-1.5 rounded-full glass glass-hover text-white/70 hover:text-white cursor-pointer shrink-0"
                        >
                          {`"${s}"`}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Floating glass composer */}
                  <div className="max-w-2xl mx-auto w-full mt-2">
                    <Composer
                      value={chatInput}
                      onChange={setChatInput}
                      onSubmit={(e) => handleSendChatMessage(e)}
                      onToggleVoice={handleToggleVoice}
                      onToggleConsole={() => setIsChatConsoleOpen(!isChatConsoleOpen)}
                      isProcessing={isProcessingChat}
                      liveState={liveState}
                      identityName={identity.name}
                    />
                  </div>
                </div>

                {/* Right voice panel */}
                <div className="hidden lg:flex items-center pr-6 pl-2 shrink-0">
                  {liveClientRef.current && (
                    <VoiceCore
                      state={liveState}
                      onToggle={handleToggleVoice}
                      streamer={liveClientRef.current.getStreamer()}
                      player={liveClientRef.current.getPlayer()}
                      activeIdentityName={identity.name}
                      isOwner={identity.role === 'owner'}
                    />
                  )}
                </div>
              </main>

              {/* Bottom status bar */}
              <footer className="w-full px-6 py-2.5 flex items-center justify-between gap-3 border-t border-white/10">
                <div className="text-[12px] text-white/50 truncate">
                  {identity.role === 'owner' ? (
                    <span className="text-amber-200/90 flex items-center gap-1.5 font-medium">
                      <Shield className="w-3.5 h-3.5" /> Owner Mode • Authoritative access
                    </span>
                  ) : identity.role === 'user' ? (
                    <span className="text-white/60">
                      Personal Mode • Context isolated to{' '}
                      <strong className="text-white/85 font-medium">{identity.name}</strong>
                    </span>
                  ) : (
                    <span className="text-white/55">Guest Mode • Introduce yourself or switch identity</span>
                  )}
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <Lock className="w-3.5 h-3.5 text-white/35" />
                  <span className="flex items-center gap-1.5">
                    <AudioLines
                      className={`w-3.5 h-3.5 ${
                        liveState === 'listening' || liveState === 'speaking'
                          ? 'text-indigo-200'
                          : 'text-white/35'
                      }`}
                    />
                    <span
                      className={`w-2 h-2 rounded-full ${
                        liveState === 'idle'
                          ? 'bg-slate-400'
                          : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                      }`}
                    />
                  </span>
                </div>
              </footer>
            </div>
          </div>
        </div>
      )}

      {/* Lazy Loaded Modals wrapped in Suspense for minimum initial bundle size */}
      <Suspense fallback={null}>
        {isOwnerSetupOpen && (
          <OwnerSetupModal
            isOpen={isOwnerSetupOpen}
            onSuccess={handleOwnerSetupSuccess}
            onClose={() => setIsOwnerSetupOpen(false)}
          />
        )}

        {isOwnerAuthOpen && (
          <OwnerAuthModal
            isOpen={isOwnerAuthOpen}
            onSuccess={handleOwnerAuthSuccess}
            onClose={() => setIsOwnerAuthOpen(false)}
          />
        )}

        {isIdentitySwitchOpen && (
          <IdentitySwitchModal
            isOpen={isIdentitySwitchOpen}
            currentIdentity={identity}
            authToken={authToken}
            onSelectIdentity={handleSelectIdentity}
            onRegisterUser={handleRegisterUser}
            onDeleteUser={identity.role === 'owner' ? handleDeleteUser : undefined}
            onClose={() => setIsIdentitySwitchOpen(false)}
          />
        )}

        {activeModalMode && (
          <MemoryViewerModal
            isOpen={true}
            identity={identity}
            token={authToken}
            mode={activeModalMode}
            onClose={() => setActiveModalMode(null)}
            onRestored={fetchStatus}
          />
        )}
      </Suspense>

      {/* Tool Action Notifications */}
      <ToolActionToast actions={toolActions} onDismiss={handleDismissToast} />
    </div>
  );
}
