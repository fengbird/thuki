/**
 * Registry of all slash commands supported by the ask bar.
 *
 * Commands are categorised into three tiers:
 * - **system**: `/screen`, `/think` — hard-wired behaviour, not editable.
 * - **builtin**: `/translate`, `/rewrite`, … — ships with the app, users may
 *   override trigger / description / template, disable, or reset to defaults.
 * - **custom**: user-created commands with full CRUD.
 *
 * At runtime, `mergeCommands(config)` produces the final `ActiveCommand[]`
 * by layering user overrides and custom definitions on top of the built-in
 * registry while filtering out disabled entries.
 */

// ─── Core types ────────────────────────────────────────────────────────────

export type CommandCategory = 'system' | 'builtin' | 'custom';

export interface Command {
  /** The slash trigger, e.g. "/screen". Must start with "/". */
  readonly trigger: string;
  /** Short label shown in the suggestion row. */
  readonly label: string;
  /** One-line description shown as muted subtext in the suggestion row. */
  readonly description: string;
  /** Prompt template with $INPUT / $LANG placeholders. Absent for non-template commands. */
  readonly promptTemplate?: string;
  /**
   * Optional instruction used when the command is submitted with image input
   * only (no typed or selected text). Lets multimodal models infer text/content
   * directly from the attached image instead of requiring extra keystrokes.
   */
  readonly imageInputHint?: string;
}

/** A command enriched with its category for the runtime pipeline. */
export interface ActiveCommand extends Command {
  readonly category: CommandCategory;
  /** Original trigger before override (only set when trigger was changed). */
  readonly originalTrigger?: string;
}

// ─── Config types (persisted as JSON in app_config) ────────────────────────

/** Per-builtin override. Only present fields are changed; absent = keep default. */
export interface CommandOverride {
  trigger?: string;
  description?: string;
  prompt_template?: string;
}

/** A fully user-defined command. */
export interface CustomCommandDef {
  trigger: string;
  description: string;
  prompt_template?: string;
}

/** Persisted configuration blob — single DB key `settings.commands_config`. */
export interface CommandsConfig {
  /** Keyed by the *original* built-in trigger (e.g. "/translate"). */
  overrides: Record<string, CommandOverride>;
  /** User-created commands. */
  custom: CustomCommandDef[];
  /** Original triggers (built-in) or actual triggers (custom) that are disabled. */
  disabled: string[];
}

export const EMPTY_COMMANDS_CONFIG: CommandsConfig = {
  overrides: {},
  custom: [],
  disabled: [],
};

// ─── Built-in registry ─────────────────────────────────────────────────────

/** Triggers that are hard-wired system commands (not editable / disableable). */
export const SYSTEM_TRIGGERS = new Set(['/screen', '/think']);

export const COMMANDS: readonly Command[] = [
  {
    trigger: '/screen',
    label: '/screen',
    description: 'Capture your screen and include it as context',
  },
  {
    trigger: '/think',
    label: '/think',
    description: 'Think deeply before answering',
  },
  {
    trigger: '/translate',
    label: '/translate',
    description: 'Translate text to another language',
    promptTemplate:
      'You are a translation assistant. Translate the provided source content into the specified target language. The source content may come from typed text, selected text, attached images, or a combination of these. If attached images are present, read and understand all clearly visible text in the images before translating. If the text field already contains the real source text, prioritize that text; if the text field is empty or only describes the attachment, use the text extracted from the attached images as the source content. The user may specify the target language by its full name (for example, "Chinese"), ISO code (for example, "zh" or "zho"), abbreviation, or informal shorthand. Interpret the language identifier flexibly and use your best judgment. If no target language is specified: translate to Chinese (Simplified) if the source content is non-Chinese, or to English if it is already Chinese. Output only the final translation. Do not add commentary, explanation, OCR notes, labels, or quotation marks.\n\nTarget language: $LANG\n\nSource content: $INPUT',
    imageInputHint:
      'The attached image contains the source content. Read all clearly visible text in the image and translate it.',
  },
  {
    trigger: '/rewrite',
    label: '/rewrite',
    description: 'Rewrite text for clarity and flow',
    promptTemplate:
      'Please help rewrite the text below so it reads naturally and smoothly. Make it clear, easy to understand, and easy to follow. No icons, no em dashes. Please output only the rewritten text.\n\nText: $INPUT',
  },
  {
    trigger: '/tldr',
    label: '/tldr',
    description: 'Summarize text in 1-3 sentences',
    promptTemplate:
      "Summarize the following text into a TL;DR. Capture the core message in 1-3 short, direct sentences. Focus on what matters most: the main point, the key decision, or the critical takeaway. Skip background details, qualifications, and anything that isn't essential to understanding the gist. Output only the summary.\n\nText: $INPUT",
  },
  {
    trigger: '/refine',
    label: '/refine',
    description: 'Fix grammar, spelling, and punctuation',
    promptTemplate:
      'Refine the following text by correcting grammar, spelling, punctuation, and awkward phrasing. Keep the original tone, voice, and meaning intact. Do not restructure paragraphs, add new ideas, or remove content. If a sentence is grammatically correct but stylistically rough, smooth it lightly without changing the intent. Output only the refined text.\n\nText: $INPUT',
  },
  {
    trigger: '/bullets',
    label: '/bullets',
    description: 'Extract key points as a bullet list',
    promptTemplate:
      'Extract the key points from the following text as a bulleted list. Each item must begin with "- " (a hyphen followed by a space). Do not use numbered lists, plain paragraphs, headers, or any other formatting. Output only the bulleted list, nothing else.\n\nExample output format:\n- First key point\n- Second key point\n- Third key point\n\nEach bullet should be a concise, self-contained statement. Order by importance or logical sequence. Leave out filler and repetition.\n\nText: $INPUT',
  },
  {
    trigger: '/todos',
    label: '/todos',
    description: 'Extract to-do items as a checkbox list',
    promptTemplate:
      'Read the following text and respond in two parts:\n\n**Part 1: Summary.** Write a short paragraph (3-5 sentences) explaining what this text is about. Cover: what the situation or topic is, who is involved, what the current state is, and why it matters or what is at stake. This should give someone who has not read the original text a clear picture of the context.\n\n**Part 2: To-dos.** List every task, action item, commitment, and follow-up from the text as a markdown checkbox list. Every single item MUST begin with "- [ ] " (hyphen, space, open bracket, space, close bracket, space). Do not use numbered lists, plain bullets, headers, or any other format for the list items.\n\nSeparate the two parts with a blank line. Do not add any headings or labels like "Summary:" or "To-dos:"; just write the paragraph, then the list.\n\nExample output format:\nThis is a paragraph explaining what the text is about, who is involved, and what the situation is. It gives enough context to understand why the tasks matter. It is clear and direct.\n\n- [ ] First task to complete\n- [ ] Second task to complete\n- [ ] Third task to complete\n\nFor each to-do item, include who is responsible (if mentioned), what needs to be done, and any deadline or timeframe (if mentioned). Order by urgency or sequence when possible.\n\nText: $INPUT',
  },
] as const;

/**
 * Sentinel image-path value used as a loading placeholder while the
 * /screen capture is in flight. ChatBubble detects this value and
 * renders a branded screen-capture loading tile instead of a broken image.
 */
export const SCREEN_CAPTURE_PLACEHOLDER = 'blob:screen-capture-loading';

// ─── Runtime merge ─────────────────────────────────────────────────────────

/**
 * Merges the built-in command registry with user configuration to produce
 * the runtime-active command list.
 *
 * Order: system commands first (always), then built-in (minus disabled),
 * then custom (minus disabled).
 */
export function mergeCommands(config?: CommandsConfig | null): ActiveCommand[] {
  const cfg = config ?? EMPTY_COMMANDS_CONFIG;
  const result: ActiveCommand[] = [];

  for (const cmd of COMMANDS) {
    const isSystem = SYSTEM_TRIGGERS.has(cmd.trigger);
    if (isSystem) {
      result.push({ ...cmd, category: 'system' });
      continue;
    }

    // Built-in: skip if disabled.
    if (cfg.disabled.includes(cmd.trigger)) continue;

    const override = cfg.overrides[cmd.trigger];
    if (!override) {
      result.push({ ...cmd, category: 'builtin' });
      continue;
    }

    const newTrigger = override.trigger ?? cmd.trigger;
    result.push({
      trigger: newTrigger,
      label: newTrigger,
      description: override.description ?? cmd.description,
      promptTemplate: override.prompt_template ?? cmd.promptTemplate,
      category: 'builtin',
      originalTrigger: override.trigger ? cmd.trigger : undefined,
    });
  }

  // Custom commands.
  for (const custom of cfg.custom) {
    if (cfg.disabled.includes(custom.trigger)) continue;
    result.push({
      trigger: custom.trigger,
      label: custom.trigger,
      description: custom.description,
      promptTemplate: custom.prompt_template,
      category: 'custom',
    });
  }

  return result;
}

// ─── Prompt builder ────────────────────────────────────────────────────────

/**
 * Builds a fully composed prompt from a utility command's template.
 *
 * Input resolution (selected text primary, typed text fallback):
 * 1. Selected text present, no typed text: selected text is $INPUT.
 * 2. No selected text, typed text present: typed text is $INPUT.
 * 3. Both present: selected text is $INPUT, typed text appended as instruction.
 *
 * For /translate (or any command whose trigger resolves to the /translate
 * template), the first word of strippedMessage is treated as the target
 * language identifier. The model interprets it flexibly (full name, ISO code,
 * abbreviation). If the language word is the only typed content and there is
 * no selected text, returns null (no input to translate).
 *
 * Returns null if the command has no template, is unknown, or input is empty.
 *
 * @param commands  The active command list (from `mergeCommands`). Falls back
 *                  to the built-in `COMMANDS` when omitted (for backward compat
 *                  in tests).
 */
export function buildPrompt(
  trigger: string,
  strippedMessage: string,
  selectedText?: string,
  commands?: readonly Command[],
  options?: { hasImageInput?: boolean },
): string | null {
  const list = commands ?? COMMANDS;
  const cmd = list.find((c) => c.trigger === trigger);
  if (!cmd?.promptTemplate) return null;

  const typed = strippedMessage.trim();
  const selected = selectedText?.trim() ?? '';

  let lang = '';
  let typedRemainder = typed;

  // Detect $LANG placeholder in the template to decide language parsing.
  // Only split when there are 2+ words (first = lang, rest = input).
  // A single word is treated as text to translate with the default language.
  if (cmd.promptTemplate.includes('$LANG') && typed) {
    const spaceIdx = typed.indexOf(' ');
    if (spaceIdx !== -1) {
      lang = typed.slice(0, spaceIdx);
      typedRemainder = typed.slice(spaceIdx + 1).trim();
    }
  }

  // Resolve $INPUT.
  let input: string;
  if (selected && typedRemainder) {
    input = `${selected}\n\n[Additional instruction]: ${typedRemainder}`;
  } else if (selected) {
    input = selected;
  } else if (typedRemainder) {
    input = typedRemainder;
  } else if (options?.hasImageInput) {
    input =
      cmd.imageInputHint ??
      'Use the attached image as the source content. Extract the relevant text or content from the image before completing the task.';
  } else {
    return null;
  }

  return cmd.promptTemplate.replace(/\$LANG|\$INPUT/g, (m) =>
    m === '$LANG' ? lang : input,
  );
}
