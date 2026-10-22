import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

// A real stdio child forwards the runtime's requested calls over the production
// reverse RPC, so the gate order below is the order the sidecar really uses.
const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map(); rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

function harness(allowed = true) {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", child] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  const calls: string[] = [];
  const host: SidecarHostLink = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      return { ok: allowed, content: allowed ? { authorized: true } : "denied", errorCode: allowed ? undefined : "PERMISSION_DENIED" } as T;
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  const execute = (mode = "agent", toolName = "SessionSend") =>
    sidecar.call<{ ok: boolean; errorCode?: string }>("probe", {
      method: "tools.execute",
      params: {
        sessionId: "s",
        turnId: "turn-1",
        toolCallId: `call-${toolName}-${mode}`,
        mode,
        toolName,
        args: { sessionId: "target", content: "review the diff" },
      },
    });
  return { sidecar, calls, execute };
}

it("gates a session send through the host before the local handler runs", async () => {
  const { sidecar, calls, execute } = harness();
  sidecar.setLocalTool("SessionSend", async () => {
    calls.push("sent");
    return { ok: true, content: "delivered" };
  });

  expect((await execute()).ok).toBe(true);
  expect(calls).toEqual(["tools.execute", "sent"]);
});

it("keeps the host's refusal and never delivers when the gate denies", async () => {
  const { sidecar, execute } = harness(false);
  const send = vi.fn().mockResolvedValue({ ok: true, content: "delivered" });
  sidecar.setLocalTool("SessionSend", send);

  const result = await execute();
  expect(result.ok).toBe(false);
  expect(result.errorCode).toBe("PERMISSION_DENIED");
  expect(send).not.toHaveBeenCalled();
});

it("fails closed in Plan mode without asking the host", async () => {
  const { sidecar, calls, execute } = harness();
  const send = vi.fn().mockResolvedValue({ ok: true, content: "delivered" });
  sidecar.setLocalTool("SessionSend", send);

  expect((await execute("plan")).errorCode).toBe("TOOL_DISABLED_IN_PLAN");
  expect(calls).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});

it("gates the read-only session tools too, so a host refusal is authoritative", async () => {
  for (const toolName of ["SessionList", "SessionResult"]) {
    const { sidecar, calls, execute } = harness(false);
    const handler = vi.fn().mockResolvedValue({ ok: true, content: "listed" });
    sidecar.setLocalTool(toolName, handler);

    expect((await execute("agent", toolName)).ok).toBe(false);
    expect(calls).toEqual(["tools.execute"]);
    expect(handler).not.toHaveBeenCalled();
  }
});

it("gates a session creation through the host before the local handler runs", async () => {
  const { sidecar, calls, execute } = harness();
  sidecar.setLocalTool("SessionCreate", async () => {
    calls.push("created");
    return { ok: true, content: "created" };
  });

  expect((await execute("agent", "SessionCreate")).ok).toBe(true);
  expect(calls).toEqual(["tools.execute", "created"]);
});

it("fails a session creation closed in Plan mode without asking the host", async () => {
  // Creating a session is a durable write that spends a model the user opted
  // into, so Plan must refuse it the way it refuses a send.
  const { sidecar, calls, execute } = harness();
  const create = vi.fn().mockResolvedValue({ ok: true, content: "created" });
  sidecar.setLocalTool("SessionCreate", create);

  expect((await execute("plan", "SessionCreate")).errorCode).toBe("TOOL_DISABLED_IN_PLAN");
  expect(calls).toEqual([]);
  expect(create).not.toHaveBeenCalled();
});

it("hands the declared turn to the local handler", async () => {
  // The handler binds an approval to the turn that asked for it, so the turn
  // has to cross the boundary rather than be re-derived from session state.
  const { sidecar, execute } = harness();
  let seen: string | undefined;
  sidecar.setLocalTool("SessionSend", async ({ turnId }) => {
    seen = turnId;
    return { ok: true, content: "delivered" };
  });

  await execute();
  expect(seen).toBe("turn-1");
});

it("runs an ungated local tool without a host round trip", async () => {
  const { sidecar, calls, execute } = harness();
  sidecar.setLocalTool("BrowserPreview", async () => {
    calls.push("previewed");
    return { ok: true, content: "preview" };
  });

  expect((await execute("agent", "BrowserPreview")).ok).toBe(true);
  expect(calls).toEqual(["previewed"]);
});
