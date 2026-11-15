FROM registry.k8s.io/kubectl:v1.35.10@sha256:4e1d541a3d62f74637974e4c71f3cea91b9a36ffd059ab45e355648898783837 AS kubectl

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS check
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# A failing type check or test stops the image from being built at all.
RUN npm run typecheck && npm test

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
ENV NODE_ENV=production
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
# Node runs the TypeScript sources as they are, so there is no build step and the
# image carries no node_modules: the server uses nothing but Node itself.
COPY --from=check /app/package.json ./
COPY --from=check /app/server ./server
USER 1000:1000
EXPOSE 8080
CMD ["node", "server/index.ts"]
