# Backend Deployment Guide (Render)

This guide documents how to deploy the backend microservice to Render and configure database migrations and environment variables.

---

## Deployment Settings
1. **Service Type**: Web Service
2. **Root Directory**: `backend` (Ensure this is set so Render only builds this directory)
3. **Build Command**: `npm install && npx prisma generate && npm run build`
4. **Start Command**: `npm start`

---

## Environment Variables Configuration

Configure the following variables in the **Environment** tab of the Render dashboard:

- **`DATABASE_URL`**: Connection string to your production database instance (e.g. Postgres on Render or MySQL instance).
- **`JWT_SECRET`**: A private random key string used to sign JWT authentication claims.
- **`PORT`**: Set to `10000` (defaults to Render standard).
- **`EMAIL_SERVICE_API_KEY`**: Set to your email provider API key (or `dummy_api_key` to run in simulated console logger mode).
- **`FRONTEND_URL`**: The live Vercel deployment URL (e.g. `https://last-mile-tracker.vercel.app`).
  - *Note: This is configured in a two-step process. Once Vercel deploys the frontend and generates the production domain, copy that domain and set it as the value of `FRONTEND_URL` on Render to allow CORS boundary crossings.*

---

## Remote Database Migration & Seeding

Once the backend web service and database instances are live on Render:

1. Sync local source tables with the remote database by pushing schemas:
   ```bash
   DATABASE_URL="your_remote_db_url" npx prisma db push
   ```
2. Populate the remote database with initial active configuration zone mappings, rate cards, and demo accounts:
   ```bash
   DATABASE_URL="your_remote_db_url" npx ts-node src/scripts/seed-data.ts

   
   ```
