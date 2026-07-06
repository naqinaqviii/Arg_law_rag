import {
  AbstractAgent,
  EventType
} from "@ag-ui/client";
import type {
  AgentConfig,
  RunAgentInput,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunErrorEvent
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { v4 as uuidv4 } from "uuid";
import { streamOpenAIFallback } from "./OpenAIFallback";


// Read fallback timeout from env (default 15 seconds)
const FALLBACK_TIMEOUT_MS = Number(
  import.meta.env.VITE_OPENAI_FALLBACK_TIMEOUT_MS ?? 15000
);

interface DifyAgentConfig extends AgentConfig {
  apiKey?: string;
  apiUrl: string;
}

export class DifyAgent extends AbstractAgent {
  private apiKey?: string;
  private apiUrl: string;
  private currentConversationId: string | null = null;

  constructor(config: DifyAgentConfig) {
    super(config);
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl;

    // Load persistent conversation ID if saved
    const savedConvId = localStorage.getItem("dify_conversation_id");
    if (savedConvId) {
      this.currentConversationId = savedConvId;
    }
  }

  /**
   * Reset the current conversation to start a new chat session.
   */
  public resetConversation() {
    this.currentConversationId = null;
    localStorage.removeItem("dify_conversation_id");
    this.setMessages([]);
  }

  public getConversationId(): string | null {
    return this.currentConversationId;
  }

  public setConversationId(conversationId: string | null) {
    this.currentConversationId = conversationId;
    if (conversationId) {
      localStorage.setItem("dify_conversation_id", conversationId);
    } else {
      localStorage.removeItem("dify_conversation_id");
    }
  }

  /**
   * Upload a file to Dify's /files/upload endpoint.
   */
  public async uploadFile(file: File): Promise<any> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("user", "ag-ui-client-user");

    const requestHeaders: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey || "app-NaiszFmtKTlPA13NLzT4Mc80"}`
    };

    console.log("[DifyAgent] Uploading file to Dify:", file.name, "size:", file.size);
    const response = await fetch(`${this.apiUrl}/files/upload`, {
      method: "POST",
      headers: requestHeaders,
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[DifyAgent] Upload failed with status:", response.status, "body:", errText);
      throw new Error(`Dify upload error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    console.log("[DifyAgent] Upload success, response data:", data);
    return data;
  }

  /**
   * Main entry point required by AbstractAgent.
   * Connects to Dify's streaming /chat-messages endpoint, parses the SSE chunks,
   * and yields them mapped to AG-UI events.
   *
   * If Dify does not return the first content token within FALLBACK_TIMEOUT_MS,
   * the Dify request is aborted and the query is re-routed to OpenAI as a fallback.
   */
  public override run(input: RunAgentInput): any {
    return new Observable<any>((subscriber) => {
      // 1. Get the latest user message from the run input
      const userMessages = input.messages.filter((m) => m.role === "user");
      const latestMessage = userMessages[userMessages.length - 1];

      let latestQuery = "";
      const difyFiles: Array<{ type: string; transfer_method: string; upload_file_id: string }> = [];

      if (latestMessage) {
        console.log("[DifyAgent] run latestMessage:", latestMessage);
        if (typeof latestMessage.content === "string") {
          latestQuery = latestMessage.content;
        } else if (Array.isArray(latestMessage.content)) {
          for (const part of latestMessage.content) {
            if (part.type === "text") {
              latestQuery += (part.text || "");
            } else if (part.type === "document") {
              const metadata = (part as any).metadata;
              const source = (part as any).source;
              const fileId = metadata?.id || metadata?.upload_file_id;
              const mimeType = source?.mimeType || "";
              const isImage = mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(metadata?.extension || "");
              const type = isImage ? "image" : "document";
              if (fileId) {
                difyFiles.push({
                  type,
                  transfer_method: "local_file",
                  upload_file_id: fileId
                });
              }
            }
          }
        }
      }

      console.log("[DifyAgent] run parameters - latestQuery:", latestQuery, "difyFiles:", difyFiles);

      if (!latestQuery && difyFiles.length === 0) {
        subscriber.next({
          type: EventType.RUN_FINISHED,
          runId: input.runId,
          outcome: { type: "success" },
          timestamp: Date.now()
        } as RunFinishedEvent);
        subscriber.complete();
        return;
      }

      // Generate a unique ID for the incoming assistant response
      const assistantMessageId = `msg_${uuidv4()}`;
      let hasStartedMessage = false;
      const abortController = new AbortController();

      // Emit RUN_STARTED event
      subscriber.next({
        type: EventType.RUN_STARTED,
        runId: input.runId,
        timestamp: Date.now()
      } as RunStartedEvent);

      // ── Timeout-based fallback logic ──────────────────────────────────
      let firstTokenReceived = false;
      let fallbackTriggered = false;

      const fallbackTimer = setTimeout(() => {
        if (!firstTokenReceived && !subscriber.closed) {
          fallbackTriggered = true;
          console.warn(
            `[DifyAgent] Dify did not respond within ${FALLBACK_TIMEOUT_MS}ms — falling back to OpenAI.`
          );

          // Abort the ongoing Dify request
          abortController.abort();

          // Launch OpenAI fallback stream
          const fallbackAbort = new AbortController();
          streamOpenAIFallback(
            subscriber,
            input.runId,
            assistantMessageId,
            input.messages,
            fallbackAbort.signal
          ).catch((fallbackErr: any) => {
            console.error("[DifyAgent] OpenAI fallback also failed:", fallbackErr);
            subscriber.next({
              type: EventType.RUN_ERROR,
              message:
                fallbackErr?.message ||
                "Both Dify and OpenAI fallback failed.",
              timestamp: Date.now()
            } as RunErrorEvent);
            subscriber.error(fallbackErr);
          });
        }
      }, FALLBACK_TIMEOUT_MS);
      // ─────────────────────────────────────────────────────────────────

      // Perform the streaming request to Dify
      const runStream = async () => {
        try {
          const requestHeaders: Record<string, string> = {
            "Content-Type": "application/json"
          };

          if (this.apiKey) {
            requestHeaders["Authorization"] = `Bearer ${this.apiKey}`;
          } else {
            requestHeaders["Authorization"] = `Bearer ${"app-NaiszFmtKTlPA13NLzT4Mc80"}`;
          }

          const requestBody = {
            inputs: {},
            query: latestQuery,
            response_mode: "streaming",
            user: "ag-ui-client-user",
            conversation_id: this.currentConversationId || "",
            ...(difyFiles.length > 0 ? { files: difyFiles } : {})
          };
          console.log("[DifyAgent] POST /chat-messages request body:", requestBody);

          const response = await fetch(`${this.apiUrl}/chat-messages`, {
            method: "POST",
            headers: requestHeaders,
            signal: abortController.signal,
            body: JSON.stringify(requestBody)
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Dify API error (${response.status}): ${errText}`);
          }

          if (!response.body) {
            throw new Error("Dify streaming response body is empty.");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // If fallback already took over, stop processing Dify chunks
            if (fallbackTriggered) return;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");

            // Keep the last partial line in the buffer
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              // If fallback already took over mid-loop, bail out
              if (fallbackTriggered) return;

              // Parse Dify SSE prefix (e.g. data: {"event": "..."})
              if (trimmed.startsWith("data:")) {
                const jsonStr = trimmed.substring(5).trim();
                try {
                  const payload = JSON.parse(jsonStr);

                  // A. Standard text chunk from assistant
                  if (payload.event === "message" || payload.event === "agent_message") {
                    // Emit TEXT_MESSAGE_START on first token
                    if (!hasStartedMessage) {
                      // ── Mark first token received → cancel fallback timer ──
                      firstTokenReceived = true;
                      clearTimeout(fallbackTimer);
                      // ──────────────────────────────────────────────────────

                      subscriber.next({
                        type: EventType.TEXT_MESSAGE_START,
                        messageId: assistantMessageId,
                        role: "assistant",
                        timestamp: Date.now()
                      } as TextMessageStartEvent);
                      hasStartedMessage = true;
                    }

                    // Emit TEXT_MESSAGE_CONTENT delta
                    if (payload.answer) {
                      subscriber.next({
                        type: EventType.TEXT_MESSAGE_CONTENT,
                        messageId: assistantMessageId,
                        delta: payload.answer
                      } as TextMessageContentEvent);
                    }
                  }

                  // B. Conversation finished event
                  if (payload.event === "message_end") {
                    // Capture and persist conversation ID for session continuity
                    if (payload.conversation_id) {
                      this.currentConversationId = payload.conversation_id;
                      localStorage.setItem("dify_conversation_id", payload.conversation_id);
                    }

                    // Emit TEXT_MESSAGE_END
                    if (hasStartedMessage) {
                      subscriber.next({
                        type: EventType.TEXT_MESSAGE_END,
                        messageId: assistantMessageId,
                        timestamp: Date.now()
                      } as TextMessageEndEvent);
                    }

                    // Emit RUN_FINISHED
                    subscriber.next({
                      type: EventType.RUN_FINISHED,
                      runId: input.runId,
                      outcome: { type: "success" },
                      timestamp: Date.now()
                    } as RunFinishedEvent);

                    clearTimeout(fallbackTimer);
                    subscriber.complete();
                    return;
                  }

                  // C. Error event from Dify server
                  if (payload.event === "error") {
                    throw new Error(payload.message || "An unknown Dify engine error occurred.");
                  }

                } catch (parseErr) {
                  console.error("Failed to parse SSE JSON:", parseErr, "Raw line:", trimmed);
                }
              }
            }
          }

          // Fallback if stream closed abruptly without message_end
          if (!subscriber.closed && !fallbackTriggered) {
            clearTimeout(fallbackTimer);
            if (hasStartedMessage) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                messageId: assistantMessageId,
                timestamp: Date.now()
              } as TextMessageEndEvent);
            }
            subscriber.next({
              type: EventType.RUN_FINISHED,
              runId: input.runId,
              outcome: { type: "success" },
              timestamp: Date.now()
            } as RunFinishedEvent);
            subscriber.complete();
          }

        } catch (error: any) {
          // If the error is due to intentional abort for fallback, don't treat it as a real error
          if (fallbackTriggered) {
            return; // OpenAI fallback is already handling the response
          }

          clearTimeout(fallbackTimer);
          console.error("Dify agent stream failed:", error);

          // If Dify fails outright (not timeout), also try the OpenAI fallback
          if (!subscriber.closed) {
            console.warn("[DifyAgent] Dify failed — attempting OpenAI fallback.");
            try {
              await streamOpenAIFallback(
                subscriber,
                input.runId,
                assistantMessageId,
                input.messages
              );
            } catch (fallbackErr: any) {
              console.error("[DifyAgent] OpenAI fallback also failed:", fallbackErr);
              subscriber.next({
                type: EventType.RUN_ERROR,
                message: fallbackErr?.message || "Both Dify and OpenAI fallback failed.",
                timestamp: Date.now()
              } as RunErrorEvent);
              subscriber.error(fallbackErr);
            }
          }
        }
      };

      runStream();

      // Clean up connection if unsubscribed
      return () => {
        clearTimeout(fallbackTimer);
        abortController.abort();
      };
    });
  }
}
