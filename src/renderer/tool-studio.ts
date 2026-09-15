import type {
  ToolStudioDefinition,
  ToolStudioKind,
  ToolStudioParam,
  ToolStudioSummary,
  ToolStudioToolCandidate,
  ToolStudioTestResult,
} from '../shared/types';

declare global {
  interface Window {
    adi: import('../main/preload').AdiApi;
  }
}

type Notice = (text: string) => void;
type ErrorNotice = (text: string) => void;

interface ToolStudioOptions {
  root: HTMLElement;
  onNotice: Notice;
  onError: ErrorNotice;
  onTestState?: (running: boolean) => void;
}

interface StudioDraftState {
  headerText: string;
  workflowArgTexts: string[];
  outputsText: string;
  effectsText: string;
  reasonText: string;
  testArgsText: string;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,80}$/;
const KINDS: ToolStudioKind[] = ['script', 'http', 'workflow'];
const LANGUAGES = ['powershell', 'python', 'node'] as const;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const element = make('button', className, label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function inputField(type: string, placeholder: string, value: string): HTMLInputElement {
  const element = make('input') as HTMLInputElement;
  element.type = type;
  element.placeholder = placeholder;
  element.value = value;
  element.autocomplete = 'off';
  return element;
}

function copyDefinition(definition: ToolStudioDefinition): ToolStudioDefinition {
  return JSON.parse(JSON.stringify(definition)) as ToolStudioDefinition;
}

function blankDraft(kind: ToolStudioKind): ToolStudioDefinition {
  if (kind === 'http') {
    return {
      name: 'api_tool',
      description: 'Call an API and return the useful response.',
      kind,
      language: 'powershell',
      params: [{ name: 'query', description: 'Value to send to the API.', type: 'string', required: false }],
      method: 'GET',
      url: 'https://example.com/search?q={{query}}',
    };
  }
  if (kind === 'workflow') {
    return {
      name: 'task_flow',
      description: 'Run a short sequence of saved tools in order.',
      kind,
      language: 'powershell',
      params: [],
      steps: [{ tool: 'tool_name', args: {} }],
    };
  }
  return {
    name: 'local_tool',
    description: 'Run a focused local helper with clear inputs and output.',
    kind: 'script',
    language: 'powershell',
    params: [{ name: 'input', description: 'The value the helper should process.', type: 'string', required: true }],
    script: 'Write-Output "Input: {{input}}"',
  };
}

function sampleArgs(params: ToolStudioParam[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const param of params) {
    if (param.default !== undefined) result[param.name] = param.default;
    else if (param.type === 'number') result[param.name] = 1;
    else if (param.type === 'boolean') result[param.name] = true;
    else result[param.name] = 'sample';
  }
  return result;
}

function initialState(definition: ToolStudioDefinition): StudioDraftState {
  return {
    headerText: JSON.stringify(definition.headers ?? {}, null, 2),
    workflowArgTexts: (definition.steps ?? []).map((step) => JSON.stringify(step.args ?? {}, null, 2)),
    outputsText: definition.sideEffectManifest?.outputs?.join('\n') ?? '',
    effectsText: definition.sideEffectManifest?.effects?.join('\n') ?? '',
    reasonText: definition.sideEffectManifest?.reason ?? '',
    testArgsText: JSON.stringify(sampleArgs(definition.params), null, 2),
  };
}

function parseObject(text: string, label: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return { value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: label + ' must be a JSON object.' };
    }
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: label + ' contains invalid JSON.' };
  }
}

function lines(text: string): string[] {
  return [...new Set(text.split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean))];
}

function sourceLabel(source: ToolStudioSummary['source'] | undefined): string {
  if (source === 'folder') return 'TOOLS FOLDER';
  if (source === 'skill') return 'SKILL';
  if (source === 'agent') return 'YOUR TOOL';
  return 'NEW TOOL';
}

export function createToolStudio(options: ToolStudioOptions): {
  load: (force?: boolean) => Promise<void>;
  destroy: () => void;
} {
  const { root, onNotice, onError, onTestState } = options;
  const adi = window.adi;
  let tools: ToolStudioSummary[] = [];
  let candidates: ToolStudioToolCandidate[] = [];
  let selectedName: string | null = null;
  let editingName: string | undefined;
  let draft = blankDraft('script');
  let state = initialState(draft);
  let dirty = false;
  let loading = false;
  let saving = false;
  let testing = false;
  let loaded = false;
  let loadGeneration = 0;
  let editorRevision = 0;
  let testOutput = '';
  let testResult: ToolStudioTestResult | null = null;

  const shell = make('div', 'studio-shell');
  const library = make('aside', 'studio-library');
  const libraryHead = make('div', 'studio-library-head');
  const libraryKicker = make('span', 'studio-kicker', 'TOOL STUDIO');
  const libraryTitle = make('strong', 'studio-library-title', 'Your tools');
  const libraryNote = make(
    'p',
    'studio-library-note',
    'Build repeatable actions once. Adi discovers and runs them through the normal permission gate.',
  );
  const librarySearch = inputField('search', 'Filter tools...', '');
  librarySearch.className = 'studio-search';
  const libraryList = make('div', 'studio-library-list');
  const libraryFoot = make('div', 'studio-library-foot');
  const candidateDatalist = make('datalist');
  candidateDatalist.id = 'studio-tool-candidates';
  const libraryCount = make('span', 'muted');
  let updateUnsubscribe: (() => void) | null = null;
  const refreshButton = button('Refresh', 'btn btn-ghost studio-refresh', () => void load(true));
  libraryHead.append(libraryKicker, libraryTitle, libraryNote, librarySearch);
  libraryFoot.append(libraryCount, refreshButton);
  library.append(libraryHead, libraryList, libraryFoot);

  const editor = make('section', 'studio-editor');
  const editorHeader = make('div', 'studio-editor-head');
  const editorHeading = make('div', 'studio-editor-heading');
  const editorKicker = make('span', 'studio-kicker', 'SIGNAL PATH');
  const editorTitle = make('h2', 'studio-editor-title', 'Create a tool');
  const editorMeta = make('div', 'studio-editor-meta');
  const editorActions = make('div', 'studio-editor-actions');
  const newButton = button('＋ New', 'btn btn-ghost', () => startNew('script'));
  const duplicateButton = button('Duplicate', 'btn btn-ghost', () => duplicateCurrent());
  const copyButton = button('Copy JSON', 'btn btn-ghost', () => void copyCurrent());
  const saveButton = button('Save', 'btn btn-primary', () => void saveCurrent());
  const testButton = button('Test', 'btn btn-ghost', () => void testCurrent());
  const deleteButton = button('Delete', 'btn btn-ghost studio-delete', () => void deleteCurrent());
  editorActions.append(newButton, duplicateButton, copyButton, saveButton, testButton, deleteButton);
  editorHeading.append(editorKicker, editorTitle, editorMeta);
  editorHeader.append(editorHeading, editorActions);

  const templates = make('div', 'studio-templates');
  const templateLabel = make('span', 'studio-template-label', 'Start from a shape');
  const templateButtons = make('div', 'studio-template-buttons');
  for (const entry of [
    ['Script', 'A local helper in PowerShell, Python, or Node.', 'script'] as const,
    ['API', 'A small HTTP request with placeholders.', 'http'] as const,
    ['Workflow', 'A visible chain of tools with gated steps.', 'workflow'] as const,
  ]) {
    const template = button(entry[0], 'studio-template', () => startNew(entry[2]));
    template.title = entry[1];
    templateButtons.append(template);
  }
  templates.append(templateLabel, templateButtons);

  const editorScroll = make('div', 'studio-editor-scroll');
  const editorBody = make('div', 'studio-editor-body');
  editorBody.addEventListener('input', () => { editorRevision += 1; });
  editorBody.addEventListener('change', () => { editorRevision += 1; });
  editorScroll.append(editorBody);
  editor.append(editorHeader, templates, editorScroll);
  shell.append(candidateDatalist, library, editor);
  root.replaceChildren(shell);

  let statusEl: HTMLElement | null = null;
  let previewEl: HTMLElement | null = null;
  let outputEl: HTMLElement | null = null;

  function renderCandidateOptions(): void {
    candidateDatalist.replaceChildren();
    for (const candidate of candidates) {
      const option = make('option') as HTMLOptionElement;
      option.value = candidate.name;
      option.label = candidate.availability === 'available' && candidate.callable
        ? candidate.provider
        : candidate.provider + ' - ' + candidate.availability;
      candidateDatalist.append(option);
    }
    for (const input of Array.from(editorBody.querySelectorAll<HTMLInputElement>('input[list="studio-tool-candidates"]'))) {
      input.title = candidateHint(input.value);
    }
    refreshWorkflowCandidateControls();
  }

  function refreshWorkflowCandidateControls(): void {
    if (draft.kind !== 'workflow') return;
    const rows = Array.from(editorBody.querySelectorAll<HTMLElement>('.studio-step-row'));
    rows.forEach((row, index) => {
      const tool = row.querySelector<HTMLInputElement>('input[list="studio-tool-candidates"]');
      const args = row.querySelector<HTMLTextAreaElement>('.studio-step-args');
      const fillArgs = row.querySelector<HTMLButtonElement>('.studio-step-fill');
      const candidate = candidates.find((entry) => entry.name === (tool?.value ?? draft.steps?.[index]?.tool ?? '').trim());
      if (tool) tool.title = candidateHint(tool.value);
      if (fillArgs) {
        fillArgs.disabled = isManaged() || !candidate;
        fillArgs.title = candidate
          ? candidate.parameterNames.length
            ? 'Insert an editable argument skeleton for ' + candidate.name + '.'
            : candidate.name + ' has no declared inputs.'
          : 'Choose a live tool first.';
      }
      if (args) {
        args.placeholder = candidate?.parameterNames.length
          ? JSON.stringify(Object.fromEntries(candidate.parameterNames.map((name) => [name, ''])))
          : '{}';
      }
    });
  }

  function candidateHint(name: string): string {
    const candidate = candidates.find((entry) => entry.name === name.trim());
    if (!candidate) return 'Type a canonical tool name or choose one from the suggestions.';
    const status = candidate.availability === 'available' && candidate.callable
      ? 'Ready to call.'
      : 'Not currently callable: ' + candidate.availability + '.';
    const params = candidate.parameterNames.length
      ? ' Inputs: ' + candidate.parameterNames.join(', ') + '.'
      : ' No inputs.';
    return candidate.description + ' ' + status + params;
  }

  function isManaged(): boolean {
    return draft.source === 'folder' || draft.source === 'skill';
  }

  function updateLibrary(): void {
    const query = librarySearch.value.trim().toLowerCase();
    const visible = tools.filter((tool) =>
      !query ||
      (tool.name + ' ' + tool.description + ' ' + tool.kind + ' ' + tool.source)
        .toLowerCase()
        .includes(query),
    );
    libraryList.replaceChildren();
    libraryCount.textContent = visible.length + ' of ' + tools.length + ' tools';
    if (loading) {
      libraryList.append(make('div', 'studio-empty', 'Reading the tool library...'));
      return;
    }
    if (!visible.length) {
      libraryList.append(
        make(
          'div',
          'studio-empty',
          tools.length ? 'No tools match that filter.' : 'No tools yet. Start with a shape on the right.',
        ),
      );
      return;
    }
    for (const tool of visible) {
      const row = button(
        '',
        'studio-tool-row' + (tool.name === selectedName ? ' active' : ''),
        () => void selectTool(tool.name, true),
      );
      row.disabled = saving || testing;
      const rowTop = make('div', 'studio-tool-row-top');
      const name = make('strong', 'studio-tool-name', tool.name);
      const badge = make('span', 'studio-badge', tool.kind.toUpperCase());
      rowTop.append(name, badge);
      row.append(
        rowTop,
        make('span', 'studio-tool-description', tool.description),
        make('span', 'studio-tool-source', sourceLabel(tool.source)),
      );
      libraryList.append(row);
    }
  }

  function setFieldDisabled(
    control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    disabled: boolean,
  ): void {
    control.disabled = disabled;
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      control.readOnly = disabled;
    }
  }

  function addField(parent: HTMLElement, labelText: string, control: HTMLElement, note?: string): void {
    const field = make('label', 'studio-field');
    field.append(make('span', 'studio-field-label', labelText), control);
    if (note) field.append(make('span', 'studio-field-note', note));
    parent.append(field);
  }

  function selectControl(values: readonly string[], selected: string): HTMLSelectElement {
    const select = make('select') as HTMLSelectElement;
    for (const value of values) {
      const option = make('option') as HTMLOptionElement;
      option.value = value;
      option.textContent = value;
      option.selected = value === selected;
      select.append(option);
    }
    return select;
  }

  function validationErrors(): string[] {
    const errors: string[] = [];
    if (!NAME_RE.test(draft.name)) {
      errors.push('Name: use 3-41 lowercase letters, digits, or underscores, starting with a letter.');
    }
    if (!draft.description.trim()) errors.push('Description: tell Adi what this tool is for.');
    const names = new Set<string>();
    for (const param of draft.params) {
      if (!PARAM_NAME_RE.test(param.name)) {
        errors.push('Parameter "' + (param.name || 'unnamed') + '" has an invalid name.');
      }
      if (names.has(param.name)) errors.push('Parameter "' + param.name + '" is repeated.');
      names.add(param.name);
      if (!param.description.trim()) errors.push('Parameter "' + param.name + '" needs a description.');
      if (param.type === 'number' && param.default !== undefined && typeof param.default !== 'number') {
        errors.push('Default for "' + param.name + '" must be a number.');
      }
      if (param.type === 'boolean' && param.default !== undefined && typeof param.default !== 'boolean') {
        errors.push('Default for "' + param.name + '" must be true or false.');
      }
    }
    if (draft.kind === 'script' && !draft.script?.trim()) errors.push('Script: add the code that should run.');
    if (draft.kind === 'http' && !draft.url?.trim()) errors.push('API: add a URL.');
    if (draft.kind === 'workflow') {
      if (!draft.steps?.length) errors.push('Workflow: add at least one step.');
      for (let index = 0; index < (draft.steps ?? []).length; index += 1) {
        const step = draft.steps?.[index];
        if (!step?.tool.trim()) errors.push('Workflow step ' + (index + 1) + ' needs a tool name.');
        const parsed = parseObject(
          state.workflowArgTexts[index] ?? '{}',
          'Workflow step ' + (index + 1) + ' arguments',
        );
        if (parsed.error) errors.push(parsed.error);
      }
    }
    if (draft.kind === 'http') {
      const parsed = parseObject(state.headerText, 'Headers');
      if (parsed.error) errors.push(parsed.error);
    }
    return errors;
  }

  function actionDetail(): string {
    if (draft.kind === 'http') {
      return ((draft.method ?? 'GET') + ' ' + (draft.url || 'URL not set')).slice(0, 180);
    }
    if (draft.kind === 'workflow') {
      const count = draft.steps?.length ?? 0;
      return count + ' gated step' + (count === 1 ? '' : 's');
    }
    return draft.language + ' script - ' + (draft.script?.length ?? 0) + ' characters';
  }

  function workflowPreviewContent(definition: ToolStudioDefinition, input: Record<string, unknown>): string {
    const lines = [
      'Workflow "' + definition.name + '" preview only.',
      'No steps were executed. Running this workflow from chat will classify and gate each step independently.',
      'Inputs: ' + JSON.stringify(input),
      '',
      'Resolved step plan:',
    ];
    for (const [index, step] of (definition.steps ?? []).entries()) {
      lines.push((index + 1) + '. ' + step.tool + '  args: ' + JSON.stringify(step.args ?? {}));
    }
    const output = lines.join('\n');
    return output.length <= 20_000 ? output : output.slice(0, 19_999) + '…';
  }

  function renderPreview(parent: HTMLElement): void {
    parent.replaceChildren();
    const heading = make('div', 'studio-preview-heading');
    heading.append(
      make('span', 'studio-kicker', 'LIVE PREVIEW'),
      make('span', 'studio-preview-note', 'What Adi will understand'),
    );
    const path = make('div', 'studio-signal-path');
    const nodes: Array<[string, string, string]> = [
      ['01', 'Trigger', 'You or Adi call the tool'],
      ['02', 'Inputs', draft.params.length + ' declared input' + (draft.params.length === 1 ? '' : 's')],
      [
        '03',
        draft.kind === 'http' ? 'API request' : draft.kind === 'workflow' ? 'Tool chain' : 'Local action',
        actionDetail(),
      ],
      ['04', 'Result', 'Bounded output returned to the task'],
    ];
    nodes.forEach((entry, index) => {
      const node = make('div', 'studio-signal-node');
      node.append(
        make('span', 'studio-signal-number', entry[0]),
        make('strong', 'studio-signal-title', entry[1]),
        make('span', 'studio-signal-detail', entry[2]),
      );
      path.append(node);
      if (index < nodes.length - 1) path.append(make('span', 'studio-signal-link', '->'));
    });
    const gate = make('div', 'studio-gate');
    gate.append(
      make('span', 'studio-gate-dot'),
      make('strong', 'Central permission gate'),
      make('span', 'Every run is classified, cancellable, and audited.'),
    );
    parent.append(heading, path, gate);
  }

  function renderOutput(parent: HTMLElement): void {
    parent.replaceChildren();
    if (!editingName) return;
    const head = make('div', 'studio-output-head');
    head.append(
      make('span', 'studio-kicker', 'TEST OUTPUT'),
      make(
        'span',
        'studio-preview-note',
        testing
          ? 'Running through Adi...'
          : testResult
            ? testResult.durationMs + 'ms'
            : draft.kind === 'workflow'
              ? 'Preview only - no steps execute'
              : 'Save, then test with sample JSON',
      ),
    );
    parent.append(head);
    if (!testOutput) {
      parent.append(
        make(
          'div',
          'studio-output-empty',
          draft.kind === 'workflow'
            ? 'Preview resolves the steps without executing them. A real run gates each step.'
            : 'A test result will appear here. The test uses the same approval controls as a normal task.',
        ),
      );
      return;
    }
    parent.append(make('pre', 'studio-output ' + (testResult?.ok ? 'ok' : 'bad'), testOutput));
  }

  function updateStatus(): void {
    const busy = saving || testing;
    editorBody.inert = busy;
    templateButtons.inert = busy;
    newButton.disabled = busy;
    refreshButton.disabled = busy || loading;
    for (const row of Array.from(libraryList.querySelectorAll<HTMLButtonElement>('button'))) {
      row.disabled = busy;
    }
    if (!statusEl) return;
    const errors = validationErrors();
    statusEl.className = 'studio-status ' + (errors.length ? 'bad' : dirty ? 'dirty' : 'ok');
    statusEl.textContent =
      errors[0] ??
      (dirty
        ? 'Unsaved changes'
        : isManaged()
          ? 'Managed elsewhere - read-only here'
          : 'Ready to save');
    saveButton.disabled = saving || testing || isManaged() || errors.length > 0;
    testButton.disabled = saving || testing || !editingName;
    duplicateButton.disabled = saving || testing || !editingName;
    deleteButton.disabled = saving || testing || !editingName || isManaged();
  }

  function refreshDerived(): void {
    renderHeader();
    updateStatus();
    if (previewEl) renderPreview(previewEl);
    if (outputEl) renderOutput(outputEl);
  }

  function appendParams(parent: HTMLElement, readOnly: boolean): void {
    const section = make('section', 'studio-section');
    const heading = make('div', 'studio-section-head');
    heading.append(
      make('strong', '', 'Inputs'),
      make('span', 'studio-section-note', 'Use {{name}} inside the action.'),
    );
    section.append(heading);
    const list = make('div', 'studio-param-list');
    draft.params.forEach((param, index) => {
      const row = make('div', 'studio-param-row');
      const name = inputField('text', 'name', param.name);
      const description = inputField('text', 'what it means', param.description);
      const type = selectControl(['string', 'number', 'boolean'], param.type ?? 'string');
      const required = make('input') as HTMLInputElement;
      required.type = 'checkbox';
      required.checked = param.required !== false;
      const defaultInput = inputField(
        'text',
        'optional default',
        param.default === undefined ? '' : String(param.default),
      );
      const choices = inputField('text', 'choices, comma-separated', param.choices?.join(', ') ?? '');
      setFieldDisabled(name, readOnly);
      setFieldDisabled(description, readOnly);
      setFieldDisabled(type, readOnly);
      setFieldDisabled(required, readOnly);
      setFieldDisabled(defaultInput, readOnly);
      setFieldDisabled(choices, readOnly);
      name.addEventListener('input', () => {
        param.name = name.value.trim();
        dirty = true;
        refreshDerived();
      });
      description.addEventListener('input', () => {
        param.description = description.value;
        dirty = true;
        refreshDerived();
      });
      type.addEventListener('change', () => {
        param.type = type.value as ToolStudioParam['type'];
        dirty = true;
        refreshDerived();
      });
      required.addEventListener('change', () => {
        param.required = required.checked;
        dirty = true;
        refreshDerived();
      });
      defaultInput.addEventListener('input', () => {
        updateDefault(param, defaultInput.value);
        dirty = true;
        refreshDerived();
      });
      choices.addEventListener('input', () => {
        param.choices = lines(choices.value);
        if (!param.choices.length) delete param.choices;
        dirty = true;
        refreshDerived();
      });
      const remove = button('x', 'icon-btn studio-param-remove', () => {
        draft.params.splice(index, 1);
        state.testArgsText = JSON.stringify(sampleArgs(draft.params), null, 2);
        dirty = true;
        renderEditor();
      });
      remove.title = 'Remove input';
      remove.disabled = readOnly;
      row.append(name, description, type, required, defaultInput, choices, remove);
      list.append(row);
    });
    section.append(list);
    const add = button('＋ Add input', 'btn btn-ghost studio-add', () => {
      draft.params.push({
        name: 'input_' + (draft.params.length + 1),
        description: 'Describe this input.',
        type: 'string',
        required: true,
      });
      dirty = true;
      renderEditor();
    });
    add.disabled = readOnly;
    section.append(add);
    parent.append(section);
  }

  function updateDefault(param: ToolStudioParam, raw: string): void {
    if (!raw.trim()) {
      delete param.default;
      return;
    }
    if (param.type === 'number') {
      const value = Number(raw);
      param.default = Number.isFinite(value) ? value : raw;
    } else if (param.type === 'boolean') {
      const value = raw.trim().toLowerCase();
      param.default = value === 'true' ? true : value === 'false' ? false : raw;
    } else {
      param.default = raw;
    }
  }

  function appendAction(parent: HTMLElement, readOnly: boolean): void {
    const section = make('section', 'studio-section');
    const title = draft.kind === 'script' ? 'Script' : draft.kind === 'http' ? 'API request' : 'Workflow';
    const heading = make('div', 'studio-section-head');
    heading.append(make('strong', '', title), make('span', 'studio-section-note', draft.kind === 'workflow' ? 'Choose a live tool for each step.' : 'This is the executable part.'));
    section.append(heading);

    if (draft.kind === 'script') {
      const language = selectControl([...LANGUAGES], draft.language);
      setFieldDisabled(language, readOnly);
      language.addEventListener('change', () => {
        draft.language = language.value as ToolStudioDefinition['language'];
        dirty = true;
        refreshDerived();
      });
      addField(section, 'Language', language);
      const script = make('textarea', 'studio-code') as HTMLTextAreaElement;
      script.rows = 12;
      script.value = draft.script ?? '';
      script.placeholder = 'Write-Output "Hello {{input}}"';
      script.spellcheck = false;
      setFieldDisabled(script, readOnly);
      script.addEventListener('input', () => {
        draft.script = script.value;
        dirty = true;
        refreshDerived();
      });
      addField(section, 'Code', script, 'Placeholders look like {{input}} and are resolved from Inputs above.');
    } else if (draft.kind === 'http') {
      const line = make('div', 'studio-inline-fields');
      const method = selectControl(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], (draft.method ?? 'GET').toUpperCase());
      const url = inputField('url', 'https://example.com/{{id}}', draft.url ?? '');
      setFieldDisabled(method, readOnly);
      setFieldDisabled(url, readOnly);
      method.addEventListener('change', () => {
        draft.method = method.value;
        dirty = true;
        refreshDerived();
      });
      url.addEventListener('input', () => {
        draft.url = url.value;
        dirty = true;
        refreshDerived();
      });
      addField(line, 'Method', method);
      addField(line, 'URL', url);
      section.append(line);

      const headers = make('textarea', 'studio-code') as HTMLTextAreaElement;
      headers.rows = 4;
      headers.value = state.headerText;
      headers.spellcheck = false;
      headers.placeholder = '{"Accept":"application/json"}';
      setFieldDisabled(headers, readOnly);
      headers.addEventListener('input', () => {
        state.headerText = headers.value;
        dirty = true;
        refreshDerived();
      });
      addField(section, 'Headers JSON', headers, 'Keep secrets out of definitions when possible.');

      const body = make('textarea', 'studio-code') as HTMLTextAreaElement;
      body.rows = 6;
      body.value = draft.body ?? '';
      body.spellcheck = false;
      body.placeholder = '{"query":"{{query}}"}';
      setFieldDisabled(body, readOnly);
      body.addEventListener('input', () => {
        draft.body = body.value;
        dirty = true;
        refreshDerived();
      });
      addField(section, 'Body', body, 'Optional. Placeholders are resolved before the request is sent.');
    } else {
      const list = make('div', 'studio-step-list');
      (draft.steps ?? []).forEach((step, index) => {
        const row = make('div', 'studio-step-row');
        const number = make('span', 'studio-step-number', String(index + 1).padStart(2, '0'));
        const tool = inputField('text', 'choose a tool name', step.tool);
        tool.setAttribute('list', candidateDatalist.id);
        tool.setAttribute('aria-label', 'Workflow step ' + (index + 1) + ' tool name');
        tool.title = candidateHint(step.tool);
        const args = make('textarea', 'studio-step-args') as HTMLTextAreaElement;
        args.rows = 2;
        args.value = state.workflowArgTexts[index] ?? '{}';
        args.spellcheck = false;
        setFieldDisabled(tool, readOnly);
        setFieldDisabled(args, readOnly);
        const fillArgs = button('Fill args', 'btn btn-ghost studio-step-fill', () => {
          const candidate = candidates.find((entry) => entry.name === step.tool.trim());
          if (!candidate) {
            onError('Choose a known tool before filling its arguments.');
            return;
          }
          const skeleton = Object.fromEntries(candidate.parameterNames.map((name) => [name, '']));
          state.workflowArgTexts[index] = JSON.stringify(skeleton, null, 2);
          dirty = true;
          renderEditor();
        });
        const updateStepHint = () => {
          const candidate = candidates.find((entry) => entry.name === step.tool.trim());
          fillArgs.disabled = readOnly || !candidate;
          fillArgs.title = candidate
            ? candidate.parameterNames.length
              ? 'Insert an editable argument skeleton for ' + candidate.name + '.'
              : candidate.name + ' has no declared inputs.'
            : 'Choose a live tool first.';
          args.placeholder = candidate?.parameterNames.length
            ? JSON.stringify(Object.fromEntries(candidate.parameterNames.map((name) => [name, ''])))
            : '{}';
        };
        tool.addEventListener('input', () => {
          step.tool = tool.value.trim();
          tool.title = candidateHint(step.tool);
          updateStepHint();
          dirty = true;
          refreshDerived();
        });
        args.addEventListener('input', () => {
          state.workflowArgTexts[index] = args.value;
          dirty = true;
          refreshDerived();
        });
        const remove = button('x', 'icon-btn studio-param-remove', () => {
          draft.steps?.splice(index, 1);
          state.workflowArgTexts.splice(index, 1);
          dirty = true;
          renderEditor();
        });
        remove.disabled = readOnly;
        updateStepHint();
        row.append(number, tool, args, fillArgs, remove);
        list.append(row);
      });
      section.append(list);
      section.append(make('span', 'studio-field-note', candidates.length ? 'Suggestions include ' + candidates.length + ' built-in, custom, and connected tools.' : 'Loading canonical tool suggestions...'));
      const add = button('＋ Add step', 'btn btn-ghost studio-add', () => {
        draft.steps ??= [];
        draft.steps.push({ tool: 'tool_name', args: {} });
        state.workflowArgTexts.push('{}');
        dirty = true;
        renderEditor();
      });
      add.disabled = readOnly;
      section.append(
        add,
        make('span', 'studio-field-note', 'Each step is checked and gated independently when the workflow runs.'),
      );
    }
    parent.append(section);
  }

  function appendManifest(parent: HTMLElement, readOnly: boolean): void {
    const section = make('section', 'studio-section studio-manifest');
    const heading = make('div', 'studio-section-head');
    heading.append(
      make('strong', '', 'Declared effects'),
      make('span', 'studio-section-note', 'Helps Adi explain what the tool changes.'),
    );
    section.append(heading);
    const outputs = make('textarea', 'studio-compact-text') as HTMLTextAreaElement;
    outputs.rows = 2;
    outputs.value = state.outputsText;
    outputs.placeholder = 'output path or artifact, one per line';
    const effects = make('textarea', 'studio-compact-text') as HTMLTextAreaElement;
    effects.rows = 2;
    effects.value = state.effectsText;
    effects.placeholder = 'writes a file, sends a request, one per line';
    const reason = inputField('text', 'why this tool needs access', state.reasonText);
    setFieldDisabled(outputs, readOnly);
    setFieldDisabled(effects, readOnly);
    setFieldDisabled(reason, readOnly);
    outputs.addEventListener('input', () => { state.outputsText = outputs.value; dirty = true; refreshDerived(); });
    effects.addEventListener('input', () => { state.effectsText = effects.value; dirty = true; refreshDerived(); });
    reason.addEventListener('input', () => { state.reasonText = reason.value; dirty = true; refreshDerived(); });
    addField(section, 'Outputs', outputs);
    addField(section, 'Effects', effects);
    addField(section, 'Reason', reason);
    parent.append(section);
  }

  function appendTest(parent: HTMLElement): void {
    if (!editingName) return;
    const section = make('section', 'studio-section studio-test');
    const heading = make('div', 'studio-section-head');
    heading.append(
      make('strong', '', 'Test arguments'),
      make('span', 'studio-section-note', 'JSON object passed to the saved tool.'),
    );
    const args = make('textarea', 'studio-code studio-test-args') as HTMLTextAreaElement;
    args.rows = 5;
    args.value = state.testArgsText;
    args.spellcheck = false;
    args.addEventListener('input', () => { state.testArgsText = args.value; });
    const defaults = button('Use defaults', 'btn btn-ghost studio-use-defaults', () => {
      state.testArgsText = JSON.stringify(sampleArgs(draft.params), null, 2);
      renderEditor();
    });
    heading.append(defaults);
    section.append(heading, args);
    parent.append(section);
  }

  function renderEditor(): void {
    editorRevision += 1;
    editorBody.replaceChildren();
    statusEl = make('div', 'studio-status');
    const intro = make('div', 'studio-intro');
    intro.append(
      make('span', 'studio-kicker', 'DEFINITION'),
      make('span', 'studio-intro-note', 'The plain-language contract Adi uses to choose this tool.'),
    );
    editorBody.append(intro, statusEl);

    const basics = make('section', 'studio-section studio-basics');
    const name = inputField('text', 'lowercase_tool_name', draft.name);
    name.maxLength = 41;
    const description = make('textarea', 'studio-description') as HTMLTextAreaElement;
    description.rows = 3;
    description.maxLength = 2_000;
    description.value = draft.description;
    const kind = selectControl(KINDS, draft.kind);
    const readOnly = isManaged();
    setFieldDisabled(name, readOnly);
    setFieldDisabled(description, readOnly);
    setFieldDisabled(kind, readOnly);
    name.addEventListener('input', () => { draft.name = name.value.trim(); dirty = true; refreshDerived(); });
    description.addEventListener('input', () => { draft.description = description.value; dirty = true; refreshDerived(); });
    kind.addEventListener('change', () => {
      draft.kind = kind.value as ToolStudioKind;
      if (draft.kind === 'script' && !draft.script) draft.script = 'Write-Output "{{input}}"';
      if (draft.kind === 'http' && !draft.url) draft.url = 'https://example.com/{{input}}';
      if (draft.kind === 'workflow' && !draft.steps?.length) {
        draft.steps = [{ tool: 'tool_name', args: {} }];
        state.workflowArgTexts = ['{}'];
      }
      dirty = true;
      renderEditor();
    });
    addField(basics, 'Name', name, 'This is how you will call it from chat.');
    addField(basics, 'Description', description, 'Be specific about when Adi should choose it.');
    addField(basics, 'Shape', kind, 'Script, API, or a workflow of existing tools.');
    editorBody.append(basics);
    appendParams(editorBody, readOnly);
    appendAction(editorBody, readOnly);
    appendManifest(editorBody, readOnly);
    appendTest(editorBody);

    const preview = make('section', 'studio-preview');
    previewEl = preview;
    renderPreview(preview);
    editorBody.append(preview);

    const output = make('section', 'studio-output-panel');
    outputEl = output;
    renderOutput(output);
    editorBody.append(output);
    updateStatus();
  }

  function renderHeader(): void {
    editorTitle.textContent = draft.name || 'Create a tool';
    editorMeta.replaceChildren(
      make('span', 'studio-source-badge', sourceLabel(draft.source)),
      make('span', 'studio-meta-copy', draft.kind.toUpperCase() + (dirty ? ' - UNSAVED' : '')),
    );
    duplicateButton.hidden = !editingName;
    copyButton.hidden = !editingName;
    saveButton.hidden = isManaged();
    testButton.hidden = !editingName;
    testButton.textContent = dirty ? 'Save & test' : draft.kind === 'workflow' ? 'Preview' : 'Test';
    testButton.title = draft.kind === 'workflow'
      ? 'Preview the resolved steps without executing them.'
      : dirty
        ? 'Save the current definition, then test it.'
        : 'Run the saved tool with the test arguments.';
    deleteButton.hidden = !editingName || isManaged();
  }

  async function selectTool(name: string, userRequested = false): Promise<void> {
    if (userRequested && (saving || testing)) return;
    if (userRequested && dirty && !window.confirm('Discard the unsaved tool changes?')) return;
    const generation = ++loadGeneration;
    const revision = editorRevision;
    try {
      const selected = await adi.tools.get(name);
      if (generation !== loadGeneration || revision !== editorRevision || !selected) return;
      selectedName = name;
      editingName = selected.name;
      draft = copyDefinition(selected);
      state = initialState(draft);
      dirty = false;
      testOutput = '';
      testResult = null;
      renderHeader();
      renderEditor();
      updateLibrary();
    } catch (error) {
      onError('Could not open tool: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  function startNew(kind: ToolStudioKind, afterDelete = false): void {
    if (!afterDelete && (saving || testing)) return;
    if (!afterDelete && dirty && !window.confirm('Discard the unsaved tool changes?')) return;
    ++loadGeneration;
    selectedName = null;
    editingName = undefined;
    draft = blankDraft(kind);
    state = initialState(draft);
    dirty = false;
    testOutput = '';
    testResult = null;
    renderHeader();
    renderEditor();
    updateLibrary();
  }

  function duplicateCurrent(): void {
    if (saving || testing) return;
    ++loadGeneration;
    const next = copyDefinition(draft);
    const base = next.name.replace(/[^a-z0-9_]/g, '_').slice(0, 34) || 'new_tool';
    let candidate = base + '_copy';
    let number = 2;
    while (tools.some((tool) => tool.name === candidate) && number < 100) {
      candidate = base + '_copy_' + number++;
    }
    next.name = candidate.slice(0, 41);
    delete next.source;
    delete next.createdAt;
    delete next.path;
    delete next.skillId;
    draft = next;
    selectedName = null;
    editingName = undefined;
    state = initialState(draft);
    dirty = true;
    renderHeader();
    renderEditor();
    updateLibrary();
  }

  function prepareDraft(): ToolStudioDefinition | null {
    const errors = validationErrors();
    if (errors.length) {
      onError(errors[0] ?? 'The tool definition is invalid.');
      return null;
    }
    const prepared = copyDefinition(draft);
    const headers = parseObject(state.headerText, 'Headers');
    if (draft.kind === 'http') {
      if (headers.error) {
        onError(headers.error);
        return null;
      }
      if (headers.value && Object.keys(headers.value).length) {
        prepared.headers = Object.fromEntries(
          Object.entries(headers.value).map(([key, value]) => [key, String(value)]),
        );
      } else {
        delete prepared.headers;
      }
    } else {
      delete prepared.headers;
    }
    if (draft.kind === 'workflow') {
      prepared.steps = (prepared.steps ?? []).map((step, index) => {
        const parsed = parseObject(
          state.workflowArgTexts[index] ?? '{}',
          'Workflow step ' + (index + 1) + ' arguments',
        );
        return { ...step, args: parsed.value ?? {} };
      });
    } else {
      delete prepared.steps;
    }
    const outputs = lines(state.outputsText);
    const effects = lines(state.effectsText);
    const reason = state.reasonText.trim();
    if (outputs.length || effects.length || reason) {
      prepared.sideEffectManifest = {
        ...(outputs.length ? { outputs } : {}),
        ...(effects.length ? { effects } : {}),
        ...(reason ? { reason } : {}),
      };
    } else {
      delete prepared.sideEffectManifest;
    }
    delete prepared.source;
    delete prepared.createdAt;
    delete prepared.path;
    delete prepared.skillId;
    return prepared;
  }

  async function saveCurrent(): Promise<void> {
    if (saving || testing) return;
    const prepared = prepareDraft();
    if (!prepared) return;
    saving = true;
    updateStatus();
    try {
      const next = await adi.tools.save(prepared, editingName);
      tools = next;
      selectedName = prepared.name;
      editingName = prepared.name;
      dirty = false;
      onNotice('Saved ' + prepared.name + '. It is available immediately.');
      await selectTool(prepared.name);
    } catch (error) {
      onError('Could not save tool: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      saving = false;
      updateStatus();
    }
  }

  async function testCurrent(): Promise<void> {
    if (saving || testing || !editingName) return;
    const requestedArgsText = state.testArgsText;
    if (dirty) {
      onNotice('Saving changes before testing...');
      await saveCurrent();
      if (dirty || !editingName) return;
    }
    const selectedNameForTest = editingName;
    const parsed = parseObject(requestedArgsText, 'Test arguments');
    if (parsed.error || !parsed.value) {
      onError(parsed.error ?? 'Test arguments must be a JSON object.');
      return;
    }
    if (draft.kind === 'workflow') {
      const prepared = prepareDraft();
      if (!prepared) return;
      testResult = {
        name: selectedNameForTest,
        ok: true,
        content: workflowPreviewContent(prepared, parsed.value),
        durationMs: 0,
      };
      testOutput = testResult.content;
      renderHeader();
      refreshDerived();
      return;
    }
    testing = true;
    onTestState?.(true);
    testResult = null;
    testOutput = '';
    renderHeader();
    refreshDerived();
    try {
      const result = await adi.tools.test(selectedNameForTest, parsed.value);
      testResult = result;
      testOutput = result.content || '(tool returned no text)';
    } catch (error) {
      testOutput = error instanceof Error ? error.message : String(error);
      testResult = {
        name: selectedNameForTest,
        ok: false,
        content: testOutput,
        durationMs: 0,
        errorCode: 'execution-failed',
      };
      onError('Tool test failed: ' + testOutput);
    } finally {
      testing = false;
      onTestState?.(false);
      renderHeader();
      refreshDerived();
    }
  }

  async function deleteCurrent(): Promise<void> {
    if (!editingName || isManaged() || saving || testing) return;
    const name = editingName;
    if (!window.confirm('Delete "' + name + '"? This cannot be undone.')) return;
    saving = true;
    updateStatus();
    try {
      tools = await adi.tools.delete(name);
      onNotice('Deleted ' + name + '.');
      const next = tools[0];
      if (next) await selectTool(next.name);
      else startNew('script', true);
      updateLibrary();
    } catch (error) {
      onError('Could not delete tool: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      saving = false;
      updateStatus();
    }
  }

  async function writeClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const fallback = make('textarea') as HTMLTextAreaElement;
    fallback.value = text;
    fallback.readOnly = true;
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand('copy');
    fallback.remove();
    if (!copied) throw new Error('Clipboard access is unavailable.');
  }

  async function copyCurrent(): Promise<void> {
    try {
      const prepared = prepareDraft();
      if (!prepared) return;
      await writeClipboard(JSON.stringify(prepared, null, 2));
      onNotice('Tool definition copied as clean JSON.');
    } catch (error) {
      onError('Could not copy tool definition: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  librarySearch.addEventListener('input', updateLibrary);
  async function refreshCandidates(): Promise<void> {
    try {
      candidates = await adi.tools.candidates();
      renderCandidateOptions();
    } catch (error) {
      onError('Could not load tool suggestions: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  updateUnsubscribe = adi.tools.onUpdate((next) => {
    tools = next;
    void refreshCandidates();
    updateLibrary();
    if (!saving && !testing && !dirty && selectedName && tools.some((tool) => tool.name === selectedName)) {
      void selectTool(selectedName);
    }
  });
  renderHeader();
  renderEditor();
  updateLibrary();

  async function load(force = false): Promise<void> {
    if (saving || testing || loading || (loaded && !force)) return;
    loading = true;
    updateLibrary();
    const generation = ++loadGeneration;
    try {
      const [next, nextCandidates] = await Promise.all([adi.tools.list(), adi.tools.candidates()]);
      if (generation !== loadGeneration) return;
      tools = next;
      candidates = nextCandidates;
      renderCandidateOptions();
      loaded = true;
      updateLibrary();
      if (dirty) return;
      const selected = selectedName && tools.some((tool) => tool.name === selectedName)
        ? selectedName
        : tools[0]?.name;
      if (selected) await selectTool(selected);
      else startNew('script');
    } catch (error) {
      onError('Could not load tools: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      loading = false;
      updateLibrary();
      updateStatus();
    }
  }

  function destroy(): void {
    updateUnsubscribe?.();
    updateUnsubscribe = null;
  }

  return { load, destroy };
}
