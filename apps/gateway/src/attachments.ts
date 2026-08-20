// What to tell the model about the files a user attached.
//
// `relayImages` has already downloaded every attachment into the local cache and
// handed back paths; this decides what each one becomes in the turn. Most of it
// is type-specific advice — a .xlsx must not be Read, it must be converted —
// and that advice is identical no matter which backend is driving, so it lives
// here rather than in one runner's inline branch chain.
//
// The one part that DOES differ by backend is images. A pane carries no binary,
// so the tmux path can only name the file and let the model spend a Read on it;
// a backend that speaks Anthropic content blocks should get the bytes in the
// first request instead. `nativeImages` picks which.

import type { RuntimeImage } from './runtime/types';

const IMAGE_EXTS: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};

// Archives are binary — Read'ing them is gibberish. Extract via Bash instead.
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', '7z', 'rar', 'zst']);
// Audio is binary too. Transcribe / inspect via Bash.
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']);
// Video is binary and Claude cannot ingest it natively — ffprobe, frames, audio.
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', '3gp', 'wmv']);

const ext = (p: string) => (p.split('.').pop() || '').toLowerCase();

/** Office docs are binary (zip+XML) — per-type conversion advice, or null. */
export function officeHint(p: string): string | null {
  const e = ext(p);
  if (e === 'doc' || e === 'docx' || e === 'odt') {
    return (
      `An uploaded Word document is at ${p} — it is binary, so do NOT Read it directly. ` +
      `Get its plain text with \`textutil -convert txt -stdout ${p}\` (macOS built-in).`
    );
  }
  if (e === 'xls' || e === 'xlsx' || e === 'ods') {
    return (
      `An uploaded spreadsheet is at ${p} — it is binary, so do NOT Read it directly. ` +
      `Convert it in Python (pandas + openpyxl are installed): ` +
      `\`pd.read_excel('${p}', sheet_name=None)\` returns {sheet: DataFrame}; print or write each sheet's \`.to_csv()\`. ` +
      `Fallback: it is a zip — \`unzip -o ${p} -d /tmp/xlsx\` then read xl/worksheets/*.xml + xl/sharedStrings.xml.`
    );
  }
  if (e === 'ppt' || e === 'pptx' || e === 'odp') {
    return (
      `An uploaded presentation is at ${p} — it is binary, so do NOT Read it directly. ` +
      `Pull the slide text with \`unzip -p ${p} 'ppt/slides/slide*.xml' | sed -E 's/<[^>]+>/ /g'\` ` +
      `(text lives in <a:t> elements), or use python-pptx if available.`
    );
  }
  return null;
}

export function isImage(p: string): boolean {
  return ext(p) in IMAGE_EXTS;
}

export type AttachmentPlan = {
  /** Images to send as content blocks. Always empty when `nativeImages` is false. */
  images: RuntimeImage[];
  /** Lines to append to the prompt text, in attachment order. */
  hints: string[];
};

/**
 * Split relayed attachment paths into "bytes the model gets directly" and
 * "instructions about a file on disk".
 */
export function planAttachments(paths: string[], opts: { nativeImages: boolean }): AttachmentPlan {
  const images: RuntimeImage[] = [];
  const hints: string[] = [];

  for (const p of paths) {
    const e = ext(p);

    if (isImage(p)) {
      if (opts.nativeImages) images.push({ path: p, mediaType: IMAGE_EXTS[e] });
      else hints.push(`Read ${p}`);
      continue;
    }

    if (ARCHIVE_EXTS.has(e)) {
      hints.push(
        `An uploaded archive is at ${p} — it is binary, so do NOT Read it directly. ` +
        `Run \`file ${p}\` to confirm the type, then extract it into a fresh temp directory ` +
        `(unzip / tar -xf / gunzip / 7z as appropriate) and inspect the extracted files.`,
      );
      continue;
    }

    if (AUDIO_EXTS.has(e)) {
      hints.push(
        `An uploaded audio file is at ${p} — it is binary, so do NOT Read it directly. ` +
        `Inspect it with \`ffmpeg -i ${p}\` (format / duration). For speech, transcribe via Bash ` +
        `with whisper / whisper-cpp if installed (\`command -v whisper whisper-cpp ffmpeg\` first); ` +
        `if no transcriber is available, tell the user what to install.`,
      );
      continue;
    }

    if (VIDEO_EXTS.has(e)) {
      hints.push(
        `An uploaded video file is at ${p} — it is binary, so do NOT Read it directly. ` +
        `First inspect it with \`ffprobe -hide_banner ${p}\` (duration / resolution / streams). ` +
        `To see the visuals, extract frames into a temp dir and Read those images — e.g. ` +
        `\`mkdir -p /tmp/vframes && ffmpeg -i ${p} -vf "fps=1,scale=-2:720" /tmp/vframes/f_%03d.jpg\` ` +
        `(1 fps, 720p — lower the fps for long clips so Read doesn't wedge on too many frames). ` +
        `For speech, extract the audio (\`ffmpeg -i ${p} -vn -ac 1 /tmp/vaudio.wav\`) and transcribe with ` +
        `whisper / whisper-cpp if installed (\`command -v ffmpeg ffprobe whisper whisper-cpp\` first); ` +
        `if no transcriber is available, tell the user what to install.`,
      );
      continue;
    }

    const office = officeHint(p);
    hints.push(office ?? `Read ${p}`);
  }

  return { images, hints };
}
