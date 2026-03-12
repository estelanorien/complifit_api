/**
 * Google Cloud Text-to-Speech v1beta1 client for voiceover pipeline.
 * Supports enableTimePointing for audio-driven edit lists (Phase 2).
 */

import textToSpeech from '@google-cloud/text-to-speech';
import { createHash } from 'crypto';

export interface SynthesizeOptions {
  enableTimePointing?: boolean;
}

export interface Timepoint {
  markName?: string;
  timeSeconds?: number;
}

export interface SynthesizeResult {
  audioBuffer: Buffer;
  timepoints?: Timepoint[];
}

const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, SynthesizeResult>();

function cacheKey(text: string, languageCode: string, options?: SynthesizeOptions): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const suffix = options?.enableTimePointing ? ':tp' : '';
  return `${languageCode}:${hash}${suffix}`;
}

// TimepointType.SSML_MARK = 1 (for enableTimePointing; timepoints only returned for SSML <mark>)
const TIMEPOINT_TYPE_SSML_MARK = 1;

/**
 * Synthesize speech from text. Returns audio buffer and optional timepoints (when enableTimePointing).
 * Uses in-memory cache keyed by hash(text)+languageCode.
 */
export async function synthesize(
  text: string,
  languageCode: string,
  options: SynthesizeOptions = {}
): Promise<SynthesizeResult> {
  const key = cacheKey(text, languageCode, options);
  const cached = cache.get(key);
  if (cached) return cached;

  const client = new textToSpeech.v1beta1.TextToSpeechClient();
  try {
    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode: languageCode.replace(/-.*/, ''), // e.g. en-US -> en
        name: undefined
      },
      audioConfig: {
        audioEncoding: 'MP3',
        sampleRateHertz: 24000
      },
      enableTimePointing: options.enableTimePointing ? [TIMEPOINT_TYPE_SSML_MARK] : undefined
    });

    const audioContent = response.audioContent as Uint8Array | Buffer | undefined;
    if (!audioContent || audioContent.length === 0) {
      throw new Error('TTS returned empty audio');
    }

    const audioBuffer = Buffer.isBuffer(audioContent) ? audioContent : Buffer.from(audioContent);
    const timepoints: Timepoint[] | undefined = (response as any).timepoints?.map((tp: any) => ({
      markName: tp.markName,
      timeSeconds: tp.timeSeconds ?? Number(tp.timeSeconds)
    }));

    const result: SynthesizeResult = { audioBuffer, timepoints };

    if (cache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(key, result);
    return result;
  } finally {
    await client.close();
  }
}
