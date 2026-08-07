"""Build voice session config from workflow nodes/edges (react-flow JSON)."""

from __future__ import annotations

from typing import Any


def _node_data(node: dict) -> dict:
    data = node.get("data") or {}
    return data if isinstance(data, dict) else {}


def _responses(data: dict) -> list[dict]:
    out = []
    for r in data.get("responses") or []:
        if not isinstance(r, dict):
            continue
        item = {"id": r.get("id", ""), "label": r.get("label", "")}
        examples = r.get("examples")
        if examples:
            item["examples"] = [e for e in examples if e]
        out.append(item)
    return out


def react_flow_to_voice_graph(nodes: list[dict], edges: list[dict]) -> dict[str, Any]:
    allowed = {"start", "conversation", "qa", "userInput", "react", "end"}
    graph_nodes: list[dict] = []

    for node in nodes:
        ntype = node.get("type")
        if ntype not in allowed:
            continue
        data = _node_data(node)
        base = {"id": node.get("id", ""), "type": ntype, "title": data.get("title")}

        if ntype == "start":
            graph_nodes.append(base)
        elif ntype == "end":
            graph_nodes.append({**base, "status": data.get("status")})
        elif ntype == "conversation":
            graph_nodes.append(
                {
                    **base,
                    "message": data.get("message"),
                    "waitForResponse": data.get("waitForResponse"),
                    "silenceTimeoutSec": data.get("silenceTimeoutSec"),
                    "responses": _responses(data),
                }
            )
        elif ntype == "qa":
            graph_nodes.append(
                {
                    **base,
                    "message": data.get("message"),
                    "silenceTimeoutSec": data.get("silenceTimeoutSec"),
                    "responses": _responses(data),
                }
            )
        elif ntype == "userInput":
            graph_nodes.append(
                {
                    **base,
                    "instruction": data.get("instruction"),
                    "waitForResponse": data.get("waitForResponse"),
                    "silenceTimeoutSec": data.get("silenceTimeoutSec"),
                    "responses": _responses(data),
                }
            )
        elif ntype == "react":
            graph_nodes.append(
                {
                    **base,
                    "instruction": data.get("instruction"),
                    "replyGuide": data.get("replyGuide"),
                    "waitForResponse": data.get("waitForResponse"),
                    "silenceTimeoutSec": data.get("silenceTimeoutSec"),
                    "responses": _responses(data),
                }
            )

    graph_edges = [
        {
            "source": e.get("source", ""),
            "target": e.get("target", ""),
            "sourceHandle": e.get("sourceHandle"),
        }
        for e in edges
        if isinstance(e, dict)
    ]
    return {"nodes": graph_nodes, "edges": graph_edges}


def find_greeting(nodes: list[dict], edges: list[dict]) -> str | None:
    by_id = {n.get("id"): n for n in nodes}
    start = next((n for n in nodes if n.get("type") == "start"), None)
    if not start:
        return None

    for edge in edges:
        if edge.get("source") != start.get("id"):
            continue
        handle = edge.get("sourceHandle")
        if handle is not None and handle != "ai-out":
            continue
        target = by_id.get(edge.get("target"))
        if target and target.get("type") == "conversation":
            msg = _node_data(target).get("message")
            if isinstance(msg, str) and msg.strip():
                return msg.strip()
    return None


def collect_end_points(nodes: list[dict]) -> list[str]:
    points: list[str] = []
    for node in nodes:
        if node.get("type") != "end":
            continue
        status = _node_data(node).get("status")
        if isinstance(status, str) and status.strip():
            points.append(status.strip())
    return points


def build_example_script(nodes: list[dict], edges: list[dict]) -> str:
    greeting = find_greeting(nodes, edges)
    if greeting:
        return f"AI: {greeting}"
    return "AI: Hello! How can I help you today?"
