// Quick check on every page: no valid session cookie -> login page.
// Pages still call requireUser() themselves; this is only the first filter.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, decodeSession } from "@/lib/auth/session";

export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login") {
    return session ? NextResponse.redirect(new URL("/", req.nextUrl)) : NextResponse.next();
  }
  if (!session) {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|tmc-logo.png).*)"],
};
