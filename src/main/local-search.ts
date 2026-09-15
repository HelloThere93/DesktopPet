import { opendir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { Dirent } from 'node:fs';
import type { LocalSearchResult } from '../shared/types';
import { searchConversations } from './db';
import { readBoundedTextFile } from './bounded-file';
import * as assignments from './assignments';
import * as goals from './goals';
import * as projects from './projects';
import { isSensitiveName, redactSecrets, sensitiveRead } from './redaction';
import * as research from './research';
import { listLessonEntries, listWorkflowSummaries } from './tools/custom';
import { validateWorkspaceRoot } from './workspace';
import { throwIfAborted } from './abort';
import { expandSemanticTerms, normaliseSemanticSearchTerms } from './semantic-terms';

export const MAX_LOCAL_SEARCH_QUERY_CHARS = 200;
export const MAX_LOCAL_SEARCH_RESULTS = 40;
const MAX_LOCAL_SEARCH_BODY_CHARS = 12_000;
const MAX_WORKSPACE_FILE_DEPTH = 6;
const MAX_WORKSPACE_FILE_ENTRIES = 1_200;
const MAX_WORKSPACE_FILE_READS = 160;
const MAX_WORKSPACE_FILE_BYTES = 120_000;
const MAX_WORKSPACE_FILE_TOTAL_BYTES = 2_000_000;
const MAX_WORKSPACE_FILE_RESULTS = 40;
const SKIP_WORKSPACE_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__']);
const SEARCHABLE_WORKSPACE_EXTENSIONS = new Set([
  '.bat', '.c', '.cc', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.htm', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.log', '.md', '.markdown', '.mjs', '.py',
  '.ps1', '.rs', '.scss', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

interface SearchCandidate {
  result: LocalSearchResult;
  searchable: string;
  priority: number;
}

export function normaliseLocalSearchTerms(query: string): string[] {
  return normaliseSemanticSearchTerms(query, 12);
}

function normaliseSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function matchesSearchTerms(haystack: string, terms: readonly string[], phrase: string): boolean {
  return (phrase.length >= 3 && haystack.includes(phrase)) || terms.some((term) => haystack.includes(term));
}

export function matchesLocalSearchText(text: string, query: string): boolean {
  const terms = expandSemanticTerms(normaliseLocalSearchTerms(query));
  if (!terms.length) return false;
  return matchesSearchTerms(
    normaliseSearchText(text),
    terms,
    normaliseSearchText(query.slice(0, MAX_LOCAL_SEARCH_QUERY_CHARS)),
  );
}

export function searchSnippet(text: string, query: string, maxCharacters = 280): string {
  const safe = redactSecrets(String(text)).replace(/\s+/g, ' ').trim();
  if (!safe) return '';
  const requestedLimit = Number.isFinite(maxCharacters) ? Math.trunc(maxCharacters) : 280;
  const limit = Math.max(40, Math.min(400, requestedLimit));
  if (safe.length <= limit) return safe;
  const lower = safe.toLocaleLowerCase();
  const terms = expandSemanticTerms(normaliseLocalSearchTerms(query));
  const position = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, position - 72);
  const prefix = start > 0 ? '…' : '';
  const end = Math.min(safe.length, start + limit - prefix.length - 1);
  const suffix = end < safe.length ? '…' : '';
  return prefix + safe.slice(start, end).trim() + suffix;
}

function safeUpdatedAt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function addCandidate(
  candidates: SearchCandidate[],
  query: string,
  kind: LocalSearchResult['kind'],
  id: string,
  title: string,
  body: string,
  updatedAt: number,
  priority: number,
  conversationKind?: LocalSearchResult['conversationKind'],
  archived?: LocalSearchResult['archived'],
): void {
  const safeTitle = redactSecrets(title).replace(/\s+/g, ' ').trim().slice(0, 240);
  const safeBody = redactSecrets(body).replace(/\s+/g, ' ').trim().slice(0, MAX_LOCAL_SEARCH_BODY_CHARS);
  if (!safeTitle && !safeBody) return;
  candidates.push({
    result: {
      kind,
      id: id.slice(0, 120),
      title: safeTitle || 'Untitled',
      snippet: searchSnippet(safeBody || safeTitle, query),
      updatedAt: safeUpdatedAt(updatedAt, 0),
      ...(conversationKind ? { conversationKind } : {}),
      ...(archived ? { archived: true } : {}),
    },
    searchable: safeTitle + ' ' + safeBody,
    priority,
  });
}

function candidateScore(
  candidate: SearchCandidate,
  directTerms: readonly string[],
  semanticTerms: readonly string[],
  phrase: string,
): number {
  const haystack = normaliseSearchText(candidate.searchable);
  const title = normaliseSearchText(candidate.result.title);
  let score = candidate.priority;
  if (phrase.length >= 3 && haystack.includes(phrase)) score += 8;
  for (const term of directTerms) {
    if (haystack.includes(term)) score += title.includes(term) ? 4 : 2;
  }
  const directSet = new Set(directTerms);
  for (const term of semanticTerms) {
    if (directSet.has(term)) continue;
    if (haystack.includes(term)) score += title.includes(term) ? 2 : 1;
  }
  return score;
}

function candidateMatches(
  candidate: SearchCandidate,
  semanticTerms: readonly string[],
  phrase: string,
): boolean {
  const haystack = normaliseSearchText(candidate.searchable);
  return matchesSearchTerms(haystack, semanticTerms, phrase);
}

function assignmentSearchBody(assignment: assignments.Assignment): string {
  return [
    assignment.subject,
    assignment.description,
    assignment.rubric,
    assignment.goalId,
    assignment.projectId,
    ...assignment.checklist.map((item) => item.text),
    ...assignment.notes.slice(-8).map((note) => note.note),
    ...assignment.sources,
    ...assignment.teacherFeedback.slice(-6).map((note) => note.note),
    ...assignment.research.slice(-8).flatMap((entry) => [entry.source, entry.finding]),
    ...assignment.citations.slice(-8),
    ...assignment.learningGoals.slice(-8),
    ...assignment.generatedMaterial.slice(-8),
  ]
    .filter(Boolean)
    .join(' ');
}

function researchSearchBody(record: research.ResearchRecord): string {
  return [
    record.sourceKind,
    record.source,
    record.query,
    record.finding,
    record.citation,
    record.projectId,
    record.assignmentId,
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildProjectSearchBody(
  project: projects.Project,
  linkedAssignments: readonly assignments.Assignment[],
  linkedResearch: readonly research.ResearchRecord[],
): string {
  return [
    project.status,
    project.description,
    'linked assignments: ' + linkedAssignments.length,
    ...linkedAssignments.map((assignment) => [assignment.title, assignmentSearchBody(assignment)].filter(Boolean).join(' ')),
    'linked research records: ' + linkedResearch.length,
    ...linkedResearch.map((record) => [record.title, researchSearchBody(record)].filter(Boolean).join(' ')),
  ]
    .filter(Boolean)
    .join(' ');
}

function normaliseSearchLimit(value: number | undefined): number {
  const requested = Number.isFinite(value) ? Math.trunc(value as number) : MAX_LOCAL_SEARCH_RESULTS;
  return Math.min(Math.max(requested, 1), MAX_LOCAL_SEARCH_RESULTS);
}

function safeWorkspaceRelativePath(value: string): boolean {
  const clean = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return false;
  const parts = clean.split('/').filter(Boolean);
  if (parts.some((part) => SKIP_WORKSPACE_NAMES.has(part.toLocaleLowerCase()) || isSensitiveName(part))) return false;
  return !sensitiveRead(clean);
}

function workspaceFileExcerpt(text: string, query: string): string {
  const safe = redactSecrets(text).replace(/\u0000/g, ' ').trim();
  return safe ? searchSnippet(safe, query, 380) : '';
}

function workspaceFileResult(relativePath: string, snippet: string, query: string, updatedAt: number): LocalSearchResult {
  const cleanPath = redactSecrets(relativePath.replace(/\\/g, '/')).slice(0, 400);
  return {
    kind: 'file',
    id: cleanPath.slice(0, 120),
    title: 'File: ' + cleanPath.slice(0, 240),
    snippet: searchSnippet([cleanPath, snippet].filter(Boolean).join(' — '), query, 280),
    updatedAt: safeUpdatedAt(updatedAt, 0),
  };
}

async function readDirectoryWindow(dir: string, maximum: number, signal?: AbortSignal): Promise<Dirent[]> {
  throwIfAborted(signal);
  const entries: Dirent[] = [];
  const limit = Math.max(1, Math.floor(maximum));
  const directory = await opendir(dir);
  try {
    while (entries.length < limit) {
      throwIfAborted(signal);
      const entry = await directory.read();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  throwIfAborted(signal);
  return entries;
}

/** Searches a selected root only after the user explicitly enables file search. */
export async function searchWorkspaceFiles(
  root: string,
  query: string,
  limit = MAX_WORKSPACE_FILE_RESULTS,
  signal?: AbortSignal,
): Promise<LocalSearchResult[]> {
  throwIfAborted(signal);
  const terms = normaliseLocalSearchTerms(query);
  if (!terms.length) return [];
  const safeLimit = normaliseSearchLimit(limit);
  let base: string;
  try {
    base = validateWorkspaceRoot(root);
  } catch {
    return [];
  }

  const found: LocalSearchResult[] = [];
  let visited = 0;
  let reads = 0;
  let readBytes = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    if (depth > MAX_WORKSPACE_FILE_DEPTH || visited >= MAX_WORKSPACE_FILE_ENTRIES || found.length >= safeLimit) return;
    let entries;
    try {
      entries = await readDirectoryWindow(dir, MAX_WORKSPACE_FILE_ENTRIES - visited, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      throwIfAborted(signal);
      if (visited >= MAX_WORKSPACE_FILE_ENTRIES || found.length >= safeLimit) return;
      visited += 1;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      const relativePath = relative(base, fullPath).replace(/\\/g, '/');
      if (!safeWorkspaceRelativePath(relativePath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const pathMatch = matchesLocalSearchText(relativePath, query);
      let contentMatch = false;
      let excerpt = '';
      let updatedAt = 0;
      try {
        throwIfAborted(signal);
        const info = await stat(fullPath);
        throwIfAborted(signal);
        updatedAt = info.mtimeMs;
        const extension = extname(entry.name).toLocaleLowerCase();
        if (
          SEARCHABLE_WORKSPACE_EXTENSIONS.has(extension) &&
          info.size <= MAX_WORKSPACE_FILE_BYTES &&
          reads < MAX_WORKSPACE_FILE_READS &&
          readBytes + info.size <= MAX_WORKSPACE_FILE_TOTAL_BYTES
        ) {
          const bounded = await readBoundedTextFile(fullPath, MAX_WORKSPACE_FILE_BYTES, signal);
          throwIfAborted(signal);
          reads += 1;
          readBytes += bounded.bytesRead;
          if (!bounded.truncated && !bounded.text.includes('\\u0000')) {
            const safeContent = redactSecrets(bounded.text);
            contentMatch = matchesLocalSearchText(safeContent, query);
            if (contentMatch) excerpt = workspaceFileExcerpt(safeContent, query);
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        /* Files can disappear or be locked while the bounded scan runs. */
      }

      throwIfAborted(signal);
      if (!pathMatch && !contentMatch) continue;
      found.push(workspaceFileResult(relativePath, excerpt || 'Filename match.', query, updatedAt));
    }
  }

  await walk(base, 0);
  throwIfAborted(signal);
  return found;
}
export interface LocalSearchOptions {
  limit?: number;
  includeWorkspaceFiles?: boolean;
  workspaceRoot?: string;
  signal?: AbortSignal;
}

export async function searchLocalWorkspace(
  query: string,
  options: LocalSearchOptions = {},
): Promise<LocalSearchResult[]> {
  throwIfAborted(options.signal);
  const terms = normaliseLocalSearchTerms(query);
  if (!terms.length) return [];
  const semanticTerms = expandSemanticTerms(terms);
  const safeLimit = normaliseSearchLimit(options.limit);
  const phrase = normaliseSearchText(query.slice(0, MAX_LOCAL_SEARCH_QUERY_CHARS));
  const candidates: SearchCandidate[] = [];

  const storedAssignments = assignments.loadAssignments();
  const storedResearch = research.loadResearch();
  const storedProjects = projects.loadProjects();
  for (const hit of searchConversations(query, safeLimit)) {
    addCandidate(
      candidates,
      query,
      'conversation',
      String(hit.id),
      hit.title || 'Untitled conversation',
      hit.snippet,
      hit.updatedAt,
      7,
      hit.kind,
      hit.archived,
    );
  }

  for (const entry of listLessonEntries().entries) {
    addCandidate(
      candidates,
      query,
      'memory',
      String(entry.index),
      'Saved note #' + entry.index,
      entry.text,
      Date.parse(entry.date + 'T00:00:00Z') || 0,
      5,
    );
  }

  for (const goal of goals.loadGoals()) {
    const body = [
      goal.status,
      goal.detail,
      ...goal.progress.slice(-8).map((progress) => progress.note),
    ]
      .filter(Boolean)
      .join(' ');
    const updatedAt = Math.max(
      goal.createdAt,
      ...goal.progress.map((progress) => progress.at),
      0,
    );
    addCandidate(candidates, query, 'goal', goal.id, 'Goal: ' + goal.title, body, updatedAt, goal.status === 'active' ? 7 : 3);
  }

  for (const assignment of storedAssignments) {
    const body = assignmentSearchBody(assignment);
    const updatedAt = Math.max(
      assignment.createdAt,
      ...assignment.notes.map((note) => note.at),
      ...assignment.teacherFeedback.map((note) => note.at),
      ...assignment.research.map((entry) => entry.at),
      0,
    );
    addCandidate(candidates, query, 'assignment', assignment.id, 'Assignment: ' + assignment.title, body, updatedAt, assignment.status === 'active' ? 7 : 3);
  }

  for (const record of research.loadResearch()) {
    const body = [
      record.sourceKind,
      record.source,
      record.query,
      record.finding,
      record.citation,
      record.projectId,
      record.assignmentId,
    ]
      .filter(Boolean)
      .join(' ');
    addCandidate(candidates, query, 'research', record.id, 'Research: ' + record.title, body, record.capturedAt, 5);
  }

  for (const project of storedProjects) {
    const linkedAssignments = storedAssignments.filter((assignment) => assignment.projectId === project.id);
    const linkedResearch = storedResearch.filter((record) => record.projectId === project.id);
    addCandidate(
      candidates,
      query,
      'project',
      project.id,
      'Project: ' + project.name,
      buildProjectSearchBody(project, linkedAssignments, linkedResearch),
      project.createdAt,
      project.status === 'active' || project.status === 'paused' ? 6 : 3,
    );
  }

  for (const workflow of listWorkflowSummaries()) {
    addCandidate(
      candidates,
      query,
      'workflow',
      workflow.name,
      'Workflow: ' + workflow.name,
      [workflow.description, ...workflow.steps].filter(Boolean).join(' '),
      Date.parse(workflow.createdAt) || 0,
      5,
    );
  }

  if (options.includeWorkspaceFiles && options.workspaceRoot?.trim()) {
    const fileResults = await searchWorkspaceFiles(options.workspaceRoot, query, safeLimit, options.signal);
    for (const result of fileResults) {
      addCandidate(
        candidates,
        query,
        'file',
        result.id,
        result.title,
        result.snippet,
        result.updatedAt,
        4,
      );
    }
  }

  throwIfAborted(options.signal);
  return candidates
    .filter((candidate) => candidateMatches(candidate, semanticTerms, phrase))
    .map((candidate, index) => ({
      candidate,
      score: candidateScore(candidate, terms, semanticTerms, phrase),
      index,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.result.updatedAt - a.candidate.result.updatedAt ||
        a.index - b.index,
    )
    .slice(0, safeLimit)
    .map(({ candidate }) => candidate.result);
}
