import { NextResponse } from "next/server";
import { withAuth } from "next-auth/middleware";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { isLocalHost } from "@/lib/isLocalHost";

const LOGIN_PATH = "/login";
const QC_LAB_PATH = "/qc-lab";

const bootstrapVercelAuthUrl = () => {
  if ((process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "").trim()) return;
  const vercelUrl = (process.env.VERCEL_URL ?? "").trim();
  if (!vercelUrl) return;
  try {
    const candidate = new URL(vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`);
    if (
      candidate.protocol === "https:" &&
      !candidate.username &&
      !candidate.password &&
      !candidate.search &&
      !candidate.hash
    ) {
      process.env.NEXTAUTH_URL = candidate.origin;
    }
  } catch {
    // Auth remains normally configured by environment variables.
  }
};

bootstrapVercelAuthUrl();

const authenticatedProxy = withAuth(
  (request) => {
    const { nextUrl } = request;
    const path = nextUrl.pathname;
    const email =
      typeof request.nextauth.token?.email === "string"
        ? request.nextauth.token.email.toLowerCase()
        : undefined;
    const allowed = isAllowedEmail(email);

    if (path === LOGIN_PATH) {
      if (allowed) {
        return NextResponse.redirect(new URL("/", nextUrl));
      }
      return NextResponse.next();
    }

    if (path.startsWith(QC_LAB_PATH)) {
      return NextResponse.redirect(new URL("/", nextUrl));
    }

    if (!allowed) {
      const loginUrl = new URL(LOGIN_PATH, nextUrl);
      loginUrl.searchParams.set("callbackUrl", `${path}${nextUrl.search}`);
      loginUrl.searchParams.set("error", email ? "AccessDenied" : "SigninRequired");
      return NextResponse.redirect(loginUrl);
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: () => true,
    },
    pages: {
      signIn: LOGIN_PATH,
    },
  }
);

export default function proxy(
  request: Parameters<typeof authenticatedProxy>[0],
  event: Parameters<typeof authenticatedProxy>[1],
) {
  // Local development deliberately does not require OAuth configuration. This
  // dispatch must happen before withAuth is invoked; otherwise next-auth can
  // demand provider secrets before its wrapped callback sees the local host.
  if (isLocalHost(request.nextUrl.hostname)) {
    if (request.nextUrl.pathname === LOGIN_PATH) {
      return NextResponse.redirect(new URL("/", request.nextUrl));
    }
    return NextResponse.next();
  }
  return authenticatedProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|ffmpeg/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
