import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';

class APISearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).catch((err) => {
      console.error(`Error executing widgets: ${err}`);
      return [];
    });

    let researchDegraded = false;

    const searchPromise = classification.classification.skipSearch
      ? Promise.resolve(null)
      : new Researcher()
          .research(SessionManager.createSession(), {
            chatHistory: input.chatHistory,
            followUp: input.followUp,
            classification: classification,
            config: input.config,
          })
          .catch((err) => {
            researchDegraded = true;
            console.error(
              '[search] Research failed; continuing without live sources',
              err,
            );
            return { findings: [], searchFindings: [] };
          });

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    if (searchResults) {
      session.emit('data', {
        type: 'searchResults',
        data: searchResults.searchFindings,
      });
    }

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext = '';

    if (searchResults) {
      if (searchResults.searchFindings.length > 0) {
        finalContext = searchResults.searchFindings
          .map(
            (f, index) =>
              `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
          )
          .join('\n');
      } else if (researchDegraded) {
        finalContext =
          '<status note="Live search did not complete (provider/tool error). Do not invent URLs or recent facts; use general knowledge and prior chat only. Tell the user live sources were unavailable if the question needs current information."/>';
      } else {
        finalContext =
          '<no_indexed_results note="No sources retrieved for this query"/>';
      }
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const writerContextPrefix = researchDegraded
      ? `<system_note for="assistant">Tell the user briefly that live search did not complete if the question needs fresh web information.</system_note>\n`
      : '';

    const finalContextWithWidgets = `${writerContextPrefix}<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
    );

    const answerStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    if (researchDegraded) {
      session.emit('data', {
        type: 'response',
        data: '*Live web search did not complete this time, so this answer may lack up-to-date sources. You can try asking again.*\n\n',
      });
    }

    for await (const chunk of answerStream) {
      session.emit('data', {
        type: 'response',
        data: chunk.contentChunk,
      });
    }

    session.emit('end', {});
  }
}

export default APISearchAgent;
