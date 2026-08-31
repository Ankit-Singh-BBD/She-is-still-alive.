// ===================================================================
// STATE SYNC SERVICE - Real-time Backend State Mirroring
// ===================================================================
//
// Synchronizes frontend with backend state:
// - Polls awareness snapshot every 5 seconds
// - Fetches emotions and world state every 10 seconds
// - Subscribes to WebSocket for instant updates
// - Deduplicates with 200ms throttle

export interface UIState {
  awareness: any; // Full awareness snapshot
  emotions: {
    engagement: number;
    focus: number;
    confidence: number;
    state: 'active' | 'attentive' | 'calm';
    recentActivity: string[];
  };
  worldState: {
    timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
    istHour: number;
    season: 'summer' | 'monsoon' | 'autumn' | 'winter';
    weather: {
      temperature: number;
      feelsLike: number;
      condition: string;
      description: string;
      humidity: number;
      windSpeed?: number;
      sunrise?: string;
      sunset?: string;
      sunriseIso?: string;
      sunsetIso?: string;
      aqi?: number;
      aqiLabel?: string;
      hourly?: Array<{ time: string; temp: number; condition: string }>;
      locationName?: string;
    } | null;
    expression: {
      mood: 'hot' | 'pleasant' | 'cold' | 'rainy' | 'stormy' | 'misty';
      intensity: number;
      colors: {
        primary: string;
        secondary: string;
        accent: string;
      };
      particleBehavior: 'rising' | 'falling' | 'floating' | 'chaotic' | 'slow';
      breathingSpeed: number;
      description: string;
    };
  };
  lastUpdateAt: string;
}

type StateChangeListener = (state: UIState) => void;

class StateSyncService {
  private state: UIState | null = null;
  private listeners: Set<StateChangeListener> = new Set();
  private pollInterval: NodeJS.Timeout | null = null;
  private emotionsPollInterval: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private throttleTimer: NodeJS.Timeout | null = null;
  private lastUpdateMs = 0;
  private readonly THROTTLE_MS = 200;

  /**
   * Subscribe to state changes.
   */
  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);

    // Immediately emit current state if available
    if (this.state) {
      listener(this.state);
    }

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Start polling and WebSocket subscription.
   */
  start(authToken?: string, userId?: string): void {
    if (this.pollInterval) return; // Already running

    console.log('[STATE-SYNC] Starting state sync...');

    // Poll awareness snapshot every 5 seconds
    this.pollInterval = setInterval(() => {
      this.fetchAwareness(authToken, userId).catch(err =>
        console.warn('[STATE-SYNC] Awareness fetch failed:', err.message)
      );
    }, 5000);

    // Poll emotions + world state every 10 seconds
    this.emotionsPollInterval = setInterval(() => {
      this.fetchEmotionsAndWorld(authToken).catch(err =>
        console.warn('[STATE-SYNC] Emotions/world fetch failed:', err.message)
      );
    }, 10000);

    // Initial fetch
    this.fetchAwareness(authToken, userId);
    this.fetchEmotionsAndWorld(authToken);

    // Connect WebSocket for real-time updates
    this.connectWebSocket();
  }

  /**
   * Stop polling and disconnect WebSocket.
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.emotionsPollInterval) {
      clearInterval(this.emotionsPollInterval);
      this.emotionsPollInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log('[STATE-SYNC] Stopped');
  }

  /**
   * Fetch awareness snapshot from backend.
   */
  private async fetchAwareness(authToken?: string, userId?: string): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (userId) headers['X-User-Id'] = userId;

      const res = await fetch('/api/awareness/snapshot', { headers, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.success && data.snapshot) {
        this.updateState({ awareness: data.snapshot });
      }
    } catch (err: any) {
      console.warn('[STATE-SYNC] Awareness fetch error:', err.message);
    }
  }

  /**
   * Fetch emotions and world state from backend.
   */
  private async fetchEmotionsAndWorld(authToken?: string): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const [emotionsRes, worldRes] = await Promise.all([
        fetch('/api/emotions', { headers, cache: 'no-store' }),
        fetch('/api/world-state', { headers, cache: 'no-store' }),
      ]);

      if (emotionsRes.ok && worldRes.ok) {
        const emotionsData = await emotionsRes.json();
        const worldData = await worldRes.json();

        if (emotionsData.success && worldData.success) {
          this.updateState({
            emotions: emotionsData.emotions,
            worldState: worldData.world,
          });
        }
      }
    } catch (err: any) {
      console.warn('[STATE-SYNC] Emotions/world fetch error:', err.message);
    }
  }

  /**
   * Connect to WebSocket for real-time updates.
   */
  private connectWebSocket(): void {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${window.location.host}/ws/state-stream`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[STATE-SYNC] WebSocket connected');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'awareness_update') {
            this.updateState({ awareness: data.snapshot });
          } else if (data.type === 'emotions_update') {
            this.updateState({ emotions: data.emotions });
          } else if (data.type === 'world_update') {
            this.updateState({ worldState: data.worldState });
          }
        } catch (err) {
          console.warn('[STATE-SYNC] WebSocket message parse error:', err);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('[STATE-SYNC] WebSocket error:', err);
      };

      this.ws.onclose = () => {
        console.log('[STATE-SYNC] WebSocket disconnected');
        this.ws = null;
      };
    } catch (err: any) {
      console.warn('[STATE-SYNC] WebSocket connection failed:', err.message);
    }
  }

  /**
   * Update internal state and notify listeners (with throttle).
   */
  private updateState(partial: Partial<UIState>): void {
    const now = Date.now();

    // Throttle to prevent excessive re-renders
    if (now - this.lastUpdateMs < this.THROTTLE_MS) {
      if (this.throttleTimer) clearTimeout(this.throttleTimer);

      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.applyStateUpdate(partial);
      }, this.THROTTLE_MS);
    } else {
      this.applyStateUpdate(partial);
    }
  }

  /**
   * Apply state update and notify listeners.
   */
  private applyStateUpdate(partial: Partial<UIState>): void {
    this.state = {
      ...this.state,
      ...(partial as any),
      lastUpdateAt: new Date().toISOString(),
    } as UIState;

    this.lastUpdateMs = Date.now();

    // Notify all subscribers
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error('[STATE-SYNC] Listener error:', err);
      }
    }
  }

  /**
   * Get current state.
   */
  getState(): UIState | null {
    return this.state;
  }

  /**
   * Get a specific state value by path (e.g., "awareness.presence.totalActive").
   */
  getValueByPath(path: string): any {
    if (!this.state) return undefined;

    const parts = path.split('.');
    let value: any = this.state;

    for (const part of parts) {
      value = value?.[part];
      if (value === undefined) return undefined;
    }

    return value;
  }
}

export const stateSyncService = new StateSyncService();
