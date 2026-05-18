import { useState } from "preact/hooks";
import { useAdminAuth } from "../hooks/useAdminAuth";

interface Props {
  onLoggedIn: () => void;
}

// Default credentials are admin/admin; backend forces a password change
// on the next call after first login. AdminLogin shows that prompt inline
// rather than redirecting.
export function AdminLogin(props: Props) {
  const auth = useAdminAuth();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [busy, setBusy] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await auth.login(username, password);
      if (r.must_change_password) {
        setMustChange(true);
      } else {
        props.onLoggedIn();
      }
    } catch (err: any) {
      setError(err?.message ?? "login failed");
    } finally {
      setBusy(false);
    }
  }

  async function onChange(e: Event) {
    e.preventDefault();
    if (newPassword.length < 8) {
      setError("password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirm) {
      setError("passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { api } = await import("../api");
      if (!auth.token) throw new Error("not logged in");
      await api.adminChangePassword(password, newPassword, auth.token);
      // Backend invalidates the session after password change; log in again.
      await auth.login(username, newPassword);
      props.onLoggedIn();
    } catch (err: any) {
      setError(err?.message ?? "change failed");
    } finally {
      setBusy(false);
    }
  }

  if (mustChange) {
    return (
      <form class="admin-login" onSubmit={onChange}>
        <h1>Set a new password</h1>
        <p class="admin-login__hint">
          You're logged in with the default credentials. Set a new password to continue.
        </p>
        <label>
          New password
          <input
            type="password"
            value={newPassword}
            onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
            autoFocus
          />
        </label>
        <label>
          Confirm
          <input
            type="password"
            value={confirm}
            onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
          />
        </label>
        {error && <div class="admin-login__error">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save & continue"}</button>
      </form>
    );
  }

  return (
    <form class="admin-login" onSubmit={onSubmit}>
      <h1>Admin sign in</h1>
      <p class="admin-login__hint">Default credentials are admin / admin.</p>
      <label>
        Username
        <input
          value={username}
          onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
          autoFocus
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        />
      </label>
      {error && <div class="admin-login__error">{error}</div>}
      <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
