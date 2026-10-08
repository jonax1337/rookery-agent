import type { Logger } from '../logger.js';
import { extractMemories, smallModelFor } from '../memory/extractor.js';
import { admitCandidates } from '../memory/gate.js';
import { coreProfile, recall } from '../memory/recall.js';
import type { Store } from '../memory/store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderId, RookeryConfig } from '../types.js';
import type { MemoryLearnedEvent } from './types.js';

/** How many relevant memories, and how many profile rows, the extractor is shown so it does not write them again. */
const KNOWN_MATCH_LIMIT = 20;
const KNOWN_MATCH_THRESHOLD = 0.05;
const KNOWN_PROFILE_LIMIT = 5;

/** What learning from an exchange needs from the runtime. */
export interface LearningContext {
  store: Store;
  providers: ProviderRegistry;
  config: RookeryConfig;
  log: Logger;
}

/** One finished exchange, for one bank. */
export interface Exchange {
  sessionId: string;
  userText: string;
  assistantText: string;
  providerId: ProviderId;
  owner: string;
}

/**
 * The memories the extractor needs to see so it does not write them again:
 * whatever this exchange actually touches, plus the small core profile.
 *
 * Deliberately untraced: this is the `site: 'extract'` population of the
 * dream's vocabulary - `touch: false`, `expand: false`, a wider limit and a
 * lower threshold than any conversational turn. Stage 1 scores only
 * `site = 'turn'`, so the recorder does not sit here; wiring it in would
 * fill the night's pool with calls no label can ever attach to.
 */
function relevantKnown(store: Store, owner: string, text: string): string[] {
  const matched = recall(store, {
    text,
    owner,
    limit: KNOWN_MATCH_LIMIT,
    threshold: KNOWN_MATCH_THRESHOLD,
    touch: false,
    expand: false,
  });
  const profile = coreProfile(store, { owner, limit: KNOWN_PROFILE_LIMIT });
  const seen = new Set<string>();
  const known: string[] = [];
  for (const memory of [...matched, ...profile]) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    known.push(memory.content);
  }
  return known;
}

/**
 * Extract and store durable memories from a finished exchange, then tell
 * `onLearned` what was stored. A failure costs the extraction, never the
 * turn it followed: it is logged and nothing else.
 */
export async function learnFromExchange(
  context: LearningContext,
  exchange: Exchange,
  onLearned: (event: MemoryLearnedEvent) => void,
): Promise<void> {
  const { store, providers, config, log } = context;
  const { sessionId, userText, assistantText, providerId, owner } = exchange;
  try {
    // What the model must not repeat is what is RELEVANT here, not what
    // happens to rank highest overall. Listing the forty most important
    // memories was the single biggest reason the bank kept growing: the
    // sentence about to be written again was almost never in that list.
    const known = relevantKnown(store, owner, userText + '\n' + assistantText);
    const candidates = await extractMemories(providers.get(providerId), {
      userText,
      assistantText,
      known,
      sessionId,
      model: smallModelFor(providerId),
    });
    const admitted = admitCandidates(store, {
      candidates,
      owner,
      config: config.memory,
      // The user's own message, and nothing else. The assistant's answer
      // goes to the extractor so it can tell what the exchange was about,
      // but a fact the assistant produced is not a fact the user confirmed,
      // and only the user's words may stand behind a memory about the user.
      sources: [userText],
      sourceSessionId: sessionId,
    });
    if (admitted.rejected.length) {
      log.debug('Memory gate rejected candidates', {
        count: admitted.rejected.length,
        reasons: admitted.rejected.map((entry) => entry.reason).join(','),
      });
    }
    onLearned({ sessionId, stored: admitted.stored });
  } catch (error) {
    log.warn('Memory extraction failed', { error: (error as Error).message });
  }
}
