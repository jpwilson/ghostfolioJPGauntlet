# Claude Code Instructions

## On Session Start
Always read these three memory files before doing anything else:
1. `~/.claude/projects/-Users-jpwilson-Documents-Projects-gauntlet-projects-week2-ghostfolio-ghostfolio/memory/MEMORY.md`
2. `~/.claude/projects/-Users-jpwilson-Documents-Projects-gauntlet-projects-week2-ghostfolio-ghostfolio/memory/progress.md`
3. `~/.claude/projects/-Users-jpwilson-Documents-Projects-gauntlet-projects-week2-ghostfolio-ghostfolio/memory/architecture.md`

## Git Conventions
- No Co-Authored-By lines in commits
- Use --no-verify on commits (pre-existing ESLint bug in repo)
- Branch: feature/agent-mvp
- Fork: https://github.com/jpwilson/ghostfolioJPGauntlet

## Dev Environment
- Node 22 via nvm (`nvm use 22`)
- Docker for Postgres + Redis: `docker compose -f docker/docker-compose.dev.yml --env-file .env up -d`
- API server: `npm run start:server` (port 3333)
- Angular client: `npm run start:client` (port 4200)
