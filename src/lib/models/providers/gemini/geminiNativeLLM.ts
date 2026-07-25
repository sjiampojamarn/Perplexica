import {
  GoogleGenerativeAI,
  Content,
  Part,
  SchemaType,
  Schema,
} from '@google/generative-ai';
import BaseLLM from '../../base/llm';
import {
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  GenerateObjectInput,
} from '../../types';
import { Message } from '@/lib/types';
import z from 'zod';
import { parse } from 'partial-json';

type GeminiNativeConfig = {
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  options?: import('../../types').GenerateOptions;
};

class GeminiNativeLLM extends BaseLLM<GeminiNativeConfig> {
  private client: GoogleGenerativeAI;
  private currentModelIndex = 0;

  constructor(config: GeminiNativeConfig) {
    super(config);
    this.client = new GoogleGenerativeAI(config.apiKey);
  }

  private get modelList(): string[] {
    const models = [this.config.model, ...(this.config.fallbackModels || [])];
    return [...new Set(models)];
  }

  private getModel(modelName: string) {
    return this.client.getGenerativeModel({ model: modelName });
  }

  private get currentModelName(): string {
    return this.modelList[
      this.currentModelIndex % this.modelList.length
    ];
  }

  private cycleModel(): string {
    this.currentModelIndex =
      (this.currentModelIndex + 1) % this.modelList.length;
    const name = this.currentModelName;
    console.warn(`[Gemini] Rate limit hit, cycling to model: ${name}`);
    return name;
  }

  private isRateLimitError(err: unknown): boolean {
    if (err && typeof err === 'object') {
      const e = err as { status?: number; statusText?: string; message?: string };
      if (e.status === 429) return true;
      if (typeof e.message === 'string' && e.message.includes('429')) return true;
    }
    return false;
  }

  private buildContents(
    messages: Message[],
  ): { contents: Content[]; systemInstruction: string | undefined } {
    let systemInstruction: string | undefined;
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
        continue;
      }

      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        const parts: Part[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const fc: any = {
              name: tc.name,
              args: tc.arguments,
            };
            const tcAny = tc as any;
            const thoughtSig = tcAny.thought_signature || tcAny.thoughtSignature;
            const part: any = { functionCall: fc };
            if (thoughtSig) {
              part.thought_signature = thoughtSig;
              part.thoughtSignature = thoughtSig;
            }
            parts.push(part);
          }
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        let parsed: object;
        try {
          parsed = JSON.parse(msg.content);
        } catch {
          parsed = { result: msg.content };
        }
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.name,
                response: parsed,
              },
            },
          ],
        });
      }
    }

    return { contents, systemInstruction };
  }

  private buildTools(
    tools?: import('../../types').Tool[],
  ): import('@google/generative-ai').Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: this.zodToFunctionSchema(t.schema) as import('@google/generative-ai').FunctionDeclarationSchema,
        })),
      },
    ];
  }

  private zodToFunctionSchema(
    schema: z.ZodTypeAny,
  ): Schema {
    if (schema instanceof z.ZodObject) {
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(schema.shape)) {
        properties[key] = this.zodToFunctionSchema(value as z.ZodTypeAny);
        if (!(value instanceof z.ZodOptional)) {
          required.push(key);
        }
      }
      return {
        type: SchemaType.OBJECT,
        properties,
        required: required.length > 0 ? required : undefined,
      } as Schema;
    }

    if (schema instanceof z.ZodString) {
      return { type: SchemaType.STRING } as Schema;
    }

    if (schema instanceof z.ZodNumber) {
      return { type: SchemaType.NUMBER } as Schema;
    }

    if (schema instanceof z.ZodBoolean) {
      return { type: SchemaType.BOOLEAN } as Schema;
    }

    if (schema instanceof z.ZodArray) {
      return {
        type: SchemaType.ARRAY,
        items: this.zodToFunctionSchema(schema.element as any),
      } as Schema;
    }

    if (schema instanceof z.ZodEnum) {
      const def: any = schema._def;
      return {
        type: SchemaType.STRING,
        format: 'enum',
        enum: def.values || def.entries,
      } as Schema;
    }

    if (schema instanceof z.ZodOptional) {
      return this.zodToFunctionSchema(schema._def.innerType as any);
    }

    if (schema instanceof z.ZodNullable) {
      return this.zodToFunctionSchema(schema._def.innerType as any);
    }

    return { type: SchemaType.STRING } as Schema;
  }

  private extractFunctionCalls(
    parts?: Part[],
  ): any[] {
    if (!parts) return [];
    const calls: any[] = [];
    for (const part of parts) {
      if ('functionCall' in part && part.functionCall) {
        const fc: any = part.functionCall;
        const p = part as any;
        const sig =
          fc.thought_signature ||
          fc.thoughtSignature ||
          p.thought_signature ||
          p.thoughtSignature;
        const tc: any = {
          name: fc.name,
          id: fc.name,
          arguments: fc.args as Record<string, any>,
        };
        if (sig) {
          tc.thought_signature = sig;
        }
        calls.push(tc);
      }
    }
    return calls;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const { contents, systemInstruction } = this.buildContents(input.messages);
    const tools = this.buildTools(input.tools);
    const maxModels = this.modelList.length;

    for (let attempt = 0; attempt < maxModels; attempt++) {
      const modelName = this.currentModelName;
      try {
        const model = this.client.getGenerativeModel({
          model: modelName,
          systemInstruction,
        });

        const result = await model.generateContent({
          contents,
          tools,
          generationConfig: {
            temperature:
              input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
            topP: input.options?.topP ?? this.config.options?.topP,
            maxOutputTokens:
              input.options?.maxTokens ?? this.config.options?.maxTokens,
            stopSequences:
              input.options?.stopSequences ?? this.config.options?.stopSequences,
            frequencyPenalty:
              input.options?.frequencyPenalty ??
              this.config.options?.frequencyPenalty,
            presencePenalty:
              input.options?.presencePenalty ??
              this.config.options?.presencePenalty,
            candidateCount: 1,
          },
        });

        const response = result.response;
        const candidate = response.candidates?.[0];

        if (!candidate) {
          throw new Error('No response from Gemini');
        }

        return {
          content: response.text() || '',
          toolCalls: this.extractFunctionCalls(candidate.content?.parts),
          additionalInfo: {
            finishReason: candidate.finishReason,
          },
        };
      } catch (err) {
        if (this.isRateLimitError(err) && attempt < maxModels - 1) {
          this.cycleModel();
          continue;
        }
        throw err;
      }
    }

    throw new Error('All Gemini models exhausted');
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const { contents, systemInstruction } = this.buildContents(input.messages);
    const tools = this.buildTools(input.tools);
    const maxModels = this.modelList.length;

    let lastErr: unknown;
    for (let attempt = 0; attempt < maxModels; attempt++) {
      const modelName = this.currentModelName;
      try {
        const model = this.client.getGenerativeModel({
          model: modelName,
          systemInstruction,
        });

        const result = await model.generateContentStream({
          contents,
          tools,
          generationConfig: {
            temperature:
              input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
            topP: input.options?.topP ?? this.config.options?.topP,
            maxOutputTokens:
              input.options?.maxTokens ?? this.config.options?.maxTokens,
            stopSequences:
              input.options?.stopSequences ?? this.config.options?.stopSequences,
            frequencyPenalty:
              input.options?.frequencyPenalty ??
              this.config.options?.frequencyPenalty,
            presencePenalty:
              input.options?.presencePenalty ??
              this.config.options?.presencePenalty,
            candidateCount: 1,
          },
        });

        for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      const content = candidate.content;
      if (!content) continue;

      let contentChunk = '';
      const toolCallChunks: import('../../types').ToolCall[] = [];

      for (const part of content.parts) {
        if ('text' in part && part.text) {
          contentChunk += part.text;
        } else if ('functionCall' in part && part.functionCall) {
          const fc: any = part.functionCall;
          const p = part as any;
          const tc: any = {
            name: fc.name,
            id: fc.name,
            arguments: fc.args as Record<string, any>,
          };
          const sig =
          fc.thought_signature ||
          fc.thoughtSignature ||
          p.thought_signature ||
          p.thoughtSignature;
          if (sig) {
            tc.thought_signature = sig;
          } else {
            console.warn(
              `[Gemini] No thought_signature for "${fc.name}"`,
              JSON.stringify(Object.keys(p)),
              JSON.stringify(Object.keys(fc)),
            );
          }
          toolCallChunks.push(tc);
        }
      }

      const finishReason = candidate.finishReason;

      yield {
        contentChunk,
        toolCallChunk: toolCallChunks,
        done: finishReason !== null && finishReason !== undefined,
        additionalInfo: {
          finishReason,
        },
      };
    }
        return;
      } catch (err) {
        lastErr = err;
        if (this.isRateLimitError(err) && attempt < maxModels - 1) {
          this.cycleModel();
          continue;
        }
        throw err;
      }
    }

    throw lastErr || new Error('All Gemini models exhausted');
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const { contents, systemInstruction } = this.buildContents(input.messages);
    const responseSchema = this.zodToResponseSchema(input.schema);

    const model = this.client.getGenerativeModel({
      model: this.config.model,
      systemInstruction,
    });

    try {
      const result = await model.generateContent({
        contents,
        generationConfig: {
          temperature:
            input.options?.temperature ??
            this.config.options?.temperature ??
            1.0,
          topP: input.options?.topP ?? this.config.options?.topP,
          maxOutputTokens:
            input.options?.maxTokens ?? this.config.options?.maxTokens,
          stopSequences:
            input.options?.stopSequences ?? this.config.options?.stopSequences,
          responseMimeType: 'application/json',
          responseSchema,
          candidateCount: 1,
        },
      });

      const text = result.response.text();
      if (!text) throw new Error('Empty response from Gemini');

      try {
        return input.schema.parse(JSON.parse(text)) as T;
      } catch (parseErr) {
        throw new Error(
          `Error parsing structured response from Gemini: ${parseErr}`,
        );
      }
    } catch (err: any) {
      const responseFormatUnsupported =
        String(err?.message || '').includes('response_mime_type') ||
        String(err?.message || '').includes('response_schema');

      if (!responseFormatUnsupported) {
        throw err;
      }

      console.warn(
        `Structured output unavailable for model "${this.config.model}", falling back to plain JSON completion.`,
      );

      const fallbackResult = await model.generateContent({
        contents,
        generationConfig: {
          temperature:
            input.options?.temperature ??
            this.config.options?.temperature ??
            1.0,
          topP: input.options?.topP ?? this.config.options?.topP,
          maxOutputTokens:
            input.options?.maxTokens ?? this.config.options?.maxTokens,
          candidateCount: 1,
        },
      });

      const text = fallbackResult.response.text();
      if (!text) throw new Error('Empty response from Gemini');

      try {
        const repaired = text.replace(/```(?:json)?\n?|\n?```/g, '').trim();
        return input.schema.parse(JSON.parse(repaired)) as T;
      } catch (parseErr) {
        throw new Error(
          `Error parsing fallback response from Gemini: ${parseErr}`,
        );
      }
    }
  }

  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    const { contents, systemInstruction } = this.buildContents(input.messages);
    const responseSchema = this.zodToResponseSchema(input.schema);

    const model = this.client.getGenerativeModel({
      model: this.config.model,
      systemInstruction,
    });

    const result = await model.generateContentStream({
      contents,
      generationConfig: {
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
        topP: input.options?.topP ?? this.config.options?.topP,
        maxOutputTokens:
          input.options?.maxTokens ?? this.config.options?.maxTokens,
        stopSequences:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
        responseMimeType: 'application/json',
        responseSchema,
        candidateCount: 1,
      },
    });

    let recievedJson = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (!text) continue;

      recievedJson += text;

      try {
        yield parse(recievedJson) as T;
      } catch {
        yield {} as T;
      }
    }
  }

  private zodToResponseSchema(schema: z.ZodTypeAny): Schema | undefined {
    if (schema instanceof z.ZodObject) {
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(schema.shape)) {
        properties[key] = this.zodToResponseSchema(value as z.ZodTypeAny)!;
        if (!(value instanceof z.ZodOptional)) {
          required.push(key);
        }
      }
      return {
        type: SchemaType.OBJECT,
        properties,
        required: required.length > 0 ? required : undefined,
      } as Schema;
    }

    if (schema instanceof z.ZodString) {
      return { type: SchemaType.STRING } as Schema;
    }

    if (schema instanceof z.ZodNumber) {
      return { type: SchemaType.NUMBER } as Schema;
    }

    if (schema instanceof z.ZodBoolean) {
      return { type: SchemaType.BOOLEAN } as Schema;
    }

    if (schema instanceof z.ZodArray) {
      return {
        type: SchemaType.ARRAY,
        items: this.zodToResponseSchema(schema.element as any),
      } as Schema;
    }

    if (schema instanceof z.ZodEnum) {
      const def: any = schema._def;
      return {
        type: SchemaType.STRING,
        format: 'enum',
        enum: def.values || def.entries,
      } as Schema;
    }

    if (schema instanceof z.ZodOptional) {
      const inner = this.zodToResponseSchema(schema._def.innerType as any);
      if (inner) {
        (inner as any).nullable = true;
      }
      return inner;
    }

    if (schema instanceof z.ZodNullable) {
      const inner = this.zodToResponseSchema(schema._def.innerType as any);
      if (inner) {
        (inner as any).nullable = true;
      }
      return inner;
    }

    return { type: SchemaType.STRING } as Schema;
  }

}

export default GeminiNativeLLM;
