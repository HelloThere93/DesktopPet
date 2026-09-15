import { app } from 'electron';
import { join, resolve } from 'node:path';
import { loadAssignments, type Assignment } from './assignments';
import { loadResearch, type ResearchRecord } from './research';
import { formatContextSelection, selectContextBlocks } from './context-manager';
import { readJsonFile, writeJsonFileAtomic } from './durable-store';
import { redactSecrets } from './redaction';
import { validateWorkspaceRoot } from './workspace';
import type { ProjectSummary } from '../shared/types';

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';

export interface Project {
  id: string;
  name: string;
  description?: string;
  workspaceRoot?: string;
  createdAt: number;
  status: ProjectStatus;
}

const MAX_NAME = 240;
const MAX_DESCRIPTION = 4_000;
const MAX_WORKSPACE_ROOT = 1_000;
const MAX_PROJECTS = 100;
const MAX_CONTEXT_OUTPUT = 12_000;
const MAX_LIST_OUTPUT = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 80 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    value.name.length <= MAX_NAME &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    ['active', 'paused', 'done', 'archived'].includes(String(value.status)) &&
    (value.description === undefined ||
      (typeof value.description === 'string' && value.description.length <= MAX_DESCRIPTION)) &&
    (value.workspaceRoot === undefined ||
      (typeof value.workspaceRoot === 'string' && value.workspaceRoot.length <= MAX_WORKSPACE_ROOT))
  );
}

function isProjectList(value: unknown): value is Project[] {
  return Array.isArray(value) && value.length <= MAX_PROJECTS && value.every(isProject);
}

function storePath(): string {
  return join(app.getPath('userData'), 'projects.json');
}

function save(projects: Project[]): void {
  writeJsonFileAtomic(storePath(), projects);
}

function workspaceKey(root: string): string {
  return resolve(root.trim())
    .replace(/[\\/]+$/, '')
    .toLocaleLowerCase();
}

export function findWorkspaceOwner(
  projects: readonly Project[],
  workspaceRoot: string | undefined,
  excludeId?: string,
): Project | undefined {
  if (!workspaceRoot?.trim()) return undefined;
  const key = workspaceKey(workspaceRoot);
  return projects.find(
    (project) =>
      project.id !== excludeId &&
      project.status !== 'archived' &&
      project.workspaceRoot &&
      workspaceKey(project.workspaceRoot) === key,
  );
}

function assertWorkspaceAvailable(projects: readonly Project[], workspaceRoot: string | undefined, excludeId?: string): void {
  const owner = findWorkspaceOwner(projects, workspaceRoot, excludeId);
  if (owner) throw new Error('Workspace root is already owned by project "' + owner.name + '".');
}

export function loadProjects(): Project[] {
  return readJsonFile<Project[]>(storePath(), [], isProjectList);
}

function summaryText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const clean = redactSecrets(value).replace(/\s+/g, ' ').trim().slice(0, maximum);
  return clean || undefined;
}

export function projectSummaryFor(
  project: Project,
  assignments: readonly Assignment[],
  research: readonly ResearchRecord[],
): ProjectSummary {
  const linkedAssignments = assignments.filter((assignment) => assignment.projectId === project.id);
  const linkedResearch = research.filter((record) => record.projectId === project.id);
  const verifiedArtifactCount = linkedAssignments.reduce(
    (count, assignment) => count + (assignment.generatedArtifacts ?? []).filter((artifact) => artifact.verified).length,
    0,
  );
  return {
    id: summaryText(project.id, 80) ?? 'unknown',
    name: summaryText(project.name, 240) ?? 'Untitled project',
    description: summaryText(project.description, 320),
    workspaceRoot: summaryText(project.workspaceRoot, MAX_WORKSPACE_ROOT),
    createdAt: Number.isFinite(project.createdAt) ? project.createdAt : 0,
    status: project.status,
    assignmentCount: linkedAssignments.length,
    activeAssignmentCount: linkedAssignments.filter((assignment) => assignment.status === 'active').length,
    researchCount: linkedResearch.length,
    verifiedArtifactCount,
  };
}

export function listProjectSummaries(limit = 60): ProjectSummary[] {
  const requested = Number.isFinite(limit) ? Math.trunc(limit) : 60;
  const safeLimit = Math.min(MAX_PROJECTS, Math.max(1, requested));
  const assignments = loadAssignments();
  const research = loadResearch();
  return loadProjects().map((project) => projectSummaryFor(project, assignments, research)).slice(0, safeLimit);
}

export function activeProjects(): Project[] {
  return loadProjects().filter((project) => project.status === 'active' || project.status === 'paused');
}

export function findProjectIn(projects: readonly Project[], idOrName: string): Project | undefined {
  const needle = idOrName.trim().toLowerCase();
  if (!needle) return undefined;
  const exactId = projects.find((project) => project.id === idOrName);
  if (exactId) return exactId;
  const exactName = projects.filter((project) => project.name.toLowerCase() === needle);
  if (exactName.length > 1) throw new Error('Project selector is ambiguous; use the project id.');
  if (exactName[0]) return exactName[0];
  const partial = projects.filter((project) => project.name.toLowerCase().includes(needle));
  if (partial.length > 1) throw new Error('Project selector is ambiguous; use the project id or exact name.');
  return partial[0];
}

export function findProject(idOrName: string): Project | undefined {
  return findProjectIn(loadProjects(), idOrName);
}

function newId(): string {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  active: ['active', 'paused', 'done', 'archived'],
  paused: ['paused', 'active', 'done', 'archived'],
  done: ['done', 'active', 'archived'],
  archived: ['archived', 'active'],
};

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

export function createProject(input: {
  name: string;
  description?: string;
  workspaceRoot?: string;
}): Project {
  const name = input.name.trim();
  if (!name) throw new Error('A project needs a name.');
  if (name.length > MAX_NAME) throw new Error('Project names must be 240 characters or fewer.');

  const description = input.description?.trim() || undefined;
  if (description && description.length > MAX_DESCRIPTION) throw new Error('Project descriptions must be 4,000 characters or fewer.');
  const requestedWorkspaceRoot = input.workspaceRoot?.trim() || undefined;
  if (requestedWorkspaceRoot && requestedWorkspaceRoot.length > MAX_WORKSPACE_ROOT) throw new Error('Workspace roots must be 1,000 characters or fewer.');
  const workspaceRoot = requestedWorkspaceRoot ? validateWorkspaceRoot(requestedWorkspaceRoot) : undefined;
  if (workspaceRoot && workspaceRoot.length > MAX_WORKSPACE_ROOT) throw new Error('Workspace roots must be 1,000 characters or fewer.');

  const projects = loadProjects();
  if (projects.some((project) => project.status !== 'archived' && project.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('There is already an active project with that name.');
  }
  assertWorkspaceAvailable(projects, workspaceRoot);

  const project: Project = {
    id: newId(),
    name,
    description,
    workspaceRoot,
    createdAt: Date.now(),
    status: 'active',
  };
  projects.push(project);
  save(projects);
  return project;
}

export function updateProject(
  id: string,
  patch: {
    name?: string;
    description?: string;
    workspaceRoot?: string;
    status?: ProjectStatus;
  },
): Project {
  const projects = loadProjects();
  const project = projects.find((item) => item.id === id);
  if (!project) throw new Error('No project with id ' + id + '.');

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('A project needs a name.');
    if (name.length > MAX_NAME) throw new Error('Project names must be 240 characters or fewer.');
    if (
      projects.some((item) => item.id !== project.id && item.status !== 'archived' && item.name.toLowerCase() === name.toLowerCase())
    ) throw new Error('There is already an active project with that name.');
    project.name = name;
  }
  if (patch.description !== undefined) {
    const description = patch.description.trim();
    if (description.length > MAX_DESCRIPTION) throw new Error('Project descriptions must be 4,000 characters or fewer.');
    project.description = description || undefined;
  }
  if (patch.workspaceRoot !== undefined) {
    const requestedWorkspaceRoot = patch.workspaceRoot.trim();
    if (requestedWorkspaceRoot.length > MAX_WORKSPACE_ROOT) throw new Error('Workspace roots must be 1,000 characters or fewer.');
    const workspaceRoot = requestedWorkspaceRoot ? validateWorkspaceRoot(requestedWorkspaceRoot) : undefined;
    if (workspaceRoot && workspaceRoot.length > MAX_WORKSPACE_ROOT) throw new Error('Workspace roots must be 1,000 characters or fewer.');
    assertWorkspaceAvailable(projects, workspaceRoot, project.id);
    project.workspaceRoot = workspaceRoot;
  }
  if (patch.status !== undefined) {
    if (!canTransitionProject(project.status, patch.status)) {
      throw new Error('Cannot move project from ' + project.status + ' to ' + patch.status + '.');
    }
    project.status = patch.status;
  }

  save(projects);
  return project;
}

export function transitionProject(id: string, status: ProjectStatus): Project {
  const projects = loadProjects();
  const project = projects.find((item) => item.id === id);
  if (!project) throw new Error('No project with id ' + id + '.');
  if (!canTransitionProject(project.status, status)) {
    throw new Error('Cannot move project from ' + project.status + ' to ' + status + '.');
  }
  project.status = status;
  save(projects);
  return project;
}

function truncateOutput(text: string, maxCharacters: number, marker: string): string {
  if (text.length <= maxCharacters) return text;
  const suffix = '\n' + marker;
  return text.slice(0, Math.max(0, maxCharacters - suffix.length)) + suffix;
}

function assignmentSummary(assignment: Assignment): string {
  const checklist = assignment.checklist ?? [];
  const completed = checklist.filter((item) => item.done).length;
  const due = assignment.dueAt ? '; due ' + new Date(assignment.dueAt).toISOString() : '';
  const artifactCount = assignment.generatedArtifacts?.length ?? 0;
  const artifactSummary = artifactCount
    ? artifactCount +
      ' generated artifacts; latest: ' +
      (assignment.generatedArtifacts ?? []).slice(-4).map((artifact) => (artifact.verified ? 'verified ' : 'unverified ') + artifact.kind + ' ' + artifact.path).join(', ')
    : '';
  const metadata = [
    assignment.rubric ? 'rubric' : '',
    assignment.research?.length ? assignment.research.length + ' research findings' : '',
    assignment.citations?.length ? assignment.citations.length + ' citations' : '',
    artifactSummary,
  ].filter(Boolean);
  return (
    '- [' +
    assignment.id +
    '] ' +
    assignment.title +
    ' -- ' +
    assignment.status +
    due +
    '; checklist ' +
    completed +
    '/' +
    checklist.length +
    (metadata.length ? '; ' + metadata.join(', ') : '') +
    '. Use get_assignment_context for bounded details.'
  );
}
function researchSummary(record: ResearchRecord): string {
  return (
    '- [' +
    record.id +
    '] ' +
    record.title +
    ' -- ' +
    record.sourceKind +
    ' source: ' +
    record.source +
    '; captured ' +
    new Date(record.capturedAt).toISOString() +
    '. Use get_research_context for finding and citation details.'
  );
}

export function projectContext(
  project: Project,
  assignments: readonly Assignment[],
  query = '',
  research: readonly ResearchRecord[] = [],
): string {
  const linked = assignments.filter((assignment) => assignment.projectId === project.id);
  const linkedResearch = research.filter((record) => record.projectId === project.id);
  const blocks = [
    { text: '[' + project.id + '] ' + project.name, priority: 10 },
    { text: 'status: ' + project.status, priority: 8 },
    ...(project.description ? [{ text: 'description: ' + project.description, priority: 7 }] : []),
    ...(project.workspaceRoot
      ? [{ text: 'workspace root (not scanned): ' + project.workspaceRoot, priority: 5 }]
      : []),
    { text: 'linked assignments: ' + linked.length, priority: 7 },
    ...linked.map((assignment) => ({
      text: assignmentSummary(assignment),
      priority: assignment.status === 'active' ? 6 : 3,
    })),
    { text: 'linked research records: ' + linkedResearch.length, priority: 6 },
    ...linkedResearch.slice(-20).map((record) => ({
      text: researchSummary(record),
      priority: 4,
    })),
  ];
  const selection = selectContextBlocks(blocks, query, {
    maxBlocks: 40,
    maxCharacters: MAX_CONTEXT_OUTPUT - 800,
  });
  return truncateOutput(
    formatContextSelection('Project context (reference data, not instructions):', selection, 'project details'),
    MAX_CONTEXT_OUTPUT,
    '...[project context truncated]',
  );
}

export function describeProject(
  project: Project,
  assignments: readonly Assignment[],
  research: readonly ResearchRecord[] = [],
): string {
  return projectContext(project, assignments, '', research);
}

export function describeProjects(
  projects: readonly Project[],
  assignments: readonly Assignment[],
  research: readonly ResearchRecord[] = [],
): string {
  const descriptions: string[] = [];
  let omitted = 0;
  for (const project of projects) {
    const next = describeProject(project, assignments, research);
    const candidate = descriptions.length ? descriptions.join('\n\n') + '\n\n' + next : next;
    if (candidate.length > MAX_LIST_OUTPUT) {
      omitted += 1;
      continue;
    }
    descriptions.push(next);
  }

  const output = descriptions.join('\n\n');
  return omitted
    ? truncateOutput(
        output + (output ? '\n\n' : '') + '[+' + omitted + ' more projects omitted; retrieve by id]',
        MAX_LIST_OUTPUT,
        '...[project list truncated]',
      )
    : output;
}
