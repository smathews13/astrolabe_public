/**
 * How long ago something was touched, in the words a rail or a table row has
 * space for.
 *
 * Split out of App.tsx when the pages became modules. The conversation rail and
 * the Benchmark Lab's run table both date their rows with it, and two copies of
 * a rule about time are two chances for the same instant to read as "Yesterday"
 * on one surface and a date on the other.
 */

export function conversationAge(updatedAt: string) {
  const elapsed = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 172_800_000) return 'Yesterday';
  return new Date(updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
