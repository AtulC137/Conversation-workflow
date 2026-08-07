export const NO_RESPONSE_HANDLE = "no-response";
export const DEFAULT_SILENCE_TIMEOUT_SEC = 3;

export type ResponseBranch = {
  id: string;
  label: string;
  examples?: string[];
};

export type NodeData = {
  title?: string;
  message?: string;
  instruction?: string;
  replyGuide?: string;
  waitForResponse?: boolean;
  silenceTimeoutSec?: number;
  responses?: ResponseBranch[];
  tone?: string;
  notes?: string;
  // start
  // end
  status?: "Completed" | "Uninterested" | "Callback Needed";
};

export type WorkflowTools = {
  voice: { enabled: boolean };
  whatsapp: { enabled: boolean; phoneNumber: string };
};

export const defaultWorkflowTools = (): WorkflowTools => ({
  voice: { enabled: false },
  whatsapp: { enabled: false, phoneNumber: "" },
});

export function canTestWorkflow(tools: WorkflowTools): boolean {
  return (
    tools.voice.enabled ||
    (tools.whatsapp.enabled && tools.whatsapp.phoneNumber.trim().length > 0)
  );
}
