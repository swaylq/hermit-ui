'use client';

import { useRef, useState } from 'react';
import { HardDriveUpload, Loader2, CheckCircle2, XCircle, Trash2, FileUp } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { getActiveKey } from '@/lib/keyring';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SettingsTabs } from '@/components/settings-tabs';

const MAX_BYTES = 300 * 1024 * 1024;
const ACTIVE = new Set(['pending', 'running']);

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Row = {
  id: string;
  filename: string;
  destPath: string;
  size: number;
  unzip: boolean;
  status: string;
  error: string | null;
  requestedAt: string | Date;
  resolvedAt: string | Date | null;
};

// Raw XHR (not fetch) so we get upload progress. Filename/path are URL-encoded —
// HTTP headers must be latin1 and these can be non-ASCII.
function uploadXhr(file: File, destPath: string, unzip: boolean, onProgress: (p: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/file-station/upload');
    xhr.setRequestHeader('x-asst-key', getActiveKey());
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-file-path', encodeURIComponent(destPath));
    xhr.setRequestHeader('x-file-unzip', unzip ? '1' : '0');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({ id: '' });
        }
      } else {
        let msg = `上传失败 (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {
          /* keep default */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

function StatusRow({ row, onRemove }: { row: Row; onRemove: () => void }) {
  const meta: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'text-muted-foreground', label: '排队中' },
    running: { cls: 'text-sky-500', label: '传输中' },
    done: { cls: 'text-emerald-500', label: '已送达' },
    error: { cls: 'text-rose-500', label: '失败' },
  };
  const m = meta[row.status] ?? meta.pending;
  const spin = row.status === 'pending' || row.status === 'running';
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1 text-xs">
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 font-medium', m.cls)}>
          {spin ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : row.status === 'done' ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <XCircle className="h-3.5 w-3.5" />
          )}
          {m.label}
        </span>
        <span className="truncate font-medium text-foreground/90">{row.filename}</span>
        <span className="text-muted-foreground/60 shrink-0">{fmtSize(row.size)}</span>
        {row.unzip && <span className="text-amber-500 shrink-0">解压</span>}
        <span className="text-muted-foreground/60 ml-auto shrink-0">{relTime(row.resolvedAt ?? row.requestedAt)}</span>
        {!ACTIVE.has(row.status) && (
          <button onClick={onRemove} aria-label="remove" className="text-muted-foreground hover:text-rose-400 cursor-pointer shrink-0">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="font-mono text-[11px] text-muted-foreground truncate">→ {row.destPath}</div>
      {row.error && <p className="text-rose-400 break-words">{row.error}</p>}
    </div>
  );
}

export default function FileStationPage() {
  const utils = trpc.useUtils();
  const list = trpc.fileStation.list.useQuery(undefined, {
    refetchInterval: (q) => ((q.state.data as Row[] | undefined)?.some((r) => ACTIVE.has(r.status)) ? 2_500 : false),
  });
  const remove = trpc.fileStation.remove.useMutation({ onSuccess: () => utils.fileStation.list.invalidate() });

  const [file, setFile] = useState<File | null>(null);
  const [destPath, setDestPath] = useState('');
  const [unzip, setUnzip] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const isZip = !!file && /\.zip$/i.test(file.name);
  const uploading = pct !== null;
  const rows = (list.data ?? []) as Row[];

  const onPick = (f: File | null) => {
    setErr('');
    if (f && f.size > MAX_BYTES) {
      setErr(`文件 ${fmtSize(f.size)} 超过 300MB 上限`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setFile(f);
    if (!f || !/\.zip$/i.test(f.name)) setUnzip(false);
  };

  const submit = async () => {
    setErr('');
    if (!file) return setErr('请选择文件');
    if (!destPath.trim()) return setErr('请填写目标路径');
    setPct(0);
    try {
      await uploadXhr(file, destPath.trim(), unzip && isZip, setPct);
      setPct(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      utils.fileStation.list.invalidate();
    } catch (e) {
      setPct(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="files" />
      <div className="lg:hidden px-3 py-2 shrink-0">
        <SidebarMobileToggle />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 space-y-4">
          <p className="text-xs text-muted-foreground">
            把文件传到<span className="font-medium text-foreground/80">当前选中机器</span>的指定路径上（最大 300MB，支持 zip）。
            文件先暂存到面板，再由那台机器的网关拉取并写入。
          </p>

          <Card className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <HardDriveUpload className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-2.5">
                <div className="text-sm font-semibold text-foreground">上传文件到机器</div>

                <div className="flex items-center gap-2">
                  <input ref={fileRef} type="file" className="hidden" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
                  <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
                    <FileUp className="h-3.5 w-3.5 mr-1" /> 选择文件
                  </Button>
                  {file ? (
                    <span className="text-xs truncate">
                      {file.name} <span className="text-muted-foreground">({fmtSize(file.size)})</span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">未选择（≤300MB，任意类型）</span>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">
                    目标路径（机器上）—— 目录或完整文件路径，支持 <code className="font-mono">~</code>
                  </label>
                  <input
                    value={destPath}
                    onChange={(e) => setDestPath(e.target.value)}
                    spellCheck={false}
                    placeholder={unzip && isZip ? '~/some/dir（解压到这个目录）' : '~/Downloads/  或  ~/Downloads/file.bin'}
                    className="w-full rounded-md bg-background border border-border px-2.5 py-2 text-xs font-mono outline-none focus:border-foreground/30"
                  />
                </div>

                {isZip && (
                  <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                    <input type="checkbox" checked={unzip} onChange={(e) => setUnzip(e.target.checked)} />
                    上传后在目标路径解压（unzip -o，目标路径当作目录）
                  </label>
                )}

                {err && <p className="text-[11px] text-rose-400">{err}</p>}

                {uploading && (
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round((pct ?? 0) * 100)}%` }} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">上传中… {Math.round((pct ?? 0) * 100)}%</div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={uploading || !file || !destPath.trim()} onClick={submit}>
                    {uploading ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> 上传中…
                      </>
                    ) : (
                      '上传'
                    )}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">上传完成后，机器网关会拉取并写入，状态见下方。</span>
                </div>
              </div>
            </div>
          </Card>

          {rows.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60">最近传输</div>
              {rows.map((r) => (
                <StatusRow key={r.id} row={r} onRemove={() => remove.mutate({ id: r.id })} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
