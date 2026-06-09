"""Unit tests for WorkflowRunner graph navigation."""

import unittest

from workflow_runner import NO_RESPONSE_HANDLE, WorkflowRunner


def _loan_graph() -> dict:
    """Minimal graph mirroring intro → reminder / bye patterns."""
    return {
        "nodes": [
            {"id": "start", "type": "start"},
            {
                "id": "intro",
                "type": "conversation",
                "message": "Are you free?",
                "responses": [
                    {"id": "intro-yes", "label": "Yes"},
                    {"id": "intro-no", "label": "No"},
                ],
            },
            {
                "id": "reminder",
                "type": "conversation",
                "message": "Please pay.",
                "responses": [{"id": "reminder-ok", "label": "ok"}],
            },
            {"id": "warning", "type": "userInput", "instruction": "Tell fine.", "waitForResponse": False},
            {"id": "qa", "type": "qa", "message": "Any questions?", "responses": [{"id": "qa-no", "label": "no questions"}]},
            {
                "id": "bye",
                "type": "conversation",
                "message": "Goodbye.",
                "responses": [{"id": "bye-continue", "label": "Continue"}],
            },
            {"id": "end", "type": "end", "status": "Completed"},
            {"id": "linear", "type": "conversation", "message": "Linear only."},
        ],
        "edges": [
            {"source": "start", "target": "intro", "sourceHandle": "ai-out"},
            {"source": "intro", "target": "reminder", "sourceHandle": "intro-yes"},
            {"source": "intro", "target": "bye", "sourceHandle": "intro-no"},
            {"source": "intro", "target": "bye", "sourceHandle": NO_RESPONSE_HANDLE},
            {"source": "reminder", "target": "warning", "sourceHandle": "reminder-ok"},
            {"source": "reminder", "target": "bye", "sourceHandle": NO_RESPONSE_HANDLE},
            {"source": "warning", "target": "qa", "sourceHandle": "ai-out"},
            {"source": "qa", "target": "bye", "sourceHandle": "qa-no"},
            {"source": "bye", "target": "end", "sourceHandle": "bye-continue"},
            {"source": "bye", "target": "end", "sourceHandle": NO_RESPONSE_HANDLE},
            {"source": "linear", "target": "end", "sourceHandle": "ai-out"},
        ],
    }


class WorkflowRunnerNoResponseTests(unittest.TestCase):
    def setUp(self):
        self.runner = WorkflowRunner(_loan_graph())

    def test_branched_node_uses_only_explicit_no_response_wire(self):
        self.runner.current_node_id = "intro"
        self.assertEqual(self.runner.find_no_response_target("intro"), "bye")

    def test_branched_node_does_not_fall_back_to_ai_out(self):
        graph = _loan_graph()
        # Remove no-response wire — branched intro must not advance via ai-out.
        graph["edges"] = [e for e in graph["edges"] if not (e["source"] == "intro" and e.get("sourceHandle") == NO_RESPONSE_HANDLE)]
        runner = WorkflowRunner(graph)
        runner.current_node_id = "intro"
        self.assertIsNone(runner.find_no_response_target("intro"))
        self.assertIsNone(runner.advance_no_response())

    def test_unbranched_node_falls_back_to_ai_out(self):
        self.runner.current_node_id = "linear"
        self.assertEqual(self.runner.find_no_response_target("linear"), "end")
        self.assertEqual(self.runner.advance_no_response(), "end")

    def test_qa_node_with_responses_requires_no_response_wire(self):
        graph = _loan_graph()
        graph["edges"] = [e for e in graph["edges"] if e["source"] != "qa"]
        runner = WorkflowRunner(graph)
        runner.current_node_id = "qa"
        self.assertIsNone(runner.find_no_response_target("qa"))


class WorkflowRunnerHangupTests(unittest.TestCase):
    def setUp(self):
        self.runner = WorkflowRunner(_loan_graph())

    def test_is_end_node(self):
        self.assertTrue(self.runner.is_end_node("end"))
        self.assertFalse(self.runner.is_end_node("bye"))

    def test_should_hangup_after_speak_for_bye(self):
        self.assertTrue(self.runner.should_hangup_after_speak("bye"))

    def test_should_not_hangup_after_intro(self):
        self.assertFalse(self.runner.should_hangup_after_speak("intro"))

    def test_is_terminal_legacy_single_edge(self):
        self.runner.current_node_id = "linear"
        self.assertTrue(self.runner.is_terminal("linear"))


if __name__ == "__main__":
    unittest.main()
