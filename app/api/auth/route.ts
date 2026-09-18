import {
  guardClosed,
  guardLogin,
  isAuthenticated,
  sessionCookie,
  sessionValue,
  verifyToken,
} from "@/lib/auth";

/** Is the caller already allowed in? 204 yes, 401 no, 503 misconfigured. */
export async function GET(req: Request) {
  return guardClosed() ?? new Response(null, { status: isAuthenticated(req) ? 204 : 401 });
}

/** Exchange the access token for an HttpOnly session cookie. */
export async function POST(req: Request) {
  const denied = guardLogin(req);
  if (denied) return denied;
  let token: unknown;
  try {
    ({ token } = await req.json());
  } catch {
    return Response.json({ error: "Expected JSON body { token }." }, { status: 400 });
  }
  if (!verifyToken(token)) {
    return Response.json({ error: "Invalid access token." }, { status: 401 });
  }
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": sessionCookie(req, sessionValue(token as string)) },
  });
}

/** Log out: clear the session cookie. */
export async function DELETE(req: Request) {
  return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(req, "", 0) } });
}
