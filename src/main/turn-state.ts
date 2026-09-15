function requireConversationId(conversationId: number): void {
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
    throw new Error('A valid conversation id is required.');
  }
}

/** Tracks queued and active interactive turns so their conversations remain addressable. */
export class PendingTurnRegistry {
  private readonly counts = new Map<number, number>();

  retain(conversationId: number): void {
    requireConversationId(conversationId);
    this.counts.set(conversationId, (this.counts.get(conversationId) ?? 0) + 1);
  }

  release(conversationId: number): void {
    requireConversationId(conversationId);
    const count = this.counts.get(conversationId);
    if (count === undefined || count <= 1) {
      this.counts.delete(conversationId);
      return;
    }
    this.counts.set(conversationId, count - 1);
  }

  has(conversationId: number): boolean {
    return this.counts.has(conversationId);
  }
}

/** Owns pending permission resolvers so lifecycle shutdown can deny them all. */
export class PendingConfirmationRegistry<T> {
  private readonly resolvers = new Map<string, (value: T) => void>();

  get size(): number {
    return this.resolvers.size;
  }

  set(id: string, resolver: (value: T) => void): void {
    this.resolvers.set(id, resolver);
  }

  delete(id: string): void {
    this.resolvers.delete(id);
  }

  resolve(id: string, value: T): boolean {
    const resolver = this.resolvers.get(id);
    if (!resolver) return false;
    this.resolvers.delete(id);
    resolver(value);
    return true;
  }

  /** Resolves every pending request and clears the registry before callbacks run. */
  resolveAll(value: T): number {
    const resolvers = [...this.resolvers.values()];
    this.resolvers.clear();
    for (const resolver of resolvers) resolver(value);
    return resolvers.length;
  }
}
