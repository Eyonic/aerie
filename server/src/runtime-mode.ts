export function parsePrivateCanary(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('invalid_aerie_private_canary');
}

// Deployment passes this only to the unpublished migration/health candidate.
// Invalid values fail closed during module initialization.
export const privateCanary = parsePrivateCanary(process.env.AERIE_PRIVATE_CANARY);
