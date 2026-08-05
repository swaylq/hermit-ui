// Image recognition for sessions whose model endpoint drops image blocks
// (hyqubit substitutes [Unsupported Image], so the model never sees the
// pixels). When enabled on Settings → Pi Runtime, the gateway describes
// dashboard uploads with a standalone vision model and injects the text into
// the prompt, and the pi extension exposes the same call as a describe_image
// tool for on-demand re-inspection.
//
// This file is only the config half: which provider, which models, whose key.
// The HTTP call itself lives in runtime/vision-call.ts, because the pi child
// makes the very same call from its own process with config from its env.
//
// The API key is read from the machine's encrypted store at call time (never
// logged, never written to disk), exactly like the provider key.

import { readSecret } from './runtime/pi-credentials';
import { runVision, type VisionProvider, type VisionResult } from './runtime/vision-call';
import { getPiConfig } from './pi-config';

export type DescribeResult = VisionResult;
export { formatVision } from './runtime/vision-call';

/**
 * Recognise a local image via the machine's configured vision provider.
 * Returns best-effort OCR + description; any failure is captured in the result
 * rather than thrown, so a vision outage never blocks message delivery.
 */
export async function describeImage(filePath: string): Promise<DescribeResult> {
  const cfg = await getPiConfig();
  const img = cfg.image;
  if (!img?.enabled || !img.provider || img.provider === 'none') {
    return { provider: 'none', ocr: '', description: '' };
  }

  const secretName = img.apiKeySecret?.trim();
  if (!secretName) {
    return { provider: img.provider, ocr: '', description: '', error: '未配置图片识别 API key' };
  }
  const apiKey = await readSecret(secretName);
  if (!apiKey) {
    return {
      provider: img.provider, ocr: '', description: '',
      error: `本机 secrets store 里没有 "${secretName}"`,
    };
  }

  return runVision({
    provider: img.provider as VisionProvider,
    apiKey,
    filePath,
    ocrModel: img.ocrModel,
    describeModel: img.describeModel,
    prompt: img.prompt,
  });
}
