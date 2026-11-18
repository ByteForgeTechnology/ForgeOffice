import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

const origin = window.location.origin;

/** ForgeOffice web client: authorization code + PKCE against the built-in provider. */
export const userManager = new UserManager({
  authority: `${origin}/oidc`,
  client_id: 'forge-web',
  redirect_uri: `${origin}/auth/callback`,
  post_logout_redirect_uri: `${origin}/signed-out`,
  response_type: 'code',
  // `api` is the resource scope for the ForgeOffice API; offline_access yields a refresh token.
  scope: 'openid profile email offline_access forge api',
  loadUserInfo: false,
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

interface AuthState {
  user: User | null;
  ready: boolean;
  /** True once sign-out has begun; guards must not start a new sign-in. */
  signingOut: boolean;
  signIn: (returnTo?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

let renewal: Promise<User | null> | null = null;

/** Current access token, refreshing it first if it has expired. */
export async function getAccessToken(): Promise<string | null> {
  let user = await userManager.getUser();
  if (user && user.expired && user.refresh_token) {
    renewal ??= userManager.signinSilent().finally(() => (renewal = null));
    user = await renewal.catch(() => null);
  }
  return user && !user.expired ? user.access_token : null;
}

export function signInRedirect(returnTo = window.location.pathname + window.location.search) {
  // prompt=consent is required for the provider to honour offline_access; trusted
  // ForgeOffice clients are granted consent automatically.
  return userManager.signinRedirect({ state: { returnTo }, prompt: 'consent' });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      let u = await userManager.getUser();
      if (u?.expired && u.refresh_token) u = await userManager.signinSilent().catch(() => null);
      if (active) {
        setUser(u && !u.expired ? u : null);
        setReady(true);
      }
    })();
    const onLoaded = (u: User) => setUser(u);
    const onUnloaded = () => setUser(null);
    const onRenewError = () => void userManager.removeUser();
    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);
    userManager.events.addSilentRenewError(onRenewError);
    return () => {
      active = false;
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
      userManager.events.removeSilentRenewError(onRenewError);
    };
  }, []);

  const signIn = useCallback((returnTo?: string) => signInRedirect(returnTo), []);
  const signOut = useCallback(async () => {
    // signoutRedirect clears the stored user before navigating away. Without this
    // flag, RequireAuth would see "no user" and race it with a sign-in redirect.
    setSigningOut(true);
    const u = await userManager.getUser();
    if (u?.refresh_token) await userManager.revokeTokens(['refresh_token']).catch(() => {});
    await userManager.signoutRedirect({ id_token_hint: u?.id_token });
  }, []);

  const value = useMemo(() => ({ user, ready, signingOut, signIn, signOut }), [user, ready, signingOut, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
