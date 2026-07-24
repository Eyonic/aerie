export type CastLoadLease = Readonly<{
  deviceIp: string;
  generation: number;
  controllerGeneration: string;
}>;

// A Cast LOAD can resolve after its player was closed. Keep one tiny,
// process-local generation per receiver so the abandoned request may clean up
// only its own late session; a newer player on the same TV always supersedes it.
const latestGeneration = new Map<string, number>();
let nextGeneration = 0;

export function beginCastLoad(deviceIp: string): CastLoadLease {
  const generation = ++nextGeneration;
  latestGeneration.set(deviceIp, generation);
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const controllerGeneration = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return { deviceIp, generation, controllerGeneration };
}

export function ownsCastLoad(lease: CastLoadLease): boolean {
  return latestGeneration.get(lease.deviceIp) === lease.generation;
}

export function releaseCastLoad(lease: CastLoadLease): boolean {
  if (!ownsCastLoad(lease)) return false;
  latestGeneration.delete(lease.deviceIp);
  return true;
}
