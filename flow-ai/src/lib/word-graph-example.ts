export const EXAMPLE_WORD_GRAPH = `Start: greet caller about {{reason}}. Wait for yes/no. Silence 8s → goodbye.

If yes: ask open questions using their excel row (Q&A block). Silence 8s → closing.

If no: say goodbye and end.

After Q&A: LLM explains their specific loan details from row data. Wait for ack. Silence 5s → closing.

Closing: thank them. Then end Completed.`;
