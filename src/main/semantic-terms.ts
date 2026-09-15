const SEMANTIC_GROUPS = [
  ['bug', 'issue', 'problem', 'error', 'failure', 'broken', 'regression', 'crash', 'glitch', 'troubleshooting'],
  ['inventory', 'item', 'items', 'catalog', 'collection', 'stock', 'assets'],
  ['research', 'study', 'investigation', 'finding', 'evidence', 'source', 'citation', 'paper', 'literature'],
  ['assignment', 'homework', 'coursework', 'schoolwork', 'task'],
  ['goal', 'objective', 'target', 'milestone', 'plan'],
  ['memory', 'note', 'notes', 'lesson', 'knowledge', 'remember'],
  ['conversation', 'chat', 'thread', 'discussion'],
  ['document', 'file', 'pdf', 'report', 'paper'],
  ['project', 'workspace', 'repository', 'repo'],
  ['workflow', 'automation', 'process', 'routine'],
] as const;

const SEARCH_STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but',
  'can', 'did', 'do', 'does', 'for', 'from', 'have', 'how', 'i', 'in', 'is', 'it',
  'last', 'me', 'month', 'my', 'of', 'on', 'or', 'please', 'that', 'the', 'thing', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'with', 'why', 'you', 'your',
]);

const MAX_QUERY_CHARS = 200;
const MAX_DIRECT_TERMS = 12;
const MAX_EXPANDED_TERMS = 32;

function stemTerm(term: string): string {
  if (term.length > 5 && term.endsWith('ies')) return term.slice(0, -3) + 'y';
  if (term.length > 5 && term.endsWith('ing')) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith('ed')) return term.slice(0, -2);
  if (term.length > 4 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/** Returns bounded direct query terms for local content retrieval. */
export function normaliseSemanticSearchTerms(query: string, maximum = MAX_DIRECT_TERMS): string[] {
  const requested = Number.isFinite(maximum) ? Math.trunc(maximum) : MAX_DIRECT_TERMS;
  const limit = Math.min(Math.max(requested, 1), MAX_EXPANDED_TERMS);
  return [...new Set(
    String(query)
      .normalize('NFKC')
      .toLocaleLowerCase()
      .slice(0, MAX_QUERY_CHARS)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term)),
  )].slice(0, limit);
}

/**
 * Expands direct terms with a small local concept vocabulary and safe stems.
 * This is hybrid lexical retrieval, not an embedding or remote model call.
 */
export function expandSemanticTerms(terms: readonly string[], maximum = MAX_EXPANDED_TERMS): string[] {
  const requested = Number.isFinite(maximum) ? Math.trunc(maximum) : MAX_EXPANDED_TERMS;
  const limit = Math.min(Math.max(requested, 1), MAX_EXPANDED_TERMS);
  const expanded = new Set<string>();
  for (const raw of terms) {
    const term = String(raw).trim().toLocaleLowerCase();
    if (term.length < 2) continue;
    expanded.add(term);
    const stem = stemTerm(term);
    if (stem !== term) expanded.add(stem);
  }

  for (const group of SEMANTIC_GROUPS) {
    if (!group.some((alias) => expanded.has(alias))) continue;
    for (const alias of group) expanded.add(alias);
  }
  return [...expanded].slice(0, limit);
}

