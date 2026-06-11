"""

WorkflowRunner — tracks position in a conversation workflow graph.

"""



from __future__ import annotations

import os

from typing import Any

NO_RESPONSE_HANDLE = "no-response"
DEFAULT_SILENCE_TIMEOUT_SEC = float(os.environ.get("SILENCE_TIMEOUT_SEC", "2"))





class WorkflowRunner:

    def __init__(self, graph: dict[str, Any]):

        self.nodes: dict[str, dict] = {n["id"]: n for n in graph.get("nodes", [])}

        self.edges: list[dict] = graph.get("edges", [])

        self.current_node_id: str | None = self._find_first_conversation_id()

        self.qa_handled: bool = False



    def _find_first_conversation_id(self) -> str | None:

        start = next((n for n in self.nodes.values() if n.get("type") == "start"), None)

        if not start:

            return None

        for edge in self.edges:

            if edge["source"] != start["id"]:

                continue

            handle = edge.get("sourceHandle")

            if handle is None or handle == "ai-out":

                target = self.nodes.get(edge["target"])

                if target and target.get("type") == "conversation":

                    return edge["target"]

        return None



    def get_current_node(self) -> dict | None:

        if not self.current_node_id:

            return None

        return self.nodes.get(self.current_node_id)



    def get_node_type(self, node_id: str | None = None) -> str | None:

        nid = node_id or self.current_node_id

        if not nid:

            return None

        node = self.nodes.get(nid)

        return node.get("type") if node else None



    def is_qa_node(self, node_id: str | None = None) -> bool:

        return self.get_node_type(node_id) == "qa"



    def is_conversation_node(self, node_id: str | None = None) -> bool:

        return self.get_node_type(node_id) == "conversation"



    def is_user_input_node(self, node_id: str | None = None) -> bool:

        return self.get_node_type(node_id) == "userInput"



    def is_react_node(self, node_id: str | None = None) -> bool:

        return self.get_node_type(node_id) == "react"



    def get_instruction(self, node_id: str | None = None) -> str:

        nid = node_id or self.current_node_id

        if not nid:

            return ""

        node = self.nodes.get(nid)

        if not node:

            return ""

        return (node.get("instruction") or "").strip()



    def get_reply_guide(self, node_id: str | None = None) -> str:

        nid = node_id or self.current_node_id

        if not nid:

            return ""

        node = self.nodes.get(nid)

        if not node:

            return ""

        return (node.get("replyGuide") or "").strip()



    def get_wait_for_response(self, node_id: str | None = None) -> bool:

        nid = node_id or self.current_node_id

        if not nid:

            return True

        node = self.nodes.get(nid)

        if not node:

            return True

        return node.get("waitForResponse", True) is not False



    def mark_qa_handled(self) -> None:

        self.qa_handled = True



    def get_branches(self, node_id: str | None = None) -> list[dict]:

        nid = node_id or self.current_node_id

        if not nid:

            return []

        node = self.nodes.get(nid)

        if not node or node.get("type") not in ("conversation", "qa", "userInput", "react"):

            return []

        return node.get("responses") or []



    def get_message(self, node_id: str | None = None) -> str:

        nid = node_id or self.current_node_id

        if not nid:

            return ""

        node = self.nodes.get(nid)

        if not node:

            return ""

        return (node.get("message") or "").strip()



    def get_title(self, node_id: str | None = None) -> str:

        nid = node_id or self.current_node_id

        if not nid:

            return ""

        node = self.nodes.get(nid)

        if not node:

            return ""

        return (node.get("title") or nid).strip()



    def find_no_questions_branch(self, node_id: str | None = None) -> str | None:

        for branch in self.get_branches(node_id):

            bid = (branch.get("id") or "").strip()

            if not bid:

                continue

            suffix = bid.rsplit("-", 1)[-1]

            if suffix == "no" or bid.endswith("-no"):

                return bid

        return None



    def _out_edges(self, node_id: str) -> list[dict]:

        return [e for e in self.edges if e["source"] == node_id]



    def _has_response_branches(self, node_id: str | None = None) -> bool:

        nid = node_id or self.current_node_id

        if not nid:

            return False

        node = self.nodes.get(nid)

        if not node or node.get("type") not in ("conversation", "qa", "userInput", "react"):

            return False

        return bool(node.get("responses"))



    def is_end_node(self, node_id: str | None = None) -> bool:

        return self.get_node_type(node_id) == "end"



    def should_hangup_after_speak(self, node_id: str | None = None) -> bool:

        nid = node_id or self.current_node_id

        if not nid:

            return False

        if self.is_end_node(nid):

            return True

        node = self.nodes.get(nid)

        if not node or node.get("type") != "conversation":

            return False

        out = self._out_edges(nid)

        if not out:

            return False

        return all(

            self.nodes.get(edge["target"], {}).get("type") == "end" for edge in out

        )



    def is_terminal(self, node_id: str | None = None) -> bool:

        nid = node_id or self.current_node_id

        if not nid:

            return False

        node = self.nodes.get(nid)

        if not node or node.get("type") != "conversation":

            return False

        if node.get("responses"):

            return False

        out = self._out_edges(nid)

        if len(out) != 1:

            return False

        target = self.nodes.get(out[0]["target"])

        return target is not None and target.get("type") == "end"



    def _find_out_edge_target(self, node_id: str | None = None) -> str | None:
        nid = node_id or self.current_node_id
        if not nid:
            return None
        for edge in self._out_edges(nid):
            handle = edge.get("sourceHandle")
            if handle in (None, "ai-out"):
                return edge["target"]
        return None

    def advance_via_out_edge(self) -> str | None:
        target = self._find_out_edge_target()
        if target:
            self.current_node_id = target
            return target
        return None

    def get_silence_timeout_sec(self, node_id: str | None = None) -> float:
        nid = node_id or self.current_node_id
        if not nid:
            return DEFAULT_SILENCE_TIMEOUT_SEC
        node = self.nodes.get(nid)
        if not node:
            return DEFAULT_SILENCE_TIMEOUT_SEC
        val = node.get("silenceTimeoutSec")
        if val is not None:
            try:
                timeout = float(val)
                if timeout > 0:
                    return timeout
            except (TypeError, ValueError):
                pass
        return DEFAULT_SILENCE_TIMEOUT_SEC

    def has_explicit_no_response_wire(self, node_id: str | None = None) -> bool:
        nid = node_id or self.current_node_id
        if not nid:
            return False
        for edge in self._out_edges(nid):
            if edge.get("sourceHandle") == NO_RESPONSE_HANDLE:
                return True
        return False

    def find_no_response_target(self, node_id: str | None = None) -> str | None:
        # Branched conversation/qa nodes: only explicit no-response wire (no ai-out fallback).
        nid = node_id or self.current_node_id
        if not nid:
            return None
        for edge in self._out_edges(nid):
            if edge.get("sourceHandle") == NO_RESPONSE_HANDLE:
                return edge["target"]
        if self._has_response_branches(nid):
            return None
        return self._find_out_edge_target(nid)

    def advance_no_response(self) -> str | None:
        next_id = self.advance(NO_RESPONSE_HANDLE)
        if next_id:
            return next_id
        if self._has_response_branches():
            return None
        return self.advance_via_out_edge()

    def node_waits_for_caller(self, node_id: str | None = None) -> bool:
        nid = node_id or self.current_node_id
        if not nid:
            return False
        if self.is_user_input_node(nid) or self.is_react_node(nid):
            return self.get_wait_for_response(nid)
        if self.is_qa_node(nid) or self.is_conversation_node(nid):
            return True
        return False

    def advance(self, branch_id: str) -> str | None:

        if not self.current_node_id:

            return None

        for edge in self.edges:

            if edge["source"] != self.current_node_id:

                continue

            if edge.get("sourceHandle") != branch_id:

                continue

            self.current_node_id = edge["target"]

            return self.current_node_id

        return None



    def skip_qa_if_handled(self) -> str | None:

        """If on a qa node and questions were already answered, advance to goodbye."""

        if not self.is_qa_node() or not self.qa_handled:

            return self.current_node_id

        no_branch = self.find_no_questions_branch()

        if no_branch:

            return self.advance(no_branch)

        for edge in self._out_edges(self.current_node_id or ""):

            handle = edge.get("sourceHandle")

            if handle in (None, "ai-out"):

                self.current_node_id = edge["target"]

                return self.current_node_id

        return None



    def has_graph(self) -> bool:

        return bool(self.nodes) and self.current_node_id is not None


