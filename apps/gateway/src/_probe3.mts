import { query } from '@anthropic-ai/claude-agent-sdk';
const t0 = Date.now();
const T = () => `${((Date.now()-t0)/1000).toFixed(1)}s`;
let release: any; const held = new Promise<void>(r => { release = r; });
let sleepToolUseId: string | null = null;

const q = query({
  prompt: (async function* () {
    yield { type:'user', message:{role:'user',content:'Run `sleep 40` with the Bash tool. Then reply DONE.'}, parent_tool_use_id:null, session_id:'' } as any;
    await held;
  })(),
  options: {
    cwd: '/tmp/probe-bash',
    pathToClaudeCodeExecutable: '/Users/mac/.local/bin/claude',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    // (1) does canUseTool fire under bypassPermissions?
    canUseTool: async (name, input) => {
      console.log(`[${T()}] canUseTool FIRED name=${name} cmd=${JSON.stringify((input as any).command)}`);
      return { behavior: 'allow' as const };
    },
    // (2) does a PreToolUse hook fire under bypass, and does updatedInput apply?
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [async (input: any) => {
          console.log(`[${T()}] PreToolUse FIRED cmd=${JSON.stringify(input?.tool_input?.command)}`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              updatedInput: { ...input.tool_input, command: `${input.tool_input.command} && echo REWRITTEN_BY_HOOK` },
            },
          };
        }],
      }],
    },
  },
});

(async () => {
  for await (const m of q) {
    const a = m as any;
    if (a.type === 'tool_progress') {
      console.log(`[${T()}] tool_progress tool=${a.tool_name} elapsed=${a.elapsed_time_seconds}s heartbeat=${a.heartbeat} id=${String(a.tool_use_id).slice(0,12)}`);
      if (a.tool_name === 'Bash') sleepToolUseId = a.tool_use_id;
    }
    if (a.type === 'assistant') for (const b of a.message.content) {
      if (b.type === 'tool_use') console.log(`[${T()}] tool_use ${b.name} cmd=${JSON.stringify(b.input?.command)}`);
      if (b.type === 'text' && b.text.trim()) console.log(`[${T()}] TEXT: ${b.text.trim().slice(0,80)}`);
    }
    if (a.type === 'user') for (const b of (a.message?.content ?? [])) {
      if (b.type === 'tool_result') console.log(`[${T()}] tool_result: ${JSON.stringify(String(b.content).slice(0,90))}`);
    }
    if (a.type === 'system' && a.subtype === 'background_tasks_changed') console.log(`[${T()}] bg_tasks=${JSON.stringify(a.tasks)}`);
    if (a.type === 'result') { console.log(`[${T()}] RESULT ${a.subtype} num_turns=${a.num_turns}`); break; }
  }
  release(); q.close();
})();

// (3) after 12s, background the in-flight Bash and see whether the turn continues
setTimeout(async () => {
  if (!sleepToolUseId) { console.log(`[${T()}] no tool_use_id captured yet`); return; }
  console.log(`[${T()}] calling backgroundTasks(${String(sleepToolUseId).slice(0,12)})`);
  const ok = await q.backgroundTasks(sleepToolUseId).catch((e:any) => 'ERR ' + e.message);
  console.log(`[${T()}] backgroundTasks →`, ok);
}, 12000);
