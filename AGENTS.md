# CloseOS (golf-ai-assistant)

AI-powered customer engagement and sales automation platform for a golf facility business ("Primetime Golf"). Single Next.js 16 app (App Router) with React 19, TypeScript, Tailwind CSS 4. No monorepo, no Docker, no local database.

## Cursor Cloud specific instructions

### Architecture overview

- **Framework**: Next.js 16 (App Router) with Turbopack in dev
- **Database**: Remote Supabase (hosted PostgreSQL) — no local DB setup required
- **Auth**: Supabase Auth with cookie-based sessions (middleware handles protected routes)
- **AI**: OpenAI GPT-4o-mini via `openai` npm package
- **Messaging**: Sent.dm API for SMS/RCS
- **Integrations**: Square POS, Mailchimp, Google Calendar, Whoosh (CSV)

### Required environment variables

A `.env.local` file is needed at minimum with:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — for any page to render (middleware calls `supabase.auth.getUser()` on every request)
- `OPENAI_API_KEY` — for AI features
- Placeholder values allow the app to start and render UI; real Supabase credentials are needed for auth/data flows.

### Running the app

- `npm run dev` — starts Next.js dev server on port 3000
- `npm run build` — production build (compiles successfully with placeholder env vars)
- `npm run lint` — ESLint (note: codebase has ~29 pre-existing lint errors, mostly `@typescript-eslint/no-explicit-any`)
- `npm run lint:hardcoded` — checks for hardcoded business values in `app/api/`

### Gotchas

- The root page (`/`) redirects to `/dashboard`, which requires auth. Use `/login` to see the login UI without auth.
- Protected pages (`/dashboard`, `/opportunities`, `/outbound`, `/messages`) redirect to `/login` when unauthenticated.
- Public API paths (webhooks, cron, inbound, leads, auth) bypass auth middleware.
- No automated test framework is configured (no jest, vitest, etc.). Testing is manual via the dev server.
- The `middleware.ts` convention is deprecated in Next.js 16 in favor of "proxy"; the app still uses it and it works, but emits a build warning.
