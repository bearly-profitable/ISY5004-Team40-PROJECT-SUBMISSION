FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* yarn.lock* ./
RUN npm install

COPY . .

ARG VITE_BACKEND_URL
ARG GEMINI_API_KEY
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_GOOGLE_API_KEY

ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV GEMINI_API_KEY=$GEMINI_API_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_API_KEY=$VITE_GOOGLE_API_KEY

RUN npm run build

# ---------- production stage ----------
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

CMD envsubst '${PORT}' < /etc/nginx/conf.d/default.conf > /tmp/default.conf \
    && cp /tmp/default.conf /etc/nginx/conf.d/default.conf \
    && nginx -g "daemon off;"
