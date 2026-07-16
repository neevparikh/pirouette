/** Normalize pi SDK events into a JSON-safe subset for WebSocket broadcast.
 *
 *  Lifted from the event-streaming spike with minor adjustments.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { NormalizedEvent } from "./types.js";

function normalizeMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return String(part);
      if ("type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      if (
        "type" in part &&
        part.type === "thinking" &&
        "thinking" in part &&
        typeof part.thinking === "string"
      ) {
        return `[thinking:${part.thinking}]`;
      }
      if ("type" in part && part.type === "toolCall") {
        const toolName = "name" in part && typeof part.name === "string" ? part.name : "unknown";
        return `[toolCall:${toolName}]`;
      }
      return JSON.stringify(part);
    })
    .join("");
}

export function normalizeEvent(event: AgentSessionEvent): NormalizedEvent {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "turn_start":
      return { type: event.type };
    case "turn_end":
      return {
        type: event.type,
        toolResults: event.toolResults.map((r) => ({
          toolName: r.toolName,
          isError: r.isError,
        })),
      };
    case "message_start":
    case "message_end":
      return {
        type: event.type,
        role: event.message.role,
        text: normalizeMessageText(
          (event.message as { content?: unknown }).content,
        ),
      };
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        return { type: event.type, updateType: "text_delta", delta: ame.delta };
      }
      if (ame.type === "thinking_delta") {
        return { type: event.type, updateType: "thinking_delta", delta: ame.delta };
      }
      if (ame.type === "toolcall_start") {
        // partial is an AssistantMessage; try to extract the tool name from the last content block
        const lastBlock = ame.partial?.content?.at(-1);
        const toolName = lastBlock && "type" in lastBlock && lastBlock.type === "toolCall"
          ? (lastBlock as { name?: string }).name
          : undefined;
        return {
          type: event.type,
          updateType: "toolcall_start",
          toolName,
        };
      }
      if (ame.type === "toolcall_delta") {
        return { type: event.type, updateType: "toolcall_delta" };
      }
      if (ame.type === "toolcall_end") {
        return {
          type: event.type,
          updateType: "toolcall_end",
          toolName: ame.toolCall.name,
          toolCallId: ame.toolCall.id,
        };
      }
      return { type: event.type, updateType: ame.type };
    }
    case "tool_execution_start":
      return {
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      };
    case "tool_execution_end": {
      // Include result content so the frontend can display tool output
      let resultContent: Array<{ type: string; text: string }> | undefined;
      if (event.result?.content && Array.isArray(event.result.content)) {
        resultContent = event.result.content
          .filter((c: unknown): c is { type: "text"; text: string } =>
            typeof c === "object" && c !== null && "type" in c && (c as { type: string }).type === "text",
          )
          .map((c: { type: "text"; text: string }) => ({ type: "text" as const, text: c.text }));
      }
      return {
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        result: resultContent ? { content: resultContent } : undefined,
      };
    }
    case "queue_update":
      return {
        type: event.type,
        steering: [...event.steering],
        followUp: [...event.followUp],
      };
    case "compaction_start":
      return { type: event.type, reason: event.reason };
    case "compaction_end":
      return {
        type: event.type,
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
      };
    case "auto_retry_start":
      return {
        type: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      };
    case "auto_retry_end":
      return { type: event.type, attempt: event.attempt, success: event.success };
    case "session_info_changed":
      return { type: event.type, name: event.name };
    case "thinking_level_changed":
      return { type: event.type, level: event.level };
    default:
      // Passthrough for event types we don't specially normalize (e.g.
      // `agent_settled`, added in newer pi SDKs). Broadcast the bare type
      // so the frontend at least sees it; JSON-safe by construction.
      return { type: (event as { type: string }).type };
  }
}
