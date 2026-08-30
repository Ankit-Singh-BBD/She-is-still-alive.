import express from 'express';
import http from 'http';
import path from 'path';
import compression from 'compression';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI, Modality } from '@google/genai';
import { db, VALID_FEMALE_VOICES, onDatabaseStateChange } from './server/db.js';
import { auth, AuthContext } from './server/auth.js';
import { cognition } from './server/cognition.js';
import { backupEngine } from './server/backup.js';
import { LiveSessionManager, broadcastVoiceConfigUpdate, broadcastRuntimeStateToAllSessions } from './server/live-session.js';
import { buildRuntimeContext } from './server/runtime-state.js';
import { cognitiveLoop } from './server/cognitive-loop.js';
import { learningPipeline } from './server/learning-pipeline.js';
import { awarenessEngine } from './server/awareness-engine.js';
import { taskExecutor } from './server/task-executor.js';
import { loopManager } from './server/loop-manager.js';
import { proactiveEngine } from './server/proactive-engine.js';
import { startEventCognitionDrain } from './server/event-cognition.js';
import { eventBus, emitUserArrival, emitUserDeparture, emitEnvironmentChange } from './server/event-system.js';

dotenv.config();

// In-Memory Weather & Context Cache for Ultra-Low Latency & Minimum Internet Usage
const weatherCache = new Map<string, { data: any; expiresAt: number }>();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // High-Efficiency Gzip / Deflate Compression Middleware with optimal threshold & level
  app.use(
    compression({
      level: 6,
      threshold: 256,
      filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
      },
    })
  );
  app.use(express.json());

  // Helper for Stale-While-Revalidate and client-side caching headers
  const setCacheControl = (res: express.Response, maxAgeSec = 10, swrSec = 60) => {
    res.setHeader('Cache-Control', `private, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`);
  };

  // --- API Endpoints ---

  function getCallerContext(req: express.Request): AuthContext {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const headerUserId = req.headers['x-user-id'] as string | undefined;
    const queryUserId = req.query.userId as string | undefined;
    const bodyUserId = req.body?.userId as string | undefined;
    const targetUserId = headerUserId || (queryUserId && queryUserId !== 'ALL' ? queryUserId : undefined) || bodyUserId;
    return auth.resolveContext(token, targetUserId);
  }

  // SSE Event Broadcast system for continuous real-time synchronization with server-side debouncing
  const sseSubscribers = new Set<express.Response>();
  let notifyTimeout: NodeJS.Timeout | null = null;

  function notifyClientsDataChanged(operation?: string, details?: string) {
    if (notifyTimeout) {
      clearTimeout(notifyTimeout);
    }
    notifyTimeout = setTimeout(() => {
      notifyTimeout = null;
      const payload = JSON.stringify({ type: 'state_changed', operation, details, timestamp: Date.now() });
      for (const res of sseSubscribers) {
        try {
          res.write(`data: ${payload}\n\n`);
        } catch (e) {
          sseSubscribers.delete(res);
        }
      }
      try {
        broadcastRuntimeStateToAllSessions();
      } catch (e) {}
    }, 150);
  }

  onDatabaseStateChange((operation, details) => {
    notifyClientsDataChanged(operation, details);
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    sseSubscribers.add(res);

    req.on('close', () => {
      sseSubscribers.delete(res);
    });
  });

  // Single Authoritative Runtime Context Endpoint
  app.get('/api/runtime-state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const callerContext = getCallerContext(req);
    const runtimeState = buildRuntimeContext(callerContext);
    res.json(runtimeState);
  });

  // Health and System Status
  app.get('/api/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const callerContext = getCallerContext(req);
    const owner = db.getOwner();
    const hasOwner = db.hasOwner();

    if (callerContext.role === 'owner') {
      const users = db.getUsers();
      const allUsers = [];
      if (owner) {
        allUsers.push({ id: owner.id, name: owner.name, createdAt: owner.createdAt });
      }
      users.forEach((u) => {
        allUsers.push({ id: u.id, name: u.name, createdAt: u.createdAt });
      });
      return res.json({
        status: 'ok',
        hasOwner,
        ownerName: owner ? owner.name : null,
        registeredUserCount: allUsers.length,
        users: allUsers,
        systemTime: new Date().toISOString(),
      });
    }

    // Normal users and guests cannot see the total count or list of registered users
    res.json({
      status: 'ok',
      hasOwner,
      ownerName: null,
      registeredUserCount: undefined,
      users: [],
      systemTime: new Date().toISOString(),
    });
  });

  // Owner First-Time Setup
  app.post('/api/setup-owner', (req, res) => {
    const { name, passcode } = req.body;
    if (!name || !passcode) {
      return res.status(400).json({ error: 'Name and passcode are required' });
    }

    const result = auth.setupOwner(name, passcode);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Auto-authenticate newly created owner
    const loginRes = auth.authenticateOwner(passcode);
    res.json({
      success: true,
      owner: {
        id: result.owner!.id,
        name: result.owner!.name,
        role: result.owner!.role,
      },
      token: loginRes.token,
    });
  });

  // Owner Passcode Authentication
  app.post('/api/auth/owner', (req, res) => {
    const { passcode } = req.body;
    if (!passcode) {
      return res.status(400).json({ error: 'Passcode is required' });
    }

    const result = auth.authenticateOwner(passcode);
    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json(result);
  });

  // Identify / Resolve Speaker (Authoritative Identity Resolution with Ambiguity Detection)
  app.post('/api/identify', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required for identity resolution' });
    }

    const resolved = db.resolveIdentityByName(name);
    if (!resolved) {
      return res.json({
        found: false,
        ambiguous: false,
        identity: null,
        message: `No registered profile or record matching "${name}". Person remains Unregistered/Guest.`,
      });
    }

    if (resolved.ambiguous) {
      return res.json({
        found: true,
        ambiguous: true,
        candidates: resolved.candidates,
        message: `Multiple registered candidates found matching "${name}": ${resolved.candidates?.join(', ')}. Please clarify your full name.`,
      });
    }

    res.json({
      found: true,
      ambiguous: false,
      identity: {
        id: resolved.id,
        name: resolved.name,
        role: resolved.role,
      },
    });
  });

  // Owner System Awareness Operational Briefing: GET
  app.get('/api/owner/briefing', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only the Owner can access the System Operational Briefing' });
    }

    const briefing = db.getSystemAwarenessBriefingForOwner();
    res.json({ success: true, briefing });
  });

  // World Awareness Endpoint: GET
  app.get('/api/world-awareness', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only the Owner can inspect complete World Awareness state' });
    }

    const wa = db.getWorldAwareness();
    res.json({ success: true, worldAwareness: wa });
  });

  // Awareness Snapshot Endpoint: GET (Owner-only)
  app.get('/api/awareness/snapshot', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Owner-only' });
    }
    const snapshot = awarenessEngine.snapshot();
    res.json({ success: true, snapshot });
  });

  // Recent System Events Endpoint: GET (Owner-only)
  app.get('/api/events/recent', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Owner-only' });
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const events = db.getRecentSystemEvents(limit);
    res.json({ success: true, events });
  });

  // User Registration / Identification
  app.post('/api/users/register', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'User name is required' });
    }

    const cleanName = name.trim();
    const owner = db.getOwner();
    const isOwnerName = Boolean(
      (owner && owner.name.trim().toLowerCase() === cleanName.toLowerCase()) ||
      cleanName.toLowerCase() === 'ankit'
    );

    if (isOwnerName) {
      return res.status(400).json({
        error: 'OWNER_NAME_RESERVED: Cannot create a normal user profile for Ankit / Owner. Please use Owner Passcode Authentication.',
      });
    }

    const user = db.createOrGetUser(cleanName);
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        role: 'user',
        createdAt: user.createdAt,
      },
    });
  });

  // Atomic Profile Switch Endpoint
  app.post('/api/identity/switch', (req, res) => {
    const { targetId, targetName } = req.body;
    const callerContext = getCallerContext(req);

    // 1. Switch to Guest / Unknown
    if (!targetId || targetId === 'UNKNOWN' || targetId === 'UNREGISTERED' || targetId === 'GUEST') {
      const guestContext = auth.resolveContext(undefined, 'UNKNOWN');
      const runtimeState = buildRuntimeContext(guestContext);
      return res.json({
        success: true,
        identity: { id: 'UNKNOWN', name: 'Guest', role: 'unknown' },
        token: undefined,
        runtimeState,
      });
    }

    // 2. Switch to Owner
    const owner = db.getOwner();
    if (targetId === 'OWNER_001' || (owner && targetId === owner.id)) {
      if (!callerContext.isOwnerAuthenticated) {
        return res.status(401).json({
          error: 'OWNER_AUTH_REQUIRED',
          message: 'Owner passcode authentication is required to switch to Owner profile.',
        });
      }
      const ownerContext = auth.resolveContext(callerContext.token, owner ? owner.id : 'OWNER_001');
      const runtimeState = buildRuntimeContext(ownerContext);
      return res.json({
        success: true,
        identity: { id: owner ? owner.id : 'OWNER_001', name: owner ? owner.name : 'Ankit', role: 'owner' },
        token: callerContext.token,
        runtimeState,
      });
    }

    // 3. Switch to a registered user
    const user = targetId ? db.getUserById(targetId) : (targetName ? db.getUserByName(targetName) : null);
    if (!user) {
      return res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: `User profile with id "${targetId}" was not found in the database.`,
      });
    }

    // If caller has owner token, preserve it for authorized operations while setting context to user
    const userContext = auth.resolveContext(callerContext.token, user.id);
    const runtimeState = buildRuntimeContext(userContext);

    return res.json({
      success: true,
      identity: { id: user.id, name: user.name, role: 'user' },
      token: callerContext.token,
      runtimeState,
    });
  });

  // Get Registered Users (Authoritative database query for User Management)
  app.get('/api/users', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const users = db.getUsers();
    const owner = db.getOwner();
    const allUsers: Array<{ id: string; name: string; role: 'owner' | 'user'; createdAt: string }> = [];
    if (owner) {
      allUsers.push({ id: owner.id, name: owner.name, role: 'owner', createdAt: owner.createdAt });
    }
    users.forEach((u) => {
      allUsers.push({ id: u.id, name: u.name, role: 'user', createdAt: u.createdAt });
    });

    res.json({
      success: true,
      users: allUsers,
    });
  });

  // Delete User Profile (Owner-only operation)
  app.delete('/api/users/:id', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.role !== 'owner' && !callerContext.isOwnerAuthenticated) {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only Owner can delete user profiles' });
    }

    const userId = req.params.id;
    if (userId === 'OWNER_001') {
      return res.status(400).json({ error: 'CANNOT_DELETE_OWNER: Master Owner identity cannot be deleted' });
    }

    const deleted = db.deleteUser(userId);
    if (!deleted) {
      return res.status(404).json({ error: 'User profile not found or deletion failed' });
    }

    res.json({
      success: true,
      message: `User ${userId} deleted successfully`,
    });
  });

  // Get Active Tasks and Open Loops
  app.get('/api/tasks', (req, res) => {
    const callerContext = getCallerContext(req);
    const userId = callerContext.id;
    if (userId === 'UNKNOWN' || userId === 'UNREGISTERED' || userId === 'GUEST') {
      return res.json({ tasks: [], openLoops: [] });
    }

    const requestedUserId = req.query.userId as string | undefined;
    let tasks: any[] = [];
    const wa = db.getWorldAwareness();
    let openLoops: any[] = [];

    if (callerContext.role === 'owner' && requestedUserId === 'ALL') {
      tasks = db.getRawData().tasks || [];
      openLoops = wa.openLoops || [];
    } else {
      let targetId = userId;
      if (callerContext.role === 'owner' && requestedUserId) {
        targetId = requestedUserId;
      }
      tasks = db.getTasksForIdentity(targetId);
      openLoops = (wa.openLoops || []).filter(l => l.identityId === targetId);
    }
    
    // sort tasks and loops
    tasks.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
    openLoops.sort((a, b) => new Date(b.createdAtIST || b.createdAtISO || 0).getTime() - new Date(a.createdAtIST || a.createdAtISO || 0).getTime());
    
    res.json({ tasks, openLoops });
  });

  app.post('/api/tasks', express.json(), (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') return res.status(403).json({ error: 'Denied' });
    const { title, description } = req.body;
    let targetId = callerContext.id;
    if (callerContext.role === 'owner' && req.body.userId && req.body.userId !== 'ALL') {
      targetId = req.body.userId;
    }
    const task = db.addOrUpdateTask(targetId, title, description);
    broadcastRuntimeStateToAllSessions();
    res.json({ success: true, task });
  });

  app.put('/api/tasks/:id', express.json(), (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') return res.status(403).json({ error: 'Denied' });
    const { status } = req.body;
    const ok = db.updateTaskStatus(callerContext.id, req.params.id, status);
    if (ok) broadcastRuntimeStateToAllSessions();
    res.json({ success: ok });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') return res.status(403).json({ error: 'Denied' });
    const ok = db.deleteTask(callerContext.id, req.params.id);
    if (ok) broadcastRuntimeStateToAllSessions();
    res.json({ success: ok });
  });

  // Dedicated Open Loops Management Endpoints
  app.get('/api/open-loops', (req, res) => {
    const callerContext = getCallerContext(req);
    const userId = callerContext.id;
    if (userId === 'UNKNOWN' || userId === 'UNREGISTERED' || userId === 'GUEST') {
      return res.json({ openLoops: [] });
    }

    const requestedUserId = req.query.userId as string | undefined;
    const includeResolved = req.query.includeResolved !== 'false';
    let loops: any[] = [];

    if (callerContext.role === 'owner' && (requestedUserId === 'ALL' || !requestedUserId)) {
      loops = db.getOpenLoops('ALL', includeResolved);
    } else {
      let targetId = userId;
      if (callerContext.role === 'owner' && requestedUserId) {
        targetId = requestedUserId;
      }
      loops = db.getOpenLoops(targetId, includeResolved);
    }

    // Enrich with user display names
    const enriched = loops.map((l) => {
      let personName = 'Unknown';
      if (l.identityId === 'OWNER_001') {
        const owner = db.getOwner();
        personName = owner ? `${owner.name} (Owner)` : 'Owner';
      } else {
        const user = db.getUserById(l.identityId);
        personName = user ? user.name : l.identityId;
      }
      return {
        ...l,
        personName,
      };
    });

    setCacheControl(res, 5, 20);
    res.json({ openLoops: enriched });
  });

  app.post('/api/open-loops', express.json(), (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Cannot register open loop as guest.' });
    }

    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name / topic is required for open loop.' });
    }

    let targetId = callerContext.id;
    if (callerContext.role === 'owner' && req.body.userId && req.body.userId !== 'ALL') {
      targetId = req.body.userId;
    }

    const loop = db.addOpenLoop(name, description || '', targetId);
    res.json({ success: true, openLoop: loop });
  });

  app.put('/api/open-loops/:id/resolve', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') {
      return res.status(403).json({ error: 'Denied' });
    }
    const ok = db.resolveOpenLoop(req.params.id);
    res.json({ success: ok });
  });

  app.put('/api/open-loops/:id/reopen', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') {
      return res.status(403).json({ error: 'Denied' });
    }
    const ok = db.reopenOpenLoop(req.params.id);
    res.json({ success: ok });
  });

  app.put('/api/open-loops/:id', express.json(), (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') {
      return res.status(403).json({ error: 'Denied' });
    }
    const { name, description, status } = req.body;
    const ok = db.updateOpenLoop(req.params.id, { name, description, status });
    res.json({ success: ok });
  });

  app.delete('/api/open-loops/:id', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.id === 'UNKNOWN' || callerContext.id === 'UNREGISTERED' || callerContext.id === 'GUEST') {
      return res.status(403).json({ error: 'Denied' });
    }
    const ok = db.deleteOpenLoop(req.params.id);
    res.json({ success: ok });
  });

  // Fast In-Memory Multi-Domain Search API (Memories, Turns, Patterns)
  app.get('/api/search', (req, res) => {
    setCacheControl(res, 5, 20);
    const query = ((req.query.q as string) || '').trim().toLowerCase();
    const type = (req.query.type as string) || 'all';
    const requestedUserId = req.query.userId as string | undefined;
    const callerContext = getCallerContext(req);

    if (!query) {
      return res.json({ memories: [], turns: [], patterns: [], total: 0 });
    }

    const tokens = query.split(/[\s,?.!]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return res.json({ memories: [], turns: [], patterns: [], total: 0 });
    }

    const matchesTokens = (text: string) => {
      const lower = text.toLowerCase();
      return tokens.every((t) => lower.includes(t));
    };

    let targetId = callerContext.id;
    const isOwner = callerContext.role === 'owner';

    const results: {
      memories: any[];
      turns: any[];
      patterns: any[];
      total: number;
    } = {
      memories: [],
      turns: [],
      patterns: [],
      total: 0,
    };

    if (callerContext.role === 'unknown') {
      return res.json(results);
    }

    // 1. Search Memories
    if (type === 'all' || type === 'memories') {
      if (isOwner && (!requestedUserId || requestedUserId === 'ALL')) {
        const groups = db.getAllMemoriesGrouped();
        for (const g of groups) {
          const matched = g.memories.filter((m) => matchesTokens(m.content) || matchesTokens(m.category));
          results.memories.push(...matched.map((m) => ({ ...m, userName: g.user.name })));
        }
      } else {
        const mems = db.getMemoriesForIdentity(requestedUserId && isOwner ? requestedUserId : targetId);
        results.memories = mems.filter((m) => matchesTokens(m.content) || matchesTokens(m.category));
      }
    }

    // 2. Search Conversation Turns
    if (type === 'all' || type === 'conversations') {
      if (isOwner && (!requestedUserId || requestedUserId === 'ALL')) {
        const groups = db.getAllConversationsGrouped();
        for (const g of groups) {
          const matched = g.turns.filter((t) => matchesTokens(t.content) || matchesTokens(t.role));
          results.turns.push(...matched.map((t) => ({ ...t, userName: g.user.name })));
        }
      } else {
        const turns = db.getRecentTurns(requestedUserId && isOwner ? requestedUserId : targetId, 100);
        results.turns = turns.filter((t) => matchesTokens(t.content) || matchesTokens(t.role));
      }
    }

    // 3. Search Learned Patterns
    if (type === 'all' || type === 'patterns') {
      if (isOwner && (!requestedUserId || requestedUserId === 'ALL')) {
        const groups = db.getAllPatternsGrouped();
        for (const g of groups) {
          const matched = g.patterns.filter((p) => matchesTokens(p.description) || matchesTokens(p.category));
          results.patterns.push(...matched.map((p) => ({ ...p, userName: g.user.name })));
        }
      } else {
        const patterns = db.getPatternsForIdentity(requestedUserId && isOwner ? requestedUserId : targetId);
        results.patterns = patterns.filter((p) => matchesTokens(p.description) || matchesTokens(p.category));
      }
    }

    results.total = results.memories.length + results.turns.length + results.patterns.length;
    res.json(results);
  });

  // Delete User Profile (Owner-only operation)
  app.delete('/api/users/:id', (req, res) => {
    const callerContext = getCallerContext(req);

    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only the Owner can delete user profiles' });
    }

    const userId = req.params.id;
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const deleted = db.deleteUser(userId);
    if (!deleted) {
      return res.status(500).json({ error: 'FAILED_TO_DELETE_USER' });
    }

    res.json({
      success: true,
      message: `User ${user.name} (${userId}) and all associated memories and conversation context were deleted.`,
    });
  });

  // Identity-Scoped Memory API
  app.get('/api/memories', (req, res) => {
    setCacheControl(res, 5, 30);
    const requestedUserId = req.query.userId as string | undefined;
    const callerContext = getCallerContext(req);
    let targetId = callerContext.id;

    if (callerContext.role === 'owner' && requestedUserId && requestedUserId !== 'ALL') {
      targetId = requestedUserId;
    } else if (callerContext.role !== 'owner' && requestedUserId && requestedUserId !== callerContext.id) {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Normal users can only access their own memories' });
    }

    if (callerContext.role === 'unknown') {
      return res.json({ memories: [], count: 0, identity: 'UNKNOWN' });
    }

    const memories = db.getMemoriesForIdentity(targetId);
    res.json({
      identity: { id: targetId, role: callerContext.role },
      memories,
      count: memories.length,
    });
  });

  // Add Memory
  app.post('/api/memories', (req, res) => {
    const { userId, content, category } = req.body;
    const context = getCallerContext(req);
    if (context.role === 'unknown') {
      return res.status(403).json({ error: 'UNKNOWN_USER: Cannot save memory without established identity' });
    }

    const targetId = context.role === 'owner' && userId ? userId : context.id;
    const memory = db.addMemory(targetId, content, category);
    if (!memory) {
      return res.status(500).json({ error: 'FAILED_TO_SAVE_MEMORY' });
    }
    broadcastRuntimeStateToAllSessions();
    res.json({ success: true, memory });
  });

  // Delete Memory
  app.delete('/api/memories/:id', (req, res) => {
    const requestedUserId = req.query.userId as string | undefined;
    const memoryId = req.params.id;

    const callerContext = getCallerContext(req);
    let targetId = callerContext.id;

    if (callerContext.role === 'owner' && requestedUserId) {
      targetId = requestedUserId;
    } else if (callerContext.role !== 'owner' && requestedUserId && requestedUserId !== callerContext.id) {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Cannot delete another user\'s memory' });
    }

    const success = db.deleteMemory(targetId, memoryId);

    if (!success) {
      return res.status(404).json({ error: 'Memory not found or permission denied' });
    }

    broadcastRuntimeStateToAllSessions();
    res.json({ success: true });
  });

  // User Preferences API Endpoint
  app.post('/api/preferences', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.role === 'unknown' || callerContext.id === 'UNKNOWN') {
      return res.status(403).json({ error: 'UNKNOWN_USER: Cannot update preference without established identity' });
    }

    const { key, value, targetUserId } = req.body;
    if (!key || typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'Preference key is required' });
    }

    let targetId = callerContext.id;
    if (callerContext.role === 'owner' && targetUserId) {
      targetId = targetUserId;
    }

    const updatedPreferences = db.updateUserPreference(targetId, key.trim(), value);
    broadcastRuntimeStateToAllSessions();
    res.json({ success: true, targetId, key: key.trim(), value, preferences: updatedPreferences });
  });

  // Persona & Voice Controls: GET & PUT
  app.get('/api/persona-voice', (req, res) => {
    const callerContext = getCallerContext(req);
    const requestedUserId = req.query.userId as string | undefined;

    let targetId = callerContext.id;
    if (callerContext.role === 'owner' && requestedUserId) {
       targetId = requestedUserId;
    }
    if (!targetId || targetId === 'UNKNOWN') {
       targetId = requestedUserId || 'OWNER_001';
    }

    try {
      const config = db.getPersonaVoiceConfig(targetId);
      setCacheControl(res, 10, 60);
      res.json({ config });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get Persona & Voice configuration' });
    }
  });

  app.put('/api/persona-voice', (req, res) => {
    const callerContext = getCallerContext(req);
    const requestedUserId = req.query.userId as string | undefined;

    let targetId = callerContext.id;
    if (callerContext.role === 'owner' && requestedUserId) {
       targetId = requestedUserId;
    }
    if (!targetId || targetId === 'UNKNOWN') {
       targetId = requestedUserId || 'OWNER_001';
    }

    try {
      const updatedConfig = db.updatePersonaVoiceConfig(targetId, req.body);
      broadcastVoiceConfigUpdate(updatedConfig, targetId);
      broadcastRuntimeStateToAllSessions();
      res.json({ success: true, config: updatedConfig });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update Persona & Voice configuration' });
    }
  });

  // Owner Grouped Memory Overview: GET (Inspect All Persisted Memories Grouped by Profile)
  app.get('/api/owner/memories-grouped', (req, res) => {
    const callerContext = getCallerContext(req);

    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only the Owner can inspect grouped user memories' });
    }

    const grouped = db.getAllMemoriesGrouped();
    setCacheControl(res, 5, 30);
    res.json({ groups: grouped });
  });

  // Conversation Turns API: GET (Identity-Scoped)
  app.get('/api/conversations', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const requestedUserId = req.query.userId as string | undefined;
    const sessionId = req.query.sessionId as string | undefined;
    const callerContext = getCallerContext(req);
    let targetId = callerContext.id;

    if (callerContext.role === 'owner' && requestedUserId) {
      if (requestedUserId === 'ALL') {
        const grouped = db.getAllConversationsGrouped();
        return res.json({ groups: grouped });
      }
      targetId = requestedUserId;
    } else if (callerContext.role !== 'owner' && requestedUserId && requestedUserId !== callerContext.id) {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Normal users can only access their own conversations' });
    }

    if (callerContext.role === 'unknown' && !sessionId) {
      return res.json({ turns: [], count: 0, identity: 'UNKNOWN' });
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
    const turns = db.getRecentTurns(targetId, limit, sessionId);
    res.json({
      identity: { id: targetId, role: callerContext.role },
      turns,
      count: turns.length,
    });
  });

  // Clear Conversation History: DELETE
  app.delete('/api/conversations/:sessionId', (req, res) => {
    const callerContext = getCallerContext(req);
    const requestedUserId = req.query.userId as string | undefined;
    let targetId = callerContext.id;

    if (callerContext.role === 'owner' && requestedUserId) {
      targetId = requestedUserId;
    } else if (callerContext.role !== 'owner' && requestedUserId && requestedUserId !== callerContext.id) {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Cannot delete another user\'s session' });
    }

    if (callerContext.role === 'unknown') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Guests cannot delete sessions' });
    }

    try {
      const ok = db.deleteSession(targetId, req.params.sessionId);
      if (ok) {
        broadcastRuntimeStateToAllSessions();
        return res.json({ success: true, message: `Session ${req.params.sessionId} deleted` });
      } else {
        return res.status(404).json({ success: false, error: `SESSION_NOT_FOUND: Session "${req.params.sessionId}" not found for user ${targetId}` });
      }
    } catch (e: any) {
      console.error(`Error deleting session ${req.params.sessionId}:`, e);
      return res.status(500).json({ success: false, error: e.message || 'Failed to delete session' });
    }
  });

  app.delete('/api/conversations', (req, res) => {
    const requestedUserId = req.query.userId as string | undefined;

    const callerContext = getCallerContext(req);
    let targetId = callerContext.id;

    if (callerContext.role === 'owner' && requestedUserId) {
      targetId = requestedUserId;
    } else if (callerContext.role !== 'owner' && requestedUserId && requestedUserId !== callerContext.id) {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Cannot clear another user\'s history' });
    }

    if (callerContext.role === 'unknown') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Guests cannot clear history' });
    }

    try {
      const success = db.clearHistory(targetId);
      if (success) {
        broadcastRuntimeStateToAllSessions();
        return res.json({ success: true, message: `History cleared for identity ${targetId}` });
      } else {
        return res.status(500).json({ success: false, error: 'Failed to clear history' });
      }
    } catch (e: any) {
      console.error(`Error clearing history for identity ${targetId}:`, e);
      return res.status(500).json({ success: false, error: e.message || 'Failed to clear history' });
    }
  });

  // Learned Patterns & Habits API: GET (Identity-Scoped)
  app.get('/api/patterns', (req, res) => {
    setCacheControl(res, 5, 30);
    const requestedUserId = req.query.userId as string | undefined;

    const callerContext = getCallerContext(req);
    let targetId = callerContext.id;

    if (callerContext.role === 'owner' && requestedUserId) {
      if (requestedUserId === 'ALL') {
        const grouped = db.getAllPatternsGrouped();
        return res.json({ groups: grouped });
      }
      targetId = requestedUserId;
    } else if (callerContext.role !== 'owner' && requestedUserId && requestedUserId !== callerContext.id) {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Normal users can only access their own patterns' });
    }

    if (callerContext.role === 'unknown') {
      return res.json({ patterns: [], count: 0, identity: 'UNKNOWN' });
    }

    const patterns = db.getPatternsForIdentity(targetId);
    res.json({
      identity: { id: targetId, role: callerContext.role },
      patterns,
      count: patterns.length,
    });
  });

  // Direct Cognitive Conversational Endpoint: POST /api/chat
  // Executes the 12-stage cognitive loop: PERCEIVE → IDENTIFY → RECALL →
  // UNDERSTAND → REASON → DECIDE → ACT → VERIFY → RESPOND → LEARN → UPDATE → PERSIST
  app.post('/api/chat', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { message, userId, name, sessionId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const callerContext = auth.resolveContext(token, userId);
    let effectiveName = callerContext.role === 'owner' ? (db.getOwner()?.name || 'Ankit') : 'Guest';
    if (callerContext.role === 'user') {
      const u = db.getUserById(callerContext.id);
      effectiveName = u?.name || name || 'User';
    } else if (name) {
      effectiveName = name;
    }

    // Update presence
    const finalSessionId = sessionId || `SESSION_${new Date().toISOString().slice(0, 10)}`;
    db.startPresenceSession({
      sessionId: finalSessionId,
      identityId: callerContext.id,
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      status: 'active',
      channel: 'text',
    });

    try {
      // Use the 12-stage cognitive loop (Requirement #37)
      const result = await cognitiveLoop.execute(
        message,
        'text',
        finalSessionId,
        callerContext
      );

      // Run post-interaction learning pipeline asynchronously (Requirement #15)
      learningPipeline.run(
        callerContext.id,
        effectiveName,
        callerContext.role,
        message,
        result.response.text,
        finalSessionId
      ).catch(err => console.warn('[CHAT] post-learning failed:', err.message));

      res.json({
        success: true,
        reply: result.response.text,
        identity: { id: callerContext.id, name: effectiveName, role: callerContext.role },
        loopId: result.loopId,
        confidence: result.response.metadata.confidence,
        basedOnVerification: result.response.metadata.basedOnVerification,
      });
    } catch (err: any) {
      console.error('Chat endpoint failure:', err);
      // Fall back to existing cognition engine
      try {
        const result = await cognition.processChatTurn(
          callerContext.id,
          callerContext.role,
          effectiveName,
          message,
          sessionId
        );
        res.json({
          success: true,
          reply: result.reply,
          identity: result.identity,
          temporal: result.temporal,
          fallback: true,
        });
      } catch (fallbackErr: any) {
        res.status(500).json({
          error: fallbackErr.message || 'Internal cognitive processing error',
        });
      }
    }
  });

  // Interaction Timeline API: GET /api/timeline/:name
  app.get('/api/timeline/:name', (req, res) => {
    const callerContext = getCallerContext(req);
    const targetName = req.params.name;
    const timeline = db.getInteractionTimeline(targetName, callerContext.role, callerContext.id);
    res.json(timeline);
  });

  // Pending Cross-User Notes: GET /api/notes/pending
  app.get('/api/notes/pending', (req, res) => {
    const callerContext = getCallerContext(req);
    if (callerContext.role === 'unknown') {
      return res.json({ notes: [] });
    }
    const notes = db.getPendingNotesForTarget(callerContext.id, callerContext.name);
    res.json({ notes });
  });

  // Send Cross-User Note: POST /api/notes/send
  app.post('/api/notes/send', (req, res) => {
    const callerContext = getCallerContext(req);
    const { targetName, content } = req.body;
    if (!targetName || !content) {
      return res.status(400).json({ error: 'targetName and content are required' });
    }
    const note = db.addCrossUserNote(callerContext.id, callerContext.name, content, targetName);
    res.json({ success: true, note });
  });

  // Addressing Preferences: POST /api/preferences/addressing
  app.post('/api/preferences/addressing', (req, res) => {
    const callerContext = getCallerContext(req);
    const { preferredTitle } = req.body;
    if (callerContext.role === 'unknown') {
      return res.status(403).json({ error: 'UNKNOWN_USER: Cannot save preference without established identity' });
    }
    if (!preferredTitle || !preferredTitle.trim()) {
      return res.status(400).json({ error: 'preferredTitle is required' });
    }
    const updated = db.setAddressingPreference(callerContext.id, preferredTitle.trim());
    res.json({ success: true, addressing: updated });
  });

  // Owner Backup & Restore API: Export Database
  app.get('/api/backup/export', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const userId = (req.query.userId as string) || req.headers['x-user-id'] as string | undefined;
    const callerContext = auth.resolveContext(token, userId);

    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only the Owner can export system backups' });
    }

    try {
      const backup = backupEngine.createBackup();
      const filename = `madhurita_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(backup);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate database backup' });
    }
  });

  // Owner Backup & Restore API: Import / Restore Database
  app.post('/api/backup/import', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const userId = (req.query.userId as string) || req.headers['x-user-id'] as string | undefined;
    const callerContext = auth.resolveContext(token, userId);

    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only the Owner can restore database backups' });
    }

    const payload = req.body;
    if (!payload) {
      return res.status(400).json({ error: 'INVALID_PAYLOAD: Backup payload JSON is required' });
    }

    try {
      const result = backupEngine.restoreBackup(payload);
      if (!result.success) {
        return res.status(400).json({ error: result.error || 'Restore failed' });
      }

      res.json({
        success: true,
        message: 'System database successfully and transactionally restored.',
        summary: result.summary,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to restore database backup' });
    }
  });

  // Owner Backup & Restore API: Backup Info / System Health
  app.get('/api/backup/info', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const userId = (req.query.userId as string) || req.headers['x-user-id'] as string | undefined;
    const callerContext = auth.resolveContext(token, userId);

    if (callerContext.role !== 'owner') {
      return res.status(403).json({ error: 'PERMISSION_DENIED: Only the Owner can access backup metadata' });
    }

    try {
      const info = backupEngine.getBackupStatus();
      res.json({ success: true, info });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to retrieve backup info' });
    }
  });

  // System Configured Location Context: GET
  app.get('/api/location-context', (req, res) => {
    const location = db.getLocationConfig();
    const now = new Date();
    const istTimeString = now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'full',
      timeStyle: 'medium',
    });

    res.json({
      location,
      currentTimeIST: istTimeString,
      timestamp: now.toISOString(),
    });
  });

  // Real Live Weather Endpoint (Fetches actual meteorological data for Orai, UP, India with 10-minute in-memory caching)
  app.get('/api/weather', async (req, res) => {
    const location = db.getLocationConfig();
    const lat = req.query.lat ? parseFloat(req.query.lat as string) : location.latitude;
    const lon = req.query.lon ? parseFloat(req.query.lon as string) : location.longitude;
    const locationName = (req.query.city as string) || location.formattedLocation;

    const cacheKey = `${lat}_${lon}_${locationName}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached.data);
    }

    try {
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=Asia%2FKolkata`;
      const response = await fetch(weatherUrl);

      if (!response.ok) {
        return res.status(502).json({
          available: false,
          error: 'Live weather service returned a non-200 response',
          location: locationName,
        });
      }

      const weatherData = await response.json();
      const current = weatherData.current;

      // Map WMO Weather Codes to descriptive conditions
      const weatherCodeMap: Record<number, string> = {
        0: 'Clear sky',
        1: 'Mainly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Foggy',
        48: 'Depositing rime fog',
        51: 'Light drizzle',
        53: 'Moderate drizzle',
        55: 'Dense drizzle',
        61: 'Slight rain',
        63: 'Moderate rain',
        65: 'Heavy rain',
        71: 'Slight snow',
        73: 'Moderate snow',
        75: 'Heavy snow',
        80: 'Slight rain showers',
        81: 'Moderate rain showers',
        82: 'Violent rain showers',
        95: 'Thunderstorm',
      };

      const condition = weatherCodeMap[current.weather_code] || 'Clear';

      const weatherPayload = {
        available: true,
        location: locationName,
        temperature: current.temperature_2m,
        feelsLike: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m,
        precipitation: current.precipitation,
        condition,
        time: current.time,
        timezone: 'Asia/Kolkata',
      };

      weatherCache.set(cacheKey, {
        data: weatherPayload,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes cache
      });

      res.setHeader('X-Cache', 'MISS');
      res.json(weatherPayload);
    } catch (err: any) {
      console.warn('Weather fetch failed:', err.message);
      res.status(503).json({
        available: false,
        error: 'Live weather data is currently unreachable.',
        location: locationName,
      });
    }
  });

  // Fallback High-Quality Voice Greeting / TTS
  app.post('/api/tts-greeting', async (req, res) => {
    try {
      const { text, voiceName } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not set' });
      }

      // Authoritative female voice resolution
      const callerContext = getCallerContext(req);
      const activeVoice = db.getPersonaVoiceConfig(callerContext.id).voiceName;
      let effectiveVoice = voiceName || activeVoice || 'Callirrhoe';
      if (!VALID_FEMALE_VOICES.includes(effectiveVoice)) {
        effectiveVoice = 'Callirrhoe';
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      const speechText = text || 'Hey there! I am Madhurita. Tap the microphone whenever you are ready to talk to me!';

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-tts-preview',
        contents: [{ parts: [{ text: speechText }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: effectiveVoice },
            },
          },
        },
      });

      const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioData) {
        return res.status(500).json({ error: 'No audio generated' });
      }

      res.json({ audio: audioData, sampleRate: 24000 });
    } catch (err: any) {
      console.error('TTS error:', err);
      res.status(500).json({ error: err.message || 'TTS generation failed' });
    }
  });

  // Create HTTP Server
  const server = http.createServer(app);

  // WebSocket Server for Gemini Live Real-time Audio
  const wss = new WebSocketServer({ server, path: '/live' });

  wss.on('connection', (clientWs: WebSocket, req) => {
    // Parse URL query params for token / userId
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || undefined;
    const userId = url.searchParams.get('userId') || undefined;

    const authContext = auth.resolveContext(token, userId);
    const sessionManager = new LiveSessionManager(clientWs, authContext);

    sessionManager.start();

    clientWs.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        if (msg.type === 'audio' && msg.audio) {
          sessionManager.sendRealtimeAudio(msg.audio);
        } else if ((msg.type === 'text_message' || msg.type === 'chat_message') && msg.text) {
          sessionManager.sendTextMessage(msg.text);
        } else if (msg.type === 'update_auth') {
          let targetUserId = msg.userId;
          const authSession = auth.resolveAuthentication(msg.token);
          const isOwnerAuth = authSession.isAuthenticated && authSession.role === 'owner';
          
          // STRICT IDENTITY ISOLATION: Only the Owner can manually switch to a registered user or owner profile via WebSocket.
          // Voice identification (identifyUser tool) bypasses this via internal state transitions.
          if (targetUserId && targetUserId !== 'UNKNOWN' && targetUserId !== 'UNREGISTERED') {
            if (!isOwnerAuth) {
              console.warn('Unauthorized attempt to switch identity to', targetUserId, 'without Owner authentication. Forcing Guest context.');
              targetUserId = 'UNKNOWN';
            }
          }

          const newContext = auth.resolveContext(msg.token, targetUserId);
          await sessionManager.updateContext(newContext);
          clientWs.send(JSON.stringify({
            type: 'identity_changed',
            identity: { id: newContext.id, name: newContext.name, role: newContext.role },
            token: msg.token,
          }));
        }
      } catch (err) {
        console.error('Error handling WebSocket client message:', err);
      }
    });

    clientWs.on('close', () => {
      sessionManager.close();
    });

    clientWs.on('error', (err) => {
      console.error('Client WebSocket error:', err);
      sessionManager.close();
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(
      express.static(distPath, {
        maxAge: '1y',
        immutable: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
          }
        },
      })
    );
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[STARTUP VERIFICATION] Authoritative Database absolute path: ${db.getDatabaseFilePath()}`);

    // ===================================================================
    // MADHURITA IDENTITY VERIFICATION (Requirement #1)
    // ===================================================================
    // Verify Madhurita's core identity exists and is properly configured
    const identityVerification = db.verifyMadhuritaIdentity();
    if (!identityVerification.valid) {
      console.error('[MADHURITA IDENTITY] VERIFICATION FAILED:');
      identityVerification.issues.forEach((issue) => console.error(`  - ${issue}`));
      console.error('[MADHURITA IDENTITY] System may not function correctly.');
    } else {
      const identity = db.getMadhuritaIdentity();
      console.log(`[MADHURITA IDENTITY] ✓ Verified: ${identity?.name} (${identity?.gender})`);
      console.log(`[MADHURITA IDENTITY] ✓ Creator: ${identity?.creatorName} (${identity?.creatorId})`);
      console.log(`[MADHURITA IDENTITY] ✓ Voice: ${identity?.voiceIdentity}`);
      console.log(`[MADHURITA IDENTITY] ✓ Version: ${identity?.systemVersion}`);
    }

    // ===================================================================
    // START COGNITIVE SUBSYSTEMS (Requirement #37, #27, #18, #15)
    // ===================================================================
    // Awareness engine: continuous operational awareness
    awarenessEngine.start(30_000);
    // Task executor: actually executes due tasks
    taskExecutor.start(60_000);
    // Loop manager: continuous relevance evaluation
    loopManager.start(5 * 60_000);
    // Proactive reasoning: decide when to initiate
    proactiveEngine.start(2 * 60_000);
    // Drain any events recorded but not processed
    startEventCognitionDrain().catch(err => console.error('[STARTUP] event drain failed:', err.message));
    // Record system startup event
    emitEnvironmentChange('system_startup', 'Madhurita cognitive system started', {
      version: '1.0.0',
      port: PORT,
    }).catch(err => console.error('[STARTUP] emit failed:', err.message));

    console.log(`[COGNITIVE] ✓ All subsystems online (awareness, tasks, loops, proactive, events)`);
    console.log(`Madhurita AI Assistant running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
