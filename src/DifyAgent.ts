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
   * Main entry point required by AbstractAgent.
   * Connects to Dify's streaming /chat-messages endpoint, parses the SSE chunks,
   * and yields them mapped to AG-UI events.
   */
  public override run(input: RunAgentInput): any {
    return new Observable<any>((subscriber) => {
      // 1. Get the latest user message from the run input
      const userMessages = input.messages.filter((m) => m.role === "user");
      const latestQuery = userMessages[userMessages.length - 1]?.content || "";

      if (!latestQuery) {
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

      // Perform the streaming request to Dify
      const runStream = async () => {
        try {
          const requestHeaders: Record<string, string> = {
            "Content-Type": "application/json"
          };
          
          if (this.apiKey) {
            requestHeaders["Authorization"] = `Bearer ${this.apiKey}`;
          }

          const response = await fetch(`${this.apiUrl}/chat-messages`, {
            method: "POST",
            headers: requestHeaders,
            signal: abortController.signal,
            body: JSON.stringify({
              inputs: {},
              query: latestQuery,
              response_mode: "streaming",
              user: "ag-ui-client-user",
              conversation_id: this.currentConversationId || ""
            })
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

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");

            // Keep the last partial line in the buffer
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              // Parse Dify SSE prefix (e.g. data: {"event": "..."})
              if (trimmed.startsWith("data:")) {
                const jsonStr = trimmed.substring(5).trim();
                try {
                  const payload = JSON.parse(jsonStr);

                  // A. Standard text chunk from assistant
                  if (payload.event === "message" || payload.event === "agent_message") {
                    // Emit TEXT_MESSAGE_START on first token
                    if (!hasStartedMessage) {
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
          if (!subscriber.closed) {
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
          console.error("Dify agent stream failed:", error);
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: error?.message || "Connection failed.",
            timestamp: Date.now()
          } as RunErrorEvent);
          subscriber.error(error);
        }
      };

      runStream();

      // Clean up connection if unsubscribed
      return () => {
        abortController.abort();
      };
    });
  }
}
