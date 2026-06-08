import { createFileRoute } from "@tanstack/react-router";
import { WorkflowBuilder } from "@/components/workflow/WorkflowBuilder";

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
  return <WorkflowBuilder />;
}
