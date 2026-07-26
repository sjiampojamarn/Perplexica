import ModelRegistry from '@/lib/models/registry';
import { NextRequest } from 'next/server';
import { z } from 'zod';

const addModelSchema = z.object({
  key: z.string().min(1, 'Model key is required'),
  name: z.string().min(1, 'Model name is required'),
  type: z.enum(['chat', 'embedding']),
});

const removeModelSchema = z.object({
  key: z.string().min(1, 'Model key is required'),
  type: z.enum(['chat', 'embedding']),
});

export const POST = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const body = await req.json();
    const parsed = addModelSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          message: 'Validation failed',
          errors: parsed.error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 },
      );
    }

    const registry = new ModelRegistry();

    await registry.addProviderModel(id, parsed.data.type, parsed.data);

    return Response.json(
      {
        message: 'Model added successfully',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('An error occurred while adding provider model', err);
    return Response.json(
      {
        message: 'An error has occurred.',
      },
      {
        status: 500,
      },
    );
  }
};

export const DELETE = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const body = await req.json();
    const parsed = removeModelSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          message: 'Validation failed',
          errors: parsed.error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 },
      );
    }

    const registry = new ModelRegistry();

    await registry.removeProviderModel(id, parsed.data.type, parsed.data.key);

    return Response.json(
      {
        message: 'Model removed successfully',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('An error occurred while deleting provider model', err);
    return Response.json(
      {
        message: 'An error has occurred.',
      },
      {
        status: 500,
      },
    );
  }
};
