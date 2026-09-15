
import { inflateRawSync, inflateSync } from 'node:zlib';
import { throwIfAborted } from '../abort';
import { readBoundedBufferFile } from '../bounded-file';
import { MAX_DOCUMENT_INPUT_BYTES, verifyInputFile } from './file-bounds';

/**
 * Pulls the text out of a PDF without any dependency.
 *
 * Three things make this harder than "find the strings":
 *
 *  - Most streams in a PDF are not text. Images, fonts and metadata all inflate
 *    to bytes that a naive scan happily reports as content, and the result is a
 *    screenful of mojibake presented as if it were the document.
 *  - Subsetted fonts renumber their glyphs, so the bytes in the content stream
 *    are not characters. "International" comes out as ", Q W H U Q D W L R Q D O"
 *    unless the font's ToUnicode map is read and applied.
 *  - Producers position nearly every glyph individually, so breaking a line at
 *    every positioning operator turns a paragraph into one word per line.
 *
 * What it still cannot do is read a scan: those pages hold an image and no text
 * at all. Rather than returning empty and letting the agent conclude the file is
 * blank, it says so and points at OCR, which can read it.
 */

const MAX_TEXT = 200_000;
const MAX_PDF_STREAM_BYTES = 8_000_000;

function inflate(data: Buffer): Buffer | null {
  if (data.length > MAX_PDF_STREAM_BYTES) return null;
  try {
    return inflateSync(data, { maxOutputLength: MAX_PDF_STREAM_BYTES });
  } catch {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_PDF_STREAM_BYTES });
    } catch {
      return null;
    }
  }
}

/** PDF string escapes: \( \) \\ \n \r \t and octal \ddd. */
function decodeLiteral(raw: string): number[] {
  const codes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') {
      codes.push(raw.charCodeAt(i));
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3) {
        const digit = raw[i + 1];
        if (digit === undefined || digit < '0' || digit > '7') break;
        i += 1;
        oct += digit;
      }
      codes.push(parseInt(oct, 8));
      continue;
    }
    const named: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    if (next === '\n') continue;
    codes.push(named[next] ?? next.charCodeAt(0));
  }
  return codes;
}

function hexCodes(raw: string, twoByte: boolean): number[] {
  const clean = raw.replace(/[^0-9a-fA-F]/g, '');
  const step = twoByte ? 4 : 2;
  const codes: number[] = [];
  for (let i = 0; i + step - 1 < clean.length; i += step) {
    codes.push(parseInt(clean.slice(i, i + step), 16));
  }
  return codes;
}

/* ------------------------------------------------------------- ToUnicode */

type CMap = Map<number, string>;

/**
 * Reads a ToUnicode CMap: the table that says what each glyph code means.
 *
 * Without this a subsetted font's codes are meaningless numbers — which is why
 * text from Google Docs and LaTeX exports comes out shifted by a constant.
 */
function parseCMap(text: string): CMap {
  const map: CMap = new Map();

  const utf16 = (hex: string): string => {
    let out = '';
    for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    // Some producers write single-byte destinations.
    if (!out && hex.length >= 2) out = String.fromCharCode(parseInt(hex.slice(0, 2), 16));
    return out;
  };

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const body = block[1];
    if (!body) continue;
    for (const pair of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const source = pair[1];
      const destination = pair[2];
      if (source && destination) map.set(parseInt(source, 16), utf16(destination));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    if (!body) continue;
    // <lo> <hi> <dst>  — a run mapped to consecutive destinations.
    for (const r of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const sourceLow = r[1];
      const sourceHigh = r[2];
      const dst = r[3];
      if (!sourceLow || !sourceHigh || !dst) continue;
      const lo = parseInt(sourceLow, 16);
      const hi = parseInt(sourceHigh, 16);
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) {
        const base = parseInt(dst.slice(-4), 16) + (c - lo);
        map.set(c, String.fromCharCode(base));
      }
    }
    // <lo> <hi> [ <a> <b> … ] — a run mapped to an explicit list.
    for (const r of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const sourceLow = r[1];
      const list = r[3];
      if (!sourceLow || list === undefined) continue;
      const lo = parseInt(sourceLow, 16);
      const items = [...list.matchAll(/<([0-9a-fA-F]+)>/g)];
      items.forEach((item, i) => {
        const destination = item[1];
        if (destination) map.set(lo + i, utf16(destination));
      });
    }
  }
  return map;
}

/** Whether an inflated stream looks like page content rather than an image. */
function looksLikeContent(body: Buffer): boolean {
  const head = body.subarray(0, 2048).toString('latin1');
  // Content streams are ASCII operators. Images and fonts are not.
  let printable = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  if (head.length && printable / head.length < 0.9) return false;
  return /\bBT\b|\bTj\b|\bTJ\b|\bTf\b|\bTd\b|\bre\b|\bcm\b/.test(head);
}

interface Extracted {
  text: string;
  mappedChars: number;
  rawChars: number;
}

/**
 * Walks a content stream, applying the font maps and honouring line breaks.
 *
 * A new line is started only when the text position actually moves down, not on
 * every positioning operator — producers emit one per glyph, and breaking on all
 * of them is what turns a paragraph into a column of single letters.
 */
function extractFromContent(content: string, fonts: Map<string, CMap>): Extracted {
  const lines: string[] = [];
  let line = '';
  let current: CMap | null = null;
  let mapped = 0;
  let raw = 0;

  const token =
    /\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|\/[^\s/[\]<>()]+|-?[\d.]+|\bTJ\b|\bTj\b|\bT\*\b|\bTd\b|\bTD\b|\bTm\b|\bTf\b|\bET\b|\bBT\b/g;

  const numbers: number[] = [];
  const names: string[] = [];
  let pending = '';
  let lastY: number | undefined;

  const flushLine = () => {
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    line = '';
  };

  let m: RegExpExecArray | null;
  while ((m = token.exec(content))) {
    const t = m[0];

    if (t.startsWith('(') || t.startsWith('<')) {
      // Whether a hex string carries one byte or two per glyph has to be read
      // off the string itself: the CMap that would have said so is frequently
      // locked inside a compressed object stream this reader cannot open.
      const hex = t.startsWith('<') ? t.slice(1, -1).replace(/[^0-9a-fA-F]/g, '') : '';
      const twoByte = hex.length % 4 === 0 && /^00/.test(hex);
      const codes = t.startsWith('(') ? decodeLiteral(t.slice(1, -1)) : hexCodes(hex, twoByte);
      for (const code of codes) {
        raw++;
        const via = current?.get(code);
        if (via !== undefined) {
          mapped++;
          pending += via;
        } else {
          pending += String.fromCharCode(code);
        }
      }
      continue;
    }

    if (t.startsWith('/')) {
      names.push(t.slice(1));
      continue;
    }

    if (/^-?[\d.]+$/.test(t)) {
      numbers.push(Number(t));
      continue;
    }

    switch (t) {
      case 'Tf':
        current = fonts.get(names[names.length - 1] ?? '') ?? null;
        break;
      case 'Tj':
      case 'TJ':
        line += pending;
        pending = '';
        break;
      case 'T*':
        line += pending;
        pending = '';
        flushLine();
        break;
      case 'Td':
      case 'TD': {
        line += pending;
        pending = '';
        // Only a vertical move is a new line; horizontal moves are kerning.
        const dy = numbers[numbers.length - 1];
        if (dy !== undefined && Math.abs(dy) > 0.5) flushLine();
        break;
      }
      case 'Tm': {
        line += pending;
        pending = '';
        // A full matrix reset with a different Y means a new line.
        const ty = numbers[numbers.length - 1];
        if (ty !== undefined && lastY !== undefined && Math.abs(ty - lastY) > 0.5) flushLine();
        lastY = ty;
        break;
      }
      case 'ET':
        line += pending;
        pending = '';
        flushLine();
        break;
      default:
        break;
    }
    numbers.length = 0;
    if (t === 'Tf') names.length = 0;
  }

  line += pending;
  flushLine();
  return { text: lines.join('\n'), mappedChars: mapped, rawChars: raw };
}
export function extractPdfContentText(content: string): string {
  return extractFromContent(content, new Map()).text;
}

/** Collects every font's ToUnicode map, keyed by the resource name (F1, C2_0…). */
function collectFonts(latin: string, buf: Buffer, signal?: AbortSignal): Map<string, CMap> {
  const byObject = new Map<number, CMap>();

  // Every object that carries a CMap, by object number.
  for (const obj of latin.matchAll(/(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g)) {
    throwIfAborted(signal);
    const num = Number(obj[1]);
    const body = obj[2];
    if (!Number.isSafeInteger(num) || body === undefined) continue;
    if (!/\/(ToUnicode|CMapName)/.test(body) && !/beginbfchar|beginbfrange/.test(body)) continue;

    let text = body;
    const streamAt = body.indexOf('stream');
    if (streamAt >= 0 && /FlateDecode/.test(body.slice(0, streamAt))) {
      const objectIndex = obj.index;
      const objectText = obj[0];
      if (objectIndex === undefined || !objectText) continue;
      const relativeStream = objectText.indexOf('stream');
      if (relativeStream < 0) continue;
      const absStart = objectIndex + relativeStream + 'stream'.length;
      const skip = latin[absStart] === '\r' ? (latin[absStart + 1] === '\n' ? 2 : 1) : latin[absStart] === '\n' ? 1 : 0;
      const end = latin.indexOf('endstream', absStart);
      if (end < absStart + skip) continue;
      const inflated = inflate(buf.subarray(absStart + skip, end));
      if (!inflated) continue;
      text = inflated.toString('latin1');
    }
    if (/beginbfchar|beginbfrange/.test(text)) {
      const map = parseCMap(text);
      if (map.size) byObject.set(num, map);
    }
  }

  // Then the resource names that point at them: /F1 12 0 R with /ToUnicode N 0 R.
  const byName = new Map<string, CMap>();
  for (const font of latin.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
    throwIfAborted(signal);
    const target = Number(font[2]);
    const map = byObject.get(target);
    const name = font[1];
    if (map && name) byName.set(name, map);
  }

  // Fonts reference their ToUnicode indirectly, so also walk font objects.
  for (const obj of latin.matchAll(/(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g)) {
    throwIfAborted(signal);
    const body = obj[2];
    if (body === undefined) continue;
    if (!/\/Type\s*\/Font/.test(body)) continue;
    const uni = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(body);
    if (!uni) continue;
    const map = byObject.get(Number(uni[1]));
    if (!map) continue;
    // Map every resource name that points at this font object.
    const self = Number(obj[1]);
    if (!Number.isSafeInteger(self)) continue;
    for (const ref of latin.matchAll(new RegExp(`/(\\w+)\\s+${self}\\s+\\d+\\s+R`, 'g'))) {
      const name = ref[1];
      if (name) byName.set(name, map);
    }
  }

  // A single map for the whole document is a decent fallback: most exports use
  // one subsetted font, and a wrong-but-present map still beats raw codes.
  if (byName.size === 0 && byObject.size === 1) {
    const onlyMap = byObject.values().next().value;
    if (onlyMap) byName.set('*', onlyMap);
  }
  return byName;
}

export async function readPdf(path: string, signal?: AbortSignal): Promise<string> {
  const { abs } = await verifyInputFile(path, MAX_DOCUMENT_INPUT_BYTES, 'PDF', signal);
  const bounded = await readBoundedBufferFile(abs, MAX_DOCUMENT_INPUT_BYTES, signal);
  if (bounded.truncated) throw new Error(abs + ' exceeded the ' + MAX_DOCUMENT_INPUT_BYTES.toLocaleString() + '-byte PDF limit while it was being read.');
  const buf = bounded.data;
  throwIfAborted(signal);

  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`${abs} does not look like a PDF.`);
  }

  const latin = buf.toString('latin1');
  const fonts = collectFonts(latin, buf, signal);
  const fallback = fonts.get('*') ?? null;

  const pieces: string[] = [];
  let streams = 0;
  let contentStreams = 0;
  let mapped = 0;
  let rawChars = 0;
  let bufferedChars = 0;

  const marker = /stream\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(latin))) {
    throwIfAborted(signal);
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    streams++;
    marker.lastIndex = end;

    const rawStream = buf.subarray(start, end);
    if (rawStream.length > MAX_PDF_STREAM_BYTES) continue;
    const body = inflate(rawStream) ?? rawStream;
    if (body.length > MAX_PDF_STREAM_BYTES) continue;
    if (!looksLikeContent(body)) continue;

    contentStreams++;
    const useFonts = fonts.size ? fonts : new Map<string, CMap>();
    if (fallback) for (const name of ['F1', 'F2', 'F3', 'C2_0']) useFonts.set(name, fallback);

    const got = extractFromContent(body.toString('latin1'), useFonts);
    mapped += got.mappedChars;
    rawChars += got.rawChars;
    if (got.text.trim() && bufferedChars <= MAX_TEXT) {
      const remaining = MAX_TEXT + 1 - bufferedChars;
      if (remaining > 0) {
        const snippet = got.text.slice(0, remaining);
        pieces.push(snippet);
        bufferedChars += snippet.length;
      }
    }
    if (bufferedChars > MAX_TEXT) break;
  }

  const joined = pieces.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!joined) {
    return (
      `${abs}\n\nNo extractable text. The file has ${streams} stream(s) and ${contentStreams} ` +
      'of them are page content, but none carry text — which almost always means the pages ' +
      'are scanned images. Open it and use find_on_screen, or screenshot it and use ocr_image.'
    );
  }

  const coverage = rawChars ? mapped / rawChars : 1;

  // Coverage alone is not the test: a PDF using standard WinAnsi encoding needs
  // no ToUnicode map at all and would score zero while being perfectly
  // readable. What separates the two is whether the result contains words. A
  // glyph-shifted document reads as "6 R X W K . R U H D" — plausible letters,
  // no language — so the check is for the handful of words any real English
  // page of this length is nearly certain to contain.
  // Short words are too weak a signal on their own: a cipher-shifted page throws
  // up "in", "it" and "as" by chance often enough to pass. Requiring several
  // distinct common words, weighted toward longer ones, does not.
  const COMMON =
    /\b(the|and|that|with|this|from|have|are|for|you|not|but|was|were|which|their|there|would|about|when|what|your|page|question|answer|name|date)\b/gi;
  const distinctWords = new Set(
    (joined.match(COMMON) ?? []).map((w) => w.toLowerCase()),
  ).size;
  const meaningful = joined.replace(/\s/g, '').length;
  if (coverage < 0.5 && distinctWords < 2 && meaningful > 25) {
    return (
      `${abs}\n\nThis PDF draws its text with subsetted fonts, and the tables saying what each ` +
      `glyph means are not reachable from here (${Math.round(coverage * 100)}% of ${rawChars} ` +
      'glyphs resolved, and what came out contains no recognisable words). Extracting anyway ' +
      'would produce text that looks like language and reads as nonsense, so it is withheld.\n\n' +
      'To read this file: open it and use find_on_screen or read_screen_text, or screenshot it ' +
      'and use ocr_image. Those read what is actually drawn on the page.'
    );
  }

  const shown = joined.length > MAX_TEXT ? `${joined.slice(0, MAX_TEXT)}\n…[truncated]` : joined;
  return `${abs}  (${contentStreams} page content stream(s))\n\n${shown}`;
}
