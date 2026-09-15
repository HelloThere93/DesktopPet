export function isToolExposed(
  toolName: string,
  exposedToolNames?: readonly string[],
): boolean {
  return !exposedToolNames || exposedToolNames.includes(toolName);
}

export function notLoadedToolMessage(toolName: string): string {
  return (
    `Tool "${toolName}" is not loaded for this request. Call find_tools with its ` +
    `purpose, then retry after the capability is loaded.`
  );
}
