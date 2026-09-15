/**
 * Safe Markdown renderer for chat messages. It only creates DOM nodes; model
 * output is never inserted as executable HTML.
 */

import { normaliseAssistantMarkdown } from '../shared/assistant-format';

type Inline = { type: 'text' | 'code' | 'bold' | 'italic' | 'link'; text: string; href?: string };

function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  // Models occasionally escape emphasis even though their answer is already
  // being rendered as Markdown. Accept that harmless variant here, and allow
  // single * or _ characters inside bold text (common in maths and identifiers).
  const re =
    /(`[^`\n]+`)|(\\\*\\\*(?=\S).*?\S\\\*\\\*)|(\\_\\_(?=\S).*?\S\\_\\_)|(\*\*(?=\S).*?\S\*\*)|__(?=\S).*?\S__|(\\\*(?=\S).*?\S\\\*)|(\*[^*\n]+\*)|(\\_(?=\S).*?\S\\_)|(?<![\w_])_([^_\n]+)_(?![\w_])|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    if (match.index > last) out.push({ type: 'text', text: src.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith('`')) {
      out.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('\\*\\*') || token.startsWith('\\_\\_')) {
      out.push({ type: 'bold', text: token.slice(4, -4) });
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push({ type: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('[')) {
      const cut = token.indexOf('](');
      out.push({ type: 'link', text: token.slice(1, cut), href: token.slice(cut + 2, -1) });
    } else if (token.startsWith('http')) {
      out.push({ type: 'link', text: token, href: token });
    } else if (token.startsWith('\\*') || token.startsWith('\\_')) {
      out.push({ type: 'italic', text: token.slice(2, -2) });
    } else {
      out.push({ type: 'italic', text: token.slice(1, -1) });
    }
    last = match.index + token.length;
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) });
  return out;
}

function appendInline(parent: HTMLElement, src: string): void {
  for (const run of parseInline(src)) {
    if (run.type === 'code') {
      const element = document.createElement('code');
      element.textContent = run.text;
      parent.appendChild(element);
    } else if (run.type === 'bold') {
      const element = document.createElement('strong');
      element.textContent = run.text;
      parent.appendChild(element);
    } else if (run.type === 'italic') {
      const element = document.createElement('em');
      element.textContent = run.text;
      parent.appendChild(element);
    } else if (run.type === 'link') {
      const element = document.createElement('a');
      element.textContent = run.text;
      if (/^https?:\/\//i.test(run.href ?? '')) {
        element.href = run.href!;
        element.target = '_blank';
        element.rel = 'noreferrer noopener';
        parent.appendChild(element);
      } else {
        parent.appendChild(document.createTextNode(run.text));
      }
    } else {
      parent.appendChild(document.createTextNode(run.text));
    }
  }
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function tableAlignment(cell: string): 'left' | 'center' | 'right' | undefined {
  if (/^:-{3,}:$/.test(cell)) return 'center';
  if (/^-{3,}:$/.test(cell)) return 'right';
  if (/^:-{3,}$/.test(cell)) return 'left';
  return undefined;
}

function isTableDelimiter(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  return header !== undefined && delimiter !== undefined && header.includes('|') && isTableDelimiter(delimiter);
}

function appendTable(target: HTMLElement, lines: readonly string[], start: number): number {
  const headerLine = lines[start];
  const delimiterLine = lines[start + 1];
  if (headerLine === undefined || delimiterLine === undefined) return start + 1;
  const headers = tableCells(headerLine);
  const delimiters = tableCells(delimiterLine);
  const wrapper = document.createElement('div');
  wrapper.className = 'md-table-wrap';
  const table = document.createElement('table');
  table.className = 'md-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((header, index) => {
    const cell = document.createElement('th');
    const alignment = tableAlignment(delimiters[index] ?? '');
    if (alignment) cell.style.textAlign = alignment;
    appendInline(cell, header);
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  let cursor = start + 2;
  while (cursor < lines.length) {
    const sourceRow = lines[cursor];
    if (sourceRow === undefined || !sourceRow.trim() || !sourceRow.includes('|')) break;
    const row = document.createElement('tr');
    const cells = tableCells(sourceRow);
    for (let index = 0; index < headers.length; index++) {
      const cell = document.createElement('td');
      const alignment = tableAlignment(delimiters[index] ?? '');
      if (alignment) cell.style.textAlign = alignment;
      appendInline(cell, cells[index] ?? '');
      row.appendChild(cell);
    }
    body.appendChild(row);
    cursor += 1;
  }
  table.appendChild(body);
  wrapper.appendChild(table);
  target.appendChild(wrapper);
  return cursor;
}

export function renderMarkdown(target: HTMLElement, source: string): void {
  target.textContent = '';
  const lines = normaliseAssistantMarkdown(source).split('\n');
  let index = 0;
  let list: HTMLElement | null = null;
  const endList = () => {
    list = null;
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (/^\s*```/.test(line)) {
      endList();
      const language = line.replace(/^\s*```/, '').trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const codeLine = lines[index];
        if (codeLine === undefined || /^\s*```/.test(codeLine)) break;
        body.push(codeLine);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      pre.className = 'md-pre';
      const code = document.createElement('code');
      code.textContent = body.join('\n');
      if (language) pre.dataset.lang = language;
      pre.appendChild(code);
      target.appendChild(pre);
      continue;
    }

    if (isTableStart(lines, index)) {
      endList();
      index = appendTable(target, lines, index);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      endList();
      const element = document.createElement('div');
      element.className = `md-h md-h${(heading[1] ?? '').length}`;
      appendInline(element, heading[2] ?? '');
      target.appendChild(element);
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      endList();
      target.appendChild(document.createElement('hr'));
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const itemText = (bullet ?? numbered)?.[1] ?? '';
      if (!list || (numbered && list.tagName !== 'OL') || (bullet && list.tagName !== 'UL')) {
        list = document.createElement(numbered ? 'ol' : 'ul');
        list.className = 'md-list';
        target.appendChild(list);
      }
      const item = document.createElement('li');
      appendInline(item, itemText);
      list.appendChild(item);
      index += 1;
      continue;
    }

    if (!line.trim()) {
      endList();
      index += 1;
      continue;
    }

    endList();
    const paragraph: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index];
      if (
        paragraphLine === undefined ||
        !paragraphLine.trim() ||
        /^\s*```/.test(paragraphLine) ||
        /^(#{1,4})\s+/.test(paragraphLine) ||
        /^\s*[-*+]\s+/.test(paragraphLine) ||
        /^\s*\d+[.)]\s+/.test(paragraphLine) ||
        isTableStart(lines, index)
      ) break;
      paragraph.push(paragraphLine);
      index += 1;
    }
    const element = document.createElement('p');
    element.className = 'md-p';
    appendInline(element, paragraph.join('\n'));
    target.appendChild(element);
  }
}
