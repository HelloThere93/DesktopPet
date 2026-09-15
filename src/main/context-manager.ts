import { expandSemanticTerms, normaliseSemanticSearchTerms } from './semantic-terms';

export interface ContextBlock {
  text: string;
  /** Higher values keep a block relevant even when the query does not match it. */
  priority?: number;
}

export interface ContextSelection {
  blocks: ContextBlock[];
  omitted: number;
  characters: number;
}

export interface ContextSelectionOptions {
  maxBlocks: number;
  maxCharacters: number;
}

export const MAX_CONTEXT_BLOCKS = 64;
export const MAX_CONTEXT_CHARACTERS = 20_000;
export const MAX_CONTEXT_BLOCK_INPUT = 100_000;
const MAX_CONTEXT_QUERY = 4_000;

function normalise(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function queryTerms(query: string): string[] {
  return normaliseSemanticSearchTerms(query.slice(0, MAX_CONTEXT_QUERY), 24);
}

function clampText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const suffix = ' ...[context item truncated]';
  if (maxCharacters <= suffix.length) return suffix.slice(0, maxCharacters);
  return text.slice(0, Math.max(0, maxCharacters - suffix.length)).trimEnd() + suffix;
}

function score(block: ContextBlock, query: string, terms: { direct: readonly string[]; semantic: readonly string[] }, index: number, total: number): number {
  const haystack = normalise(block.text.slice(0, MAX_CONTEXT_BLOCK_INPUT));
  const phrase = normalise(query.slice(0, MAX_CONTEXT_QUERY));
  let value = Number.isFinite(block.priority) ? block.priority ?? 0 : 0;

  for (const term of terms.direct) {
    if (haystack.includes(term)) value += 3;
  }
  const directTerms = new Set(terms.direct);
  for (const term of terms.semantic) {
    if (directTerms.has(term)) continue;
    if (haystack.includes(term)) value += 1;
  }
  if (phrase.length >= 3 && haystack.includes(phrase)) value += 6;

  // Source order is oldest-to-newest for lessons and goals. A small recency
  // bonus keeps useful recent context when several items tie.
  value += total > 1 ? index / (total - 1) : 1;
  return value;
}

function normaliseLimit(value: number, fallback: number, maximum: number): number {
  if (value === Infinity) return maximum;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

/**
 * Selects a small, query-relevant set of reference blocks for a model prompt.
 * The source text is treated as data; this module never executes or interprets it.
 */
export function selectContextBlocks(
  blocks: readonly ContextBlock[],
  query: string,
  options: ContextSelectionOptions,
): ContextSelection {
  const maxBlocks = normaliseLimit(options.maxBlocks, 1, MAX_CONTEXT_BLOCKS);
  const maxCharacters = normaliseLimit(options.maxCharacters, 1, MAX_CONTEXT_CHARACTERS);
  const candidates = blocks.flatMap((block, index) => {
    if (!block || typeof block.text !== 'string') return [];
    const text = block.text.slice(0, MAX_CONTEXT_BLOCK_INPUT);
    return text.trim().length > 0 ? [{ block: { ...block, text }, index }] : [];
  });
  const directTerms = queryTerms(query);
  const terms = { direct: directTerms, semantic: expandSemanticTerms(directTerms) };
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      rank: score(candidate.block, query, terms, candidate.index, candidates.length),
    }))
    .sort((a, b) => b.rank - a.rank || b.index - a.index);

  const selected: { block: ContextBlock; index: number }[] = [];
  let characters = 0;

  for (const candidate of ranked) {
    if (selected.length >= maxBlocks) break;
    const remaining = maxCharacters - characters;
    if (remaining <= 0) break;

    const original = candidate.block.text.trim();
    if (original.length > remaining && selected.length > 0) continue;
    const text = clampText(original, remaining);
    selected.push({ block: { ...candidate.block, text }, index: candidate.index });
    characters += text.length;
  }

  selected.sort((a, b) => a.index - b.index);
  return {
    blocks: selected.map(({ block }) => block),
    omitted: Math.max(0, candidates.length - selected.length),
    characters,
  };
}

export function formatContextSelection(
  title: string,
  selection: ContextSelection,
  omittedLabel: string,
): string {
  if (!selection.blocks.length) return '';
  const body = selection.blocks.map((block) => block.text).join('\n');
  const omitted = selection.omitted
    ? '\n  (' +
      selection.omitted +
      ' additional ' +
      omittedLabel +
      ' not included; retrieve them with the relevant tool when needed.)'
    : '';
  return title + '\n' + body + omitted;
}

