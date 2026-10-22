import { env } from "cloudflare:workers";
import { handleMcp } from "../../lib/mcp-handler.ts";

export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleMcp(request, env); }
export async function GET() { return new Response("Use JSON-RPC POST /mcp", { status: 405, headers: { Allow: "POST" } }); }
