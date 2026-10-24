import { proxyStreamingRequest } from "@/lib/streaming-proxy";

export const runtime = "nodejs";
export const GET = proxyStreamingRequest;
export const POST = proxyStreamingRequest;
export const PUT = proxyStreamingRequest;
export const PATCH = proxyStreamingRequest;
export const DELETE = proxyStreamingRequest;
