"""Tests for FreJun transport message handling and workflow config helpers."""

import base64
import json
import unittest

from workflow_config import find_greeting, react_flow_to_voice_graph


class TestWorkflowConfig(unittest.TestCase):
    def test_react_flow_to_graph(self):
        nodes = [
            {"id": "s1", "type": "start", "data": {"title": "Start"}},
            {
                "id": "c1",
                "type": "conversation",
                "data": {"title": "Hi", "message": "Hello there"},
            },
            {"id": "e1", "type": "end", "data": {"title": "End", "status": "Done"}},
        ]
        edges = [
            {"source": "s1", "target": "c1", "sourceHandle": "ai-out"},
            {"source": "c1", "target": "e1", "sourceHandle": "ai-out"},
        ]
        graph = react_flow_to_voice_graph(nodes, edges)
        self.assertEqual(len(graph["nodes"]), 3)
        self.assertEqual(find_greeting(nodes, edges), "Hello there")


class TestFreJunMediaParse(unittest.TestCase):
    def test_teler_audio_payload_roundtrip(self):
        pcm = b"\x00\x01" * 160
        payload = {
            "type": "audio",
            "data": {"audio_b64": base64.b64encode(pcm).decode("ascii")},
        }
        raw = json.loads(json.dumps(payload))
        decoded = base64.b64decode(raw["data"]["audio_b64"])
        self.assertEqual(decoded, pcm)

    def test_teler_outbound_audio_shape(self):
        pcm = b"\x00\x01" * 80
        outbound = {
            "type": "audio",
            "audio_b64": base64.b64encode(pcm).decode("ascii"),
            "chunk_id": 1,
        }
        self.assertEqual(outbound["type"], "audio")
        self.assertIn("chunk_id", outbound)


if __name__ == "__main__":
    unittest.main()
