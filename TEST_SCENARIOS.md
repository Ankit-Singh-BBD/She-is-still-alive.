# End-to-End Test Scenarios

Based on the original specification, these scenarios verify the cognitive architecture is working correctly.

## Test Scenarios (A-L)

### A. Guest Arrival
**Given:** Clean boot (no auth token, localStorage cleared)  
**When:** User opens the application  
**Then:**
- UI shows identity: UNKNOWN / Guest
- No private data visible (no memories, tasks, loops, notes)
- SSE `/api/events` connected
- `/api/runtime-state` returns Guest-isolated state
- Voice session startup delivers factual context (not [SYSTEM TRIGGER])

### B. "I am Ankit" without passcode
**Given:** Guest session  
**When:** User says "I am Ankit" (voice or text)  
**Then:**
- LLM recognizes Owner claim via `identifyUser` tool
- Tool returns: `OWNER_AUTH_REQUIRED`
- LLM asks for passcode (natural language, not scripted)
- Identity remains UNKNOWN until auth completes

### C. Authenticated Ankit
**Given:** Guest session  
**When:** User provides correct Owner passcode via `ownerAuthenticate` tool  
**Then:**
- Auth succeeds, token issued
- Identity switches to `OWNER_001` / Ankit / owner
- UI re-renders with Owner scope (all users visible, system diagnostics)
- Runtime state shows Owner tasks, loops, memories
- SSE broadcasts new state to all sessions

### D. Govind sends message to Ankit
**Given:** Ankit is authenticated as Owner, Govind is registered user  
**When:** Govind (in his session) says "Ankit ko bolna I'll be late"  
**Then:**
- LLM understands intent (not regex `detectAndApplyUserDirectives`)
- Calls `manageCrossUserNote` tool with `action: send`, `targetName: Ankit`, `content: "I'll be late"`
- DB creates cross-user note with `status: pending`
- SSE broadcasts state change
- Ankit's next interaction shows pending message in cognitive context
- LLM delivers the message naturally

### E. Govind's Timeline
**Given:** Ankit is authenticated as Owner  
**When:** Ankit requests "Show me Govind's timeline" or navigates to it  
**Then:**
- GET `/api/timeline/Govind` returns interaction history
- Only Owner can see other users' timelines
- Timeline shows: last seen, recent turns, tasks, loops, notes

### F. Corrections
**Given:** Active conversation  
**When:** User says "Actually, I prefer tea, not coffee"  
**Then:**
- LLM recognizes correction in cognitive reasoning
- Post-interaction learning via `runPostInteractionCognition`
- Returns structured JSON with `correctedMemories` or `retiredMemories`
- Old memory superseded via `supersededBy` field (not deleted)
- New memory created with correct content
- Confidence and evidence count tracked

### G. Task Lifecycle
**Given:** Active conversation  
**When:** User says "Remind me to call the plumber tomorrow at 10am"  
**Then:**
- LLM understands intent and calls `manageTask` tool
- DB creates task with `status: pending`, `dueDate: <tomorrow 10am IST>`
- Task appears in runtime state
- At due time (or when user asks), LLM reminds user naturally
- User says "Done" → LLM calls `manageTask` with `action: complete`
- Task status → `completed`

### H. Supersede Knowledge
**Given:** Memory exists: "User prefers Hindi"  
**When:** User consistently speaks English, pattern detected  
**Then:**
- Post-interaction learning detects conflict
- Creates new memory: "User prefers English in formal contexts"
- Supersedes old memory via `supersededBy: <new-memory-id>`
- Old memory remains in DB (not deleted) for audit trail
- New memory used in future cognitive context

### I. Page Reload
**Given:** Authenticated session (Owner or User)  
**When:** User refreshes the page  
**Then:**
- localStorage cleared on mount (line 73-81 of App.tsx)
- Identity resets to UNKNOWN/Guest
- Auth token lost (never persisted)
- User must re-authenticate
- This is intentional: every boot is clean

### J. Reconnect (same session)
**Given:** Voice session active, network drops  
**When:** WebSocket reconnects  
**Then:**
- `LiveSessionManager` session still alive
- `sessionId` unchanged
- Conversation history preserved
- Runtime state re-broadcast
- No duplicate startup cognition

### K. UI → Voice Preference Sync
**Given:** User in text chat  
**When:** User changes voice config via UI (e.g., voice name, language, style)  
**Then:**
- POST `/api/persona-voice` updates DB
- `broadcastVoiceConfigUpdate` called
- All live voice sessions receive update
- Voice session restarts with new config (deferred until model turn completes)
- Text chat sees updated config in next `/api/runtime-state`

### L. Voice → UI Preference Sync
**Given:** User in voice session  
**When:** User says "Switch to Hindi" or "Call me Boss from now on"  
**Then:**
- LLM calls `updateVoiceConfiguration` or addressing tool
- DB updates
- `broadcastVoiceConfigUpdate` or `broadcastRuntimeStateToAllSessions` called
- UI re-fetches `/api/runtime-state` via SSE trigger
- UI reflects new preference immediately

---

## Verification Checklist

- [ ] TypeScript builds cleanly (`npm run build`)
- [ ] Server boots without errors
- [ ] No `[SYSTEM TRIGGER]` strings in code (only comment)
- [ ] No `BOOT BEHAVIOR` directives in system prompt
- [ ] No `extractKnowledgeProgrammatically` in main path
- [ ] No duplicate `detectAndApplyUserDirectives` (single source in cognition-2.ts, live-session only has addressing)
- [ ] System prompt separates facts from behavior (INVARIANTS / COGNITIVE REASONING / STATE)
- [ ] LLM-driven learning replaces regex (`runPostInteractionCognition`)
- [ ] Guest privacy isolation preserved
- [ ] Startup context is factual, not behavioral (`buildStartupFacts`)
- [ ] Database is single source of truth (all state changes via DB)
- [ ] No "How can I help?" in UI

---

## Current Status (2026-08-30)

**Build:** ✅ Pass  
**TypeScript:** ✅ Pass  
**Server Boot:** ✅ Pass  
**Architecture Verification:** ✅ Pass (all items in walkthrough.md verified)  
**UI Cleanup:** ✅ "How can I help you today?" removed from GreetingHero.tsx  

**Next:** Manual scenario testing requires:
1. Valid `GEMINI_API_KEY` in `.env`
2. Run `npm run dev`
3. Execute scenarios A-L manually or via automated E2E tests

**Note:** Scenarios require a real Gemini API key to test LLM reasoning and tool execution. Current `.env` has placeholder values.
