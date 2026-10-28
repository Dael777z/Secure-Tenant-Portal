// Times in a conversation, for both sides (the manager inbox and the tenant's
// Property Management panel). Everything is the viewer's local time.

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "2:14 PM" */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** The day heading over a group of messages: "Today", "Yesterday", "Mon, Oct 13", "Oct 3, 2025". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** A short time for a list row: "2:14 PM" today, "Yesterday", "Mon", or "Oct 3". */
export function listTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return clockTime(iso);
  const label = dayLabel(iso, now);
  if (label === "Yesterday") return label;
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The receipt under the last message you sent: "Seen · 2:14 PM" once the other side opened it. */
export function receiptText(readAt: string | null, seenBy: string): string {
  if (!readAt) return "Delivered";
  const at = sameDay(new Date(readAt), new Date()) ? clockTime(readAt) : `${dayLabel(readAt)}, ${clockTime(readAt)}`;
  return `Seen by ${seenBy} · ${at}`;
}

/** Messages grouped under day headings, oldest first. */
export function byDay<T extends { sentAt: string }>(messages: T[]): Array<{ day: string; messages: T[] }> {
  const groups: Array<{ day: string; messages: T[] }> = [];
  for (const m of messages) {
    const day = dayLabel(m.sentAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.messages.push(m);
    else groups.push({ day, messages: [m] });
  }
  return groups;
}

/** Index of the last message `from` wrote (where its receipt goes), or -1. */
export function lastIndexFrom<T extends { from: string }>(messages: T[], from: string): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.from === from) return i;
  return -1;
}
