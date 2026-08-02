import configManager from '@/lib/config';
import ModelRegistry from '@/lib/models/registry';
import { NextRequest, NextResponse } from 'next/server';
import { ConfigModelProvider } from '@/lib/config/types';
import { redactProviderConfig } from '@/lib/utils/redact';

type SaveConfigBody = {
  key: string;
  value: any;
};

const SERVER_SCOPED_SECTIONS = ['preferences', 'personalization', 'search'] as const;

type WritableField = {
  type: string;
  options?: { name: string; value: string }[];
};

const getWritableFields = (): Map<string, WritableField> => {
  const writable = new Map<string, WritableField>();
  const sections = configManager.getUIConfigSections();

  for (const section of SERVER_SCOPED_SECTIONS) {
    const fields = sections[section];

    if (!Array.isArray(fields)) continue;

    for (const field of fields) {
      if (field.scope !== 'server') continue;

      writable.set(`${section}.${field.key}`, {
        type: field.type,
        options: field.type === 'select' ? field.options : undefined,
      });
    }
  }

  return writable;
};

const validateValue = (
  field: WritableField,
  rawValue: any,
): { ok: boolean; value?: any } => {
  switch (field.type) {
    case 'switch':
      if (rawValue === true || rawValue === 'true') return { ok: true, value: true };
      if (rawValue === false || rawValue === 'false') return { ok: true, value: false };
      return { ok: false };

    case 'select': {
      if (typeof rawValue !== 'string') return { ok: false };

      const allowed = field.options?.map((o) => o.value) ?? [];

      if (allowed.length > 0 && !allowed.includes(rawValue)) {
        return { ok: false };
      }

      return { ok: true, value: rawValue };
    }

    case 'string':
      if (typeof rawValue !== 'string') return { ok: false };
      if (rawValue.length > 1000) return { ok: false };
      return { ok: true, value: rawValue };

    case 'textarea':
      if (typeof rawValue !== 'string') return { ok: false };
      if (rawValue.length > 10000) return { ok: false };
      return { ok: true, value: rawValue };

    default:
      return { ok: false };
  }
};

export const GET = async (req: NextRequest) => {
  try {
    const values = configManager.getCurrentConfig();
    const fields = configManager.getUIConfigSections();

    const modelRegistry = new ModelRegistry();
    const modelProviders = await modelRegistry.getActiveProviders();

    values.modelProviders = values.modelProviders.map(
      (mp: ConfigModelProvider) => {
        const activeProvider = modelProviders.find((p) => p.id === mp.id);

        return redactProviderConfig({
          ...mp,
          chatModels: activeProvider?.chatModels ?? mp.chatModels,
          embeddingModels:
            activeProvider?.embeddingModels ?? mp.embeddingModels,
        });
      },
    );

    return NextResponse.json({
      values,
      fields,
    });
  } catch (err) {
    console.error('Error in getting config: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};

export const POST = async (req: NextRequest) => {
  try {
    const body: SaveConfigBody = await req.json();

    if (
      typeof body?.key !== 'string' ||
      body.key.length === 0 ||
      !('value' in body)
    ) {
      return Response.json(
        { message: 'Key and value are required.' },
        { status: 400 },
      );
    }

    const field = getWritableFields().get(body.key);

    if (!field) {
      return Response.json(
        { message: 'This configuration key cannot be updated via the API.' },
        { status: 400 },
      );
    }

    const validated = validateValue(field, body.value);

    if (!validated.ok) {
      return Response.json(
        { message: 'Invalid value for configuration key.' },
        { status: 400 },
      );
    }

    configManager.updateConfig(body.key, validated.value);

    return Response.json(
      {
        message: 'Config updated successfully.',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('Error in updating config: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
