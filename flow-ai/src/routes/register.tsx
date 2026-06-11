import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { checkSlugAvailable, slugify } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/AuthContext";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [organizationName, setOrganizationName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!slugTouched && organizationName) {
      setOrganizationSlug(slugify(organizationName));
    }
  }, [organizationName, slugTouched]);

  useEffect(() => {
    const slug = organizationSlug.trim();
    if (!slug) {
      setSlugAvailable(null);
      return;
    }
    const t = setTimeout(() => {
      checkSlugAvailable(slug)
        .then((r) => setSlugAvailable(r.available))
        .catch(() => setSlugAvailable(null));
    }, 400);
    return () => clearTimeout(t);
  }, [organizationSlug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (slugAvailable === false) {
      setError("Organization URL is already taken");
      return;
    }
    setSubmitting(true);
    try {
      await register({
        organizationName,
        organizationSlug: organizationSlug.trim().toLowerCase(),
        name,
        email,
        password,
      });
      navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold">Create account</h1>
        <p className="mt-1 text-sm text-muted-foreground">Set up your organization and admin account</p>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <label className="mt-4 block text-sm font-medium">
          Organization name
          <input
            type="text"
            required
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="mt-3 block text-sm font-medium">
          Organization URL
          <input
            type="text"
            required
            pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
            placeholder="acme-bank"
            value={organizationSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setOrganizationSlug(e.target.value.toLowerCase());
            }}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {slugAvailable === true && (
            <span className="mt-1 block text-xs text-green-600">Available</span>
          )}
          {slugAvailable === false && (
            <span className="mt-1 block text-xs text-red-600">Already taken</span>
          )}
        </label>

        <label className="mt-3 block text-sm font-medium">
          Your name
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="mt-3 block text-sm font-medium">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="mt-3 block text-sm font-medium">
          Password
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
          />
        </label>

        <button
          type="submit"
          disabled={submitting || slugAvailable === false}
          className="mt-6 w-full rounded-lg bg-foreground py-2 text-sm font-medium text-background disabled:opacity-60"
        >
          {submitting ? "Creating…" : "Register"}
        </button>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-foreground underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
