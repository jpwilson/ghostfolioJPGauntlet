#!/bin/sh

set -ex

echo "Pushing database schema"
npx prisma db push --accept-data-loss

echo "Seeding the database"
npx prisma db seed || echo "Seed failed or already seeded, continuing..."

echo "Starting the server"
exec node main
