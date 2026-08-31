import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { LiveClient } from './services/liveClient.js';
import { Identity, LiveState, SystemStatus, ToolActionItem, RuntimeContext } from './types.js';
import { ExperienceIntro } from './components/ExperienceIntro.js';
import { ToolActionToast } from './components/ToolActionToast.js';
import { Sidebar } from './components/Sidebar.js';
import { BackgroundAtmosphere } from './components/BackgroundAtmosphere.js';
import { HomeStage } from './components/home/HomeStage.js';
import { ContextPanel } from './components/context/ContextPanel.js';
import { CommandFlowBanner } from './components/state/CommandFlowBanner.js';
import { UIStateProvider } from './hooks/useUIState.js';
import { useStage, StageKey } from './hooks/useStage.js';
import { useCommandFlow } from './hooks/useCommandFlow.js';
import { routeVoiceCommand, stageForCommand, VoiceCommand } from './utils/voiceCommandRouter.js';
import { AlertTriangle, X } from 'lucide-react';

// Lazy-loaded Modal Components for Code-Splitting & Minimal Initial Bundle Size
const OwnerSetupModal = lazy(() =>
  import('./components/OwnerSetupModal.js').then((m) => ({ default: m.OwnerSetupModal }))
);
const OwnerAuthModal = lazy(() =>
  import('./components/OwnerAuthModal.js').then((m) => ({ default: m.OwnerAuthModal }))
);

import { sanitizeAuthToken } from './utils/auth.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

/**
 * Commands that fully complete via the stage change itself
 * (no backend roundtrip, no chat reply expected).
 */
const PURE_NAV: ReadonlySet<string> = new Set([
  'go-home',
  'go-back',
  'close-panel',
  'open-memory',
  'open-search',
  'open-tasks',
  'open-calendar',
  'open-devices',
  'open-identity',
  'open-settings',
  'show-tasks',
]);

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

  // Active stage (single source of truth for nav/panel state)
  const { activeStage, previousStage, setStage } = useStage('home');

  // Voice/manual command lifecycle (UNDERSTAND → ACT → SHOW PROGRESS → RESULT → ACK → RETURN)
  const commandFlow = useCommandFlow(setStage);
  const commandFlowRef = useRef(commandFlow);
  commandFlowRef.current = commandFlow;

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
    if (!state || !state.activeIdentity) {
      // Backend returned an invalid or incomplete runtime state.
      // Surface this rather than silently leaving stale state.
      console.warn('applyAuthoritativeState: missing activeIdentity, retaining previous state');
      setErrorMessageRef.current?.('Backend returned an incomplete runtime state. Retrying…');
      // Re-fetch once to recover; if the backend is actually down the
      // error banner will re-surface on the next attempt.
      setTimeout(() => fetchRuntimeStateRef.current?.(), 1500);
      return;
    }
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

  // Toast actions
  const [toolActions, setToolActions] = useState<ToolActionItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const setErrorMessageRef = useRef<(msg: string | null) => void>(setErrorMessage);
  setErrorMessageRef.current = setErrorMessage;

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isProcessingChat, setIsProcessingChat] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);

  // LiveClient instance
  const liveClientRef = useRef<LiveClient | null>(null);

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
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
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

  const fetchRuntimeStateRef = useRef(fetchRuntimeState);
  fetchRuntimeStateRef.current = fetchRuntimeState;

  // Initial single boot fetch
  useEffect(() => {
    fetchStatus();
    fetchRuntimeState();
  }, [fetchStatus, fetchRuntimeState]);

  // Load existing conversation history
  const loadHistory = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      const token = authTokenRef.current;
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const activeId = identityRef.current.id;
      if (activeId) headers['X-User-Id'] = activeId;
      const url = activeId && activeId !== 'UNKNOWN'
        ? `/api/conversations?userId=${encodeURIComponent(activeId)}&limit=500`
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
  }, [chatSessionId]);

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
        if (!isFinal || !transcript) return;
        // Run the transcript through the command router.
        const cmd = routeVoiceCommand(transcript);

        // "Stop" / "Continue" / "Repeat" / "Help" are voice-control
        // commands, NOT chat input. They never get sent to the
        // cognitive engine; they operate on the live session itself.
        if (cmd.kind === 'stop') {
          handleStopVoice();
          return;
        }
        if (cmd.kind === 'continue' || cmd.kind === 'repeat') {
          // No-op for now: the live session continues from where it
          // left off. The user just wanted to convey "keep going".
          // The command flow ends immediately.
          const flowCmd = commandFlowRef.current.submit(transcript, activeStage);
          // Synthetic completion: there is no backend to wait on.
          // Pure continuation control — mark done.
          commandFlowRef.current.complete();
          return;
        }
        if (cmd.kind === 'help') {
          // Show the help text in the conversation as an assistant
          // message — the user spoke the word, so the answer belongs
          // in the conversation stream, not in a tool call.
          setChatMessages((prev) => [
            ...prev,
            {
              id: `usr_live_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              role: 'user',
              text: transcript,
              timestamp: Date.now(),
            },
            {
              id: `ast_help_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              role: 'assistant',
              text:
                'You can say things like:\n' +
                '• "Open my memory", "Show my tasks", "Open settings"\n' +
                '• "What\'s the weather?", "Summarize my day"\n' +
                '• "Add a task to call mom"\n' +
                '• "Search my past", "What did we talk about?"\n' +
                '• "Stop", "Continue", "Repeat", "Go back", "Home"',
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        // Submit to command flow so voice + manual trigger the SAME
        // UI lifecycle. We use the ref so the closure always sees the
        // latest commandFlow (no stale state).
        const flowCmd = commandFlowRef.current.submit(transcript, activeStage);
        // Show the user message in the conversation stream
        setChatMessages((prev) => [
          ...prev,
          {
            id: `usr_live_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            role: 'user',
            text: transcript,
            timestamp: Date.now(),
          },
        ]);

        if (PURE_NAV.has(flowCmd.kind)) {
          // "go back" needs the actual previous stage which the
          // command router returns null for. Resolve it from the
          // authoritative stage state.
          if (flowCmd.kind === 'go-back' && previousStage) {
            setStage(previousStage);
          }
          // The panel mount itself is the "result". Mark done
          // immediately — no backend to wait on. The user is now
          // looking at their destination panel; we do NOT auto-return
          // (shouldReturn is false for these).
          commandFlowRef.current.complete();
        }
        // For everything else (chat, search-query, recall, show-weather,
        // summarize-day, add-task) the LiveSession backend will reply
        // via onAssistantTranscript or onToolAction; the completion
        // handler is attached below.
      },
      onAssistantTranscript: (transcript) => {
        if (!transcript) return;
        setChatMessages((prev) => [
          ...prev,
          {
            id: `ast_live_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            role: 'assistant',
            text: transcript,
            timestamp: Date.now(),
          },
        ]);
        // Mark the live command flow as completed: the assistant
        // transcript IS the authoritative result. This closes the
        // banner's SHOW PROGRESS phase.
        if (!commandFlowRef.current.isIdle) {
          commandFlowRef.current.complete();
        }
      },
      onError: (msg) => {
        setErrorMessage(msg);
        setTimeout(() => setErrorMessage((prev) => (prev === msg ? null : prev)), 7000);
        // A real error in the live session aborts the flow.
        if (!commandFlowRef.current.isIdle) {
          commandFlowRef.current.fail();
        }
      },
    });

    liveClientRef.current = client;

    return () => {
      client.disconnect();
    };
  }, [fetchRuntimeState, loadHistory, activeStage]);

  // Reload history when identity changes
  useEffect(() => {
    loadHistory();
  }, [identity.id, loadHistory]);

  const handleSidebarNavigate = useCallback(
    (key: StageKey) => {
      // Manual nav interrupts any in-flight voice command flow
      commandFlow.reset();
      setStage(key);
    },
    [setStage, commandFlow],
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

  /**
   * Cancel the live voice session and any in-flight command flow.
   * Used by the "stop" voice command, by the manual toggle, and
   * when the user starts a different command while voice is active.
   */
  const handleStopVoice = useCallback(() => {
    if (liveClientRef.current) {
      liveClientRef.current.disconnect();
    }
    setLiveState('disconnected');
    commandFlowRef.current.reset();
  }, []);

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

    setStage('memory');

    if (liveClientRef.current) {
      liveClientRef.current.updateAuth(token, owner.id);
    }
  }, [fetchStatus, fetchRuntimeState, setStage]);

  // Atomic Backend-Driven Profile Switch
  const handleSelectIdentity = useCallback(async (target: { id: string; name: string; role: string }) => {
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
        setChatMessages([]);
        setStage('home');

        if (liveClientRef.current) {
          liveClientRef.current.updateAuth(data.token || token, data.identity.id);
        }
      }
    } catch (err: any) {
      console.error('Profile switch error:', err);
      setErrorMessage(err.message || 'Error switching profile');
    }
  }, [setStage]);

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

  // Send Text Message through Cognitive Process Pipeline
  // Routes through command flow so voice + manual trigger the SAME actions
  // and the SAME UI lifecycle (UNDERSTAND → ACT → SHOW PROGRESS → RESULT → ACK → RETURN).
  const handleSendChatMessage = useCallback(async (text: string) => {
    const textToSend = text.trim();
    if (!textToSend || isProcessingChat) return;

    // Pre-classify. Voice-control commands (stop/continue/repeat/help)
    // are NOT chat input and never reach /api/chat.
    const preCmd = routeVoiceCommand(textToSend);
    if (preCmd.kind === 'stop') {
      handleStopVoice();
      return;
    }
    if (preCmd.kind === 'continue' || preCmd.kind === 'repeat') {
      // No backend call needed; the user is asking the live session
      // to keep going, not the chat pipeline.
      commandFlow.submit(textToSend, activeStage);
      commandFlow.complete();
      return;
    }
    if (preCmd.kind === 'help') {
      // Insert the help answer into the local chat without
      // round-tripping through the cognitive engine.
      const helpText =
        'You can try:\n' +
        '• "Open my memory", "Show my tasks", "Open settings"\n' +
        '• "What\'s the weather?", "Summarize my day"\n' +
        '• "Add a task to call mom"\n' +
        '• "Search my past", "What did we talk about?"\n' +
        '• "Stop", "Continue", "Repeat", "Go back", "Home"';
      setChatMessages((prev) => [
        ...prev,
        { id: `usr_${Date.now()}`, role: 'user', text: textToSend, timestamp: Date.now() },
        { id: `ast_${Date.now()}`, role: 'assistant', text: helpText, timestamp: Date.now() },
      ]);
      return;
    }

    // Submit to command flow — this may navigate to a panel
    // (e.g. "open my memory" → memory panel) and start the visual lifecycle.
    const cmd = commandFlow.submit(textToSend, activeStage);

    // Always show the user message in the conversation stream
    const userMsgId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      text: textToSend,
      timestamp: Date.now(),
    };
    setChatMessages((prev) => [...prev, userMsg]);

    // For pure navigation commands (e.g. "open my tasks"), the panel
    // IS the action — no chat needed. The destination panel is the
    // final state; the user is now where they asked to be.
    if (PURE_NAV.has(cmd.kind)) {
      // "go back" needs the actual previous stage (recorded in the
      // stage hook). The command router returns null for it because
      // it doesn't know the previous stage. We resolve it here.
      if (cmd.kind === 'go-back' && previousStage) {
        setStage(previousStage);
      }
      // For all other PURE_NAV commands, submit() already called
      // setStage() with the correct destination — nothing to do.
      commandFlow.complete();
      return;
    }

    // For commands that still need backend (chat, search-query,
    // recall, show-weather, summarize-day, add-task, show-tasks), call
    // /api/chat and complete the flow on the real response.
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
        commandFlow.fail();
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
        // Mark command flow done — the real reply is the result.
        commandFlow.complete();
      } else if (data.error) {
        setChatMessages((prev) => prev.filter((m) => m.id !== userMsgId));
        setErrorMessage(data.error);
        commandFlow.fail();
      }
    } catch (err: any) {
      console.error('Chat error:', err);
      setChatMessages((prev) => prev.filter((m) => m.id !== userMsgId));
      setErrorMessage(err.message || 'Failed to send message to cognitive engine');
      commandFlow.fail();
    } finally {
      setIsProcessingChat(false);
    }
  }, [authToken, identity.id, isProcessingChat, chatSessionId, fetchRuntimeState, loadHistory, commandFlow, activeStage, handleStopVoice]);

  return (
    <UIStateProvider authToken={authToken} userId={identity.id}>
      <div className="relative w-screen h-screen overflow-hidden text-white font-sans select-none">
        {/* Immersive atmospheric background - adapts to time + weather */}
        <BackgroundAtmosphere />

        {/* Live command lifecycle banner (visible during voice/typed commands) */}
        <CommandFlowBanner
          state={commandFlow.state}
          onSkipReturn={commandFlow.reset}
        />

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

        {/* Main Experience Layout — Liquid Glass shell */}
        {hasEnteredExperience && (
          <div className="w-full h-full overflow-hidden flex">
            {/* Left: glass nav rail (desktop) or bottom tab bar (mobile, see Sidebar) */}
            <Sidebar
              identity={identity}
              state={liveState}
              activeNav={activeStage}
              onNavigate={handleSidebarNavigate}
              onOpenIdentitySwitch={() => setStage('identity')}
              onVoiceTrigger={handleToggleVoice}
            />

            {/* Main content column */}
            <div className="flex-1 flex flex-col min-w-0 relative pb-20 lg:pb-0">
              {/* Error Banner */}
              <AnimatePresence>
                {errorMessage && (
                  <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="absolute top-4 left-1/2 -translate-x-1/2 z-50 max-w-lg w-[90%] p-3.5 rounded-2xl glass-panel border border-rose-500/40 text-rose-200 text-xs flex items-center justify-between gap-3 shadow-xl"
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

              {/* Home stage (centered hero / conversation stream) */}
              <main className="flex-1 min-h-0 overflow-hidden">
                <HomeStage
                  identity={identity}
                  authToken={authToken}
                  liveState={liveState}
                  messages={chatMessages}
                  isThinking={isProcessingChat}
                  onSendMessage={handleSendChatMessage}
                  onToggleVoice={handleToggleVoice}
                  onQuickAction={handleSendChatMessage}
                  onOpenOnboarding={() => setIsOwnerAuthOpen(true)}
                />
              </main>
            </div>

            {/* Right: contextual panel overlay */}
            <ContextPanel
              identity={identity}
              authToken={authToken}
              onSwitchIdentity={handleSelectIdentity}
              onRegisterUser={handleRegisterUser}
              onDeleteUser={identity.role === 'owner' ? handleDeleteUser : undefined}
              onOpenOnboarding={() => setIsOwnerAuthOpen(true)}
            />
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
        </Suspense>

        {/* Tool Action Notifications */}
        <ToolActionToast actions={toolActions} onDismiss={handleDismissToast} />
      </div>
    </UIStateProvider>
  );
}
