import { ActionOutput, ResearcherInput, ResearcherOutput } from '../types';
import { ActionRegistry } from './actions';
import { getResearcherPrompt } from '@/lib/prompts/search/researcher';
import SessionManager from '@/lib/session';
import { Message, ReasoningResearchBlock } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import { ToolCall } from '@/lib/models/types';

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

class Researcher {
  async research(
    session: SessionManager,
    input: ResearcherInput,
  ): Promise<ResearcherOutput> {
    let actionOutput: ActionOutput[] = [];
    let maxIteration =
      input.config.mode === 'speed'
        ? 2
        : input.config.mode === 'balanced'
          ? 6
          : 25;

    const availableTools = ActionRegistry.getAvailableActionTools({
      classification: input.classification,
      fileIds: input.config.fileIds,
      mode: input.config.mode,
      sources: input.config.sources,
    });

    const availableActionsDescription =
      ActionRegistry.getAvailableActionsDescriptions({
        classification: input.classification,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
        sources: input.config.sources,
      });

    const researchBlockId = crypto.randomUUID();

    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: {
        subSteps: [],
      },
    });

    const agentMessageHistory: Message[] = [
      {
        role: 'user',
        content: `
          <conversation>
          ${formatChatHistoryAsString(input.chatHistory.slice(-10))}
           User: ${input.followUp} (Standalone question: ${input.classification.standaloneFollowUp})
           </conversation>
        `,
      },
    ];

    for (let i = 0; i < maxIteration; i++) {
      const researcherPrompt = getResearcherPrompt(
        availableActionsDescription,
        input.config.mode,
        i,
        maxIteration,
        input.config.fileIds,
      );

      const block = session.getBlock(researchBlockId);
      const subStepsBaseline =
        block && block.type === 'research' ? block.data.subSteps.length : 0;

      let finalToolCalls: ToolCall[] = [];
      const maxStreamAttempts = 3;

      for (let attempt = 0; attempt < maxStreamAttempts; attempt++) {
        let reasoningEmitted = false;
        let reasoningId = crypto.randomUUID();
        finalToolCalls = [];

        try {
          const actionStream = input.config.llm.streamText({
            messages: [
              {
                role: 'system',
                content: researcherPrompt,
              },
              ...agentMessageHistory,
            ],
            tools: availableTools,
          });

          for await (const partialRes of actionStream) {
            if (partialRes.toolCallChunk.length > 0) {
              partialRes.toolCallChunk.forEach((tc) => {
                if (
                  tc.name === '__reasoning_preamble' &&
                  tc.arguments['plan'] &&
                  !reasoningEmitted &&
                  block &&
                  block.type === 'research'
                ) {
                  reasoningEmitted = true;

                  block.data.subSteps.push({
                    id: reasoningId,
                    type: 'reasoning',
                    reasoning: tc.arguments['plan'],
                  });

                  session.updateBlock(researchBlockId, [
                    {
                      op: 'replace',
                      path: '/data/subSteps',
                      value: block.data.subSteps,
                    },
                  ]);
                } else if (
                  tc.name === '__reasoning_preamble' &&
                  tc.arguments['plan'] &&
                  reasoningEmitted &&
                  block &&
                  block.type === 'research'
                ) {
                  const subStepIndex = block.data.subSteps.findIndex(
                    (step: any) => step.id === reasoningId,
                  );

                  if (subStepIndex !== -1) {
                    const subStep = block.data.subSteps[
                      subStepIndex
                    ] as ReasoningResearchBlock;
                    subStep.reasoning = tc.arguments['plan'];
                    session.updateBlock(researchBlockId, [
                      {
                        op: 'replace',
                        path: '/data/subSteps',
                        value: block.data.subSteps,
                      },
                    ]);
                  }
                }

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
          break;
        } catch (err) {
          if (
            !isLlmToolGenerationFailedError(err) ||
            attempt === maxStreamAttempts - 1
          ) {
            throw err;
          }
          const b = session.getBlock(researchBlockId);
          if (b && b.type === 'research') {
            b.data.subSteps = b.data.subSteps.slice(0, subStepsBaseline);
            session.updateBlock(researchBlockId, [
              {
                op: 'replace',
                path: '/data/subSteps',
                value: b.data.subSteps,
              },
            ]);
          }
          console.warn(
            '[researcher] LLM tool generation failed, retrying research step',
            {
              attempt: attempt + 1,
              requestID: (err as { requestID?: string }).requestID,
            },
          );
        }
      }

      if (finalToolCalls.length === 0) {
        break;
      }

      if (finalToolCalls[finalToolCalls.length - 1].name === 'done') {
        break;
      }

      agentMessageHistory.push({
        role: 'assistant',
        content: '',
        tool_calls: finalToolCalls,
      });

      const actionResults = await ActionRegistry.executeAll(finalToolCalls, {
        llm: input.config.llm,
        embedding: input.config.embedding,
        session: session,
        researchBlockId: researchBlockId,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
      });

      actionOutput.push(...actionResults);

      actionResults.forEach((action, i) => {
        agentMessageHistory.push({
          role: 'tool',
          id: finalToolCalls[i].id,
          name: finalToolCalls[i].name,
          content: JSON.stringify(action),
        });
      });
    }

    const searchResults = actionOutput
      .filter((a) => a.type === 'search_results')
      .flatMap((a) => a.results);

    const seenUrls = new Map<string, number>();

    const filteredSearchResults = searchResults
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

    session.emitBlock({
      id: crypto.randomUUID(),
      type: 'source',
      data: filteredSearchResults,
    });

    return {
      findings: actionOutput,
      searchFindings: filteredSearchResults,
    };
  }
}

export default Researcher;
