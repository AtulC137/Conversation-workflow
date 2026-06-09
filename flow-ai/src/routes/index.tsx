import { createFileRoute, Navigate } from "@tanstack/react-router";
import { WorkflowBuilder } from "@/components/workflow/WorkflowBuilder";
import { useAuth } from "@/lib/auth/AuthContext";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Susha — AI Communication Workflow Platform" },
      { name: "description", content: "Design conversational workflows for AI voice and WhatsApp agents." },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" />;
  }

  return <WorkflowBuilder />;
}
