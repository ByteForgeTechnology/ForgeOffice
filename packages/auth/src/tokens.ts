import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  client_id?: string;
  scope?: string;
}

export interface TokenVerifierOptions {
  issuer: string;
  audience: string;
  /** In-process key set (the API that hosts the OIDC provider). */
  jwks?: JSONWebKeySet;
  /** Remote key set (any other ForgeOffice service). */
  jwksUri?: string;
}

export type TokenVerifier = (token: string) => Promise<AccessTokenClaims>;

/**
 * Build a verifier for JWT access tokens issued by the ForgeOffice OIDC
 * provider. Checks signature, issuer, audience and expiry.
 */
export function createTokenVerifier(opts: TokenVerifierOptions): TokenVerifier {
  const keySet = opts.jwks
    ? createLocalJWKSet(opts.jwks)
    : opts.jwksUri
      ? createRemoteJWKSet(new URL(opts.jwksUri))
      : (() => {
          throw new Error('createTokenVerifier requires jwks or jwksUri');
        })();
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['ES256', 'RS256'],
      typ: 'at+jwt',
    });
    if (typeof payload.sub !== 'string') throw new Error('Access token has no subject');
    return payload as AccessTokenClaims;
  };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9\-_.~+/]+=*)$/i.exec(header.trim());
  return m?.[1] ?? null;
}
