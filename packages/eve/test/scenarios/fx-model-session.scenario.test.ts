import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { type MessageStreamEvent, isCurrentTurnBoundaryEvent } from "../../src/protocol/message.js";
import {
  EVE_SESSION_ROUTE_PATH,
  createEveSessionCancelRoutePath,
} from "../../src/protocol/routes.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

// @appport/fx is not on npm yet, so this scenario installs a packed FX SDK
// release (with native addons). Point EVE_SCENARIO_FX_TARBALL at one.
const FX_TARBALL = process.env.EVE_SCENARIO_FX_TARBALL;

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const EVENT_TIMEOUT_MS = 60_000;
const TOKEN = "fx-scenario-token";
const TOOL_SECRET = "FX-4242";

interface ProviderRequest {
  readonly authorization: string | undefined;
  readonly body: {
    readonly model: string;
    readonly stream?: boolean;
    readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
    readonly tools?: readonly { readonly function: { readonly name: string } }[];
  };
  readonly host: string | undefined;
  readonly url: string | undefined;
  closedEarly: boolean;
}

function createDescriptor(): ScenarioAppDescriptor {
  return {
    dependencies: { "@appport/fx": `file:${FX_TARBALL}`, zod: "^4.3.6" },
    files: {
      "agent/agent.ts": `import { defineAgent } from "eve";
import { fx } from "eve/models/fx";
import { createFxModel } from "@appport/fx";

export default defineAgent({
  model: fx(await createFxModel({ baseUrl: process.env.FX_MOCK_BASE_URL, model: "fx-fixture" })),
  modelContextWindowTokens: 32_000,
  // FX loads its native addon relative to its own package.
  build: { externalDependencies: ["@appport/fx"] },
});
`,
      "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${TOKEN}") return null;
    return {
      attributes: {},
      authenticator: "scenario-bearer",
      principalId: "fx-scenario",
      principalType: "service",
    };
  },
});
`,
      "agent/instructions.md": "Answer the user. Call lookup-code when asked for the code.\n",
      "agent/tools/lookup-code.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up the deployment code.",
  inputSchema: z.object({ name: z.string() }),
  execute: ({ name }) => ({ code: "${TOOL_SECRET}", name }),
});
`,
    },
    installDependencies: true,
    name: "fx-model-session",
  };
}

/** A deterministic OpenAI-compatible provider that routes on the last user message. */
async function startMockProvider() {
  const requests: ProviderRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const record: ProviderRequest = {
        authorization: req.headers.authorization,
        body: JSON.parse(raw),
        host: req.headers.host,
        url: req.url,
        closedEarly: false,
      };
      requests.push(record);
      res.on("close", () => {
        if (!res.writableFinished) record.closedEarly = true;
      });
      respond(record, req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function respond(record: ProviderRequest, _req: IncomingMessage, res: ServerResponse): void {
  const messages = record.body.messages;
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content : "";
  const toolResult = messages.find((message) => message.role === "tool");

  if (prompt.includes("fx-fail")) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "fixture rejected the request", type: "invalid_request" },
      }),
    );
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta: object, finishReason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fx",
        object: "chat.completion.chunk",
        model: record.body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  const finish = (finishReason: string) => {
    send({}, finishReason);
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fx",
        object: "chat.completion.chunk",
        model: record.body.model,
        choices: [],
        usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  };

  if (prompt.includes("fx-hang")) {
    // Hold the response open after the first delta so the session can cancel mid-stream.
    send({ role: "assistant", content: "waiting" });
    return;
  }

  if (prompt.includes("fx-tool")) {
    if (toolResult === undefined) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_fx_1",
            type: "function",
            function: { name: "lookup-code", arguments: '{"name":"alice"}' },
          },
        ],
      });
      finish("tool_calls");
      return;
    }
    const code = String(toolResult.content).includes(TOOL_SECRET) ? TOOL_SECRET : "missing";
    send({ role: "assistant", content: `The code is ${code}.` });
    finish("stop");
    return;
  }

  for (const piece of ["FX ", "streamed ", "hello"]) send({ content: piece });
  finish("stop");
}

async function readTurn(
  iterator: AsyncIterator<MessageStreamEvent>,
  label: string,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  await withinDeadline(
    (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error(`Stream ended before ${label}.`);
        events.push(next.value);
        if (isCurrentTurnBoundaryEvent(next.value)) return;
      }
    })(),
    label,
  );
  return events;
}

async function readUntil(
  iterator: AsyncIterator<MessageStreamEvent>,
  label: string,
  matches: (event: MessageStreamEvent) => boolean,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  await withinDeadline(
    (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error(`Stream ended before ${label}.`);
        events.push(next.value);
        if (matches(next.value)) return;
      }
    })(),
    label,
  );
  return events;
}

async function withinDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          EVENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function appendedText(events: readonly MessageStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "message.appended" && "messageDelta" in event.data
      ? [String(event.data.messageDelta)]
      : [],
  );
}

describe.skipIf(FX_TARBALL === undefined)("FX-backed model through /eve/v1/session", () => {
  it(
    "streams, calls tools, fails, and cancels through FX against a local provider",
    async () => {
      const provider = await startMockProvider();
      const app = await scenarioApp(createDescriptor());
      const server = await startEveDev(app.appRoot, {
        env: {
          AI_GATEWAY_API_KEY: "",
          EVE_MOCK_AUTHORED_MODELS: "",
          FX_MOCK_BASE_URL: provider.baseUrl,
          NODE_ENV: "production",
          VERCEL_OIDC_TOKEN: "",
        },
      });
      const client = new Client({ auth: { bearer: TOKEN }, host: server.url });

      try {
        // 1. Asynchronous acceptance and operationId idempotency on the public route.
        const create = (message: string, operationId?: string) =>
          fetch(new URL(EVE_SESSION_ROUTE_PATH, server.url), {
            body: JSON.stringify({ message, ...(operationId !== undefined && { operationId }) }),
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            method: "POST",
          });
        const accepted = await create("Say hello. fx-text", "fx-op-1");
        expect(accepted.status).toBe(202);
        const acceptedBody = (await accepted.json()) as { sessionId: string; status: string };
        expect(acceptedBody).toMatchObject({ ok: true, status: "accepted" });
        expect(acceptedBody.sessionId).toEqual(expect.any(String));

        const textEvents = await readTurn(
          client.sessions.attach(acceptedBody.sessionId).stream()[Symbol.asyncIterator](),
          "FX text turn",
        );
        const replay = await create("Say hello. fx-text", "fx-op-1");
        expect(replay.status).toBe(202);
        expect(((await replay.json()) as { sessionId: string }).sessionId).toBe(
          acceptedBody.sessionId,
        );

        // 2. Real streaming: each provider delta arrives as its own session delta.
        expect(appendedText(textEvents), JSON.stringify(textEvents)).toEqual([
          "FX ",
          "streamed ",
          "hello",
        ]);
        expect(JSON.stringify(textEvents)).toContain("FX streamed hello");
        expect(textEvents.map((event) => event.type)).not.toContain("turn.failed");
        expect(textEvents.at(-1)?.type).toBe("session.waiting");

        const textRequest = provider.requests[0]!;
        expect(textRequest.url).toBe("/v1/chat/completions");
        expect(textRequest.host).toMatch(/^127\.0\.0\.1:\d+$/u);
        expect(textRequest.authorization).toBeUndefined();
        expect(textRequest.body).toMatchObject({ model: "fx-fixture", stream: true });
        expect(textRequest.body.tools?.map((tool) => tool.function.name)).toContain("lookup-code");
        expect(provider.requests).toHaveLength(1);

        // 3. A tool call crosses the adapter, eve executes it, and the result returns to the provider.
        const toolSession = await client.sessions.create({ message: "Find the code. fx-tool" });
        const toolEvents = await readTurn(
          toolSession.response[Symbol.asyncIterator](),
          "FX tool turn",
        );
        const toolEventJson = JSON.stringify(toolEvents);
        expect(
          toolEvents.some(
            (event) =>
              event.type === "actions.requested" &&
              event.data.actions.some(
                (action) => action.kind === "tool-call" && action.toolName === "lookup-code",
              ),
          ),
          toolEventJson,
        ).toBe(true);
        expect(
          toolEvents.some((event) => event.type === "action.result"),
          toolEventJson,
        ).toBe(true);
        expect(toolEventJson).toContain(`The code is ${TOOL_SECRET}.`);
        const toolFollowUp = provider.requests.at(-1)!;
        expect(toolFollowUp.body.messages.some((message) => message.role === "tool")).toBe(true);

        // 4. A provider failure surfaces as a failed turn, never as a completed reply.
        const requestsBeforeFailure = provider.requests.length;
        const failSession = await client.sessions.create({ message: "Break please. fx-fail" });
        const failEvents = await readTurn(
          failSession.response[Symbol.asyncIterator](),
          "FX failure turn",
        );
        const failTypes = failEvents.map((event) => event.type);
        expect(failTypes, JSON.stringify(failEvents)).toContain("turn.failed");
        expect(failTypes).not.toContain("message.completed");
        expect(JSON.stringify(failEvents)).toContain("fixture rejected the request");
        // invalid_request is not retryable, so FX reached the provider exactly once.
        expect(provider.requests.length - requestsBeforeFailure).toBe(1);

        // 5. Cancelling the turn aborts the in-flight FX provider request.
        const hangSession = await client.sessions.create({ message: "Wait. fx-hang" });
        const hangIterator = hangSession.response[Symbol.asyncIterator]();
        await readUntil(
          hangIterator,
          "first FX delta",
          (event) => event.type === "message.appended",
        );
        const hangRequest = provider.requests.at(-1)!;
        const cancel = await client.fetch(
          createEveSessionCancelRoutePath(hangSession.response.sessionId),
          {
            method: "POST",
          },
        );
        expect(cancel.status).toBe(202);
        const cancelEvents = await readTurn(hangIterator, "FX cancellation boundary");
        expect(cancelEvents.map((event) => event.type)).toContain("turn.cancelled");
        await withinDeadline(
          (async () => {
            while (!hangRequest.closedEarly)
              await new Promise((resolve) => setTimeout(resolve, 50));
          })(),
          "provider connection close",
        );
        expect(hangRequest.closedEarly).toBe(true);
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          { cause: error },
        );
      } finally {
        await server.stop();
        await provider.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
