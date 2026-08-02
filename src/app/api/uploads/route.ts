import { NextResponse } from 'next/server';
import ModelRegistry from '@/lib/models/registry';
import UploadManager, {
  MAX_FILE_SIZE,
  MAX_FILES_PER_REQUEST,
  MAX_TOTAL_UPLOAD_SIZE,
} from '@/lib/uploads/manager';
import { rateLimit } from '@/lib/rateLimit';

const getClientIp = (req: Request): string => {
  const forwardedFor = req.headers.get('x-forwarded-for');

  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.headers.get('x-real-ip') ?? 'unknown';
};

export async function POST(req: Request) {
  try {
    const clientIp = getClientIp(req);

    const rl = rateLimit({
      key: `uploads:${clientIp}`,
      limit: 10,
      windowMs: 60_000,
    });

    if (!rl.ok) {
      return NextResponse.json(
        { message: 'Too many upload requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
          },
        },
      );
    }

    const formData = await req.formData();

    const files = formData.getAll('files') as File[];
    const embeddingModel = formData.get('embedding_model_key') as string;
    const embeddingModelProvider = formData.get('embedding_model_provider_id') as string;

    if (!embeddingModel || !embeddingModelProvider) {
      return NextResponse.json(
        { message: 'Missing embedding model or provider' },
        { status: 400 },
      );
    }

    if (files.length === 0) {
      return NextResponse.json(
        { message: 'No files provided' },
        { status: 400 },
      );
    }

    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { message: `Too many files. Maximum is ${MAX_FILES_PER_REQUEST}` },
        { status: 400 },
      );
    }

    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > MAX_TOTAL_UPLOAD_SIZE) {
      return NextResponse.json(
        { message: 'Total upload size exceeds the allowed limit' },
        { status: 400 },
      );
    }

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { message: `File ${file.name} exceeds the maximum allowed size` },
          { status: 400 },
        );
      }
    }

    const registry = new ModelRegistry();

    const model = await registry.loadEmbeddingModel(embeddingModelProvider, embeddingModel);
    
    const uploadManager = new UploadManager({
      embeddingModel: model,
    })

    const processedFiles = await uploadManager.processFiles(files);

    return NextResponse.json({
      files: processedFiles,
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    return NextResponse.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
}
