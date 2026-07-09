import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import {
  clearControlToken,
  getControlToken,
  onControlUnauthorized,
  setControlToken,
  validateControlToken
} from "../lib/api";

interface AuthGateProps {
  children: ReactNode;
}

type AuthState = "checking" | "authenticated" | "unauthenticated";

export function AuthGate({ children }: AuthGateProps) {
  const queryClient = useQueryClient();
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = onControlUnauthorized(() => {
      if (active) {
        queryClient.clear();
        setAuthState("unauthenticated");
        setError("The control session expired or the token was rotated.");
      }
    });

    const storedToken = getControlToken();
    if (!storedToken) {
      setAuthState("unauthenticated");
    } else {
      void validateControlToken(storedToken)
        .then((valid) => {
          if (!active) {
            return;
          }
          if (valid) {
            setAuthState("authenticated");
          } else {
            clearControlToken();
            queryClient.clear();
            setAuthState("unauthenticated");
            setError("The saved control token is no longer valid.");
          }
        })
        .catch((validationError: unknown) => {
          if (active) {
            setAuthState("unauthenticated");
            setError(validationError instanceof Error ? validationError.message : String(validationError));
          }
        });
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) {
      setError("Enter MEMOREPO_CONTROL_TOKEN.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const valid = await validateControlToken(candidate);
      if (!valid) {
        setError("The control token is not valid.");
        return;
      }
      setControlToken(candidate);
      queryClient.clear();
      setToken("");
      setAuthState("authenticated");
    } catch (authenticationError) {
      setError(authenticationError instanceof Error ? authenticationError.message : String(authenticationError));
    } finally {
      setSubmitting(false);
    }
  }

  if (authState === "authenticated") {
    return children;
  }

  if (authState === "checking") {
    return (
      <main className="auth-shell" aria-live="polite">
        <Loader2 className="auth-spinner" aria-hidden="true" />
        <span>Checking local access…</span>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={authenticate}>
        <div className="auth-icon" aria-hidden="true">
          <KeyRound size={24} />
        </div>
        <div>
          <p className="auth-eyebrow">Local control access</p>
          <h1>Unlock MemoRepo</h1>
          <p className="auth-copy">
            Enter <code>MEMOREPO_CONTROL_TOKEN</code> from your local environment. It stays in this browser tab and is never added to URLs.
          </p>
        </div>
        <label className="auth-field">
          <span>Control token</span>
          <input
            autoComplete="off"
            autoFocus
            name="control-token"
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste the local token"
            spellCheck={false}
            type="password"
            value={token}
          />
        </label>
        <button className="primary-button auth-submit" disabled={submitting || token.trim().length === 0} type="submit">
          {submitting ? <Loader2 className="auth-spinner" size={16} aria-hidden="true" /> : null}
          <span>{submitting ? "Checking…" : "Unlock"}</span>
        </button>
        {error ? <p className="auth-error">{error}</p> : null}
      </form>
    </main>
  );
}
