import { estimateJsonBytes } from '../bounded-json';
import { MAX_MODEL_REQUEST_BYTES } from './request-bounds';
import type { ProviderShape } from '../../shared/types';

export interface ToolPayloadTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolPayloadMetrics {
  availableToolCount: number;
  selectedToolCount: number;
  availableToolBytes: number;
  selectedToolBytes: number;
  savedToolBytes: number;
  savedToolPercent: number;
}

const MAX_MODEL_TOOL_DESCRIPTION_CHARS = 1_200;
const AVAILABLE_PAYLOAD_BYTES = new WeakMap<object, Map<ProviderShape, number>>();

export function compactModelToolDescription(value: string): string {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_MODEL_TOOL_DESCRIPTION_CHARS) return compact;
  return compact.slice(0, MAX_MODEL_TOOL_DESCRIPTION_CHARS - 1).trimEnd() + '…';
}

export function toolPayloadForShape(
  shape: ProviderShape,
  tools: readonly ToolPayloadTool[],
): unknown[] {
  if (shape === 'responses') {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: compactModelToolDescription(tool.description),
      parameters: tool.parameters,
      strict: false,
    }));
  }
  if (shape === 'anthropic') {
    return tools.map((tool) => ({
      name: tool.name,
      description: compactModelToolDescription(tool.description),
      input_schema: tool.parameters,
    }));
  }
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: compactModelToolDescription(tool.description),
      parameters: tool.parameters,
    },
  }));
}

export function jsonByteLength(value: unknown): number {
  try {
    const bytes = estimateJsonBytes(value, MAX_MODEL_REQUEST_BYTES);
    return bytes > MAX_MODEL_REQUEST_BYTES ? MAX_MODEL_REQUEST_BYTES + 1 : bytes;
  } catch {
    return MAX_MODEL_REQUEST_BYTES + 1;
  }
}

export function toolPayloadBytes(
  shape: ProviderShape,
  tools: readonly ToolPayloadTool[],
): number {
  return jsonByteLength(toolPayloadForShape(shape, tools));
}

function cachedAvailableToolPayloadBytes(
  shape: ProviderShape,
  tools: readonly ToolPayloadTool[],
): number {
  let byShape = AVAILABLE_PAYLOAD_BYTES.get(tools);
  if (!byShape) {
    byShape = new Map();
    AVAILABLE_PAYLOAD_BYTES.set(tools, byShape);
  }
  const cached = byShape.get(shape);
  if (cached !== undefined) return cached;
  const bytes = toolPayloadBytes(shape, tools);
  byShape.set(shape, bytes);
  return bytes;
}

export function makeToolPayloadMetrics(
  shape: ProviderShape,
  available: readonly ToolPayloadTool[],
  selected: readonly ToolPayloadTool[],
): ToolPayloadMetrics {
  const availableToolBytes = cachedAvailableToolPayloadBytes(shape, available);
  const selectedToolBytes = selected === available
    ? availableToolBytes
    : toolPayloadBytes(shape, selected);
  const savedToolBytes = Math.max(0, availableToolBytes - selectedToolBytes);
  return {
    availableToolCount: available.length,
    selectedToolCount: selected.length,
    availableToolBytes,
    selectedToolBytes,
    savedToolBytes,
    savedToolPercent: availableToolBytes
      ? Math.round((savedToolBytes / availableToolBytes) * 10_000) / 100
      : 0,
  };
}
