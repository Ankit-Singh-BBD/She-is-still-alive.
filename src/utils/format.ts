// ===================================================================
// FORMAT UTILITIES - Time, date, number formatters (IST-aware)
// ===================================================================

/**
 * Format current IST time as "HH:MM" (24-hour) or "h:MM AM/PM"
 */
export function formatTime(istHour?: number, istMinute?: number, format: '24' | '12' = '24'): string {
  if (istHour === undefined) {
    const now = new Date();
    istHour = parseInt(
      now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }),
      10,
    );
    istMinute = parseInt(
      now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', minute: '2-digit', hour12: false }),
      10,
    );
  }
  if (format === '12') {
    const period = istHour >= 12 ? 'PM' : 'AM';
    const h12 = istHour % 12 === 0 ? 12 : istHour % 12;
    return `${h12}:${String(istMinute ?? 0).padStart(2, '0')} ${period}`;
  }
  return `${String(istHour).padStart(2, '0')}:${String(istMinute ?? 0).padStart(2, '0')}`;
}

/**
 * Format date as "Mon, 30 Aug"
 */
export function formatDateShort(date?: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date || new Date();
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Format date as "Monday, 30 August 2026"
 */
export function formatDateLong(date?: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date || new Date();
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Get greeting based on IST hour
 */
export function getGreeting(hour?: number): { label: string; emoji: string } {
  if (hour === undefined) {
    hour = parseInt(
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }),
      10,
    );
  }
  if (hour >= 5 && hour < 12) return { label: 'Good Morning', emoji: '🌅' };
  if (hour >= 12 && hour < 17) return { label: 'Good Afternoon', emoji: '☀️' };
  if (hour >= 17 && hour < 21) return { label: 'Good Evening', emoji: '🌆' };
  return { label: 'Good Night', emoji: '🌙' };
}

/**
 * Format temperature with unit
 */
export function formatTemp(celsius?: number, unit: 'C' | 'F' = 'C'): string {
  if (celsius === undefined || celsius === null) return '—°';
  if (unit === 'F') {
    return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  }
  return `${Math.round(celsius)}°`;
}

/**
 * Format relative time ("2m ago", "3h ago", "Yesterday")
 */
export function formatRelative(timestamp: number | string): string {
  const ts = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 30) return 'just now';
  if (minutes < 1) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return formatDateShort(new Date(ts));
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Format sunrise/sunset hour from timestamp
 */
export function formatHourMinute(timestamp: number | string | undefined): string {
  if (!timestamp) return '—';
  const d = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp);
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Capitalize first letter
 */
export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
