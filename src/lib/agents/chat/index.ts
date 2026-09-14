import {
  ActionOutput,
  SearchAgentConfig,
  SearchSources,
} from '@/lib/agents/search/types';
import { classify } from '@/lib/agents/search/classifier';
import { WidgetExecutor } from '@/lib/agents/search/widgets';
import { ActionRegistry } from '@/lib/agents/search/researcher/actions';
import { getChatPrompt } from '@/lib/prompts/chat';
import { loadChatHistory, mergeHistories } from '@/lib/utils/chatHistory';
import SessionManager from '@/lib/session';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { Chunk, ChatTurnMessage, Message, TextBlock } from '@/lib/types';
import { Tool, ToolCall } from '@/lib/models/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

export type ChatAgentInput = {
  chatHistory: ChatTurnMessage[];
  query: string;
  config: SearchAgentConfig;
  chatId: string;
  messageId: string;
};

/** Groq (and similar) may abort the stream with this when tool JSON is invalid. */
function isLlmToolGenerationFailedError(err: unknown): boolean {
  const e = err as {
    error?: { code?: string };
    code?: string;
    message?: string;
  };
  if (e?.error?.code === 'tool_use_failed' || e?.code === 'tool_use_failed') {
    return true;
  }
  const msg = e?.message ?? (err instanceof Error ? err.message : '');
  return (
    typeof msg === 'string' &&
    (msg.includes('tool_use_failed') ||
      msg.includes('Failed to call a function'))
  );
}

class ChatAgent {
  private getChatTools(input: {
    classification: Awaited<ReturnType<typeof classify>>;
    mode: SearchAgentConfig['mode'];
    fileIds: string[];
    sources: SearchSources[];
  }): Tool[] {
    const names = [
      'social_search',
      'academic_search',
      'uploads_search',
      'scrape_url',
      'web_search',
    ];

    const tools: Tool[] = [];

    for (const name of names) {
      const action = ActionRegistry.get(name);

      if (!action) continue;

      if (
        action.enabled({
          classification: input.classification,
          fileIds: input.fileIds,
          mode: input.mode,
          sources: input.sources,
        })
      ) {
        tools.push({
          name: action.name,
          description: action.getToolDescription({ mode: input.mode }),
          schema: action.schema,
        });
      }
    }

    return tools;
  }

  private filterSearchResults(searchResults: Chunk[]): Chunk[] {
    const seenUrls = new Map<string, number>();

    return searchResults
      .map((result, index) => {
        if (result.metadata.url && !seenUrls.has(result.metadata.url)) {
          seenUrls.set(result.metadata.url, index);
          return result;
        } else if (result.metadata.url && seenUrls.has(result.metadata.url)) {
          const existingIndex = seenUrls.get(result.metadata.url)!;

          const existingResult = searchResults[existingIndex];

          existingResult.content += `\n\n${result.content}`;

          return undefined;
        }

        return result;
      })
      .filter((r) => r !== undefined);
  }

  async chatAsync(session: SessionManager, input: ChatAgentInput) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.query,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    const serverHistory = await loadChatHistory(
      input.chatId,
      input.messageId,
    );

    const chatHistory = mergeHistories(serverHistory, input.chatHistory);

    const classification = await classify({
      chatHistory,
      enabledSources: input.config.sources,
      query: input.query,
      llm: input.config.llm,
    });

    const widgetOutputs = await WidgetExecutor.executeAll({
      classification,
      chatHistory,
      followUp: input.query,
      llm: input.config.llm,
    });

    widgetOutputs.forEach((o) => {
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'widget',
        data: {
          widgetType: o.type,
          params: o.data,
        },
      });
    });

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const mode = input.config.mode;
    const skipSearch = classification.classification.skipSearch;

    const systemPrompt = getChatPrompt({
      systemInstructions: input.config.systemInstructions,
      widgetContext,
      mode,
      skipSearch,
    });

    const availableTools = this.getChatTools({
      classification,
      mode,
      fileIds: input.config.fileIds,
      sources: input.config.sources,
    });

    const maxIterations = mode === 'speed' ? 2 : mode === 'balanced' ? 4 : 8;

    const agentMessageHistory: Message[] = [];

    let researchBlockId = '';
    let allSearchResults: Chunk[] = [];
    let loopExhausted = false;

    let textBlockId = '';
    let accumulatedText = '';

    const streamChunkIntoBlock = (text: string) => {
      if (!text) return;

      if (!textBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: text,
        };

        session.emitBlock(block);

        textBlockId = block.id;
      } else {
        const block = session.getBlock(textBlockId) as TextBlock | null;

        if (!block) return;

        block.data += text;

        session.updateBlock(textBlockId, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }

      accumulatedText += text;
    };

    const resetTextBlockTo = (text: string) => {
      if (!textBlockId) return;

      const block = session.getBlock(textBlockId) as TextBlock | null;

      if (!block) return;

      block.data = text;

      session.updateBlock(textBlockId, [
        {
          op: 'replace',
          path: '/data',
          value: text,
        },
      ]);

      accumulatedText = text;
    };

    // When tools are available, embed the conversation inside a single user
    // message (mirroring the researcher loop). Gemini requires that a
    // function-call assistant turn directly follow a user or function
    // response turn; having a plain prior assistant turn (the last chat reply)
    // immediately before the first tool-call turn triggers a 400.
    const preamble: Message[] =
      availableTools.length > 0
        ? [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: `<conversation>\n${formatChatHistoryAsString(
                chatHistory.slice(-20),
              )}\nUser: ${input.query}\n</conversation>`,
            },
          ]
        : [
            {
              role: 'system',
              content: systemPrompt,
            },
            ...chatHistory.slice(-20),
            {
              role: 'user',
              content: input.query,
            },
          ];

    for (let i = 0; i < maxIterations; i++) {
      const textBeforeRound = accumulatedText;

      let finalToolCalls: ToolCall[] = [];

      let roundFinishReason: string | null = null;

      const toolMessages: Message[] = [...preamble, ...agentMessageHistory];

      for (let attempt = 0; attempt < 3; attempt++) {
        const toolGenInput =
          availableTools.length > 0
            ? { messages: toolMessages, tools: availableTools }
            : { messages: toolMessages };

        try {
          if (attempt === 0) {
            const stream = input.config.llm.streamText(toolGenInput);

            for await (const partialRes of stream) {
              if (partialRes.contentChunk) {
                streamChunkIntoBlock(partialRes.contentChunk);
              }

              if (partialRes.additionalInfo?.finishReason) {
                roundFinishReason = partialRes.additionalInfo.finishReason;
              }

              if (partialRes.toolCallChunk.length > 0) {
                partialRes.toolCallChunk.forEach((tc) => {
                  const existingIndex = finalToolCalls.findIndex(
                    (ftc) => ftc.id === tc.id,
                  );

                  if (existingIndex !== -1) {
                    finalToolCalls[existingIndex].arguments = tc.arguments;
                  } else {
                    finalToolCalls.push(tc);
                  }
                });
              }
            }
          } else {
            const res =
              await input.config.llm.generateText(toolGenInput);

            finalToolCalls = res.toolCalls ?? [];

            if (res.content) {
              streamChunkIntoBlock(res.content);
            }
          }

          break;
        } catch (err) {
          if (
            !isLlmToolGenerationFailedError(err) ||
            attempt === 2
          ) {
            throw err;
          }

          console.warn(
            '[chat] LLM tool generation failed, retrying chat step',
            {
              attempt: attempt + 1,
              requestID: (err as { requestID?: string }).requestID,
            },
          );

          finalToolCalls = [];
          resetTextBlockTo(textBeforeRound);
        }
      }

      console.log(`[chat] round ${i + 1}/${maxIterations}`, {
        finishReason: roundFinishReason,
        toolCalls: finalToolCalls.map((tc) => tc.name),
        textAdded: accumulatedText.length - textBeforeRound.length,
      });

      if (finalToolCalls.length === 0) {
        break;
      }

      if (i === maxIterations - 1) {
        loopExhausted = true;
      }

      if (!researchBlockId) {
        researchBlockId = crypto.randomUUID();

        session.emitBlock({
          id: researchBlockId,
          type: 'research',
          data: {
            subSteps: [],
          },
        });
      }

      const roundText = accumulatedText.slice(textBeforeRound.length);

      agentMessageHistory.push({
        role: 'assistant',
        content: roundText,
        tool_calls: finalToolCalls,
      });

      let actionResults: ActionOutput[];

      try {
        actionResults = await ActionRegistry.executeAll(finalToolCalls, {
          llm: input.config.llm,
          embedding: input.config.embedding,
          session: session,
          researchBlockId: researchBlockId,
          fileIds: input.config.fileIds,
          mode,
        });
      } catch (err) {
        console.error('[chat] Tool execution failed:', err);
        actionResults = finalToolCalls.map(() => ({ type: 'done' as const }));
      }

      actionResults.forEach((action) => {
        if (action.type === 'search_results') {
          allSearchResults.push(...action.results);
        }
      });

      actionResults.forEach((action, i) => {
        agentMessageHistory.push({
          role: 'tool',
          id: finalToolCalls[i].id,
          name: finalToolCalls[i].name,
          content: JSON.stringify(action),
        });
      });
    }

    const filteredSearchResults = this.filterSearchResults(allSearchResults);

    const needsFinalAnswer =
      loopExhausted || accumulatedText.trim().length === 0;

    if (needsFinalAnswer) {
      const conversation = formatChatHistoryAsString(chatHistory.slice(-20));

      const resultsContext = filteredSearchResults
        .map((result) => {
          const content = (result.content || '').slice(0, 800);

          return `<result>\n<title>${result.metadata.title || result.metadata.url || 'Source'}</title>\n<url>${result.metadata.url || ''}</url>\n<content>${content}</content>\n</result>`;
        })
        .join('\n');

      const finalUserPrompt = [
        `<conversation>\n${conversation}\nUser: ${input.query}\n</conversation>`,
        resultsContext
          ? `<search_results>\n${resultsContext}\n</search_results>`
          : '',
        'Provide the final answer to the user now. If the search results above contain the information, use them. If there are no search results and you do not reliably know the answer, say so clearly instead of guessing.',
      ]
        .filter(Boolean)
        .join('\n\n');

      console.warn(
        '[chat] tool loop ended without a final answer; generating one now',
        { loopExhausted, accumulatedTextLength: accumulatedText.length },
      );

      try {
        const finalStream = input.config.llm.streamText({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: finalUserPrompt },
          ],
        });

        for await (const partialRes of finalStream) {
          if (partialRes.contentChunk) {
            streamChunkIntoBlock(partialRes.contentChunk);
          }
        }
      } catch (err) {
        console.error('[chat] Final answer generation failed:', err);
      }
    }

    if (filteredSearchResults.length > 0) {
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'source',
        data: filteredSearchResults,
      });
    }

    session.emit('data', {
      type: 'researchComplete',
    });

    session.emit('end', {});

    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  }
}

export default ChatAgent;