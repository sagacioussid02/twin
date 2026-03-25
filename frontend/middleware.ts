import { NextResponse } from "next/server";

export default function middleware() {
  // No-op middleware for static export deployments.
  // Auth is enforced on the client (useAuth/isSignedIn) and in backend routes instead.
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
