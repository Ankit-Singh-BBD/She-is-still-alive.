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
import { useBin, DeletionPreview, DeletionScope } from './hooks/useBin.js';
import { routeVoiceCommand, stageForCommand, VoiceCommand, DeletionScope as RouterDeletionScope } from './utils/voiceCommandRouter.js';
import { ConfirmDeletionSheet } from './components/sheets/ConfirmDeletionSheet.js';
import { GlassSheet } from './components/sheets/GlassSheet.js';
import { AlertTriangle, X } from 'lucide-react';

// Lazy-loaded Modal Components for Code-Splitting & Minimal Initial Bundle Size
const OwnerSetupModal = lazy(() =>
  import('./components/OwnerSetupModal.js').then((m) => ({ default: m.OwnerSetupModal }))
);
const OwnerAuthModal = lazy(() =>
  import('./components/OwnerAuthModal.js').then((m) => ({ default: m.OwnerAuthModal }))
);

import { sanitizeAuthToken } from './utils/auth.js';

function truncateForLabel(s: string, n = 60): string {
  const cleaned = (s || '').replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned;
}

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

  // ----- DELETION FLOW STATE -----
  // The Bin is the single source of truth for soft-deletes. useBin
  // exposes the full TARGET → SCOPE → SAFETY → CONFIRMATION → BIN
  // lifecycle.
  const bin = useBin(identity, authToken);
  const [pendingDeletion, setPendingDeletion] = useState<{
    scope: DeletionScope;
    target?: string;
    targetQuery?: string;
    preview: DeletionPreview;
    sourceLabel: string;
  } | null>(null);
  const [pendingPermanentDeletion, setPendingPermanentDeletion] = useState<{
    binId: string;
    preview: DeletionPreview;
    sourceLabel: string;
  } | null>(null);
  const [isDeletionSubmitting, setIsDeletionSubmitting] = useState(false);
  const [ambiguousCandidates, setAmbiguousCandidates] = useState<{
    scope: DeletionScope | 'permanent_delete';
    candidates: { id: string; preview: string; type: string; meta?: string }[];
    sourceLabel: string;
  } | null>(null);

  // Driver for the deletion-safety lifecycle. Voice and manual input
  // both call this. It runs /api/bin/preview, then either:
  //   - shows a pending confirmation surface (return preview to UI)
  //   - shows an ambiguous-chooser surface (multiple matches)
  //   - executes the move (when called with confirmed=true)
  const beginDeletion = useCallback(
    async (args: {
      scope: DeletionScope;
      target?: string;
      targetQuery?: string;
      sourceLabel: string;
    }) => {
      const result = await bin.requestDelete({
        scope: args.scope,
        target: args.target,
        targetQuery: args.targetQuery,
        sourceCommand: args.sourceLabel,
      });
      if (result.state === 'pending') {
        setPendingDeletion({
          scope: args.scope,
          target: args.target,
          targetQuery: args.targetQuery,
          preview: result.preview,
          sourceLabel: args.sourceLabel,
        });
        setPendingPermanentDeletion(null);
        setAmbiguousCandidates(null);
        return result;
      }
      if (result.state === 'ambiguous') {
        setAmbiguousCandidates({
          scope: args.scope,
          candidates: result.preview.candidates || [],
          sourceLabel: args.sourceLabel,
        });
        setPendingDeletion(null);
        setPendingPermanentDeletion(null);
        return result;
      }
      if (result.state === 'error') {
        setErrorMessage(result.error || 'Could not start deletion');
        return result;
      }
      return result;
    },
    [bin],
  );

  // Permanent-delete voice/manual routing. Never guesses. Resolves
  // exact Bin item against authoritative server state.
  const beginPermanentDeletion = useCallback(
    async (args: { query?: string; binId?: string; sourceLabel: string }) => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const cleanToken = sanitizeAuthToken(authToken);
        if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
        if (identity.id && identity.id !== 'UNKNOWN') headers['X-User-Id'] = identity.id;

        const res = await fetch('/api/bin/permanent-preview', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            identityId: identity.id,
            query: args.query,
            binId: args.binId,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setErrorMessage(err.error || 'Permanent delete preview failed');
          return;
        }
        const data = await res.json();
        if (data.ambiguous && data.candidates?.length > 1) {
          setAmbiguousCandidates({
            scope: 'permanent_delete',
            candidates: data.candidates,
            sourceLabel: args.sourceLabel,
          });
          setPendingDeletion(null);
          setPendingPermanentDeletion(null);
          return;
        }
        if (data.resolved && data.candidates?.length > 0) {
          const targetBinId = data.candidates[0].id;
          setPendingPermanentDeletion({
            binId: targetBinId,
            preview: {
              resolved: true,
              candidates: data.candidates,
              affected: { memories: 0, turns: 0, sessions: 0, tasks: 0, patterns: 0, derivedMemories: 0 },
              reversibility: 'permanent',
              safety: 'requires_confirm',
              message: data.message || 'This Bin item will be permanently deleted. This is irreversible.',
            },
            sourceLabel: args.sourceLabel,
          });
          setPendingDeletion(null);
          setAmbiguousCandidates(null);
          return;
        }
        // Not found or blocked
        setChatMessages((prev) => [
          ...prev,
          {
            id: `ast_perm_notfound_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            role: 'assistant',
            text: data.message || 'No matching item found in the Bin to permanently delete.',
            timestamp: Date.now(),
          },
        ]);
      } catch (err: any) {
        setErrorMessage(err?.message || 'Permanent delete failed');
      }
    },
    [authToken, identity.id],
  );

  const confirmPermanentDeletion = useCallback(async () => {
    if (!pendingPermanentDeletion) return;
    setIsDeletionSubmitting(true);
    const result = await bin.permanentDelete(pendingPermanentDeletion.binId, { confirmed: true });
    setIsDeletionSubmitting(false);
    if (result.success) {
      setPendingPermanentDeletion(null);
      setChatMessages((prev) => [
        ...prev,
        {
          id: `ast_perm_done_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          role: 'assistant',
          text: 'Item has been permanently deleted from the Bin.',
          timestamp: Date.now(),
        },
      ]);
      fetchRuntimeState();
      loadHistory();
      bin.refetch();
    } else {
      setErrorMessage(result.error || 'Permanent delete failed');
    }
  }, [pendingPermanentDeletion, bin, fetchRuntimeState, loadHistory]);

  const confirmDeletion = useCallback(async () => {
    if (pendingPermanentDeletion) {
      return confirmPermanentDeletion();
    }
    if (!pendingDeletion) return;
    setIsDeletionSubmitting(true);
    const result = await bin.requestDelete({
      scope: pendingDeletion.scope,
      target: pendingDeletion.target,
      targetQuery: pendingDeletion.targetQuery,
      confirmed: true,
      sourceCommand: pendingDeletion.sourceLabel,
    });
    setIsDeletionSubmitting(false);
    if (result.state === 'done') {
      setPendingDeletion(null);
      // Surface a success message and refresh the world.
      const removed = (result.result as any)?.removedTurns
        || (result.result as any)?.removedCount
        || (result.result as any)?.binIds?.length
        || 0;
      setChatMessages((prev) => [
        ...prev,
        {
          id: `ast_del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          role: 'assistant',
          text:
            removed > 0
              ? `Moved to the Bin. You can restore from there.`
              : `Moved to the Bin.`,
          timestamp: Date.now(),
        },
      ]);
      fetchRuntimeState();
      loadHistory();
    } else if (result.state === 'error') {
      setErrorMessage(result.error || 'Move to bin failed');
    }
  }, [pendingDeletion, pendingPermanentDeletion, confirmPermanentDeletion, bin, fetchRuntimeState, loadHistory]);

  const cancelDeletion = useCallback(() => {
    setPendingDeletion(null);
    setPendingPermanentDeletion(null);
    setAmbiguousCandidates(null);
  }, []);

  // Refs to the deletion-flow handlers so the LiveClient callbacks
  // (which are wired inside a useEffect) always see the latest
  // versions of these stateful callbacks. The refs are updated
  // synchronously on every render.
  const beginDeletionRef = useRef(beginDeletion);
  beginDeletionRef.current = beginDeletion;
  const beginPermanentDeletionRef = useRef(beginPermanentDeletion);
  beginPermanentDeletionRef.current = beginPermanentDeletion;
  const confirmDeletionRef = useRef(confirmDeletion);
  confirmDeletionRef.current = confirmDeletion;
  const cancelDeletionRef = useRef(cancelDeletion);
  cancelDeletionRef.current = cancelDeletion;
  const pendingDeletionRef = useRef(pendingDeletion);
  pendingDeletionRef.current = pendingDeletion;
  const pendingPermanentDeletionRef = useRef(pendingPermanentDeletion);
  pendingPermanentDeletionRef.current = pendingPermanentDeletion;

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
                '• "Stop", "Continue", "Repeat", "Go back", "Home"\n' +
                '• "Delete my last memory" (with confirmation)\n' +
                '• "Show the Bin", "Restore from the Bin"',
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        // Submission to the flow happens before any destructive
        // action so the voice command lifecycle is observed.
        const flowCmd = commandFlowRef.current.submit(transcript, activeStage);

        // Surface the user message in the conversation stream
        setChatMessages((prev) => [
          ...prev,
          {
            id: `usr_live_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            role: 'user',
            text: transcript,
            timestamp: Date.now(),
          },
        ]);

        // ---- DESTRUCTIVE COMMANDS (delete / restore / permanently) ----
        // These never go through /api/chat. They run the full
        // TARGET → SCOPE → SAFETY → CONFIRMATION → BIN flow.
        if (flowCmd.kind === 'confirm-destructive') {
          if (pendingDeletionRef.current || pendingPermanentDeletionRef.current) {
            confirmDeletionRef.current?.();
            commandFlowRef.current.complete();
            return;
          }
          commandFlowRef.current.complete();
          return;
        }
        if (flowCmd.kind === 'cancel-destructive') {
          cancelDeletionRef.current?.();
          commandFlowRef.current.complete();
          return;
        }
        if (flowCmd.kind === 'permanently-delete') {
          beginPermanentDeletionRef.current({
            query: flowCmd.targetQuery || transcript,
            sourceLabel: `voice: ${transcript}`,
          });
          commandFlowRef.current.complete();
          return;
        }
        if (
          flowCmd.kind === 'delete-memory' ||
          flowCmd.kind === 'delete-conversation' ||
          flowCmd.kind === 'delete-all-memories' ||
          flowCmd.kind === 'delete-all-conversations' ||
          flowCmd.kind === 'delete-task' ||
          flowCmd.kind === 'delete-all-tasks' ||
          flowCmd.kind === 'delete-pattern' ||
          flowCmd.kind === 'delete-all-patterns'
        ) {
          if (!flowCmd.deletionScope) {
            commandFlowRef.current.complete();
            return;
          }
          // Use a context-aware target if available: the last
          // visible memory/conversation in the active panel. For
          // "this" / "that" references, we send the transcript as
          // targetQuery so the server can do scope resolution.
          beginDeletionRef.current({
            scope: flowCmd.deletionScope as DeletionScope,
            targetQuery: flowCmd.targetQuery,
            sourceLabel: `voice: ${transcript}`,
          });
          commandFlowRef.current.complete();
          return;
        }

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
        '• "Stop", "Continue", "Repeat", "Go back", "Home"\n' +
        '• "Delete my last memory" (with confirmation)\n' +
        '• "Show the Bin", "Restore from the Bin"';
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

    // ---- DESTRUCTIVE COMMANDS (delete / restore / permanently) ----
    // These never go through /api/chat. They run the full
    // TARGET → SCOPE → SAFETY → CONFIRMATION → BIN flow.
    if (cmd.kind === 'confirm-destructive') {
      if (pendingDeletion || pendingPermanentDeletion) {
        await confirmDeletion();
      }
      commandFlow.complete();
      return;
    }
    if (cmd.kind === 'cancel-destructive') {
      cancelDeletion();
      commandFlow.complete();
      return;
    }
    if (cmd.kind === 'permanently-delete') {
      await beginPermanentDeletion({
        query: cmd.targetQuery || textToSend,
        sourceLabel: `text: ${textToSend}`,
      });
      commandFlow.complete();
      return;
    }
    if (
      cmd.kind === 'delete-memory' ||
      cmd.kind === 'delete-conversation' ||
      cmd.kind === 'delete-all-memories' ||
      cmd.kind === 'delete-all-conversations' ||
      cmd.kind === 'delete-task' ||
      cmd.kind === 'delete-all-tasks' ||
      cmd.kind === 'delete-pattern' ||
      cmd.kind === 'delete-all-patterns'
    ) {
      if (!cmd.deletionScope) {
        commandFlow.complete();
        return;
      }
      await beginDeletion({
        scope: cmd.deletionScope as DeletionScope,
        targetQuery: cmd.targetQuery,
        sourceLabel: `text: ${textToSend}`,
      });
      commandFlow.complete();
      return;
    }

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
  }, [authToken, identity.id, isProcessingChat, chatSessionId, fetchRuntimeState, loadHistory, commandFlow, activeStage, handleStopVoice, beginDeletion, beginPermanentDeletion, confirmDeletion, cancelDeletion, pendingDeletion, pendingPermanentDeletion, previousStage, setStage]);

  // === AmbiguousCandidateSheet: shown when the server cannot
  // uniquely resolve a single-target delete (e.g. "delete my
  // project memory" when 3 memories match). ===
  function AmbiguousCandidateSheet({
    scope,
    candidates,
    sourceLabel,
    onPick,
    onCancel,
  }: {
    scope: DeletionScope | 'permanent_delete';
    candidates: { id: string; preview: string; type: string; meta?: string }[];
    sourceLabel: string;
    onPick: (candidate: { id: string; preview: string; type: string; meta?: string }) => void;
    onCancel: () => void;
  }) {
    const isPermanent = scope === 'permanent_delete';
    return (
      <GlassSheet
        isOpen
        onClose={onCancel}
        title={isPermanent ? 'Which item to delete forever?' : 'Which one did you mean?'}
        subtitle={`${candidates.length} matches for ${String(scope).replace(/_/g, ' ')}`}
        icon={<AlertTriangle className="w-4 h-4" />}
      >
        <div className="flex flex-col gap-3">
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-[12.5px] text-amber-100/90 leading-relaxed">
            {isPermanent
              ? `I found ${candidates.length} items in the Bin. Pick the exact item you want to permanently delete.`
              : `I found ${candidates.length} matches. Pick the exact ${scope === 'single_memory' ? 'memory' : scope === 'single_task' ? 'task' : scope === 'single_pattern' ? 'pattern' : 'conversation'} you want to move to the Bin.`}
          </div>
          <div className="flex flex-col gap-1.5">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c)}
                className="text-left rounded-xl border border-white/12 bg-white/[0.05] hover:bg-white/[0.12] p-3 cursor-pointer press-scale transition-colors"
              >
                <div className="text-[12.5px] text-white/90 leading-relaxed break-words">
                  {c.preview}
                </div>
                {c.meta && (
                  <div className="mt-1 text-[10.5px] text-white/45">{c.meta}</div>
                )}
              </button>
            ))}
          </div>
          {sourceLabel && (
            <p className="text-[10.5px] text-white/40">
              Request source: <span className="text-white/60">{sourceLabel}</span>
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-xl text-[12.5px] font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-white/80 hover:text-white flex items-center gap-1.5 cursor-pointer press-scale transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        </div>
      </GlassSheet>
    );
  }

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
            <main className="flex-1 flex flex-col min-w-0 relative pb-20 lg:pb-0">
              {/* Top-Right Floating Waveform Voice Trigger Button (Section 1) */}
              <div className="hidden lg:block absolute top-5 right-6 z-30 pointer-events-auto">
                <button
                  type="button"
                  onClick={handleToggleVoice}
                  className={`w-10 h-10 rounded-full glass-panel border flex items-center justify-center transition-all duration-200 cursor-pointer press-scale group ${
                    liveState === 'listening' || liveState === 'speaking'
                      ? 'border-orange-400/50 shadow-[0_0_20px_rgba(251,146,60,0.4)]'
                      : 'border-white/15 hover:border-white/30'
                  }`}
                  aria-label="Toggle live voice"
                  title="Toggle Full-Duplex Voice"
                >
                  <div className="flex items-center gap-0.5 h-3.5">
                    <span
                      className={`w-0.5 rounded-full transition-all duration-200 ${
                        liveState === 'listening' || liveState === 'speaking'
                          ? 'h-3 bg-orange-300 animate-pulse'
                          : 'h-1.5 bg-white/70 group-hover:bg-white'
                      }`}
                    />
                    <span
                      className={`w-0.5 rounded-full transition-all duration-200 ${
                        liveState === 'listening' || liveState === 'speaking'
                          ? 'h-4 bg-orange-400 animate-pulse delay-75'
                          : 'h-3.5 bg-white/90 group-hover:bg-white'
                      }`}
                    />
                    <span
                      className={`w-0.5 rounded-full transition-all duration-200 ${
                        liveState === 'listening' || liveState === 'speaking'
                          ? 'h-2.5 bg-orange-300 animate-pulse delay-150'
                          : 'h-2 bg-white/70 group-hover:bg-white'
                      }`}
                    />
                  </div>
                </button>
              </div>
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
              <div className="flex-1 min-h-0 overflow-hidden">
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
                  streamer={liveClientRef.current?.getStreamer()}
                  player={liveClientRef.current?.getPlayer()}
                />
              </div>
            </main>

            {/* Right: contextual panel overlay */}
            <ContextPanel
              identity={identity}
              authToken={authToken}
              onSwitchIdentity={handleSelectIdentity}
              onRegisterUser={handleRegisterUser}
              onDeleteUser={identity.role === 'owner' ? handleDeleteUser : undefined}
              onOpenOnboarding={() => setIsOwnerAuthOpen(true)}
              onRequestDeleteMemory={(memoryId, preview) =>
                beginDeletion({
                  scope: 'single_memory',
                  target: memoryId,
                  sourceLabel: `panel: delete "${truncateForLabel(preview)}"`,
                })
              }
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

        {/* DELETION CONFIRMATION SURFACE — single source of truth for
            any soft-delete or permanent-delete request. Shown when /api/bin/preview
            or /api/bin/permanent-preview returns a resolved scope. */}
        <ConfirmDeletionSheet
          isOpen={!!pendingDeletion || !!pendingPermanentDeletion}
          preview={pendingPermanentDeletion?.preview || pendingDeletion?.preview || null}
          scopeLabel={
            pendingPermanentDeletion
              ? 'permanent delete'
              : pendingDeletion?.scope?.replace(/_/g, ' ') || ''
          }
          sourceLabel={pendingPermanentDeletion?.sourceLabel || pendingDeletion?.sourceLabel}
          isSubmitting={isDeletionSubmitting}
          onConfirm={confirmDeletion}
          onCancel={cancelDeletion}
        />

        {/* AMBIGUOUS TARGETS — server returned multiple matches. The
            user picks which one. Picking re-issues the deletion with
            a concrete target id (no targetQuery). */}
        {ambiguousCandidates && (
          <AmbiguousCandidateSheet
            scope={ambiguousCandidates.scope}
            candidates={ambiguousCandidates.candidates}
            sourceLabel={ambiguousCandidates.sourceLabel}
            onPick={async (candidate) => {
              const scope = ambiguousCandidates.scope;
              const sourceLabel = ambiguousCandidates.sourceLabel;
              setAmbiguousCandidates(null);
              if (scope === 'permanent_delete') {
                await beginPermanentDeletion({ binId: candidate.id, sourceLabel });
              } else {
                await beginDeletion({ scope, target: candidate.id, sourceLabel });
              }
            }}
            onCancel={cancelDeletion}
          />
        )}
      </div>
    </UIStateProvider>
  );
}
