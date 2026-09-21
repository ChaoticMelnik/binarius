import { spawn } from "node:child_process";

const child = spawn(
  "zsh",
  ["-lc", "./.claude/scripts/start-codex-mcp-server.sh"],
  {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: process.cwd(),
    env: process.env,
  },
);

const timeoutMs = Number(process.env.CODEX_MCP_TIMEOUT_MS ?? 120_000);
let stdinBuffer = "";
let stdoutBuffer = "";
const activeCalls = new Map();
const timedOutCalls = new Set();
let shuttingDown = false;

function writeMessage(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function timestamp() {
  return new Date().toISOString();
}

function appendAction(trace, action, successful = false, stage = null) {
  if (stage) trace.stage = stage;
  trace.actions.push(`${timestamp()} ${action}`);
  if (successful) trace.lastSuccessfulAction = action;
}

function summarizeEvent(message) {
  const event = message?.params?.msg;
  if (!event) return null;

  switch (event.type) {
    case "session_configured":
      return {
        action: `session configured: model=${event.model}, sandbox=read-only`,
        successful: true,
        stage: "starting Codex MCP dependencies",
      };
    case "mcp_startup_update":
      return {
        action: `MCP startup ${event.server}: ${event.status?.state ?? "unknown"}`,
        successful: event.status?.state === "ready",
        stage: event.status?.state === "starting"
          ? `starting MCP server ${event.server}`
          : null,
      };
    case "mcp_startup_complete":
      return {
        action: `MCP startup complete: ready=${(event.ready ?? []).join(",")}`,
        successful: true,
      };
    case "task_started":
      return {
        action: "Codex review task started",
        successful: true,
        stage: "Codex review task running",
      };
    case "mcp_tool_call_begin":
      return {
        action: `running MCP tool ${event.invocation?.server}.${event.invocation?.tool}`,
        stage: `running MCP tool ${event.invocation?.server}.${event.invocation?.tool}`,
      };
    case "mcp_tool_call_end":
      return {
        action: `MCP tool completed ${event.invocation?.server}.${event.invocation?.tool}`,
        successful: true,
        stage: `waiting for Codex after MCP tool ${event.invocation?.server}.${event.invocation?.tool}`,
      };
    case "elicitation_request":
      return {
        action: `waiting for MCP approval: ${event.server_name}`,
        stage: `waiting for MCP approval: ${event.server_name}`,
      };
    case "exec_command_begin":
      return {
        action: `running command: ${(event.command ?? []).join(" ")}`,
        stage: `running command: ${(event.command ?? []).join(" ")}`,
      };
    case "exec_command_end":
      return {
        action: `command completed: ${(event.command ?? []).join(" ")}`,
        successful: true,
        stage: `waiting for Codex after command: ${(event.command ?? []).join(" ")}`,
      };
    case "agent_message":
      return {
        action: `agent message (${event.phase ?? "unknown"})`,
        successful: true,
      };
    case "task_complete":
      return {
        action: "Codex review task completed",
        successful: true,
        stage: "Codex review task completed",
      };
    default:
      return null;
  }
}

function startTimeout(requestId) {
  const trace = {
    actions: [],
    lastSuccessfulAction: "MCP request accepted",
    stage: "waiting for Codex session",
    timer: null,
  };
  appendAction(trace, "MCP request accepted", true, "waiting for Codex session");

  trace.timer = setTimeout(() => {
    activeCalls.delete(requestId);
    timedOutCalls.add(requestId);

    writeMessage(child.stdin, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        requestId,
        reason: `Codex MCP review exceeded ${timeoutMs}ms`,
      },
    });

    const report = [
      "ERROR: MCP_TIMEOUT",
      `Stage: ${trace.stage}`,
      `Last successful action: ${trace.lastSuccessfulAction}`,
      `Blocked action: ${trace.stage}`,
      "Full action log:",
      ...trace.actions,
    ].join("\n");

    writeMessage(process.stdout, {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32001,
        message: "MCP_TIMEOUT",
        data: {
          stage: trace.stage,
          lastSuccessfulAction: trace.lastSuccessfulAction,
          blockedAction: trace.stage,
          fullActionLog: trace.actions,
          report,
        },
      },
    });
  }, timeoutMs);

  activeCalls.set(requestId, trace);
}

function applyReviewDefaults(message) {
  if (message?.method !== "tools/call") {
    return message;
  }

  if (message?.params?.name === "codex-reply") {
    if (message.id != null) startTimeout(message.id);
    return message;
  }

  if (message?.params?.name !== "codex") return message;

  const args = message.params.arguments ?? {};
  const config = args.config ?? {};

  message.params.arguments = {
    ...args,
    sandbox: args.sandbox ?? "read-only",
    "approval-policy": args["approval-policy"] ?? "never",
    config: {
      ...config,
      model_reasoning_effort: config.model_reasoning_effort ?? "low",
    },
  };

  if (message.id != null) startTimeout(message.id);
  return message;
}

function handleServerMessage(message) {
  const requestId = message?.id ?? message?.params?._meta?.requestId;
  const trace = activeCalls.get(requestId);

  if (trace) {
    const summary = summarizeEvent(message);
    if (summary) {
      appendAction(
        trace,
        summary.action,
        summary.successful,
        summary.stage,
      );
    }
  }

  if (message?.id != null && activeCalls.has(message.id)) {
    clearTimeout(activeCalls.get(message.id).timer);
    activeCalls.delete(message.id);
  }

  if (timedOutCalls.has(requestId)) {
    if (message?.id === requestId) timedOutCalls.delete(requestId);
    return;
  }

  writeMessage(process.stdout, message);
}

function drainLines(buffer, onLine) {
  let nextBuffer = buffer;

  while (true) {
    const newlineIndex = nextBuffer.indexOf("\n");
    if (newlineIndex === -1) break;

    const line = nextBuffer.slice(0, newlineIndex);
    nextBuffer = nextBuffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    onLine(line);
  }

  return nextBuffer;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  stdinBuffer = drainLines(stdinBuffer, (line) => {
    writeMessage(child.stdin, applyReviewDefaults(JSON.parse(line)));
  });
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  stdoutBuffer = drainLines(stdoutBuffer, (line) => {
    handleServerMessage(JSON.parse(line));
  });
});

child.on("exit", (code, signal) => {
  if (shuttingDown) {
    process.exit(0);
  }

  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const trace of activeCalls.values()) clearTimeout(trace.timer);
  activeCalls.clear();

  child.kill(signal);
  setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
}

process.stdin.on("end", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
