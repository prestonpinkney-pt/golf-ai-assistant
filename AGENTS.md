# AGENTS.md

## Cursor Cloud specific instructions

### Overview
CloseOS is a single Next.js 16 application (App Router + Turbopack) that serves as an AI-powered sales closing platform for a golf facility. All UI, API routes, and integrations live in one deployable unit. There are no microservices, Docker containers, or separate backend processes.

### Running the dev server
```
npm run dev
```
Starts on http://localhost:3000. The app requires a `.env.local` with at minimum:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `SENT_API_KEY`, `SENT_DM_API_KEY`
- `INTERNAL_API_SECRET`, `CRON_SECRET`

Without real Supabase credentials, the app compiles and renders static/login pages but API routes that hit the database will fail with connection errors. This is expected.

### Lint and build
- `npm run lint` — ESLint (flat config, `eslint.config.mjs`). Pre-existing errors exist in the codebase.
- `npm run lint:hardcoded` — custom script checking for hardcoded runtime values.
- `npm run build` — production build via Turbopack.

### Testing
No test framework is configured (no jest, vitest, etc.). Validation is done through lint, build, and manual testing.

### Key gotchas
- The root `/` route redirects (307) to `/login` due to Supabase auth middleware. Use `/login`, `/test`, `/test-ai`, or `/test-sms` to verify the server is serving pages.
- Next.js 16 emits a deprecation warning about the "middleware" file convention (recommends "proxy"). This is cosmetic and does not affect functionality.
- The app uses both `SENT_API_KEY` and `SENT_DM_API_KEY` in different code paths — both should be set.
- Some API routes read `process.env` values at request time (not build time), so env var changes take effect without rebuilding.
