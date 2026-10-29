/** The only ad status this project is ever allowed to send to Meta. */
export const PAUSED_STATUS = 'PAUSED' as const;

/**
 * Hard safety guard: throw unless the payload explicitly sets status PAUSED.
 * Call this immediately before every write that carries a status field.
 */
export function assertOnlyPaused(payload: { status?: unknown }, context: string): void {
  if (payload.status !== PAUSED_STATUS) {
    throw new Error(
      `[safety] Refusing ${context}: status must be "PAUSED", got ${JSON.stringify(payload.status)}`,
    );
  }
}
