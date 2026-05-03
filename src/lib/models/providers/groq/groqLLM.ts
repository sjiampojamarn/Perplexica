import OpenAILLM from '../openai/openaiLLM';

type GroqLLMConfig = ConstructorParameters<typeof OpenAILLM>[0];

/**
 * Groq intermittently returns `tool_use_failed` when parallel tool streams
 * confuse the model or the gateway. Sequential tool calls are more reliable.
 */
class GroqLLM extends OpenAILLM {
  constructor(config: GroqLLMConfig) {
    super({ ...config, parallelToolCalls: false });
  }
}

export default GroqLLM;
