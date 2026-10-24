import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MONAVISA_TOOLS, handleMcpToolCall, type McpContext } from "./tools.js";

export interface CreateMcpServerOptions extends Partial<McpContext> {
  serverName?: string;
  serverVersion?: string;
}

export function createMcpServer(options: CreateMcpServerOptions = {}) {
  const server = new Server(
    {
      name: options.serverName ?? "monavisa-mcp",
      version: options.serverVersion ?? "0.0.1",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const context: McpContext = {
    chainId: options.chainId ?? 10143,
    rpcUrl: options.rpcUrl ?? process.env.MONAD_RPC_URL ?? "http://localhost:8545",
    ...(options.privateKey ? { privateKey: options.privateKey } : {}),
    ...(options.sessionVaultAddress ? { sessionVaultAddress: options.sessionVaultAddress } : {}),
    ...(options.usdcAddress ? { usdcAddress: options.usdcAddress } : {}),
    ...(options.platformUrl ? { platformUrl: options.platformUrl } : {}),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: MONAVISA_TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleMcpToolCall(request.params.name, request.params.arguments ?? {}, context);
  });

  return {
    server,
    startStdio: async () => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}
