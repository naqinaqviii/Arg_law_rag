/**
 * OpenAI Fallback Service
 *
 * Streams a chat completion from the OpenAI API (browser-side).
 * Used as a fallback when the primary Dify RAG endpoint is slow.
 *
 * Features automatic API key rotation: if a key hits its quota limit
 * (HTTP 429 / 402), the next backup key is tried automatically.
 *
 * SECURITY NOTE: Calling OpenAI directly from the browser exposes the API key
 * in client-side JS. This is acceptable for internal/demo use only.
 */

import { EventType } from "@ag-ui/client";
import type {
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunErrorEvent,
  Message,
} from "@ag-ui/client";

// ─── Key Rotation Setup ─────────────────────────────────────────────────────

const PRIMARY_KEY = import.meta.env.VITE_OPENAI_API_KEY as string;
const BACKUP_KEYS_RAW = (import.meta.env.VITE_OPENAI_BACKUP_KEYS as string) || "";

/** All available API keys (primary first, then backups). */
const ALL_KEYS: string[] = [
  PRIMARY_KEY,
  ...BACKUP_KEYS_RAW.split(",").map((k) => k.trim()).filter(Boolean),
];

/** Index of the currently active key – persists across calls within a session. */
let activeKeyIndex = 0;

function getActiveKey(): string {
  return ALL_KEYS[activeKeyIndex];
}

function rotateToNextKey(): boolean {
  const nextIndex = activeKeyIndex + 1;
  if (nextIndex < ALL_KEYS.length) {
    activeKeyIndex = nextIndex;
    console.warn(
      `[KeyRotation] Switched to backup key #${nextIndex} (${ALL_KEYS[nextIndex].slice(0, 12)}…)`
    );
    return true;
  }
  console.error("[KeyRotation] All API keys exhausted – no more backups available.");
  return false;
}

/** HTTP status codes that indicate quota / rate-limit exhaustion. */
const QUOTA_ERROR_CODES = new Set([429, 402]);

// ─── Configuration ───────────────────────────────────────────────────────────

const OPENAI_MODEL = (import.meta.env.VITE_OPENAI_MODEL as string) || "gpt-4o-mini";
const OPENAI_BASE_URL =
  (import.meta.env.VITE_OPENAI_BASE_URL as string) || "https://api.openai.com/v1";

/** Minimal OpenAI message shape */
interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Convert AG-UI Message[] history to OpenAI's message format.
 * Adds a system prompt tailored for the ARG Law Portal context.
 */
function toOpenAIMessages(agMessages: Message[]): OpenAIChatMessage[] {
  const systemPrompt: OpenAIChatMessage = {
    role: "system",
    content:
      "You are ARG Corporate AI, an expert legal and tax advisory assistant for Pakistan. " +
      "You provide accurate guidance on FBR taxation, SECP corporate compliance, company law, " +
      "and statutory precedents. Be concise, professional, and cite relevant sections where applicable. " +
      "If you are unsure about a specific statutory detail, say so clearly.",
  };

  const converted: OpenAIChatMessage[] = agMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : "",
    }));

  return [systemPrompt, ...converted];
}

// ─── Core Streaming Function ─────────────────────────────────────────────────

/**
 * Attempt a single streaming request with the given API key.
 * Returns the Response object if successful, or throws on non-quota errors.
 * On quota errors (429/402) returns `null` to signal "try next key".
 */
async function tryStreamWithKey(
  apiKey: string,
  openaiMessages: OpenAIChatMessage[],
  signal?: AbortSignal
): Promise<Response | null> {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://arg-law-portal.app",
      "X-Title": "ARG Law Portal",
    },
    signal,
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: openaiMessages,
      stream: true,
      temperature: 0.4,
      max_tokens: 2048,
    }),
  });

  if (response.ok) {
    return response;
  }

  // Quota / rate-limit → signal caller to rotate
  if (QUOTA_ERROR_CODES.has(response.status)) {
    const errText = await response.text();
    console.warn(
      `[KeyRotation] Key ${apiKey.slice(0, 12)}… hit quota/rate limit (${response.status}): ${errText}`
    );
    return null;
  }

  // Any other error is a hard failure
  const errText = await response.text();
  throw new Error(`OpenAI API error (${response.status}): ${errText}`);
}

/**
 * Stream a chat completion from OpenAI and emit AG-UI–compatible events
 * through the provided subscriber (RxJS-style next/error/complete).
 *
 * Automatically rotates through available API keys on quota errors.
 *
 * @param subscriber - RxJS subscriber that receives AG-UI events.
 * @param runId      - The current run ID (for event tagging).
 * @param messageId  - Unique ID for the assistant message being generated.
 * @param messages   - Full conversation history in AG-UI Message[] format.
 * @param signal     - Optional AbortSignal to cancel the request.
 */
export async function streamOpenAIFallback(
  subscriber: {
    next: (event: any) => void;
    error: (err: any) => void;
    complete: () => void;
    closed?: boolean;
  },
  runId: string,
  messageId: string,
  messages: Message[],
  signal?: AbortSignal
): Promise<void> {
  if (ALL_KEYS.length === 0 || ALL_KEYS.every((k) => !k || k === "sk-proj-YOUR_NEW_KEY_HERE")) {
    throw new Error(
      "No OpenAI API keys configured. Set VITE_OPENAI_API_KEY (and optionally VITE_OPENAI_BACKUP_KEYS) in your .env file."
    );
  }

  const openaiMessages = toOpenAIMessages(messages);

  // Try current key, then rotate through remaining keys on quota errors
  let response: Response | null = null;
  const startIndex = activeKeyIndex;

  while (true) {
    const key = getActiveKey();
    response = await tryStreamWithKey(key, openaiMessages, signal);

    if (response) break; // success

    // Quota hit → try next key
    const hasMore = rotateToNextKey();
    if (!hasMore) {
      throw new Error(
        "All API keys have exceeded their quota. Please add new keys or wait for quota reset."
      );
    }
  }

  if (!response!.body) {
    throw new Error("OpenAI streaming response body is empty.");
  }

  // Emit TEXT_MESSAGE_START
  subscriber.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
    timestamp: Date.now(),
  } as TextMessageStartEvent);

  const reader = response!.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep last partial line
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const jsonStr = trimmed.substring(5).trim();
      if (jsonStr === "[DONE]") {
        // Stream finished
        break;
      }

      try {
        const payload = JSON.parse(jsonStr);
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) {
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta,
          } as TextMessageContentEvent);
        }
      } catch {
        // Skip unparseable SSE lines
      }
    }
  }

  // Emit TEXT_MESSAGE_END
  subscriber.next({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
    timestamp: Date.now(),
  } as TextMessageEndEvent);

  // Emit RUN_FINISHED
  subscriber.next({
    type: EventType.RUN_FINISHED,
    runId,
    outcome: { type: "success" },
    timestamp: Date.now(),
  } as RunFinishedEvent);

  subscriber.complete();
}

