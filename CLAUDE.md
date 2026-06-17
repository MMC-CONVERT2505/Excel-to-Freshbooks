# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

This tool migrates data from QuickBooks Desktop (QBD) to FreshBooks. QBD exports IIF/CSV files → backend parses and transforms them → pushes to FreshBooks via REST API.

## Tech Stack

- **Backend:** Express + TypeScript (ES modules), Node.js
- **ORM:** Prisma
- **Database:** PostgreSQL
- **HTTP client:** Axios
- **Runner:** `tsx` (not `ts-node`) — required for ES module compatibility
- **Frontend (planned):** React + TypeScript (Vite)

## Backend Commands

All commands run from `backend/`:

```bash
npm run dev       # start dev server with nodemon + tsx (auto-restarts on .ts changes)
npm run build     # compile TypeScript → dist/
npm start         # run compiled output (production)
npx prisma migrate dev    # run migrations and update DB
npx prisma generate       # regenerate Prisma client after schema changes
npx prisma studio         # open Prisma visual DB browser
```

**Important:** Nodemon does not watch `.env` — restart manually after any `.env` change.

## Architecture

### Request Flow
```
HTTP Request → index.ts (Express app)
  → Router (src/routes/)
  → Controller (src/controllers/)   ← handles req/res only
  → Service (src/services/)         ← business logic, external API calls
  → Response
```

### Key Files
- `src/index.ts` — app entry, mounts routers, registers `/callback` and utility routes
- `src/routes/auth.route.ts` — mounts under `/auth`, exposes `GET /auth/login`
- `src/controllers/auth.controller.ts` — handles redirect to FreshBooks and OAuth callback
- `src/services/auth.service.ts` — builds auth URL, exchanges code for tokens via FreshBooks API
- `prisma/schema.prisma` — database schema (Prisma client output: `src/generated/prisma`)

### ES Module Rules
- All source files are `.ts`; compiled output goes to `dist/`
- Internal imports must use `.js` extension (e.g., `import x from './services/auth.service.js'`)
- `package.json` has `"type": "module"`

## FreshBooks OAuth2 Flow

1. `GET /auth/login` → redirects browser to FreshBooks authorization page
2. User approves → FreshBooks redirects to `FRESHBOOKS_REDIRECT_URI` with `?code=XXX`
3. `GET /callback` → `handleCallback` exchanges code for tokens via FreshBooks token endpoint
4. Tokens saved to DB (access_token expires in 43200s / 12 hours; refresh with refresh_token)

## Environment Variables

See `.env.example`. Required:
- `PORT`
- `FRESHBOOKS_CLIENT_ID`
- `FRESHBOOKS_CLIENT_SECRET`
- `FRESHBOOKS_REDIRECT_URI` — must match exactly what is registered in FreshBooks Developer Portal
- `DATABASE_URL` — PostgreSQL connection string (added by `prisma init`)

## Local Development Notes

- FreshBooks requires HTTPS for redirect URIs → use **ngrok** locally: `ngrok http 1073`
- Update `FRESHBOOKS_REDIRECT_URI` in `.env` and FreshBooks portal when ngrok URL changes
- Prisma client is generated into `src/generated/prisma` (gitignored)
