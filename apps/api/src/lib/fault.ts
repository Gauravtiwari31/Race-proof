/**
 * Deterministic crash injection for the chaos test: dies at an exact line, instead of hoping a
 * random kill lands mid-transaction. loadConfig refuses FAULT_POINT in production.
 */
export function faultPoint(name: string): void {
  if (process.env.FAULT_POINT === name) process.kill(process.pid, 'SIGKILL');
}
