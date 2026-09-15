const PRIVATE_OR_LOCAL_CONTEXT =
  /\b(?:my|our)\s+(?:account|app|browser|chrome|classroom|email|file|folder|homework|manage\s*bac|screen|tabs?|workspace)\b|\b(?:google\s+classroom|manage\s*bac|localhost|127\.0\.0\.1)\b/i;

const DEEP_RESEARCH_REQUEST =
  /\b(?:analyse|analyze|compare|deep\s+(?:dive|research)|essay|full\s+report|investigate|literature\s+review|pros?\s+and\s+cons?|research\s+paper|timeline)\b/i;

const SIMPLE_PUBLIC_FACT =
  /\b(?:net\s*worth|age|birthday|date\s+of\s+birth|born|height|nationality|spouse|partner|occupation|profession|current\s+(?:ceo|president|prime\s+minister|role|title)|population|capital\s+of|release\s+date|latest\s+version)\b/i;

export interface PublicFactRequestPlan {
  query: string;
  limit: number;
  deterministic: 'net-worth' | 'none';
}

/**
 * Routes short public lookups around the multi-round agent loop. These are the
 * questions where tool discovery and page reading cost far more than the search.
 */
export function publicFactRequestPlan(userText: string): PublicFactRequestPlan | undefined {
  const query = String(userText ?? '').replace(/\s+/g, ' ').trim();
  if (!query || query.length > 240 || /https?:\/\//i.test(query)) return undefined;
  if (PRIVATE_OR_LOCAL_CONTEXT.test(query) || DEEP_RESEARCH_REQUEST.test(query)) return undefined;
  if (!SIMPLE_PUBLIC_FACT.test(query)) return undefined;
  return {
    query,
    limit: 6,
    deterministic: /\bnet\s*worth\b/i.test(query) ? 'net-worth' : 'none',
  };
}

interface SearchResultRow {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchRows(content: string): SearchResultRow[] {
  const clean = String(content ?? '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');
  const rows: SearchResultRow[] = [];
  for (let index = 0; index < lines.length && rows.length < 12; index += 1) {
    const title = /^\s*\d+\.\s+(.+?)\s*$/.exec(lines[index] ?? '')?.[1]?.trim();
    if (!title) continue;
    const url = lines[index + 1]?.trim() ?? '';
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    const snippetLine = lines[index + 2] ?? '';
    const snippet = snippetLine && !/^\s*\d+\.\s+/.test(snippetLine)
      ? snippetLine.trim()
      : '';
    rows.push({ title: title.slice(0, 180), url: url.slice(0, 2_000), snippet: snippet.slice(0, 500) });
  }
  return rows;
}

const MONEY_AMOUNT =
  /(?:₹|\$|£|€|\b(?:Rs\.?|INR|USD|GBP|EUR))\s*\d[\d,.]*(?:[\s\-‐‑‒–—]*(?:crore|crores|lakh|lakhs|million|billion|thousand|mn|bn))?|\d[\d,.]*[\s\-‐‑‒–—]*(?:crore|crores|lakh|lakhs|million|billion)\b/gi;

function normalizeMoneyAmount(value: string): string {
  return value
    .replace(/[\-‐‑‒–—]+(?=\s*(?:crore|crores|lakh|lakhs|million|billion|thousand|mn|bn)\b)/gi, ' ')
    .replace(/[,.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownLabel(value: string): string {
  return value.replace(/[\[\]]/g, '').trim().slice(0, 100) || 'source';
}

/** Returns a zero-model answer when search snippets contain a usable estimate. */
export function directPublicFactReply(
  plan: PublicFactRequestPlan,
  searchContent: string,
): string | undefined {
  if (plan.deterministic !== 'net-worth') return undefined;
  const estimates: Array<{ amount: string; title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const row of parseSearchRows(searchContent)) {
    const rawAmount = (row.title + ' ' + row.snippet).match(MONEY_AMOUNT)?.[0];
    const amount = rawAmount ? normalizeMoneyAmount(rawAmount) : '';
    if (!amount) continue;
    const key = amount.toLowerCase().replace(/[,.\s\-‐‑‒–—]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    estimates.push({ amount, title: row.title, url: row.url });
    if (estimates.length >= 2) break;
  }
  if (!estimates.length) return undefined;
  const sources = estimates.map((estimate) =>
    `${estimate.amount} ([${markdownLabel(estimate.title)}](${estimate.url}))`,
  );
  return (
    `Public net-worth figures are estimates, not verified financial disclosures. ` +
    `Current search results report ${sources.join(' and ')}.`
  );
}
