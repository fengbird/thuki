/**
 * Shared between the clipboard panel (tile labels) and the Settings
 * picker (pill labels) so both surfaces show the same friendly name
 * for every slash command.
 */
export const AI_ACTION_LABELS: Record<string, string> = {
  '/tldr': 'Summarize',
  '/translate': 'Translate',
  '/rewrite': 'Rewrite',
  '/refine': 'Refine',
  '/bullets': 'Bullets',
  '/todos': 'Todos',
};

/** Returns the friendly tile name for a slash-command trigger. */
export function formatAiActionLabel(trigger: string): string {
  if (AI_ACTION_LABELS[trigger]) return AI_ACTION_LABELS[trigger];
  const stem = trigger.replace(/^\//, '');
  if (!stem) return trigger;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}
