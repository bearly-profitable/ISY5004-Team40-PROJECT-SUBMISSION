FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* yarn.lock* ./
RUN npm ci

COPY . .

# Everything here is compiled into public JavaScript: only values that are
# safe for any visitor to read belong in this list (never a server secret).
ARG VITE_BACKEND_URL
ARG VITE_API_KEY
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_API_KEY=$VITE_API_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# Without it the bundle would call http://127.0.0.1:8000 from visitors' browsers.
RUN test -n "$VITE_BACKEND_URL" || (echo "Set VITE_BACKEND_URL on this service before building." && exit 1)
RUN npm run build

# ---------- production stage ----------
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Railway injects PORT; the default keeps `listen` valid anywhere else.
ENV PORT=8080
EXPOSE 8080

CMD envsubst '${PORT}' < /etc/nginx/conf.d/default.conf > /tmp/default.conf \
    && cp /tmp/default.conf /etc/nginx/conf.d/default.conf \
    && nginx -g "daemon off;"
