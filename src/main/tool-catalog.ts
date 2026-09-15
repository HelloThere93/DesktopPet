import type { PermissionTier } from '../shared/types';

export type ToolProvider = 'builtin' | 'custom' | 'mcp';
export type ToolRiskLevel = 'passive' | 'low' | 'modification' | 'sensitive';
export type ToolAvailability =
  | 'available'
  | 'unavailable'
  | 'disabled'
  | 'degraded';

const CAPABILITY_GROUPS = [
  ['web', 'internet', 'online', 'browser', 'chrome'],
  ['search', 'lookup', 'research', 'find'],
  ['file', 'document', 'pdf', 'text'],
  ['folder', 'directory'],
  ['read', 'open', 'inspect', 'view'],
  ['write', 'edit', 'modify', 'update', 'save'],
  ['code', 'program', 'script', 'developer'],
  ['image', 'picture', 'photo', 'screenshot', 'screen'],
  ['calendar', 'schedule', 'appointment', 'meeting'],
  ['email', 'mail', 'message'],
  ['spreadsheet', 'excel', 'csv', 'table'],
  ['terminal', 'shell', 'command', 'powershell', 'cmd'],
  ['clipboard', 'copy', 'paste'],
  ['window', 'desktop', 'application', 'app'],
  ['reminder', 'todo', 'task'],
  ['audio', 'sound', 'volume'],
  ['network', 'http', 'url', 'download'],
  ['database', 'sql', 'query'],
  ['mcp', 'integration', 'service'],
  ['skill', 'plugin', 'extension', 'capability', 'package'],
  ['research', 'academic', 'scholar', 'scholarly', 'paper', 'papers', 'citation', 'citations', 'literature', 'journal', 'source', 'sources'],
  ['student', 'school', 'class', 'classroom', 'course', 'assignment', 'homework', 'study', 'exam', 'lesson'],
  ['workspace', 'project', 'repository', 'repo', 'files', 'folder', 'directory'],
  ['planning', 'plan', 'planner', 'planning', 'goal', 'task', 'todo', 'deadline', 'milestone', 'schedule', 'reminder'],
  ['memory', 'remember', 'lesson', 'notes', 'note', 'context', 'knowledge'],
] as const;

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'for', 'from', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'please', 'relevant', 'that', 'the', 'this', 'to',
  'use', 'using', 'with', 'would', 'all', 'every', 'quick', 'quickly',
  'check', 'log', 'summarize', 'summarise', 'work',
]);

function queryWords(value: string): string[] {
  return words(value).filter((term) => !QUERY_STOP_WORDS.has(term));
}

function expandSemanticGroups(terms: Set<string>): Set<string> {
  // Expand from the caller's original words only. Mutating `terms` while also
  // using it as the trigger caused accidental transitive chains such as
  // homework -> lesson -> memory -> context, which loaded system/memory tools
  // for a Classroom request.
  const seeds = new Set(terms);
  for (const group of CAPABILITY_GROUPS) {
    if (group.some((term) => seeds.has(term))) {
      for (const term of group) terms.add(term);
    }
  }
  return terms;
}

/** Returns the related capability vocabulary used for semantic discovery. */
export function capabilityTermsForName(name: string): string[] {
  return [...expandSemanticGroups(new Set(words(name)))];
}

function semanticTermsForQuery(query: string): {
  direct: string[];
  expanded: Set<string>;
} {
  const direct = queryWords(query);
  return { direct, expanded: expandSemanticGroups(new Set(direct)) };
}

export interface ToolMetadata {
  provider?: ToolProvider;
  permissionTier?: PermissionTier;
  riskLevel?: ToolRiskLevel;
  requiresConfirmation?: boolean;
  timeoutMs?: number;
  modifiesState?: boolean;
  reversible?: boolean | 'unknown';
  availability?: ToolAvailability;
  availabilityReason?: string;
  callable?: boolean;
  capabilityTerms?: string[];
  capabilityTags?: string[];
  dependency?: string;
  outputSchema?: Record<string, unknown>;
}

export interface ToolDefinition extends ToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface QueryIntent {
  observes: boolean;
  managesRecords: boolean;
  classroom: boolean;
  manageBac: boolean;
  school: boolean;
  login: boolean;
  browser: boolean;
  multi: boolean;
  tabRead: boolean;
  form: boolean;
  screenClick: boolean;
  pdfBatch: boolean;
  skillInstall: boolean;
  publicLookup: boolean;
}

function queryIntent(query: string): QueryIntent {
  const text = query.toLowerCase();
  const observes = /\b(?:check|read|find|show|inspect|summari[sz]e|what|next|upcoming|latest|go through)\b/.test(text);
  const managesRecords = /\b(?:remember|save|record|track|create|add|update|edit|delete|remove|mark|complete)\b/.test(text);
  const classroom = /\b(?:google\s+classroom|classroom|classrooms)\b/.test(text);
  const manageBac = /\bmanage\s*bac\b/.test(text);
  const school = classroom || manageBac || /\b(?:school|homework|coursework|study|exam|subject|unit|topic)\b/.test(text);
  const login = /\b(?:log\s*in|login|sign\s*in|signin|sign\s*up|signup|create\s+(?:an?\s+)?account|make\s+(?:an?\s+)?account)\b/.test(text);
  const browser = /\b(?:browser|chrome|tab|tabs|website|site|page|form)\b/.test(text) || manageBac || login;
  const multi = /\b(?:all|every|entire|multiple|several|across)\b/.test(text);
  const tabRead = browser && multi && observes && /\btabs?\b/.test(text);
  const form = /\bform\b/.test(text) && /\b(?:fill|submit|complete|enter|type)\b/.test(text);
  const screenClick = /\bscreen\b/.test(text) && /\b(?:find|click|press|select)\b/.test(text);
  const pdfBatch = multi && /\bpdfs?\b/.test(text);
  const skillInstall = /\b(?:skill|skills|plugin|plugins|extension|extensions)\b/.test(text) &&
    /\b(?:find|download|install|add|get)\b/.test(text);
  const publicLookup = /\b(?:find|search|look\s*up|who|net\s*worth|person)\b/.test(text) &&
    !browser && !school && !screenClick && !/\b(?:file|folder|document|email|mail)\b/.test(text);
  return {
    observes,
    managesRecords,
    classroom,
    manageBac,
    school,
    login,
    browser,
    multi,
    tabRead,
    form,
    screenClick,
    pdfBatch,
    skillInstall,
    publicLookup,
  };
}

function intentScore(tool: ToolDefinition, intent: QueryIntent): number {
  const name = tool.name.toLowerCase();
  const {
    observes,
    managesRecords,
    classroom,
    manageBac,
    school,
    login,
    browser,
    multi,
    tabRead,
    form,
    screenClick,
    pdfBatch,
    skillInstall,
    publicLookup,
  } = intent;
  let score = 0;

  if (classroom) {
    if (name === 'read_classroom') score += 260;
    if (name === 'read_google_doc') score += 90;
    if (name === 'chrome_tabs_context') score += 45;
  } else if (manageBac) {
    if (name === 'chrome_tabs_context') score += 260;
    if (name === 'chrome_page_context') score += 90;
    if (name === 'chrome_sequence') score += 70;
    if (name === 'read_google_doc') score += 60;
  } else if (school && observes) {
    if (name === 'read_classroom') score += 210;
    if (name === 'read_google_doc') score += 80;
  }

  if (school && !managesRecords && /(?:assignment|lesson|research|goal|project)/.test(name)) score -= 140;
  if (login) {
    if (name === 'chrome_continue_login') score += 280;
    if (name === 'chrome_use_profile' || name === 'chrome_list_profiles') score += 100;
    if (name === 'chrome_sequence' || name === 'chrome_snapshot') score += 75;
    if (name === 'chrome_page_context') score += 45;
  }
  if (multi && browser) {
    if (name === 'chrome_tabs_context') score += 180;
    if (name === 'chrome_sequence') score += 70;
    if (name === 'chrome_open_tab' || name === 'chrome_read_tab') score -= 35;
    if (observes && /^(?:chrome_open_tab|chrome_close_tabs|chrome_restart_for_automation)$/.test(name)) score -= 120;
  }
  if (tabRead && !/^(?:chrome_tabs_context|chrome_list_tabs|chrome_read_tab|chrome_page_context)$/.test(name)) {
    score -= 140;
  }
  if (form) {
    if (name === 'chrome_sequence') score += 220;
    if (name === 'chrome_fill_field' || name === 'chrome_set_value') score += 140;
    if (name === 'chrome_snapshot' || name === 'chrome_click_text') score += 90;
  }
  if (screenClick) {
    if (name === 'find_on_screen') score += 240;
    if (name === 'input_sequence' || name === 'mouse_click') score += 80;
  }
  if (pdfBatch) {
    if (name === 'read_files') score += 180;
    if (name === 'read_pdf') score += 140;
    if (name === 'file_tree' || name === 'search_files') score += 70;
    if (!/^(?:read_files|read_pdf|search_files|file_tree|read_file|read_document|file_info|read_lines|list_dir)$/.test(name)) {
      score -= 140;
    }
  }
  if (publicLookup) {
    if (name === 'web_search') score += 240;
    if (name === 'fetch_url') score += 70;
    if (name === 'research') score += 55;
    if (name === 'record_research_finding' || name.startsWith('add_assignment_')) score -= 140;
    if (name === 'network_info' || name === 'network_connections') score -= 220;
    if (!/^(?:web_search|web_search_bulk|fetch_url|fetch_url_bulk|research)$/.test(name)) score -= 140;
  }
  if (skillInstall) {
    if (name === 'find_skills') score += 260;
    if (name === 'install_skill') score += 230;
    if (name === 'preview_skill') score += 110;
    if (name === 'list_skills') score += 60;
    if (/^(?:create_skill|disable_skill|update_skill|remove_skill)$/.test(name)) score -= 140;
    if (!/^(?:install_skill|find_skills|preview_skill|inspect_skill|enable_skill|list_skills|download_file|fetch_url)$/.test(name)) {
      score -= 120;
    }
  }
  if (screenClick && !/^(?:find_on_screen|mouse_click|input_sequence|read_screen_text|screen_capture|type_text|paste_text)$/.test(name)) {
    score -= 120;
  }
  if (school && observes && !/^(?:read_classroom|read_google_doc|find_google_docs|chrome_tabs_context|chrome_page_context|chrome_sequence|chrome_use_profile|chrome_list_profiles|chrome_continue_login|read_gmail|read_gmail_message|read_document|read_pdf)$/.test(name)) {
    score -= 120;
  }
  if (login && !/^(?:chrome_continue_login|chrome_list_profiles|chrome_use_profile|chrome_snapshot|chrome_sequence|chrome_page_context|chrome_tabs_context|read_gmail_message)$/.test(name)) {
    score -= 120;
  }
  return score;
}

export interface ToolSummary {
  name: string;
  description: string;
  provider: ToolProvider;
  permissionTier?: PermissionTier;
  riskLevel?: ToolRiskLevel;
  requiresConfirmation?: boolean;
  timeoutMs?: number;
  modifiesState?: boolean;
  reversible?: boolean | 'unknown';
  availability?: ToolAvailability;
  availabilityReason?: string;
  callable?: boolean;
  capabilityTerms?: string[];
  capabilityTags?: string[];
  dependency?: string;
}
const CAPABILITY_DOMAIN_RULES = [
  {
    tag: 'research',
    names: [
      'research',
      'web_search',
      'web_search_bulk',
      'fetch_url',
      'fetch_url_bulk',
      'read_google_doc',
      'find_google_docs',
      'read_pdf',
      'chrome_read_tab',
      'chrome_tabs_context',
      'chrome_links',
      'chrome_tables',
      'record_research_finding',
      'list_research',
      'get_research_context',
    ],
    terms: ['academic', 'scholar', 'citation', 'literature', 'journal', 'paper', 'source'],
  },
  {
    tag: 'student',
    names: [
      'read_classroom',
      'chrome_tabs_context',
      'read_gmail',
      'read_gmail_message',
      'read_google_doc',
      'find_google_docs',
      'read_pdf',
      'remember_lesson',
      'list_lessons',
      'create_assignment',
      'list_assignments',
      'get_assignment',
      'update_assignment',
      'add_assignment_item',
      'complete_assignment_item',
      'add_assignment_note',
      'add_assignment_source',
      'get_assignment_context',
      'transition_assignment',
      'set_assignment_rubric',
      'add_assignment_feedback',
      'add_assignment_research',
      'add_assignment_citation',
      'add_assignment_learning_goal',
      'add_assignment_material',
      'create_project',
      'list_projects',
      'get_project',
      'update_project',
      'transition_project',
      'get_project_context',
      'record_research_finding',
      'list_research',
      'get_research_context',
    ],
    terms: ['classroom', 'assignment', 'school', 'student', 'homework', 'course', 'study', 'exam', 'lesson'],
  },
  {
    tag: 'workspace',
    names: [
      'workspace_context',
      'read_file',
      'list_dir',
      'write_file',
      'edit_file',
      'search_files',
      'search_text',
      'file_info',
      'read_lines',
      'append_file',
      'read_files',
      'read_document',
      'file_tree',
      'dir_size',
      'recent_files',
      'replace_in_files',
      'git_status',
      'git_log',
      'git_diff',
      'git_branches',
      'read_csv',
      'json_query',
      'open_path',
      'reveal_path',
      'create_project',
      'list_projects',
      'get_project',
      'update_project',
      'transition_project',
      'get_project_context',
    ],
    terms: ['workspace', 'project', 'repository', 'repo', 'folder', 'directory', 'document', 'spreadsheet', 'sheet', 'path'],
  },
  {
    tag: 'planning',
    names: [
      'set_goal',
      'list_goals',
      'add_goal_progress',
      'check_goal',
      'watch_goal',
      'finish_goal',
      'set_reminder',
      'list_reminders',
      'cancel_reminder',
      'create_workflow',
      'create_assignment',
      'list_assignments',
      'get_assignment',
      'update_assignment',
      'add_assignment_item',
      'complete_assignment_item',
      'add_assignment_note',
      'add_assignment_source',
      'get_assignment_context',
      'transition_assignment',
      'set_assignment_rubric',
      'add_assignment_feedback',
      'add_assignment_research',
      'add_assignment_citation',
      'add_assignment_learning_goal',
      'add_assignment_material',
      'create_project',
      'list_projects',
      'get_project',
      'update_project',
      'transition_project',
      'get_project_context',
      'record_research_finding',
      'list_research',
      'get_research_context',
    ],
    terms: ['goal', 'plan', 'planning', 'task', 'todo', 'deadline', 'milestone', 'schedule', 'reminder', 'workflow'],
  },
  {
    tag: 'memory',
    names: ['remember_lesson', 'list_lessons', 'edit_lesson', 'delete_lesson'],
    terms: ['memory', 'remember', 'lesson', 'notes', 'note', 'context', 'knowledge'],
  },
] as const;

export function capabilityTagsForTool(
  tool: Pick<ToolDefinition, 'name' | 'description' | 'capabilityTags'>,
): string[] {
  const name = tool.name.toLowerCase();
  const textTerms = new Set(words(tool.name + ' ' + tool.description));
  const tags = new Set(tool.capabilityTags ?? []);

  for (const rule of CAPABILITY_DOMAIN_RULES) {
    const nameMatch = rule.names.some(
      (pattern) => name === pattern || name.startsWith(pattern + '_'),
    );
    const textMatch = rule.terms.some((term) => textTerms.has(term));
    if (nameMatch || textMatch) tags.add(rule.tag);
  }

  return [...tags];
}

export function withToolMetadata(
  tool: ToolDefinition,
  metadata: ToolMetadata,
): ToolDefinition {
  return { ...tool, ...metadata };
}

interface ToolSearchIndex {
  name: string;
  nameTerms: Set<string>;
  descriptionTerms: Set<string>;
  providerTerms: Set<string>;
  dependencyTerms: Set<string>;
  capabilityTerms: Set<string>;
}

const TOOL_SEARCH_INDEX = new WeakMap<ToolDefinition, ToolSearchIndex>();

function searchIndexForTool(tool: ToolDefinition): ToolSearchIndex {
  const cached = TOOL_SEARCH_INDEX.get(tool);
  if (cached) return cached;
  const index = {
    name: tool.name.toLowerCase(),
    nameTerms: new Set(words(tool.name)),
    descriptionTerms: new Set(words(tool.description)),
    providerTerms: new Set(words(tool.provider ?? '')),
    dependencyTerms: new Set(words(tool.dependency ?? '')),
    capabilityTerms: new Set([
      ...capabilityTermsForName(tool.name),
      ...(tool.capabilityTerms ?? []).flatMap(words),
      ...(tool.capabilityTags ?? []),
    ]),
  };
  TOOL_SEARCH_INDEX.set(tool, index);
  return index;
}

function scoreTool(
  tool: ToolDefinition,
  directTerms: string[],
  direct: ReadonlySet<string>,
  semanticTerms: Set<string>,
  intent: QueryIntent,
): number {
  if (!directTerms.length) return 0;

  const {
    name,
    nameTerms,
    descriptionTerms,
    providerTerms,
    dependencyTerms,
    capabilityTerms,
  } = searchIndexForTool(tool);
  let score = 0;

  for (const term of directTerms) {
    if (name === term) score += 100;
    else if (nameTerms.has(term)) score += 30;
    if (descriptionTerms.has(term)) score += 10;
    if (providerTerms.has(term) || dependencyTerms.has(term)) score += 8;
    if (capabilityTerms.has(term)) score += 18;
  }

  let semanticScore = 0;
  for (const term of semanticTerms) {
    if (direct.has(term)) continue;
    if (capabilityTerms.has(term)) semanticScore += 7;
    else if (nameTerms.has(term)) semanticScore += 4;
    else if (descriptionTerms.has(term)) semanticScore += 2;
  }

  return score + Math.min(semanticScore, 21) + intentScore(tool, intent);
}

/**
 * Searches a unified catalog without exposing large parameter schemas. Results
 * are ranked by name first, then description, semantic capability, and
 * provider/dependency matches.
 */
export function searchToolCatalog(
  tools: readonly ToolDefinition[],
  query: string,
  limit = 12,
): ToolDefinition[] {
  const { direct, expanded } = semanticTermsForQuery(query);
  const directSet = new Set(direct);
  const intent = queryIntent(query);
  const capped = Math.min(Math.max(Math.floor(limit) || 12, 1), 50);

  return tools
    .map((tool, index) => ({
      tool,
      index,
      score: scoreTool(tool, direct, directSet, expanded, intent),
    }))
    // One incidental semantic overlap is weak evidence (for example both a
    // school tool and a memory tool mentioning "lesson"). Require either a
    // direct match or more than one independent semantic signal.
    .filter(({ score }) => !direct.length || score >= 8)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, capped)
    .map(({ tool }) => tool);
}

const CORE_ALWAYS_EXPOSED_TOOL_NAMES = ['find_tools'] as const;

const CAPABILITY_ALWAYS_EXPOSED_TOOL_NAMES = [
  'list_tools',
  'inspect_tool',
  'test_tool',
  'create_tool',
  'create_api_tool',
  'create_workflow',
  'update_tool',
  'delete_tool',
  'find_skills',
  'list_skills',
  'preview_skill',
  'install_skill',
  'create_skill',
  'inspect_skill',
  'enable_skill',
  'disable_skill',
  'update_skill',
  'remove_skill',
  'skills_folder',
] as const;

const CAPABILITY_MANAGEMENT_TOOL_NAMES = new Set<string>(CAPABILITY_ALWAYS_EXPOSED_TOOL_NAMES);

export function isCapabilityManagementRequest(query: string): boolean {
  const text = String(query).toLocaleLowerCase();
  return (
    /\b(?:plugins?|skills?|capabilit(?:y|ies)|integrations?|mcp(?:\s+servers?)?|extensions?|workflows?)\b/.test(text) ||
    /\b(?:what|which|list|show|find|add|create|build|make|inspect|test|update|delete|install|download)\b[^\n]{0,40}\btools?\b/.test(text) ||
    /\btools?\b[^\n]{0,40}\b(?:list|show|find|add|create|build|make|inspect|test|update|delete|install|download)\b/.test(text)
  );
}

export function isCapabilityManagementToolName(name: string): boolean {
  return CAPABILITY_MANAGEMENT_TOOL_NAMES.has(String(name));
}

/**
 * Keep the everyday prompt small while keeping capability-management tools
 * available when the user is actually asking about skills, plugins, or tools.
 */
export function alwaysExposedToolNamesForPrompt(query: string): string[] {
  // Capability-management requests are allowed to select these tools below,
  // but do not need every management schema injected up front. Relevance
  // ranking plus find_tools keeps the prompt smaller and puts the requested
  // operation before unrelated create/update/delete controls.
  void query;
  return [...CORE_ALWAYS_EXPOSED_TOOL_NAMES];
}
export interface ToolSelectionOptions {
  limit?: number;
  maxTools?: number;
  alwaysNames?: readonly string[];
  loadedNames?: readonly string[];
}

export function selectToolCatalog(
  tools: readonly ToolDefinition[],
  query: string,
  options: ToolSelectionOptions = {},
): ToolDefinition[] {
  const always = new Set(options.alwaysNames ?? []);
  const allowCapabilityManagement = isCapabilityManagementRequest(query);
  const selectable = tools.filter(
    (tool) =>
      (tool.availability ?? 'available') === 'available' &&
      tool.callable !== false &&
      (allowCapabilityManagement || !isCapabilityManagementToolName(tool.name)),
  );
  const maxTools = Math.min(
    Math.max(Math.floor(options.maxTools ?? 48) || 48, 1),
    100,
  );
  const selected: ToolDefinition[] = [];
  const seen = new Set<string>();
  const add = (tool: ToolDefinition) => {
    if (seen.has(tool.name)) return;
    seen.add(tool.name);
    selected.push(tool);
  };

  for (const tool of selectable) {
    if (always.has(tool.name)) add(tool);
  }
  const selectableByName = new Map(selectable.map((tool) => [tool.name, tool]));
  const loadedToolsRecentFirst: ToolDefinition[] = [];
  const loadedSeen = new Set<string>();
  const loadedNames = options.loadedNames ?? [];
  for (let index = loadedNames.length - 1; index >= 0; index -= 1) {
    const name = loadedNames[index];
    if (!name) continue;
    if (loadedSeen.has(name) || always.has(name)) continue;
    loadedSeen.add(name);
    const tool = selectableByName.get(name);
    if (tool) loadedToolsRecentFirst.push(tool);
  }
  const queryMatches = searchToolCatalog(selectable, query, options.limit ?? 24);
  const availableSlots = Math.max(0, maxTools - selected.length);
  const freshQueryMatches = queryMatches.filter((tool) => !seen.has(tool.name));
  const queryReserve = Math.min(
    freshQueryMatches.length,
    availableSlots ? Math.max(1, Math.ceil(availableSlots * 0.55)) : 0,
  );
  const loadedBudget = Math.max(0, availableSlots - queryReserve);

  // Preserve recent working tools, but never let a long task crowd the current
  // request's relevant schemas out of the prompt.
  if (loadedBudget) {
    for (const tool of loadedToolsRecentFirst.slice(0, loadedBudget).reverse()) add(tool);
  }
  for (const tool of queryMatches) {
    if (selected.length >= maxTools) break;
    add(tool);
  }
  for (const tool of loadedToolsRecentFirst) {
    if (selected.length >= maxTools) break;
    add(tool);
  }
  return selected;
}

export function summarizeTool(tool: ToolDefinition): ToolSummary {
  return {
    name: tool.name,
    description: tool.description.slice(0, 500),
    provider: tool.provider ?? 'builtin',
    permissionTier: tool.permissionTier,
    riskLevel: tool.riskLevel,
    requiresConfirmation: tool.requiresConfirmation,
    timeoutMs: tool.timeoutMs,
    modifiesState: tool.modifiesState,
    reversible: tool.reversible,
    availability: tool.availability,
    availabilityReason: tool.availabilityReason,
    callable: tool.callable,
    capabilityTerms: tool.capabilityTerms?.slice(0, 24),
    capabilityTags: tool.capabilityTags?.slice(0, 8),
    dependency: tool.dependency,
  };
}
