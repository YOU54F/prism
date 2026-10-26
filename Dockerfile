# syntax=docker/dockerfile:1
#
# Optional build secret "ca": a full PEM bundle (public roots + a TLS-intercepting proxy root), used only while
# fetching packages and never stored in a layer:
#   docker build --secret id=ca,src=/path/to/ca-bundle.pem -t prism .
# Dependency lifecycle scripts are not run (npm ci --ignore-scripts); Prism has no native dependencies.

FROM golang:1-alpine AS nodeprune

RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export SSL_CERT_FILE=/run/secrets/ca; fi; \
    go install -trimpath -ldflags "-s -w" github.com/tj/node-prune@v1.2.0

###############################################################
FROM node:24 AS compiler

WORKDIR /usr/src/prism

COPY package.json package-lock.json /usr/src/prism/
COPY packages/ /usr/src/prism/packages/

RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --ignore-scripts && npm run build

###############################################################
FROM node:24 AS dependencies

WORKDIR /usr/src/prism/

COPY --from=nodeprune /go/bin/node-prune /bin/

COPY package.json package-lock.json /usr/src/prism/
RUN mkdir -p /usr/src/prism/node_modules

COPY packages/core/package.json /usr/src/prism/packages/core/
RUN mkdir -p /usr/src/prism/packages/core/node_modules

COPY packages/http/package.json /usr/src/prism/packages/http/
RUN mkdir -p /usr/src/prism/packages/http/node_modules

COPY packages/http-server/package.json /usr/src/prism/packages/http-server/
RUN mkdir -p /usr/src/prism/packages/http-server/node_modules

COPY packages/cli/package.json /usr/src/prism/packages/cli/
RUN mkdir -p /usr/src/prism/packages/cli/node_modules

ENV NODE_ENV=production
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --omit=dev --ignore-scripts

RUN node-prune

###############################################################
FROM node:24-alpine

# https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#handling-kernel-signals
RUN --mount=type=secret,id=ca,target=/etc/ssl/certs/ca-certificates.crt,required=false \
    apk add --no-cache tini

WORKDIR /usr/src/prism
ENV NODE_ENV=production

COPY package.json /usr/src/prism/
COPY packages/core/package.json /usr/src/prism/packages/core/
COPY packages/http/package.json /usr/src/prism/packages/http/
COPY packages/http-server/package.json /usr/src/prism/packages/http-server/
COPY packages/cli/package.json /usr/src/prism/packages/cli/

COPY --from=compiler /usr/src/prism/packages/core/dist /usr/src/prism/packages/core/dist
COPY --from=compiler /usr/src/prism/packages/http/dist /usr/src/prism/packages/http/dist
COPY --from=compiler /usr/src/prism/packages/http-server/dist /usr/src/prism/packages/http-server/dist
COPY --from=compiler /usr/src/prism/packages/cli/dist /usr/src/prism/packages/cli/dist

COPY --from=dependencies /usr/src/prism/node_modules/ /usr/src/prism/node_modules/
COPY --from=dependencies /usr/src/prism/packages/core/node_modules/ /usr/src/prism/packages/core/node_modules/
COPY --from=dependencies /usr/src/prism/packages/http/node_modules/ /usr/src/prism/packages/http/node_modules/
COPY --from=dependencies /usr/src/prism/packages/http-server/node_modules/ /usr/src/prism/packages/http-server/node_modules/
COPY --from=dependencies /usr/src/prism/packages/cli/node_modules/ /usr/src/prism/packages/cli/node_modules/

WORKDIR /usr/src/prism/packages/cli/

# No `npm link` step: npm workspaces already symlink node_modules/@stoplight/prism-* to packages/*, and
# `npm link` re-reifies the tree against the registry, which needs network access (and the CA) in the final stage.

EXPOSE 4010

ENTRYPOINT [ "/sbin/tini", "--", "node", "dist/index.js" ]
