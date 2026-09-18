import { doorState, guardLogin, sessionCookie, sessionValue, verifyToken } from "@/lib/auth";

/** May this visitor use the app? 204 open · 401 needs the access token · 503
 *  misconfigured. BYOK deployments (no server key) are always open. */
export async function GET(req: Request) {
  const state = doorState(req);
  const status = state === "open" ? 204 : state === "locked" ? 401 : 503;
  return new Response(null, { status });
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
