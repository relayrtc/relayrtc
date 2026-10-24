import { NextResponse, type NextRequest } from "next/server";
import { requestOrigin } from "@/lib/request-origin";

export function proxy(request: NextRequest) {
  const hasSession = request.cookies.getAll().some(cookie => /^(?:__Secure-)?better-auth\.session_token$/.test(cookie.name) && cookie.value);
  if (!hasSession) {
    const login = new URL("/auth/login", requestOrigin(request));
    login.searchParams.set("redirect", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-relayrtc-path", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = { matcher: ["/", "/account/:path*", "/onboarding", "/console/onboarding", "/org/:path*", "/cleanup/:path*", "/organizations/:path*", "/projects/:path*", "/invitations/:path*", "/rooms/:path*", "/realtime", "/streams/:path*", "/analytics", "/usage", "/activity/:path*", "/developer/:path*"] };
