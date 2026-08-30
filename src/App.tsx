import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense, FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { LiveClient } from './services/liveClient.js';
import { Identity, LiveState, SystemStatus, ToolActionItem, RuntimeContext } from './types.js';
import { ExperienceIntro } from './components/ExperienceIntro.js';
import { HUDHeader } from './components/HUDHeader.js';
import { VoiceCore } from './components/VoiceCore.js';
import { ToolActionToast } from './components/ToolActionToast.js';
import {
  Shield,
  AlertTriangle,
  Send,
  Sparkles,
  MessageSquare,
  ChevronUp,
  ChevronDown,
  BrainCircuit,
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
    <div className="relative w-screen h-screen overflow-hidden bg-[#030712] text-white flex flex-col justify-between font-sans select-none">
      {/* Background Ambient Lights */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-600/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-blue-600/20 rounded-full blur-[150px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.05)_0%,transparent_70%)]" />
      </div>

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

      {/* Main Experience Layout */}
      {hasEnteredExperience && (
        <>
          {/* Top HUD Header */}
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

          {/* Error Banner */}
          <AnimatePresence>
            {errorMessage && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute top-16 left-1/2 -translate-x-1/2 z-40 max-w-lg w-[90%] p-3.5 rounded-2xl bg-rose-950/80 border border-rose-500/40 text-rose-200 text-xs backdrop-blur-xl flex items-center justify-between gap-3 shadow-xl"
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
                    className="px-2 py-1 rounded-lg text-rose-300 hover:text-white text-[11px] transition-colors cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Central Voice Core Interaction */}
          <main className="flex-1 flex items-center justify-center p-4 relative z-10">
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
          </main>

          {/* Collapsible Cognitive Text Chat Drawer */}
          <div className="z-30 w-full max-w-xl mx-auto px-4 pb-2">
            <div className="rounded-2xl bg-[#030712]/90 border border-white/15 backdrop-blur-xl shadow-2xl overflow-hidden transition-all">
              {/* Drawer Toggle Header */}
              <div
                onClick={() => setIsChatConsoleOpen(!isChatConsoleOpen)}
                className="px-4 py-2 flex items-center justify-between cursor-pointer hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-2 text-xs text-white/80 font-medium">
                  <BrainCircuit className="w-3.5 h-3.5 text-pink-400" />
                  <span>Cognitive Chat Console & Recall</span>
                  {chatMessages.length > 0 && (
                    <span className="px-1.5 py-0.2 rounded bg-pink-500/20 text-pink-300 text-[10px]">
                      {chatMessages.length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-white/40">
                  <span>{isChatConsoleOpen ? 'Minimize' : 'Type to Chat'}</span>
                  {isChatConsoleOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                </div>
              </div>

              {/* Chat Expanded Area */}
              {isChatConsoleOpen && (
                <div className="p-3 border-t border-white/10 space-y-3">
                  {/* Messages Feed */}
                  <div className="max-h-48 overflow-y-auto space-y-2 pr-1 text-xs">
                    {chatMessages.length === 0 ? (
                      <div className="text-center py-4 text-white/40 text-[11px]">
                        Send a message or test recall questions like <span className="text-pink-300 font-medium">"What did we talk about?"</span>
                      </div>
                    ) : (
                      chatMessages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`flex items-start gap-2 ${
                            msg.role === 'user' ? 'justify-end' : 'justify-start'
                          }`}
                        >
                          {msg.role === 'assistant' && (
                            <div className="w-5 h-5 rounded-full bg-pink-500/20 text-pink-300 flex items-center justify-center shrink-0 mt-0.5">
                              <Bot className="w-3 h-3" />
                            </div>
                          )}
                          <div
                            className={`p-2.5 rounded-2xl max-w-[85%] leading-relaxed ${
                              msg.role === 'user'
                                ? 'bg-blue-600/30 border border-blue-500/30 text-blue-100'
                                : 'bg-white/10 border border-white/15 text-white/90'
                            }`}
                          >
                            <p className="whitespace-pre-wrap">{msg.text}</p>
                          </div>
                          {msg.role === 'user' && (
                            <div className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 flex items-center justify-center shrink-0 mt-0.5">
                              <User className="w-3 h-3" />
                            </div>
                          )}
                        </div>
                      ))
                    )}
                    {isProcessingChat && (
                      <div className="flex items-center gap-2 text-xs text-white/50 py-1">
                        <div className="w-2 h-2 rounded-full bg-pink-400 animate-ping" />
                        <span>Madhurita is analyzing context and generating response...</span>
                      </div>
                    )}
                    <div ref={chatBottomRef} />
                  </div>

                  {/* Suggestion Chips */}
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-[10px]">
                    <button
                      type="button"
                      onClick={() => handleSendChatMessage(undefined, 'What did we talk about?')}
                      className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 text-white/70 hover:text-white cursor-pointer shrink-0 transition-colors"
                    >
                      "What did we talk about?"
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSendChatMessage(undefined, 'What do you remember about me?')}
                      className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 text-white/70 hover:text-white cursor-pointer shrink-0 transition-colors"
                    >
                      "What do you remember about me?"
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSendChatMessage(undefined, 'My project deadline is this Friday')}
                      className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 text-white/70 hover:text-white cursor-pointer shrink-0 transition-colors"
                    >
                      "Project deadline is Friday"
                    </button>
                  </div>

                  {/* Input form */}
                  <form onSubmit={(e) => handleSendChatMessage(e)} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={`Message Madhurita as ${identity.name}...`}
                      className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-pink-500/50"
                    />
                    <button
                      type="submit"
                      disabled={!chatInput.trim() || isProcessingChat}
                      className="p-2 rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 text-white disabled:opacity-40 hover:shadow-lg hover:shadow-pink-500/20 cursor-pointer shrink-0"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>

          {/* Bottom Status & Info Bar */}
          <footer className="w-full px-6 py-3 z-20 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-white/5 bg-[#030712]/40 backdrop-blur-xl">
            <div className="flex items-center gap-2.5 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
              <span className="text-white/60">Active Identity: <strong className="text-white font-medium">{identity.name}</strong> <span className="uppercase text-[10px] tracking-wider text-blue-300 font-semibold px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">{identity.role}</span></span>
            </div>

            <div className="text-[11px] text-white/50 tracking-wider">
              {identity.role === 'owner' ? (
                <span className="text-amber-300 flex items-center gap-1.5 justify-center font-medium">
                  <Shield className="w-3.5 h-3.5 text-amber-400" /> Authoritative Owner Access
                </span>
              ) : identity.role === 'user' ? (
                <span className="text-purple-300">Memory & Context Isolated to {identity.name}</span>
              ) : (
                <span className="text-slate-400">Guest Mode • Introduce yourself or switch identity</span>
              )}
            </div>

            <div className="flex items-center gap-4 text-[10px] text-white/30 uppercase tracking-[0.2em]">
              <span>Logic-Driven Intelligence</span>
              <span className="hidden md:inline">•</span>
              <span className="hidden md:inline text-emerald-400/70">Persistent Storage</span>
            </div>
          </footer>
        </>
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
