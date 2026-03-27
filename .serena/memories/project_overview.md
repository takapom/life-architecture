# life-architecture overview
- Purpose: Web app that diagnoses a user's life as a software architecture metaphor for engineers.
- Current repository state: docs-only repository with no app scaffold yet. Main docs are README.md, CLAUDE.md, and docs/{requirements,architecture,database,design}.md.
- Planned stack: Next.js 15 App Router, Tailwind CSS, shadcn/ui, React Flow, Recharts, Supabase Auth/DB, Mastra, Vercel AI SDK, Gemini 1.5 Flash, Vercel deploy.
- Rough structure planned in docs: src/modules/{auth,diagnosis,result,history,visualization,ai}, src/app routes for landing/auth/diagnosis/result/timeline/history.
- Important architectural constraints from CLAUDE.md: do not break ai/interface.ts, keep React Flow read-only, preserve module boundaries, add new AI providers under providers/ instead of changing interface.
