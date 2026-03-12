/**
 * Builds narration script from asset meta for TTS voiceover.
 * Used by the video-with-voiceover pipeline.
 */

export interface AssetMetaForScript {
  name?: string;
  instructions?: { instructions?: string[] };
}

const DEFAULT_MAX_WORDS = 200;

/**
 * Build a single narration string from asset meta: intro + "Step N: [instruction]" per item.
 * Caps total length at maxWords (default 200).
 */
export function buildNarrationScript(
  assetMeta: AssetMetaForScript,
  maxWords: number = DEFAULT_MAX_WORDS
): string {
  const name = assetMeta?.name ?? '';
  const steps = assetMeta?.instructions?.instructions ?? [];
  const parts: string[] = [];

  if (name) {
    parts.push(`This is ${name}.`);
  }

  steps.forEach((step: string | { simple?: string; detailed?: string; instruction?: string }, i) => {
    const text = typeof step === 'string' ? step : (step?.detailed || step?.instruction || step?.simple || '');
    if (text?.trim()) {
      parts.push(`Step ${i + 1}: ${text.trim()}`);
    }
  });

  let script = parts.join(' ').trim();
  if (!script) return '';

  const words = script.split(/\s+/);
  if (words.length <= maxWords) return script;
  return words.slice(0, maxWords).join(' ');
}
