import { useState, useEffect, useMemo, type FormEvent, type ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Database,
  Plus,
  Trash2,
  ShieldCheck,
  Tag,
  X,
  Lock,
  Sparkles,
  Sliders,
  MapPin,
  Clock,
  CloudSun,
  Crown,
  User,
  CheckCircle2,
  RefreshCw,
  Volume2,
  MessageSquare,
  Globe2,
  HardDrive,
  Download,
  Upload,
  CheckSquare,
  FileJson,
  AlertTriangle,
  History,
  BrainCircuit,
  Compass,
  Search,
  RotateCcw,
  Check,
} from 'lucide-react';
import {
  Identity,
  MemoryItem,
  GroupedMemory,
  PersonaAndVoiceConfig,
  WeatherData,
  ConversationTurnItem,
  GroupedConversation,
  LearnedPatternItem,
  GroupedPattern,
} from '../types.js';
import { sanitizeAuthToken } from '../utils/auth.js';
import { globalAppCache } from '../utils/searchAndCache.js';

interface MemoryViewerModalProps {
  isOpen: boolean;
  identity: Identity;
  token?: string;
  onClose: () => void;
  onRestored?: () => void;
  mode?: 'database' | 'tasks' | 'voice' | 'iot';
}

export function MemoryViewerModal({ isOpen, identity, token, onClose, onRestored, mode = 'database' }: MemoryViewerModalProps) {
  const isOwner = identity.role === 'owner';
  const [activeTab, setActiveTab] = useState<'memories' | 'tasks' | 'conversations' | 'patterns' | 'briefing' | 'persona' | 'location' | 'backup'>(
    mode === 'tasks' ? 'tasks' : mode === 'voice' ? 'persona' : mode === 'iot' ? 'location' : 'memories'
  );

  // Tasks State
  const [tasks, setTasks] = useState<any[]>([]);
  const [openLoops, setOpenLoops] = useState<any[]>([]);
  const [taskSubTab, setTaskSubTab] = useState<'tasks' | 'open_loops'>('tasks');
  const [taskStatusFilter, setTaskStatusFilter] = useState<'all' | 'pending' | 'in_progress' | 'completed'>('all');
  const [openLoopFilter, setOpenLoopFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [newLoopTopic, setNewLoopTopic] = useState('');
  const [newLoopDesc, setNewLoopDesc] = useState('');
  const [isAddingLoop, setIsAddingLoop] = useState(false);

  // World Awareness & Briefing State
  const [briefingData, setBriefingData] = useState<any>(null);
  const [isLoadingBriefing, setIsLoadingBriefing] = useState(false);

  // Memories State
  const [groups, setGroups] = useState<GroupedMemory[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingMemories, setIsLoadingMemories] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<MemoryItem['category']>('fact');
  const [targetUserForAdd, setTargetUserForAdd] = useState<string>(identity.id);
  const [isAddingMemory, setIsAddingMemory] = useState(false);

  // Conversations State
  const [conversationGroups, setConversationGroups] = useState<GroupedConversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);

  // Patterns & Habits State
  const [patternGroups, setPatternGroups] = useState<GroupedPattern[]>([]);
  const [isLoadingPatterns, setIsLoadingPatterns] = useState(false);

  // Persona & Voice State
  const [personaConfig, setPersonaConfig] = useState<PersonaAndVoiceConfig>({
    speakingStyle: 'warm_conversational',
    tone: 'friendly_warm',
    formality: 'balanced',
    preferredLanguage: 'Hinglish',
    hinglishBehavior: 'natural_mix',
    voiceName: 'Callirrhoe',
    responseLength: 'balanced',
    conversationalStyle: 'interactive_engaging',
  });
  const [isSavingPersona, setIsSavingPersona] = useState(false);
  const [personaSaveSuccess, setPersonaSaveSuccess] = useState(false);

  // Location & Weather State
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);
  const [istTime, setIstTime] = useState<string>('');
  const [isLoadingWeather, setIsLoadingWeather] = useState(false);

  // Backup & Restore State
  const [backupInfo, setBackupInfo] = useState<any>(null);
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<{ success?: boolean; message?: string; error?: string } | null>(null);
  const [importFileContent, setImportFileContent] = useState<string>('');
  const [importFileName, setImportFileName] = useState<string>('');

  const getAuthHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    const cleanToken = sanitizeAuthToken(token);
    if (cleanToken) {
      headers['Authorization'] = `Bearer ${cleanToken}`;
    }
    if (identity?.id) {
      headers['X-User-Id'] = identity.id;
    }
    return headers;
  };

  // Fetch Grouped Memories directly from backend
  const fetchMemories = async () => {
    setIsLoadingMemories(true);
    try {
      const headers = getAuthHeaders();

      if (isOwner) {
        const res = await fetch('/api/owner/memories-grouped', { headers, cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data.groups) {
            setGroups(data.groups);
          }
        }
      } else {
        const res = await fetch(`/api/memories?userId=${encodeURIComponent(identity.id)}`, { headers, cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data.memories) {
            const formatted = [
              {
                user: { id: identity.id, name: identity.name, role: identity.role as any },
                memories: data.memories,
                count: data.memories.length,
              },
            ];
            setGroups(formatted);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load memories:', err);
    } finally {
      setIsLoadingMemories(false);
    }
  };

  // Fetch Conversations directly from backend
  const fetchConversations = async () => {
    setIsLoadingConversations(true);
    try {
      const headers = getAuthHeaders();
      const param = isOwner ? 'userId=ALL' : `userId=${encodeURIComponent(identity.id)}`;
      const res = await fetch(`/api/conversations?${param}`, { headers, cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        let formatted: GroupedConversation[] = [];
        if (data.groups) {
          formatted = data.groups;
        } else if (data.turns) {
          formatted = [
            {
              user: { id: identity.id, name: identity.name, role: identity.role as any },
              turns: data.turns,
              count: data.turns.length,
            },
          ];
        }
        setConversationGroups(formatted);
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  // Fetch Learned Patterns directly from backend
  const fetchPatterns = async () => {
    setIsLoadingPatterns(true);
    try {
      const headers = getAuthHeaders();
      const param = isOwner ? 'userId=ALL' : `userId=${encodeURIComponent(identity.id)}`;
      const res = await fetch(`/api/patterns?${param}`, { headers, cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        let formatted: GroupedPattern[] = [];
        if (data.groups) {
          formatted = data.groups;
        } else if (data.patterns) {
          formatted = [
            {
              user: { id: identity.id, name: identity.name, role: identity.role as any },
              patterns: data.patterns,
              count: data.patterns.length,
            },
          ];
        }
        setPatternGroups(formatted);
      }
    } catch (err) {
      console.error('Failed to load patterns:', err);
    } finally {
      setIsLoadingPatterns(false);
    }
  };

  // Fetch Operational Briefing (Owner only) directly from backend
  const fetchBriefing = async () => {
    if (!isOwner) return;
    setIsLoadingBriefing(true);
    try {
      const headers = getAuthHeaders();
      const res = await fetch('/api/owner/briefing', { headers, cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.briefing) {
          setBriefingData(data.briefing);
        }
      }
    } catch (err) {
      console.error('Failed to load operational briefing:', err);
    } finally {
      setIsLoadingBriefing(false);
    }
  };

  // Fetch Persona Config directly from backend
  const fetchPersonaConfig = async () => {
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`/api/persona-voice?userId=${encodeURIComponent(identity.id)}`, {
        headers,
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setPersonaConfig(data.config);
        }
      }
    } catch (err) {
      console.error('Failed to load persona config:', err);
    }
  };

  // Fetch Location & Weather with SWR Caching
  const fetchLocationAndWeather = async () => {
    const cachedWeather = globalAppCache.get('weather_data', 60000);
    if (cachedWeather.data) {
      setWeatherData(cachedWeather.data);
    } else {
      setIsLoadingWeather(true);
    }

    try {
      const locRes = await fetch('/api/location-context');
      if (locRes.ok) {
        const locData = await locRes.json();
        if (locData.currentTimeIST) {
          setIstTime(locData.currentTimeIST);
        }
      }

      const weatherRes = await fetch('/api/weather');
      if (weatherRes.ok) {
        const wData = await weatherRes.json();
        globalAppCache.set('weather_data', wData);
        setWeatherData(wData);
      }
    } catch (err) {
      console.error('Failed to load weather/location:', err);
    } finally {
      setIsLoadingWeather(false);
    }
  };

  // Fetch Backup Metadata with SWR Caching
  const fetchBackupInfo = async () => {
    if (!isOwner) return;
    const cached = globalAppCache.get('backup_info', 30000);
    if (cached.data) {
      setBackupInfo(cached.data);
      if (!cached.isStale) return;
    }

    try {
      const headers = getAuthHeaders();
      const res = await fetch(`/api/backup/info?userId=${encodeURIComponent(identity.id)}`, {
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.info) {
          globalAppCache.set('backup_info', data.info);
          setBackupInfo(data.info);
        }
      }
    } catch (err) {
      console.error('Failed to load backup info:', err);
    }
  };

  const fetchTasks = async () => {
    setIsLoadingTasks(true);
    try {
      const headers = getAuthHeaders();
      let url = '/api/tasks';
      if (isOwner && selectedUserId !== 'ALL') url += `?userId=${encodeURIComponent(selectedUserId)}`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
        setOpenLoops(data.openLoops || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingTasks(false);
    }
  };

  const fetchOpenLoops = async () => {
    try {
      const headers = getAuthHeaders();
      let url = '/api/open-loops';
      if (isOwner && selectedUserId !== 'ALL') url += `?userId=${encodeURIComponent(selectedUserId)}`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        setOpenLoops(data.openLoops || []);
      }
    } catch (err) {
      console.error('Failed to load open loops:', err);
    }
  };

  const handleAddOpenLoop = async (e: FormEvent) => {
    e.preventDefault();
    if (!newLoopTopic.trim()) return;
    setIsAddingLoop(true);
    try {
      const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
      const targetId = isOwner && targetUserForAdd ? targetUserForAdd : identity.id;
      const res = await fetch('/api/open-loops', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: newLoopTopic.trim(), description: newLoopDesc.trim(), userId: targetId })
      });
      if (res.ok) {
        setNewLoopTopic('');
        setNewLoopDesc('');
        fetchOpenLoops();
        fetchTasks();
        fetchBriefing();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsAddingLoop(false);
    }
  };

  const handleResolveOpenLoop = async (loopId: string) => {
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`/api/open-loops/${loopId}/resolve`, { method: 'PUT', headers });
      if (res.ok) {
        fetchOpenLoops();
        fetchTasks();
        fetchBriefing();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleReopenOpenLoop = async (loopId: string) => {
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`/api/open-loops/${loopId}/reopen`, { method: 'PUT', headers });
      if (res.ok) {
        fetchOpenLoops();
        fetchTasks();
        fetchBriefing();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteOpenLoop = async (loopId: string) => {
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`/api/open-loops/${loopId}`, { method: 'DELETE', headers });
      if (res.ok) {
        fetchOpenLoops();
        fetchTasks();
        fetchBriefing();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    setIsAddingTask(true);
    try {
      const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
      const targetId = isOwner && targetUserForAdd ? targetUserForAdd : identity.id;
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: newTaskTitle, description: newTaskDesc, userId: targetId })
      });
      if (res.ok) {
        setNewTaskTitle('');
        setNewTaskDesc('');
        fetchTasks();
        fetchBriefing();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsAddingTask(false);
    }
  };

  const handleUpdateTaskStatus = async (taskId: string, status: string) => {
    try {
      const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ status })
      });
      if (res.ok) fetchTasks();
    } catch (err) {}
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE', headers });
      if (res.ok) fetchTasks();
    } catch (err) {}
  };

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    globalAppCache.invalidate();
    try {
      await Promise.all([
        fetchMemories(),
        fetchTasks(),
        fetchConversations(),
        fetchPatterns(),
        fetchPersonaConfig(),
        isOwner ? fetchBriefing() : Promise.resolve(),
      ]);
    } catch (err) {}
    setIsRefreshing(false);
  };

  useEffect(() => {
    if (isOpen) {
      fetchMemories();
      fetchTasks();
      fetchConversations();
      fetchPatterns();
      fetchPersonaConfig();
      if (isOwner) {
        fetchBackupInfo();
        fetchBriefing();
      }
      fetchLocationAndWeather();
    }
  }, [isOpen, identity.id, token, isOwner]);

  useEffect(() => {
    if (isOpen && activeTab === 'persona') {
      fetchPersonaConfig();
    }
  }, [isOpen, activeTab, identity.id]);

  useEffect(() => {
    if (isOpen) {
      fetchTasks();
    }
  }, [selectedUserId]);

  // Handle Memory Addition with Optimistic UI
  const handleAddMemory = async (e: FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;

    const contentToAdd = newContent.trim();
    const categoryToAdd = newCategory;
    const targetId = isOwner && targetUserForAdd ? targetUserForAdd : identity.id;

    // Optimistic UI insertion
    const tempId = `temp_${Date.now()}`;
    const optimisticMemory: MemoryItem = {
      memoryId: tempId,
      ownerId: targetId,
      content: contentToAdd,
      category: categoryToAdd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setGroups((prev) => {
      const existingGroup = prev.find((g) => g.user.id === targetId);
      if (existingGroup) {
        return prev.map((g) =>
          g.user.id === targetId
            ? { ...g, memories: [optimisticMemory, ...g.memories], count: g.count + 1 }
            : g
        );
      } else {
        return [
          ...prev,
          {
            user: { id: targetId, name: targetId === identity.id ? identity.name : targetId, role: 'user' },
            memories: [optimisticMemory],
            count: 1,
          },
        ];
      }
    });

    setNewContent('');
    setIsAddingMemory(true);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      };

      const res = await fetch('/api/memories', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: targetId,
          content: contentToAdd,
          category: categoryToAdd,
        }),
      });

      if (res.ok) {
        globalAppCache.delete(`memories_${isOwner ? 'owner_all' : identity.id}`);
        fetchMemories();
      }
    } catch (err) {
      console.error(err);
      fetchMemories(); // Rollback on error
    } finally {
      setIsAddingMemory(false);
    }
  };

  // Handle Memory Deletion with Optimistic UI
  const handleDeleteMemory = async (userId: string, memoryId: string) => {
    // Optimistic removal
    setGroups((prev) =>
      prev.map((g) =>
        g.user.id === userId
          ? {
              ...g,
              memories: g.memories.filter((m) => m.memoryId !== memoryId),
              count: Math.max(0, g.count - 1),
            }
          : g
      )
    );

    try {
      const headers = getAuthHeaders();
      await fetch(`/api/memories/${encodeURIComponent(memoryId)}?userId=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers,
      });
      globalAppCache.delete(`memories_${isOwner ? 'owner_all' : identity.id}`);
    } catch (err) {
      console.error(err);
      fetchMemories(); // Rollback on error
    }
  };

  // Handle Clear Conversation History
  const handleClearHistory = async (userId: string) => {
    try {
      const headers = getAuthHeaders();

      const res = await fetch(`/api/conversations?userId=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to clear history (${res.status})`);
      }

      fetchConversations();
      window.dispatchEvent(new CustomEvent('conversations_changed', { detail: { userId } }));
    } catch (err: any) {
      console.error('Failed to clear history:', err);
      alert(`Error clearing conversation history: ${err?.message || err}`);
    }
  };

  // Handle Persona Save
  const handleSavePersona = async (e: FormEvent) => {
    e.preventDefault();
    if (!isOwner) return;

    setIsSavingPersona(true);
    setPersonaSaveSuccess(false);
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      };
      const res = await fetch(`/api/persona-voice?userId=${encodeURIComponent(identity.id)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(personaConfig),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setPersonaConfig(data.config);
        }
        setPersonaSaveSuccess(true);
        setTimeout(() => setPersonaSaveSuccess(false), 4000);
      }
    } catch (err) {
      console.error('Failed to save persona:', err);
    } finally {
      setIsSavingPersona(false);
    }
  };

  // Export Backup File Download
  const handleExportBackup = async () => {
    if (!isOwner) return;
    setIsExportingBackup(true);
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`/api/backup/export?userId=${encodeURIComponent(identity.id)}`, {
        headers,
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Backup export failed');
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `madhurita_system_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      fetchBackupInfo();
    } catch (err: any) {
      console.error('Export error:', err);
    } finally {
      setIsExportingBackup(false);
    }
  };

  // Handle File Upload for Restore
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setImportFileContent(content);
    };
    reader.readAsText(file);
  };

  // Transactionally Restore Database from Payload
  const handleRestoreBackup = async () => {
    if (!isOwner || !importFileContent.trim()) return;

    setIsRestoringBackup(true);
    setRestoreStatus(null);

    try {
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(importFileContent);
      } catch (e) {
        setRestoreStatus({
          success: false,
          error: 'INVALID_JSON: The uploaded file is not a valid JSON document.',
        });
        setIsRestoringBackup(false);
        return;
      }

      const headers = {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      };

      const res = await fetch(`/api/backup/import?userId=${encodeURIComponent(identity.id)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsedPayload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setRestoreStatus({
          success: false,
          error: data.error || 'Restore failed',
        });
      } else {
        setRestoreStatus({
          success: true,
          message: data.message || 'Database restored successfully!',
        });
        setImportFileContent('');
        setImportFileName('');
        fetchMemories();
        fetchConversations();
        fetchPatterns();
        fetchBackupInfo();
        fetchPersonaConfig();
        fetchLocationAndWeather();
        if (onRestored) {
          onRestored();
        }
      }
    } catch (err: any) {
      setRestoreStatus({
        success: false,
        error: err.message || 'Network error during restore',
      });
    } finally {
      setIsRestoringBackup(false);
    }
  };

  if (!isOpen) return null;

  // Format relative time helper
  const formatTimeAgo = (isoString?: string) => {
    if (!isoString) return 'Just now';
    try {
      const diffMs = Date.now() - new Date(isoString).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return 'Recently';
    }
  };

  const filteredGroups = useMemo(() => {
    const base = selectedUserId === 'ALL' ? groups : groups.filter((g) => g.user.id === selectedUserId);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base
      .map((g) => ({
        ...g,
        memories: g.memories.filter(
          (m) =>
            m.content.toLowerCase().includes(q) ||
            m.category.toLowerCase().includes(q) ||
            g.user.name.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.memories.length > 0);
  }, [groups, selectedUserId, searchQuery]);

  const filteredConversations = useMemo(() => {
    const base = selectedUserId === 'ALL' ? conversationGroups : conversationGroups.filter((g) => g.user.id === selectedUserId);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base
      .map((g) => ({
        ...g,
        turns: g.turns.filter(
          (t) =>
            t.content.toLowerCase().includes(q) ||
            t.role.toLowerCase().includes(q) ||
            g.user.name.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.turns.length > 0);
  }, [conversationGroups, selectedUserId, searchQuery]);

  const filteredPatterns = useMemo(() => {
    const base = selectedUserId === 'ALL' ? patternGroups : patternGroups.filter((g) => g.user.id === selectedUserId);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base
      .map((g) => ({
        ...g,
        patterns: g.patterns.filter(
          (p) =>
            p.pattern.toLowerCase().includes(q) ||
            p.category.toLowerCase().includes(q) ||
            g.user.name.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.patterns.length > 0);
  }, [patternGroups, selectedUserId, searchQuery]);

  return (
    <div
      id="memory-viewer-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#030712]/80 backdrop-blur-xl"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl bg-[#030712]/95 border border-white/15 rounded-3xl p-5 sm:p-7 shadow-[0_0_60px_rgba(236,72,153,0.15)] text-white relative max-h-[88vh] flex flex-col"
      >
        <div className="absolute top-5 right-5 flex items-center gap-1.5 z-10">
          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            title="Refresh from db.json"
            className="p-1.5 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-all cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-pink-400' : ''}`} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 mb-4 shrink-0">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-pink-500 via-purple-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-pink-500/20 shrink-0">
            {mode === 'tasks' ? <CheckSquare className="w-5 h-5 text-white" /> :
             mode === 'voice' ? <Sliders className="w-5 h-5 text-white" /> :
             mode === 'iot' ? <MapPin className="w-5 h-5 text-white" /> :
             <Database className="w-5 h-5 text-white" />}
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-white">
              {mode === 'tasks' ? 'Tasks & Open Loops' :
               mode === 'voice' ? 'Persona & Voice Profile' :
               mode === 'iot' ? 'Home Context & Telemetry' :
               isOwner ? 'Owner System & Memory Control' : 'Cognitive Memory & Context Engine'}
            </h3>
            <p className="text-xs text-white/50">
              Active Context: <strong className="text-pink-300 font-medium">{identity.name} ({identity.id})</strong>
            </p>
          </div>
        </div>

        {/* Tabs Bar */}
        {mode === 'database' && (
          <div className="flex items-center gap-1 p-1 rounded-2xl bg-white/5 border border-white/10 mb-3 text-xs font-medium shrink-0 overflow-x-auto">
            <button
              id="tab-memories"
              onClick={() => setActiveTab('memories')}
              className={`py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === 'memories'
                  ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-md shadow-pink-500/20'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <Database className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">Memories</span>
            </button>
          <button
            id="tab-conversations"
            onClick={() => setActiveTab('conversations')}
            className={`py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'conversations'
                ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-md shadow-pink-500/20'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
          >
            <History className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">Conversations</span>
          </button>

          <button
            id="tab-patterns"
            onClick={() => setActiveTab('patterns')}
            className={`py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'patterns'
                ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-md shadow-pink-500/20'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
          >
            <BrainCircuit className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">Learned Patterns</span>
          </button>

          {isOwner && (
            <button
              id="tab-briefing"
              onClick={() => setActiveTab('briefing')}
              className={`py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === 'briefing'
                  ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-md shadow-pink-500/20'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0 text-amber-300" />
              <span className="whitespace-nowrap">Operational Briefing</span>
            </button>
          )}

          {isOwner && (
            <button
              id="tab-backup"
              onClick={() => setActiveTab('backup')}
              className={`py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === 'backup'
                  ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-md shadow-pink-500/20'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <HardDrive className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">Backup & Restore</span>
            </button>
          )}
        </div>
        )}

        {/* Global Real-Time Search Bar (for memories, conversations, patterns) */}
        {(activeTab === 'memories' || activeTab === 'conversations' || activeTab === 'patterns') && (
          <div className="relative mb-3 shrink-0">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Instant search in ${activeTab}...`}
              className="w-full pl-8 pr-8 py-1.5 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 text-xs focus:outline-none focus:border-pink-500/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white text-xs"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}

        {/* Tab 1: Grouped Memories Management */}
        {activeTab === 'memories' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Filter by User (Owner Only) */}
            {isOwner && groups.length > 1 && (
              <div className="flex items-center gap-2 mb-3 py-1 px-0.5 overflow-x-auto text-xs shrink-0">
                <span className="text-white/50 text-[11px] uppercase tracking-wider shrink-0 font-medium">Filter:</span>
                <button
                  onClick={() => setSelectedUserId('ALL')}
                  className={`px-3 py-1 rounded-full text-xs transition-all cursor-pointer shrink-0 ${
                    selectedUserId === 'ALL'
                      ? 'bg-pink-500/20 border border-pink-500/50 text-pink-200'
                      : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                  }`}
                >
                  All Profiles ({groups.reduce((acc, g) => acc + g.count, 0)})
                </button>
                {groups.map((g, gIdx) => (
                  <button
                    key={`mem-filter-${g.user.id}-${gIdx}`}
                    onClick={() => setSelectedUserId(g.user.id)}
                    className={`px-3 py-1 rounded-full text-xs transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
                      selectedUserId === g.user.id
                        ? 'bg-purple-500/20 border border-purple-500/50 text-purple-200'
                        : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    {g.user.role === 'owner' ? <Crown className="w-2.5 h-2.5 text-amber-400" /> : <User className="w-2.5 h-2.5 text-blue-400" />}
                    <span>{g.user.name} ({g.count})</span>
                  </button>
                ))}
              </div>
            )}

            {/* Memories List */}
            <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-1">
              {isLoadingMemories ? (
                <div className="text-center py-10 text-xs text-white/50">Loading memories from persistent storage...</div>
              ) : filteredGroups.length === 0 || filteredGroups.every((g) => g.memories.length === 0) ? (
                <div className="text-center py-10 px-4 rounded-2xl border border-dashed border-white/10 bg-white/5">
                  <p className="text-xs text-white/80 mb-1">No memories stored for this profile yet.</p>
                  <p className="text-[11px] text-white/40">
                    Madhurita learns and saves memories continuously as you speak, or you can add one manually below.
                  </p>
                </div>
              ) : (
                filteredGroups.map((group, groupIdx) => (
                  <div key={`mem-group-${group.user.id}-${groupIdx}`} className="space-y-2">
                    <div className="flex items-center justify-between px-1 text-xs text-white/70">
                      <div className="flex items-center gap-1.5 font-medium">
                        {group.user.role === 'owner' ? (
                          <span className="flex items-center gap-1 text-amber-300">
                            <Crown className="w-3 h-3" />
                            {group.user.name} (Owner)
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-blue-300">
                            <User className="w-3 h-3" />
                            {group.user.name} (User)
                          </span>
                        )}
                        <span className="text-[11px] text-white/40">ID: {group.user.id}</span>
                      </div>
                      <span className="text-[11px] text-white/40">{group.memories.length} records</span>
                    </div>

                    <div className="space-y-2">
                      {group.memories.map((mem, memIdx) => (
                        <div
                          key={`mem-card-${group.user.id}-${mem.memoryId || memIdx}`}
                          className="p-3 rounded-2xl bg-white/5 border border-white/10 flex items-start justify-between gap-3 group hover:border-pink-500/30 transition-colors"
                        >
                          <div className="space-y-1">
                            <p className="text-xs text-white/90 leading-relaxed font-normal">{mem.content}</p>
                            <div className="flex items-center gap-2 text-[10px] text-white/40">
                              <span className="px-1.5 py-0.5 rounded bg-white/10 text-pink-300 capitalize">
                                {mem.category}
                              </span>
                              <span>{formatTimeAgo(mem.updatedAt || mem.createdAt)}</span>
                            </div>
                          </div>
                          {(isOwner || identity.id === group.user.id) && (
                            <button
                              onClick={() => handleDeleteMemory(group.user.id, mem.memoryId)}
                              className="p-1.5 rounded-lg text-white/30 hover:text-rose-400 hover:bg-rose-500/10 transition-all opacity-80 group-hover:opacity-100 cursor-pointer"
                              title="Delete Memory"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Add Memory Form */}
            <form onSubmit={handleAddMemory} className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2 shrink-0">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Add memory manually (e.g. Loves filter coffee, Project deadline Friday)..."
                  className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-pink-500/50"
                />
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as any)}
                  className="px-2 py-2 rounded-xl bg-[#0b1120] border border-white/10 text-xs text-white/80 focus:outline-none focus:border-pink-500/50"
                >
                  <option value="fact">Fact</option>
                  <option value="preference">Preference</option>
                  <option value="project">Project</option>
                  <option value="goal">Goal</option>
                  <option value="personal">Personal</option>
                </select>
                <button
                  type="submit"
                  disabled={isAddingMemory || !newContent.trim()}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 text-xs font-medium text-white disabled:opacity-50 hover:shadow-lg hover:shadow-pink-500/20 transition-all flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Save</span>
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Tab: Tasks & Open Loops */}
        {activeTab === 'tasks' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden space-y-3">
            {/* Sub-tab Navigation */}
            <div className="flex items-center justify-between gap-2 shrink-0 border-b border-white/10 pb-2">
              <div className="flex items-center gap-1.5 p-0.5 rounded-xl bg-white/5 border border-white/10">
                <button
                  type="button"
                  onClick={() => setTaskSubTab('tasks')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                    taskSubTab === 'tasks'
                      ? 'bg-amber-500/20 text-amber-300 shadow-sm border border-amber-500/40'
                      : 'text-white/60 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  <span>Tasks & Commitments ({tasks.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTaskSubTab('open_loops');
                    fetchOpenLoops();
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                    taskSubTab === 'open_loops'
                      ? 'bg-cyan-500/20 text-cyan-300 shadow-sm border border-cyan-500/40'
                      : 'text-white/60 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <BrainCircuit className="w-3.5 h-3.5" />
                  <span>Open Loops & Situations ({openLoops.length})</span>
                </button>
              </div>

              {/* User filter for Owner */}
              {isOwner && groups.length > 1 && (
                <div className="flex items-center gap-1.5 overflow-x-auto text-xs shrink-0 max-w-[40%]">
                  <button
                    onClick={() => setSelectedUserId('ALL')}
                    className={`px-2.5 py-1 rounded-full text-[11px] transition-all cursor-pointer shrink-0 ${
                      selectedUserId === 'ALL'
                        ? 'bg-pink-500/20 border border-pink-500/50 text-pink-200'
                        : 'bg-white/5 border border-white/10 text-white/50 hover:bg-white/10'
                    }`}
                  >
                    All Users
                  </button>
                  {groups.map((g, gIdx) => (
                    <button
                      key={`task-filter-${g.user.id}-${gIdx}`}
                      onClick={() => setSelectedUserId(g.user.id)}
                      className={`px-2.5 py-1 rounded-full text-[11px] transition-all cursor-pointer flex items-center gap-1 shrink-0 ${
                        selectedUserId === g.user.id
                          ? 'bg-purple-500/20 border border-purple-500/50 text-purple-200'
                          : 'bg-white/5 border border-white/10 text-white/50 hover:bg-white/10'
                      }`}
                    >
                      <span>{g.user.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* View 1: Tasks */}
            {taskSubTab === 'tasks' && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Task Filter Pills */}
                <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
                  <div className="flex items-center gap-1 text-[11px]">
                    {(['all', 'pending', 'in_progress', 'completed'] as const).map((st) => (
                      <button
                        key={`task-st-${st}`}
                        onClick={() => setTaskStatusFilter(st)}
                        className={`px-2.5 py-0.5 rounded-full capitalize transition-all cursor-pointer ${
                          taskStatusFilter === st
                            ? 'bg-white/15 text-white font-medium border border-white/20'
                            : 'text-white/40 hover:text-white/70'
                        }`}
                      >
                        {st.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-white/40">
                    {tasks.filter((t) => (taskStatusFilter === 'all' ? true : t.status === taskStatusFilter)).length} items
                  </span>
                </div>

                {/* Tasks List */}
                <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                  {isLoadingTasks ? (
                    <div className="p-8 text-center text-xs text-white/40 flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
                      Loading tasks...
                    </div>
                  ) : tasks.length === 0 ? (
                    <div className="p-8 text-center text-xs text-white/40 italic bg-white/5 rounded-2xl border border-white/5">
                      No tasks or commitments recorded yet.
                    </div>
                  ) : (
                    tasks
                      .filter((t) => (taskStatusFilter === 'all' ? true : t.status === taskStatusFilter))
                      .map((t, tIdx) => {
                        const isDone = t.status === 'completed';
                        return (
                          <div
                            key={`task-${t.id || tIdx}`}
                            className={`p-3 rounded-2xl border transition-all ${
                              isDone
                                ? 'bg-white/[0.02] border-white/5 opacity-60'
                                : 'bg-white/5 border-white/10 hover:border-amber-500/30'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5 flex-1 min-w-0">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateTaskStatus(t.id, isDone ? 'in_progress' : 'completed')
                                  }
                                  className={`mt-0.5 w-5 h-5 rounded-lg border flex items-center justify-center transition-all cursor-pointer shrink-0 ${
                                    isDone
                                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                                      : 'border-white/20 hover:border-amber-400 text-transparent hover:text-amber-400/50'
                                  }`}
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span
                                      className={`text-sm font-medium ${
                                        isDone ? 'line-through text-white/50' : 'text-white'
                                      }`}
                                    >
                                      {t.title}
                                    </span>
                                    <span
                                      className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ${
                                        isDone
                                          ? 'bg-emerald-500/20 text-emerald-300'
                                          : t.status === 'in_progress'
                                          ? 'bg-amber-500/20 text-amber-300'
                                          : 'bg-blue-500/20 text-blue-300'
                                      }`}
                                    >
                                      {t.status.replace('_', ' ')}
                                    </span>
                                    {t.identityId && t.identityId !== 'UNKNOWN' && (
                                      <span className="text-[10px] text-white/40 bg-white/5 px-1.5 py-0.5 rounded">
                                        For: {t.identityId === 'OWNER_001' ? 'Owner' : t.identityId}
                                      </span>
                                    )}
                                  </div>
                                  {t.description && (
                                    <p className="text-xs text-white/60 mt-1 leading-relaxed">{t.description}</p>
                                  )}
                                  {t.updatedAt && (
                                    <div className="text-[10px] text-white/30 mt-1 flex items-center gap-1">
                                      <Clock className="w-2.5 h-2.5" />
                                      {new Date(t.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                                    </div>
                                  )}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeleteTask(t.id)}
                                className="p-1.5 rounded-lg text-white/30 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
                                title="Delete task"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>

                {/* Add Task Form */}
                <form
                  onSubmit={handleAddTask}
                  className="mt-3 p-3 bg-[#080d16] border border-white/10 rounded-2xl shrink-0 shadow-lg"
                >
                  <div className="text-[11px] font-medium text-white/60 mb-2 uppercase tracking-wide flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Plus className="w-3.5 h-3.5 text-amber-400" />
                      Add New Commitment / Task
                    </span>
                    {isOwner && groups.length > 0 && (
                      <select
                        value={targetUserForAdd}
                        onChange={(e) => setTargetUserForAdd(e.target.value)}
                        className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] text-white/80 focus:outline-none"
                      >
                        <option value={identity.id}>Assign to: Current User ({identity.name})</option>
                        {groups.map((g) => (
                          <option key={`assign-t-${g.user.id}`} value={g.user.id}>
                            Assign to: {g.user.name} ({g.user.id})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      placeholder="Task or commitment title..."
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-amber-500/50"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="Optional details, deadline or context..."
                        value={newTaskDesc}
                        onChange={(e) => setNewTaskDesc(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-amber-500/50"
                      />
                      <button
                        type="submit"
                        disabled={isAddingTask || !newTaskTitle.trim()}
                        className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black text-xs font-semibold transition-all disabled:opacity-50 flex items-center justify-center min-w-[75px] cursor-pointer shadow-md shadow-amber-500/20"
                      >
                        {isAddingTask ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : 'Add Task'}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            )}

            {/* View 2: Open Loops */}
            {taskSubTab === 'open_loops' && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Header Explainer & Filter */}
                <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
                  <div className="flex items-center gap-1 text-[11px]">
                    {(['all', 'open', 'resolved'] as const).map((st) => (
                      <button
                        key={`loop-st-${st}`}
                        onClick={() => setOpenLoopFilter(st)}
                        className={`px-2.5 py-0.5 rounded-full capitalize transition-all cursor-pointer ${
                          openLoopFilter === st
                            ? 'bg-cyan-500/20 text-cyan-300 font-medium border border-cyan-500/40'
                            : 'text-white/40 hover:text-white/70'
                        }`}
                      >
                        {st === 'all' ? 'All Loops' : st === 'open' ? 'Active / Open' : 'Resolved'}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-white/40">
                    {openLoops.filter((l) => (openLoopFilter === 'all' ? true : l.status === openLoopFilter)).length} loops
                  </span>
                </div>

                {/* Open Loops List */}
                <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                  {openLoops.length === 0 ? (
                    <div className="p-8 text-center text-xs text-white/40 italic bg-white/5 rounded-2xl border border-white/5">
                      No open loops or unresolved situations tracked.
                    </div>
                  ) : (
                    openLoops
                      .filter((l) => (openLoopFilter === 'all' ? true : l.status === openLoopFilter))
                      .map((l, lIdx) => {
                        const isResolved = l.status === 'resolved';
                        const topic = l.name || l.topic || 'Unresolved Situation';
                        return (
                          <div
                            key={`loop-${l.id || l.loopId || lIdx}`}
                            className={`p-3.5 rounded-2xl border transition-all ${
                              isResolved
                                ? 'bg-white/[0.02] border-white/5 opacity-65'
                                : 'bg-cyan-950/15 border-cyan-500/20 hover:border-cyan-500/40'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3 mb-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span
                                  className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                                    isResolved
                                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                                      : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                                  }`}
                                >
                                  {isResolved ? (
                                    <>
                                      <CheckCircle2 className="w-2.5 h-2.5" /> Resolved
                                    </>
                                  ) : (
                                    <>
                                      <BrainCircuit className="w-2.5 h-2.5" /> Active Open Loop
                                    </>
                                  )}
                                </span>
                                <span className="text-[10px] text-white/60 bg-white/5 px-2 py-0.5 rounded-full border border-white/5 flex items-center gap-1">
                                  <User className="w-2.5 h-2.5" />
                                  {l.personName || (l.identityId === 'OWNER_001' ? 'Owner' : l.identityId)}
                                </span>
                              </div>

                              {/* Actions */}
                              <div className="flex items-center gap-1.5">
                                {!isResolved ? (
                                  <button
                                    type="button"
                                    onClick={() => handleResolveOpenLoop(l.id)}
                                    className="px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-[10px] font-medium border border-emerald-500/30 transition-all flex items-center gap-1 cursor-pointer"
                                    title="Mark loop as resolved"
                                  >
                                    <Check className="w-3 h-3" />
                                    <span>Resolve</span>
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleReopenOpenLoop(l.id)}
                                    className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white text-[10px] font-medium border border-white/10 transition-all flex items-center gap-1 cursor-pointer"
                                    title="Reopen loop"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                    <span>Reopen</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleDeleteOpenLoop(l.id)}
                                  className="p-1 rounded-lg text-white/30 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                                  title="Delete open loop"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            <div className="text-sm font-semibold text-white mb-1">{topic}</div>
                            {l.description && (
                              <p className="text-xs text-white/70 leading-relaxed bg-black/20 p-2 rounded-xl border border-white/5">
                                {l.description}
                              </p>
                            )}

                            <div className="flex items-center gap-3 text-[10px] text-white/40 mt-2">
                              {l.createdAtIST && (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-2.5 h-2.5" />
                                  Opened: {l.createdAtIST}
                                </span>
                              )}
                              {l.resolvedAtIST && (
                                <span className="flex items-center gap-1 text-emerald-400/70">
                                  <CheckCircle2 className="w-2.5 h-2.5" />
                                  Resolved: {l.resolvedAtIST}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>

                {/* Add Open Loop Form */}
                <form
                  onSubmit={handleAddOpenLoop}
                  className="mt-3 p-3 bg-[#080d16] border border-white/10 rounded-2xl shrink-0 shadow-lg"
                >
                  <div className="text-[11px] font-medium text-white/60 mb-2 uppercase tracking-wide flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <BrainCircuit className="w-3.5 h-3.5 text-cyan-400" />
                      Register New Open Loop / Situation
                    </span>
                    {isOwner && groups.length > 0 && (
                      <select
                        value={targetUserForAdd}
                        onChange={(e) => setTargetUserForAdd(e.target.value)}
                        className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] text-white/80 focus:outline-none"
                      >
                        <option value={identity.id}>Target: Current User ({identity.name})</option>
                        {groups.map((g) => (
                          <option key={`assign-l-${g.user.id}`} value={g.user.id}>
                            Target: {g.user.name} ({g.user.id})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      placeholder="Topic or unresolved situation (e.g. Deployment error follow-up)..."
                      value={newLoopTopic}
                      onChange={(e) => setNewLoopTopic(e.target.value)}
                      className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-500/50"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="Context notes, promises made, or expectations..."
                        value={newLoopDesc}
                        onChange={(e) => setNewLoopDesc(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-500/50"
                      />
                      <button
                        type="submit"
                        disabled={isAddingLoop || !newLoopTopic.trim()}
                        className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-xs font-semibold transition-all disabled:opacity-50 flex items-center justify-center min-w-[90px] cursor-pointer shadow-md shadow-cyan-500/20"
                      >
                        {isAddingLoop ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : 'Open Loop'}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Grouped Conversations Log */}
        {activeTab === 'conversations' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {isOwner && conversationGroups.length > 1 && (
              <div className="flex items-center gap-2 mb-3 py-1 px-0.5 overflow-x-auto text-xs shrink-0">
                <span className="text-white/50 text-[11px] uppercase tracking-wider shrink-0 font-medium">Filter:</span>
                <button
                  onClick={() => setSelectedUserId('ALL')}
                  className={`px-3 py-1 rounded-full text-xs transition-all cursor-pointer shrink-0 ${
                    selectedUserId === 'ALL'
                      ? 'bg-pink-500/20 border border-pink-500/50 text-pink-200'
                      : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                  }`}
                >
                  All Profiles
                </button>
                {conversationGroups.map((g, gIdx) => (
                  <button
                    key={`conv-filter-${g.user.id}-${gIdx}`}
                    onClick={() => setSelectedUserId(g.user.id)}
                    className={`px-3 py-1 rounded-full text-xs transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
                      selectedUserId === g.user.id
                        ? 'bg-purple-500/20 border border-purple-500/50 text-purple-200'
                        : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    <span>{g.user.name} ({g.count})</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-4 mb-3 pr-1">
              {isLoadingConversations ? (
                <div className="text-center py-10 text-xs text-white/50">Loading conversation history...</div>
              ) : filteredConversations.length === 0 || filteredConversations.every((g) => g.turns.length === 0) ? (
                <div className="text-center py-10 px-4 rounded-2xl border border-dashed border-white/10 bg-white/5">
                  <p className="text-xs text-white/80 mb-1">No conversation history logged yet.</p>
                  <p className="text-[11px] text-white/40">
                    Interact with Madhurita using voice or text, and turns will be logged here permanently.
                  </p>
                </div>
              ) : (
                filteredConversations.map((group, groupIdx) => (
                  <div key={`conv-group-${group.user.id}-${groupIdx}`} className="space-y-2">
                    <div className="flex items-center justify-between px-1 text-xs text-white/70">
                      <div className="flex items-center gap-1.5 font-medium">
                        <span className="text-pink-300">{group.user.name}</span>
                        <span className="text-[11px] text-white/40">({group.user.id})</span>
                      </div>
                      <button
                        onClick={() => handleClearHistory(group.user.id)}
                        className="text-[11px] text-rose-400 hover:underline cursor-pointer"
                      >
                        Clear History
                      </button>
                    </div>

                    <div className="space-y-4">
                      {Array.from(
                        group.turns.reduce((acc, t) => {
                          if (!acc.has(t.sessionId || 'unknown')) acc.set(t.sessionId || 'unknown', []);
                          acc.get(t.sessionId || 'unknown')!.push(t);
                          return acc;
                        }, new Map<string, any[]>())
                      ).map(([sessionId, sessionTurns], sIdx) => (
                        <div key={`session-box-${group.user.id}-${sessionId}-${sIdx}`} className="p-3 bg-white/5 border border-white/10 rounded-xl space-y-2 relative">
                          <div className="flex items-center justify-between text-[11px] text-white/50 mb-2 border-b border-white/10 pb-2">
                            <span>Session: {sessionId}</span>
                            <button
                              onClick={async () => {
                                if (confirm('Delete this session?')) {
                                  try {
                                    const res = await fetch(`/api/conversations/${sessionId}?userId=${encodeURIComponent(group.user.id)}`, {
                                      method: 'DELETE',
                                      headers: getAuthHeaders(),
                                    });
                                    if (res.ok) {
                                      fetchConversations();
                                      window.dispatchEvent(new CustomEvent('conversations_changed', { detail: { userId: group.user.id, sessionId } }));
                                    } else {
                                      const errData = await res.json().catch(() => ({}));
                                      alert(`Failed to delete session: ${errData.error || res.statusText}`);
                                    }
                                  } catch (e: any) {
                                    console.error(e);
                                    alert(`Error deleting session: ${e?.message || e}`);
                                  }
                                }
                              }}
                              className="text-rose-400 hover:text-rose-300 transition-colors"
                              title="Delete this entire session"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {sessionTurns.map((t, tIdx) => (
                            <div
                              key={`turn-${t.turnId || `${group.user.id}-${sessionId}-${tIdx}`}`}
                              className={`p-3 rounded-2xl text-xs ${
                                t.role === 'user'
                                  ? 'bg-blue-500/10 border border-blue-500/20 text-blue-100 ml-4'
                                  : 'bg-purple-500/10 border border-purple-500/20 text-purple-100 mr-4'
                              }`}
                            >
                              <div className="flex items-center justify-between text-[10px] text-white/40 mb-1">
                                <span className="font-semibold uppercase tracking-wider text-white/60">
                                  {t.role === 'user' ? group.user.name : 'Madhurita'}
                                </span>
                                <span>{formatTimeAgo(t.timestamp)}</span>
                              </div>
                              <p className="leading-relaxed whitespace-pre-wrap">{t.content}</p>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tab 3: Learned Habits & Routines */}
        {activeTab === 'patterns' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {isOwner && patternGroups.length > 1 && (
              <div className="flex items-center gap-2 mb-3 py-1 px-0.5 overflow-x-auto text-xs shrink-0">
                <span className="text-white/50 text-[11px] uppercase tracking-wider shrink-0 font-medium">Filter:</span>
                <button
                  onClick={() => setSelectedUserId('ALL')}
                  className={`px-3 py-1 rounded-full text-xs transition-all cursor-pointer shrink-0 ${
                    selectedUserId === 'ALL'
                      ? 'bg-pink-500/20 border border-pink-500/50 text-pink-200'
                      : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                  }`}
                >
                  All Profiles
                </button>
                {patternGroups.map((g, gIdx) => (
                  <button
                    key={`pat-filter-${g.user.id}-${gIdx}`}
                    onClick={() => setSelectedUserId(g.user.id)}
                    className={`px-3 py-1 rounded-full text-xs transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
                      selectedUserId === g.user.id
                        ? 'bg-purple-500/20 border border-purple-500/50 text-purple-200'
                        : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    <span>{g.user.name} ({g.count})</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-4 mb-3 pr-1">
              {isLoadingPatterns ? (
                <div className="text-center py-10 text-xs text-white/50">Analyzing learned habits and routines...</div>
              ) : filteredPatterns.length === 0 || filteredPatterns.every((g) => g.patterns.length === 0) ? (
                <div className="text-center py-10 px-4 rounded-2xl border border-dashed border-white/10 bg-white/5">
                  <p className="text-xs text-white/80 mb-1">No habits or recurring patterns learned yet.</p>
                  <p className="text-[11px] text-white/40">
                    As you chat naturally with Madhurita, she learns your preferences, routines, habits, and recurring plans.
                  </p>
                </div>
              ) : (
                filteredPatterns.map((group, groupIdx) => (
                  <div key={`pat-group-${group.user.id}-${groupIdx}`} className="space-y-2">
                    <div className="flex items-center justify-between px-1 text-xs text-white/70">
                      <div className="flex items-center gap-1.5 font-medium">
                        <span className="text-cyan-300">{group.user.name}</span>
                        <span className="text-[11px] text-white/40">({group.patterns.length} patterns)</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {group.patterns.map((pat, patIdx) => (
                        <div
                          key={`pattern-item-${group.user.id}-${pat.id || patIdx}`}
                          className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cyan-500/20 text-cyan-300 uppercase tracking-wider">
                              {pat.category}
                            </span>
                            <span className="text-[10px] text-white/40">
                              {Math.round((pat.confidence || 0.9) * 100)}% conf • {pat.evidenceCount || 1}x observed
                            </span>
                          </div>
                          <p className="text-xs text-white/90 font-medium leading-tight">{pat.description}</p>
                          <div className="text-[10px] text-white/40">
                            Last active: {formatTimeAgo(pat.lastObservedAt || pat.updatedAt || pat.createdAt)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tab: Operational Briefing (Owner only) */}
        {activeTab === 'briefing' && isOwner && (
          <div className="flex-1 flex flex-col min-h-0 overflow-y-auto space-y-4 pr-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span className="font-semibold text-white text-xs sm:text-sm">Owner System & World Awareness Briefing</span>
              </div>
              <button
                onClick={fetchBriefing}
                disabled={isLoadingBriefing}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white cursor-pointer transition-colors"
                title="Refresh Briefing"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingBriefing ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {isLoadingBriefing ? (
              <div className="text-center py-10 text-xs text-white/50">Compiling real-time awareness briefing...</div>
            ) : !briefingData ? (
              <div className="text-center py-8 text-xs text-white/40">Briefing data unavailable.</div>
            ) : (
              <div className="space-y-3 text-xs">
                {/* Summary Banner */}
                <div className="p-3.5 rounded-2xl bg-gradient-to-r from-amber-500/10 via-purple-500/10 to-transparent border border-amber-500/20 text-white/90 leading-relaxed">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-300 mb-1">
                    System Synthesis
                  </div>
                  <p>{briefingData.summary}</p>
                </div>

                {/* Grid of Key Indicators */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 text-center">
                    <span className="text-[10px] text-white/40 block">Registered Users</span>
                    <span className="text-sm font-semibold text-white">{briefingData.totalRegisteredUsers}</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 text-center">
                    <span className="text-[10px] text-white/40 block">Recent Visitors</span>
                    <span className="text-sm font-semibold text-cyan-300">{briefingData.recentVisitors?.length || 0}</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 text-center">
                    <span className="text-[10px] text-white/40 block">Pending Notes</span>
                    <span className="text-sm font-semibold text-pink-300">{briefingData.pendingNotes?.length || 0}</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 text-center">
                    <span className="text-[10px] text-white/40 block">Open Loops / Tasks</span>
                    <span className="text-sm font-semibold text-amber-300">{briefingData.openLoops?.length || 0}</span>
                  </div>
                </div>

                {/* Recent Visitors & Sessions */}
                {briefingData.recentVisitors && briefingData.recentVisitors.length > 0 && (
                  <div className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <span className="text-[11px] font-semibold text-white/80 uppercase tracking-wider block">
                      Recent Visitor Activity
                    </span>
                    <div className="space-y-1.5">
                      {briefingData.recentVisitors.map((v: any, idx: number) => (
                        <div key={`briefing-vis-${v.id || v.name || idx}`} className="flex items-center justify-between p-2 rounded-xl bg-white/5 text-[11px]">
                          <span className="font-medium text-pink-300">{v.name}</span>
                          <span className="text-white/40">Last seen: {v.lastSeenIST || formatTimeAgo(v.lastSeen)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pending Cross-User Notes */}
                {briefingData.pendingNotes && briefingData.pendingNotes.length > 0 && (
                  <div className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <span className="text-[11px] font-semibold text-white/80 uppercase tracking-wider block">
                      Pending Notes & Messages
                    </span>
                    <div className="space-y-1.5">
                      {briefingData.pendingNotes.map((n: any, idx: number) => (
                        <div key={`briefing-note-${n.noteId || n.id || idx}`} className="p-2.5 rounded-xl bg-pink-500/10 border border-pink-500/20 space-y-1">
                          <div className="flex items-center justify-between text-[10px] text-pink-300">
                            <span>From: <strong>{n.senderName}</strong> → To: <strong>{n.targetName || 'Owner'}</strong></span>
                            <span>{formatTimeAgo(n.createdAt)}</span>
                          </div>
                          <p className="text-white/90 text-xs">{n.content}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Open Loops & Commitments */}
                {briefingData.openLoops && briefingData.openLoops.length > 0 && (
                  <div className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <span className="text-[11px] font-semibold text-white/80 uppercase tracking-wider block">
                      Active Open Loops & Tasks
                    </span>
                    <div className="space-y-1.5">
                      {briefingData.openLoops.map((loop: any, idx: number) => (
                        <div key={`briefing-loop-${loop.loopId || loop.id || idx}`} className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-1">
                          <div className="flex items-center justify-between text-[10px] text-amber-300">
                            <span>User ID: {loop.identityId}</span>
                            <span>{loop.status}</span>
                          </div>
                          <p className="text-white/90 text-xs">{loop.topic}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 4: Persona & Voice Config */}
        {activeTab === 'persona' && (
          <form onSubmit={handleSavePersona} className="flex-1 flex flex-col min-h-0 overflow-y-auto space-y-4 pr-1">
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-3">
              <h4 className="text-xs font-semibold text-white/90 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-pink-400" />
                Adaptive Voice & Conversational Parameters
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-white/60 text-[11px] mb-1">Prebuilt Voice</label>
                  <select
                    value={personaConfig.voiceName}
                    onChange={(e) => setPersonaConfig({ ...personaConfig, voiceName: e.target.value as any })}
                    className="w-full px-3 py-2 rounded-xl bg-[#0b1120] border border-white/10 text-white text-xs focus:outline-none focus:border-pink-500/50"
                  >
                    <option value="Callirrhoe">Callirrhoe (Expressive, Clear, Natural)</option>
                    <option value="Aoede">Aoede (Breeze, Bright, Melodic)</option>
                    <option value="Kore">Kore (Warm, Conversational, Soft)</option>
                    <option value="Leda">Leda (Gentle, Calm, Crisp)</option>
                    <option value="Despina">Despina (Smooth, Dynamic, Direct)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-white/60 text-[11px] mb-1">Language Style</label>
                  <select
                    value={personaConfig.preferredLanguage}
                    onChange={(e) => setPersonaConfig({ ...personaConfig, preferredLanguage: e.target.value as any })}
                    className="w-full px-3 py-2 rounded-xl bg-[#0b1120] border border-white/10 text-white text-xs focus:outline-none focus:border-pink-500/50"
                  >
                    <option value="Hinglish">Natural Hinglish (Hindi + English blend)</option>
                    <option value="English">Pure English</option>
                    <option value="Hindi">Pure Hindi</option>
                  </select>
                </div>

                <div>
                  <label className="block text-white/60 text-[11px] mb-1">Speaking Style</label>
                  <select
                    value={personaConfig.speakingStyle}
                    onChange={(e) => setPersonaConfig({ ...personaConfig, speakingStyle: e.target.value as any })}
                    className="w-full px-3 py-2 rounded-xl bg-[#0b1120] border border-white/10 text-white text-xs focus:outline-none focus:border-pink-500/50"
                  >
                    <option value="warm_conversational">Warm & Natural</option>
                    <option value="expressive_witty">Expressive & Witty</option>
                    <option value="calm_thoughtful">Calm & Thoughtful</option>
                    <option value="concise_direct">Concise & Direct</option>
                  </select>
                </div>

                <div>
                  <label className="block text-white/60 text-[11px] mb-1">Response Length</label>
                  <select
                    value={personaConfig.responseLength}
                    onChange={(e) => setPersonaConfig({ ...personaConfig, responseLength: e.target.value as any })}
                    className="w-full px-3 py-2 rounded-xl bg-[#0b1120] border border-white/10 text-white text-xs focus:outline-none focus:border-pink-500/50"
                  >
                    <option value="concise">Concise & Snappy</option>
                    <option value="balanced">Balanced & Engaging</option>
                    <option value="detailed">Detailed & Analytical</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              {personaSaveSuccess ? (
                <span className="text-emerald-400 text-xs flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Preferences updated and persisted!
                </span>
              ) : <div />}

              <button
                type="submit"
                disabled={isSavingPersona}
                className="px-5 py-2.5 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 text-white text-xs font-medium shadow-md shadow-pink-500/25 hover:shadow-lg hover:shadow-pink-500/40 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>{isSavingPersona ? 'Saving...' : 'Save Configuration'}</span>
              </button>
            </div>
          </form>
        )}

        {/* Tab 5: Location Context */}
        {activeTab === 'location' && (
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            <div className="p-4 rounded-2xl bg-gradient-to-br from-white/5 to-white/[0.02] border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-pink-400" />
                  <span className="font-semibold text-white text-xs sm:text-sm">Home Geographic Grounding</span>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/20 text-emerald-300">
                  Live Synced
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-white/5 border border-white/5 space-y-1">
                  <span className="text-white/40 text-[10px] uppercase tracking-wider block">Configured Home Location</span>
                  <span className="text-white font-medium">Orai, Uttar Pradesh, India</span>
                  <span className="text-white/40 text-[10px] block">25.9898° N, 79.4500° E</span>
                </div>

                <div className="p-3 rounded-xl bg-white/5 border border-white/5 space-y-1">
                  <span className="text-white/40 text-[10px] uppercase tracking-wider block">Current Indian Standard Time (IST)</span>
                  <span className="text-pink-300 font-semibold">{istTime || 'Loading IST...'}</span>
                  <span className="text-white/40 text-[10px] block">Timezone: Asia/Kolkata (UTC+05:30)</span>
                </div>
              </div>

              {/* Weather Data */}
              <div className="p-3.5 rounded-xl bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-transparent border border-white/10">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-white/90 flex items-center gap-1.5">
                    <CloudSun className="w-3.5 h-3.5 text-blue-400" />
                    Live Meteorological Data (Open-Meteo)
                  </span>
                  <button
                    onClick={fetchLocationAndWeather}
                    disabled={isLoadingWeather}
                    className="p-1 rounded text-white/40 hover:text-white cursor-pointer"
                    title="Refresh Weather"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingWeather ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {weatherData && weatherData.available ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="p-2 rounded-lg bg-white/5">
                      <span className="text-white/40 text-[10px] block">Condition</span>
                      <span className="text-white font-medium">{weatherData.condition || 'Clear'}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-white/5">
                      <span className="text-white/40 text-[10px] block">Temperature</span>
                      <span className="text-white font-medium">{weatherData.temperature}°C</span>
                    </div>
                    <div className="p-2 rounded-lg bg-white/5">
                      <span className="text-white/40 text-[10px] block">Humidity</span>
                      <span className="text-white font-medium">{weatherData.humidity}%</span>
                    </div>
                    <div className="p-2 rounded-lg bg-white/5">
                      <span className="text-white/40 text-[10px] block">Wind Speed</span>
                      <span className="text-white font-medium">{weatherData.windSpeed} km/h</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-white/40 py-2">Fetching live weather telemetry...</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 6: Backup & Restore */}
        {activeTab === 'backup' && isOwner && (
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {backupInfo && (
              <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-2 rounded-xl bg-white/5">
                  <span className="text-white/40 text-[10px] block">Users</span>
                  <span className="text-white font-semibold">{backupInfo.counts?.users || 0}</span>
                </div>
                <div className="p-2 rounded-xl bg-white/5">
                  <span className="text-white/40 text-[10px] block">Memories</span>
                  <span className="text-white font-semibold">{backupInfo.counts?.memories || 0}</span>
                </div>
                <div className="p-2 rounded-xl bg-white/5">
                  <span className="text-white/40 text-[10px] block">Conversation Turns</span>
                  <span className="text-white font-semibold">{backupInfo.counts?.conversationTurns || 0}</span>
                </div>
              </div>
            )}

            {/* Export Card */}
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-2">
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4 text-indigo-400" />
                <span className="font-semibold text-white text-xs">Export Complete System Backup</span>
              </div>
              <p className="text-[11px] text-white/50">Downloads a SHA-256 verified JSON database backup to your machine.</p>
              <button
                onClick={handleExportBackup}
                disabled={isExportingBackup}
                className="px-4 py-2 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 mt-1"
              >
                <Download className="w-3 h-3" />
                <span>{isExportingBackup ? 'Exporting...' : 'Download Backup (.json)'}</span>
              </button>
            </div>

            {/* Restore Card */}
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-2">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-purple-400" />
                <span className="font-semibold text-white text-xs">Restore Database Backup</span>
              </div>
              <input
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                className="text-xs text-white/70 file:mr-2 file:py-1 file:px-2.5 file:rounded-full file:border-0 file:text-xs file:bg-pink-500/20 file:text-pink-300 cursor-pointer w-full"
              />
              {restoreStatus && (
                <div className={`p-2.5 rounded-xl text-xs ${restoreStatus.success ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                  {restoreStatus.message || restoreStatus.error}
                </div>
              )}
              <button
                onClick={handleRestoreBackup}
                disabled={!importFileContent.trim() || isRestoringBackup}
                className="px-4 py-2 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
              >
                <Upload className="w-3 h-3" />
                <span>{isRestoringBackup ? 'Restoring...' : 'Restore Now'}</span>
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
