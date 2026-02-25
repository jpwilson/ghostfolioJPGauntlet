# Deploying Ghostfolio Agent to Railway

## Prerequisites
- Railway account (https://railway.app)
- Railway CLI installed (`npm install -g @railway/cli`)
- GitHub repo pushed with latest changes

## Step 1: Create Railway Project

```bash
railway login
railway init
```

## Step 2: Add Services

In the Railway dashboard or via CLI:

1. **PostgreSQL**: Add a PostgreSQL plugin
2. **Redis**: Add a Redis plugin
3. **App**: Link to your GitHub repo

## Step 3: Configure Environment Variables

Set these in Railway dashboard for the app service:

```
# Database (auto-set by Railway Postgres plugin, but verify format)
DATABASE_URL=${{Postgres.DATABASE_URL}}?connect_timeout=300&sslmode=require

# Redis (auto-set by Railway Redis plugin)
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}
REDIS_PASSWORD=${{Redis.REDIS_PASSWORD}}

# App secrets (generate random strings)
ACCESS_TOKEN_SALT=<random-32-char-string>
JWT_SECRET_KEY=<random-32-char-string>

# AI
OPENAI_API_KEY=sk-your-openai-key

# Timezone (critical for portfolio calculations)
TZ=UTC

# Port (Railway provides this)
PORT=3333
```

## Step 4: Deploy

Push to GitHub and Railway auto-deploys, or:

```bash
railway up
```

## Step 5: Verify

1. Check deployment logs in Railway dashboard
2. Visit `https://your-app.railway.app/api/v1/health`
3. Visit `https://your-app.railway.app/api/v1/agent/ui`

## Troubleshooting

- If portfolio shows 0.00: Ensure `TZ=UTC` is set
- If agent fails: Ensure `OPENAI_API_KEY` is set
- If DB errors: Check `DATABASE_URL` format includes `?sslmode=require`
