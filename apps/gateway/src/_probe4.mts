import { query } from '@anthropic-ai/claude-agent-sdk';
const t0 = Date.now(); const T = () => `${((Date.now()-t0)/1000).toFixed(1)}s`;
let release: any; const held = new Promise<void>(r => { release = r; });
let bashId: string | null = null;
const SLOW = process.argv[2] === 'slow';

const q = query({
  prompt: (async function* () {
    yield { type:'user', message:{role:'user', content: SLOW
      ? 'Run exactly this with the Bash tool: `python3 -c "import time; time.sleep(60)"` . Then reply DONE.'
      : 'Run exactly this with the Bash tool: `echo ORIGINAL` . Then tell me what it printed.'
    }, parent_tool_use_id:null, session_id:'' } as any;
    await held;
  })(),
  options: {
    cwd: '/tmp/probe-bash', pathToClaudeCodeExecutable: '/Users/mac/.local/bin/claude',
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, persistSession: false,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async (input: any) => {
      const cmd = input?.tool_input?.command ?? '';
      const next = SLOW ? cmd : cmd.replace('ORIGINAL', 'REWRITTEN_BY_HOOK');
      console.log(`[${T()}] PreToolUse: ${JSON.stringify(cmd)} -> ${JSON.stringify(next)}`);
      return { hookSpecificOutput: { hookEventName:'PreToolUse' as const, permissionDecision:'allow' as const,
        updatedInput: { ...input.tool_input, command: next } } };
    }]}]},
  },
});

(async () => {
  for await (const m of q) {
    const a = m as any;
    if (a.type === 'tool_progress') { bashId = a.tool_use_id;
      console.log(`[${T()}] tool_progress tool=${a.tool_name} elapsed=${a.elapsed_time_seconds}s hb=${a.heartbeat}`); }
    if (a.type === 'assistant') for (const b of a.message.content) {
      if (b.type === 'tool_use') { bashId = bashId ?? b.id; console.log(`[${T()}] tool_use cmd=${JSON.stringify(b.input?.command)}`); }
      if (b.type === 'text' && b.text.trim()) console.log(`[${T()}] TEXT: ${b.text.trim().slice(0,70)}`); }
    if (a.type === 'user') for (const b of (a.message?.content ?? []))
      if (b.type === 'tool_result') console.log(`[${T()}] tool_result: ${JSON.stringify(String(b.content).slice(0,80))}`);
    if (a.type === 'result') { console.log(`[${T()}] RESULT ${a.subtype}`); break; }
  }
  release(); q.close(); process.exit(0);
})();

if (SLOW) setTimeout(async () => {
  console.log(`[${T()}] backgroundTasks(${String(bashId).slice(0,10)}) ...`);
  console.log(`[${T()}] ->`, await q.backgroundTasks(bashId ?? undefined).catch((e:any)=>'ERR '+e.message));
}, 20000);
