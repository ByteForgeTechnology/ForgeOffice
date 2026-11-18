import argon2 from 'argon2';

/** OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function passwordNeedsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}

let dummyHash: Promise<string> | undefined;
/**
 * Perform a throwaway verification so that "unknown user" and "wrong password"
 * take comparable time (mitigates account enumeration via timing).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('forge-timing-equaliser');
  await verifyPassword(await dummyHash, password);
}

export interface PasswordPolicy {
  minLength: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { minLength: 12 };

/** Returns a list of human-readable problems; empty means acceptable. */
export function checkPasswordPolicy(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY, context: string[] = []): string[] {
  const problems: string[] = [];
  if (password.length < policy.minLength) problems.push(`Must be at least ${policy.minLength} characters long.`);
  if (password.length > 256) problems.push('Must be at most 256 characters long.');
  if (/^(.)\1+$/.test(password)) problems.push('Must not be a single repeated character.');
  const lowered = password.toLowerCase();
  for (const c of context) {
    if (c && c.length >= 3 && lowered.includes(c.toLowerCase())) {
      problems.push('Must not contain your name or username.');
      break;
    }
  }
  return problems;
}
