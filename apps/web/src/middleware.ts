export { default } from "next-auth/middleware";

// Protect authenticated *page* surfaces. Everything not listed here stays
// public — landing page, /login, /register, /api/auth/*, Next internals,
// static assets.
//
// Deliberately not guarded here:
//   - /api/trpc/*  — each procedure gates itself via `protectedProcedure`.
//     Edge-blocking this path would also block public procedures (e.g.
//     `health.ping`) from the landing page.
//
// Keep this list in sync as new app sections come online:
//   - /overview       (default authed landing)
//   - /engagements/*  (Task 5+)
//   - /admin/*        (Task 3+)
export const config = {
  matcher: ["/overview", "/engagements/:path*", "/admin/:path*"],
};
