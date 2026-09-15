/**
 * Repairs common model-output formatting before the renderer parses Markdown.
 * Fenced code blocks are left byte-for-byte unchanged.
 */

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵',
  '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻',
  '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};
const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅',
  '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋',
  '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ',
  j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ',
  r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};
const TEX_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\mapsto\b/g, '↦'], [/\\(?:longrightarrow|rightarrow|to)\b/g, '→'],
  [/\\(?:longleftarrow|leftarrow)\b/g, '←'], [/\\(?:Leftrightarrow|iff)\b/g, '⇔'],
  [/\\(?:Rightarrow|implies)\b/g, '⇒'], [/\\leq?\b/g, '≤'], [/\\geq?\b/g, '≥'],
  [/\\(?:ne|neq)\b/g, '≠'], [/\\approx\b/g, '≈'], [/\\equiv\b/g, '≡'],
  [/\\times\b/g, '×'], [/\\div\b/g, '÷'], [/\\cdot\b/g, '·'],
  [/\\pm\b/g, '±'], [/\\mp\b/g, '∓'], [/\\infty\b/g, '∞'],
  [/\\notin\b/g, '∉'], [/\\in\b/g, '∈'], [/\\subseteq\b/g, '⊆'],
  [/\\supseteq\b/g, '⊇'], [/\\subset\b/g, '⊂'], [/\\supset\b/g, '⊃'],
  [/\\cup\b/g, '∪'], [/\\cap\b/g, '∩'], [/\\forall\b/g, '∀'],
  [/\\exists\b/g, '∃'], [/\\sum\b/g, '∑'], [/\\prod\b/g, '∏'],
  [/\\alpha\b/g, 'α'], [/\\beta\b/g, 'β'], [/\\gamma\b/g, 'γ'],
  [/\\delta\b/g, 'δ'], [/\\theta\b/g, 'θ'], [/\\lambda\b/g, 'λ'],
  [/\\mu\b/g, 'μ'], [/\\pi\b/g, 'π'], [/\\rho\b/g, 'ρ'],
  [/\\sigma\b/g, 'σ'], [/\\phi\b/g, 'φ'], [/\\omega\b/g, 'ω'],
  [/\\Delta\b/g, 'Δ'], [/\\Sigma\b/g, 'Σ'], [/\\Pi\b/g, 'Π'],
];
const FENCE = new RegExp('^\\s*' + String.fromCharCode(96).repeat(3));

function scriptValue(value: string, map: Record<string, string>, marker: '^' | '_'): string {
  const converted = [...value].map((char) => map[char]).join('');
  return converted.length === value.length ? converted : marker + '(' + value + ')';
}

function replaceBalancedCommand(
  source: string,
  command: string,
  transform: (value: string) => string,
): string {
  const marker = '\\' + command + '{';
  let cursor = 0;
  let output = '';
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) return output + source.slice(cursor);
    output += source.slice(cursor, start);
    let depth = 1;
    let end = start + marker.length;
    for (; end < source.length && depth > 0; end++) {
      const char = source[end];
      if (char === '\\') {
        end += 1;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    if (depth !== 0) return output + source.slice(start);
    output += transform(source.slice(start + marker.length, end - 1));
    cursor = end;
  }
  return output;
}

function convertMath(source: string): string {
  let text = source.trim().replace(/\\{2,}(?=[A-Za-z]|[\[\]{}()_%#&|])/g, '\\');
  text = replaceBalancedCommand(text, 'boxed', (value) => '**' + value + '**');
  for (const command of ['text', 'mathrm', 'mathbf', 'operatorname']) {
    text = replaceBalancedCommand(text, command, (value) => value);
  }
  text = text
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
    .replace(/\\(?:left|right)\b/g, '');
  for (const [pattern, symbol] of TEX_SYMBOLS) text = text.replace(pattern, symbol);
  return text
    .replace(/\^\{([^{}]+)\}/g, (_match, value: string) => scriptValue(value, SUPERSCRIPT, '^'))
    .replace(/\^(-?\d+)/g, (_match, value: string) => scriptValue(value, SUPERSCRIPT, '^'))
    .replace(/_\{([^{}]+)\}/g, (_match, value: string) => scriptValue(value, SUBSCRIPT, '_'))
    .replace(/_([A-Za-z0-9+-]+)/g, (_match, value: string) => scriptValue(value, SUBSCRIPT, '_'))
    .replace(/\\([{}_%#&|])/g, '$1')
    .replace(/\\([A-Za-z]+)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function repairCompactTableLine(line: string): string {
  const unescaped = line.replace(/^(\s*)\\+\|/, '$1|');
  if (!/\|\s*:?-{3,}:?\s*\|/.test(unescaped)) return unescaped;
  const fragments = unescaped.split(/\|\s+\|/);
  if (fragments.length < 3) return unescaped;
  const rows = fragments.map((fragment) => {
    const body = fragment.trim().replace(/^\|/, '').replace(/\|$/, '').trim();
    return '| ' + body + ' |';
  });
  const delimiterRow = rows[1];
  if (delimiterRow === undefined) return unescaped;
  const delimiterCells = delimiterRow.slice(1, -1).split('|').map((cell) => cell.trim());
  return delimiterCells.length && delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell))
    ? rows.join('\n')
    : unescaped;
}

function processPlainText(source: string): string {
  const math = source
    .replace(/\\+\[([\s\S]*?)\\+\]/g, (_match, value: string) => '\n\n' + convertMath(value) + '\n\n')
    .replace(/\\+\(([\s\S]*?)\\+\)/g, (_match, value: string) => convertMath(value));
  return math.split('\n').map(repairCompactTableLine).join('\n').replace(/\n{3,}/g, '\n\n');
}

export function normaliseAssistantMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let plain: string[] = [];
  let inFence = false;
  const flushPlain = () => {
    if (!plain.length) return;
    output.push(processPlainText(plain.join('\n')));
    plain = [];
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!inFence) flushPlain();
      output.push(line);
      inFence = !inFence;
    } else if (inFence) {
      output.push(line);
    } else {
      plain.push(line);
    }
  }
  flushPlain();
  return output.join('\n');
}


export const MAX_ASSISTANT_CLIPBOARD_CHARS = 100_000;

function clipboardTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return [];
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isClipboardTableDelimiter(line: string): boolean {
  const cells = clipboardTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function stripClipboardInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\`([^\`]+)\`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(?<!\w)\*([^*\n]+)\*/g, '$1')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/\\([\\\`*_[\]{}()#+.!|])/g, '$1');
}

/**
 * Converts the displayed assistant format into paste-ready text. Math has
 * already been made readable by normaliseAssistantMarkdown; Markdown chrome
 * is removed, fenced code stays intact, and tables become TSV so they paste
 * cleanly into documents or spreadsheets.
 */
export function assistantClipboardText(source: string): string {
  const lines = normaliseAssistantMarkdown(String(source ?? '')).split('\n');
  const output: string[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      output.push(line);
      continue;
    }

    const nextLine = lines[index + 1];
    if (nextLine !== undefined && line.includes('|') && isClipboardTableDelimiter(nextLine)) {
      output.push(clipboardTableCells(line).map(stripClipboardInline).join('\t'));
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index];
        if (tableLine === undefined || !tableLine.trim() || !tableLine.includes('|')) break;
        output.push(clipboardTableCells(tableLine).map(stripClipboardInline).join('\t'));
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      output.push('');
      continue;
    }

    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      output.push(stripClipboardInline(heading[1] ?? ''));
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      output.push('- ' + stripClipboardInline(bullet[1] ?? ''));
      continue;
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      output.push((numbered[1] ?? '') + '. ' + stripClipboardInline(numbered[2] ?? ''));
      continue;
    }

    output.push(stripClipboardInline(line));
  }

  return output
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_ASSISTANT_CLIPBOARD_CHARS);
}
