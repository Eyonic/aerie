const DEFAULT_HOUR = 3;

/** Effective server-local hour for the nightly recovery bundle (0-23). */
export function backupScheduleHour(value = process.env.BACKUP_SCHEDULE_HOUR): number {
  if (value === undefined || value.trim() === '') return DEFAULT_HOUR;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : DEFAULT_HOUR;
}

/** IANA timezone used by Node for server-local Date operations. */
export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'UTC';
  } catch {
    return process.env.TZ || 'UTC';
  }
}

export function localScheduleTime(hour = backupScheduleHour()): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** Next occurrence of the configured hour using the server's local timezone. */
export function nextNightlyBackup(now = new Date(), hour = backupScheduleHour()): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** Most recent scheduled occurrence, including an occurrence exactly at now. */
export function latestNightlyBackup(now = new Date(), hour = backupScheduleHour()): Date {
  const latest = new Date(now);
  latest.setHours(hour, 0, 0, 0);
  if (latest.getTime() > now.getTime()) latest.setDate(latest.getDate() - 1);
  return latest;
}

export function serverLocalDay(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}
